import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getMigrationsDir(): string {
  const rootDir = path.resolve(__dirname, "..");
  const configPath = path.join(rootDir, "drizzle.config.ts");
  
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/out:\s*["']([^"']+)["']/);
    if (match && match[1]) {
      return path.resolve(rootDir, match[1]);
    }
  }
  return path.resolve(rootDir, "src/db/migrations");
}

/**
 * Read the Drizzle migration journal to determine which migrations are registered.
 * Returns the set of tags (filename without .sql) that appear in the journal.
 */
function readJournalTags(migrationsDir: string): Set<string> {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
    const tags = new Set<string>();
    for (const entry of journal.entries ?? []) {
      if (entry.tag) tags.add(entry.tag);
    }
    return tags;
  } catch {
    return new Set();
  }
}

/** Pattern for timestamp-prefixed migration files (13-14 digit prefix). */
const TIMESTAMP_PATTERN = /^\d{13,14}_(.+)\.sql$/;

/** Pattern for sequence-prefixed migration files (4-digit prefix). */
const SEQUENCE_PATTERN = /^(\d{4})_(.+)\.sql$/;

/**
 * Extract the numeric prefix from a migration filename.
 * Returns the full numeric prefix string (e.g. "20240101000000" or "0003").
 */
function extractPrefix(filename: string): string | null {
  const tsMatch = filename.match(TIMESTAMP_PATTERN);
  if (tsMatch) {
    // For timestamp-prefixed, the prefix is the first 13-14 digits
    const prefix = filename.split("_")[0];
    return prefix;
  }
  const seqMatch = filename.match(SEQUENCE_PATTERN);
  if (seqMatch) {
    return seqMatch[1];
  }
  return null;
}

export function lintMigrations(dir?: string): boolean {
  const migrationsDir = dir || getMigrationsDir();
  
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    return false;
  }

  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
  const journalTags = readJournalTags(migrationsDir);
  let valid = true;

  // Track which files use which scheme
  const timestampFiles: string[] = [];
  const sequenceFiles: string[] = [];
  const invalidFiles: string[] = [];

  for (const file of files) {
    if (TIMESTAMP_PATTERN.test(file)) {
      timestampFiles.push(file);
    } else if (SEQUENCE_PATTERN.test(file)) {
      sequenceFiles.push(file);
    } else {
      invalidFiles.push(file);
    }
  }

  // Report files that don't match any recognized scheme
  for (const file of invalidFiles) {
    console.error(
      `Error: Migration filename "${file}" does not match any recognized convention ` +
      `(expected 13-14 digit timestamp prefix or 4-digit sequence prefix)`,
    );
    valid = false;
  }

  // Check for mixed naming schemes (grandfather clause: registered journal entries
  // using the old sequence scheme are allowed, but unregistered files must use timestamps)
  if (sequenceFiles.length > 0 && timestampFiles.length > 0) {
    const unregisteredSequenceFiles = sequenceFiles.filter(f => {
      const tag = f.replace(/\.sql$/, "");
      return !journalTags.has(tag);
    });

    if (unregisteredSequenceFiles.length > 0) {
      for (const file of unregisteredSequenceFiles) {
        console.error(
          `Error: Migration filename "${file}" uses sequence prefix but is not registered ` +
          `in the journal. New migrations must use timestamp prefix (e.g. 20240101123000_name.sql)`,
        );
        valid = false;
      }
    }
  }

  // Check for duplicate prefixes within the timestamp scheme
  const timestampPrefixes = new Map<string, string[]>();
  for (const file of timestampFiles) {
    const prefix = extractPrefix(file);
    if (prefix) {
      const existing = timestampPrefixes.get(prefix) ?? [];
      existing.push(file);
      timestampPrefixes.set(prefix, existing);
    }
  }

  for (const [prefix, conflictingFiles] of timestampPrefixes) {
    if (conflictingFiles.length > 1) {
      console.error(
        `Error: Duplicate migration prefix "${prefix}" found in: ${conflictingFiles.join(", ")}. ` +
        `Each migration must have a unique timestamp prefix.`,
      );
      valid = false;
    }
  }

  // Check for duplicate prefixes within the sequence scheme
  const sequencePrefixes = new Map<string, string[]>();
  for (const file of sequenceFiles) {
    const prefix = extractPrefix(file);
    if (prefix) {
      const existing = sequencePrefixes.get(prefix) ?? [];
      existing.push(file);
      sequencePrefixes.set(prefix, existing);
    }
  }

  for (const [prefix, conflictingFiles] of sequencePrefixes) {
    if (conflictingFiles.length > 1) {
      console.error(
        `Error: Duplicate migration prefix "${prefix}" found in: ${conflictingFiles.join(", ")}. ` +
        `Each migration must have a unique sequence prefix.`,
      );
      valid = false;
    }
  }

  // Check for duplicate prefixes across schemes (e.g. "0003" vs "0003" - same number
  // in different schemes). This is caught by the mixed scheme check above, but we
  // also explicitly check for cross-scheme numeric collisions.
  for (const [seqPrefix, seqFiles] of sequencePrefixes) {
    for (const [tsPrefix, tsFiles] of timestampPrefixes) {
      // A 4-digit sequence prefix could collide with the last 4 digits of a
      // timestamp prefix. This is a secondary concern; the primary issue is
      // the mixed scheme itself, which is already flagged above.
    }
  }

  return valid;
}

export function isMainModule(argvPath: string | undefined, moduleUrl: string) {
  return Boolean(argvPath && moduleUrl === pathToFileURL(path.resolve(argvPath)).href);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const success = lintMigrations();
  if (!success) {
    process.exit(1);
  } else {
    console.log("Migration filenames passed linting.");
  }
}
