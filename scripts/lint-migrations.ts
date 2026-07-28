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

export function lintMigrations(dir?: string): boolean {
  const migrationsDir = dir || getMigrationsDir();
  
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found: ${migrationsDir}`);
    return false;
  }

  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
  let valid = true;

  // Pattern: 13-14 digits followed by underscore and name
  const pattern = /^\d{13,14}_.+\.sql$/;

  for (const file of files) {
    if (!pattern.test(file)) {
      console.error(`Error: Migration filename "${file}" does not follow the timestamp-prefixed convention (e.g. 20240101123000_name.sql)`);
      valid = false;
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
