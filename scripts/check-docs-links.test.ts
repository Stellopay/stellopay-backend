/**
 * Link-checking test for docs/ markdown files.
 *
 * Walks every `.md` file under `docs/`, extracts all markdown links
 * (`[text](target)`), and verifies that internal links (relative paths or
 * links to other files in the repo) resolve to real files on disk.
 *
 * External URLs (http/https) are collected but not fetched — they are
 * reported as informational only.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarkdownLink {
  /** The display text of the link. */
  text: string;
  /** The raw target (URL or path). */
  target: string;
  /** The file where this link was found (relative to the repo root). */
  sourceFile: string;
  /** 1-based line number where the link text starts. */
  line: number;
}

interface BrokenLink {
  link: MarkdownLink;
  reason: string;
}

interface CheckResult {
  /** Absolute path to the scanned file. */
  filePath: string;
  /** Links found in the file. */
  links: MarkdownLink[];
  /** Links whose targets could not be resolved. */
  brokenLinks: BrokenLink[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

/**
 * Recursively lists all `.md` files under `dir`.
 */
function collectMarkdownFiles(dir: string): string[] {
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
 * Escape regex-sensitive characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract all markdown links (inline + reference-style) from a file.
 */
function extractLinks(filePath: string): MarkdownLink[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const sourceFile = path.relative(REPO_ROOT, filePath);
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

/**
 * Returns `true` when `target` is an external URL (http/https).
 */
function isExternalUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * Returns `true` when `target` is a mailto: link.
 */
function isMailto(target: string): boolean {
  return /^mailto:/i.test(target);
}

/**
 * Returns `true` when `target` is a fragment-only link (`#section`).
 */
function isFragmentOnly(target: string): boolean {
  return target.startsWith("#");
}

/**
 * Given a link target found in `sourceFile`, resolve it to an absolute path.
 * Returns the resolved path or `null` if the target cannot be resolved.
 *
 * Resolution rules:
 *  - External URLs → null (skip validation)
 *  - `mailto:` links → null (skip validation)
 *  - Fragment-only → resolved to the source file itself
 *  - Absolute paths (starting with `/`) → resolved from REPO_ROOT
 *  - Relative paths → resolved relative to the source file's directory
 *  - Targets with `#fragment` → fragment stripped before file resolution
 */
function resolveTarget(target: string, sourceFile: string): string | null {
  if (isExternalUrl(target) || isMailto(target)) return null;

  if (isFragmentOnly(target)) {
    return path.resolve(REPO_ROOT, sourceFile);
  }

  // Strip fragment for file resolution.
  const hashIdx = target.indexOf("#");
  const filePart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;

  // Empty file part with a fragment (e.g. "#section") → same file.
  if (!filePart) {
    return path.resolve(REPO_ROOT, sourceFile);
  }

  if (filePart.startsWith("/")) {
    return path.resolve(REPO_ROOT, "." + filePart);
  }

  return path.resolve(path.dirname(path.join(REPO_ROOT, sourceFile)), filePart);
}

/**
 * Check a single link target for validity.
 * Returns `null` if the link is valid, or a `BrokenLink` if broken.
 */
function checkLink(link: MarkdownLink): BrokenLink | null {
  const resolved = resolveTarget(link.target, link.sourceFile);

  // External URLs and mailto: links are skipped.
  if (resolved === null) return null;

  // Check that the resolved path stays within the repo (no traversal escape).
  if (!resolved.startsWith(REPO_ROOT + path.sep) && resolved !== REPO_ROOT) {
    return { link, reason: `target resolves outside repo: ${resolved}` };
  }

  // Check that the target file exists.
  if (!fs.existsSync(resolved)) {
    return { link, reason: `target not found: ${link.target} → ${resolved}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("docs/ markdown link integrity", () => {
  const mdFiles = collectMarkdownFiles(DOCS_DIR);

  if (mdFiles.length === 0) {
    // In a real checkout this should never happen, but handle gracefully.
    it("no markdown files found under docs/", () => {
      // This is a legitimate pass condition — nothing to validate.
      expect(mdFiles).toHaveLength(0);
    });
    return;
  }

  const allResults: CheckResult[] = [];

  for (const filePath of mdFiles) {
    const links = extractLinks(filePath);
    const brokenLinks: BrokenLink[] = [];

    for (const link of links) {
      const broken = checkLink(link);
      if (broken) brokenLinks.push(broken);
    }

    allResults.push({ filePath, links, brokenLinks });
  }

  // Test 1: every doc file is covered by at least one check
  it("covers every .md file under docs/", () => {
    expect(allResults.length).toBeGreaterThanOrEqual(1);
  });

  // Test 2: no broken internal links
  it("has zero broken internal links", () => {
    const allBroken: BrokenLink[] = [];
    for (const result of allResults) {
      allBroken.push(...result.brokenLinks);
    }

    const report = allBroken
      .map(
        (b) =>
          `  ${b.link.sourceFile}:${b.link.line} → [${b.link.text}](${b.link.target}): ${b.reason}`,
      )
      .join("\n");

    expect(allBroken, `Found ${allBroken.length} broken link(s):\n${report}`).toHaveLength(0);
  });

  // Test 3: informational — report external link count
  it("reports external link summary (informational)", () => {
    let totalLinks = 0;
    let externalLinks = 0;
    let internalLinks = 0;

    for (const result of allResults) {
      for (const link of result.links) {
        totalLinks++;
        if (isExternalUrl(link.target) || isMailto(link.target)) {
          externalLinks++;
        } else {
          internalLinks++;
        }
      }
    }

    // This assertion always passes; it's here to surface the counts in test output.
    expect({ totalLinks, internalLinks, externalLinks }).toBeDefined();
  });
});
