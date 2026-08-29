/**
 * Link checker for docs/ markdown files.
 *
 * Walks every `.md` file under `docs/`, extracts all markdown links
 * (`[text](target)` plus reference-style links), and verifies that internal
 * links (relative paths or paths to other files in the repo) resolve to real
 * files on disk.
 *
 * External URLs (http/https) are collected but never fetched — they are
 * reported as informational counts only.
 *
 * Usage: tsx scripts/check-docs-links.ts [--docs <dir>]
 *
 * Exit codes: 0 when every internal link resolves, 1 otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A markdown link found in a docs file. */
export interface MarkdownLink {
  /** The display text of the link. */
  text: string;
  /** The raw target (URL or path). */
  target: string;
  /** The file where this link was found (relative to the repo root). */
  sourceFile: string;
  /** 1-based line number where the link text starts. */
  line: number;
}

/** A link whose target could not be resolved on disk. */
export interface BrokenLink {
  link: MarkdownLink;
  reason: string;
}

/** Aggregated result of scanning the whole docs tree. */
export interface DocsLinkCheckResult {
  /** Number of .md files scanned. */
  filesChecked: number;
  /** Total links found (internal + external). */
  totalLinks: number;
  /** Links that were validated against the filesystem. */
  internalLinks: number;
  /** http/https/mailto links collected but not fetched. */
  externalLinks: number;
  /** Links whose targets could not be resolved. */
  brokenLinks: BrokenLink[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/**
 * Regex that matches CommonMark inline links: `[text](target)`.
 *
 * It handles:
 *  - basic links: [label](url)
 *  - links with titles: [label](url "title")
 *  - reference-style links are NOT matched (handled separately below).
 *  - escaped brackets within the text part.
 *
 * Reference: https://spec.commonmark.org/0.30/#links
 */
const INLINE_LINK_RE = /(?<!!)\[([^\]]*?)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Regex matching reference-style link definitions:
 *   [ref]: target "optional title"
 */
const REF_DEF_RE = /^\[([^\]]+)\]:\s*(\S+)(?:\s+"[^"]*")?\s*$/gm;

/**
 * Regex matching inline reference links: [text][ref] or [text][]
 */
const REF_LINK_RE = /(?<!!)\[([^\]]+)\](?!\s*\()(?:\s*\[([^\]]*)\])?/g;

/**
 * Recursively lists all `.md` files under `dir`.
 */
export function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract all markdown links (inline + reference-style) from a file.
 */
export function extractLinks(filePath: string, repoRoot: string = REPO_ROOT): MarkdownLink[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const sourceFile = path.relative(repoRoot, filePath);
  const links: MarkdownLink[] = [];

  // --- Pass 1: Inline links [text](target) ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    INLINE_LINK_RE.lastIndex = 0;

    while ((match = INLINE_LINK_RE.exec(line)) !== null) {
      const text = match[1] ?? "";
      const target = match[2] ?? "";

      // Skip empty targets and fragment-only links (same-page anchors).
      if (!target) continue;

      links.push({ text, target, sourceFile, line: i + 1 });
    }
  }

  // --- Pass 2: Reference definitions [ref]: target ---
  const refDefinitions = new Map<string, string>();
  REF_DEF_RE.lastIndex = 0;
  let defMatch: RegExpExecArray | null;
  while ((defMatch = REF_DEF_RE.exec(content)) !== null) {
    refDefinitions.set(defMatch[1]!.toLowerCase(), defMatch[2]!);
  }

  // --- Pass 3: Reference links [text][ref] or [text][] ---
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    REF_LINK_RE.lastIndex = 0;
    let refMatch: RegExpExecArray | null;

    while ((refMatch = REF_LINK_RE.exec(line)) !== null) {
      const text = refMatch[1] ?? "";
      const refKey = (refMatch[2] || text).toLowerCase();
      const target = refDefinitions.get(refKey);

      // Skip unresolved refs (could be defined in another file — out of scope).
      if (!target) continue;

      links.push({ text, target, sourceFile, line: i + 1 });
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Target resolution & validation
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `target` is an external URL (http/https).
 */
export function isExternalUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * Returns `true` when `target` is a mailto: link.
 */
export function isMailto(target: string): boolean {
  return /^mailto:/i.test(target);
}

/**
 * Returns `true` when `target` is a fragment-only link (`#section`).
 */
export function isFragmentOnly(target: string): boolean {
  return target.startsWith("#");
}

/**
 * Given a link target found in `sourceFile`, resolve it to an absolute path.
 * Returns the resolved path or `null` if the target cannot be validated
 * against the filesystem.
 *
 * Resolution rules:
 *  - External URLs → null (skip validation)
 *  - `mailto:` links → null (skip validation)
 *  - Fragment-only → resolved to the source file itself
 *  - Absolute paths (starting with `/`) → resolved from the repo root
 *  - Relative paths → resolved relative to the source file's directory
 *  - Targets with `#fragment` → fragment stripped before file resolution
 */
export function resolveTarget(
  target: string,
  sourceFile: string,
  repoRoot: string = REPO_ROOT,
): string | null {
  if (isExternalUrl(target) || isMailto(target)) return null;

  if (isFragmentOnly(target)) {
    return path.resolve(repoRoot, sourceFile);
  }

  // Strip fragment for file resolution.
  const hashIdx = target.indexOf("#");
  const filePart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;

  // Empty file part with a fragment (e.g. "#section") → same file.
  if (!filePart) {
    return path.resolve(repoRoot, sourceFile);
  }

  if (filePart.startsWith("/")) {
    return path.resolve(repoRoot, "." + filePart);
  }

  return path.resolve(path.dirname(path.join(repoRoot, sourceFile)), filePart);
}

/**
 * Check a single link target for validity.
 * Returns `null` if the link is valid, or a `BrokenLink` if broken.
 */
export function checkLink(link: MarkdownLink, repoRoot: string = REPO_ROOT): BrokenLink | null {
  const resolved = resolveTarget(link.target, link.sourceFile, repoRoot);

  // External URLs and mailto: links are skipped.
  if (resolved === null) return null;

  // Check that the resolved path stays within the repo (no traversal escape).
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
    return { link, reason: `target resolves outside repo: ${resolved}` };
  }

  // Check that the target file exists.
  if (!fs.existsSync(resolved)) {
    return { link, reason: `target not found: ${link.target} → ${resolved}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Orchestration & reporting
// ---------------------------------------------------------------------------

/**
 * Scans every `.md` file under `docsDir` (default: `<repo>/docs`) and returns
 * an aggregated report of internal link integrity.
 */
export function runCheckDocsLinks(
  docsDir: string = DOCS_DIR,
  repoRoot: string = REPO_ROOT,
): DocsLinkCheckResult {
  const mdFiles = fs.existsSync(docsDir) ? collectMarkdownFiles(docsDir) : [];
  const result: DocsLinkCheckResult = {
    filesChecked: mdFiles.length,
    totalLinks: 0,
    internalLinks: 0,
    externalLinks: 0,
    brokenLinks: [],
  };

  for (const filePath of mdFiles) {
    const links = extractLinks(filePath, repoRoot);
    result.totalLinks += links.length;

    for (const link of links) {
      if (isExternalUrl(link.target) || isMailto(link.target)) {
        result.externalLinks++;
        continue;
      }
      result.internalLinks++;

      const broken = checkLink(link, repoRoot);
      if (broken) result.brokenLinks.push(broken);
    }
  }

  return result;
}

/**
 * Formats a check result into a human-readable multi-line report.
 */
export function formatReport(result: DocsLinkCheckResult): string {
  const lines: string[] = [
    `Checked ${result.filesChecked} markdown file(s) under docs/: ` +
      `${result.totalLinks} link(s), ${result.internalLinks} internal, ${result.externalLinks} external.`,
  ];

  if (result.brokenLinks.length === 0) {
    lines.push("✓ All internal documentation links resolve.");
  } else {
    lines.push(`❌ Found ${result.brokenLinks.length} broken internal link(s):`);
    for (const { link, reason } of result.brokenLinks) {
      lines.push(`  ${link.sourceFile}:${link.line} → [${link.text}](${link.target}): ${reason}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  // Optional --docs <dir> override; defaults to <repo>/docs. When overridden,
  // the parent of the given directory is treated as the project root so
  // targets resolve relative to the tree being checked.
  const docsFlagIdx = args.indexOf("--docs");
  const docsDirArg = docsFlagIdx >= 0 ? args[docsFlagIdx + 1] : undefined;
  const result = runCheckDocsLinks(
    docsDirArg,
    docsDirArg ? path.dirname(path.resolve(docsDirArg)) : undefined,
  );
  const output = formatReport(result);

  if (result.brokenLinks.length === 0) {
    console.log(output);
    process.exit(0);
  } else {
    console.error(output);
    process.exit(1);
  }
}
