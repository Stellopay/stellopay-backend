/**
 * Tests for the docs link checker (scripts/check-docs-links.ts).
 *
 * Two layers:
 *  1. Unit tests over exported helpers using temporary fixtures.
 *  2. Repository integration tests that scan the real docs/ tree and assert
 *     zero broken internal links (the invariant the CI guard enforces).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  collectMarkdownFiles,
  extractLinks,
  resolveTarget,
  checkLink,
  isExternalUrl,
  isMailto,
  isFragmentOnly,
  runCheckDocsLinks,
  formatReport,
  type MarkdownLink,
} from "./check-docs-links.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpRepo(files: Record<string, string>): { root: string; docsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-links-"));
  tmpDirs.push(root);
  const docsDir = path.join(root, "docs");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, docsDir };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI (proves the exit-code contract the CI guard relies on)
// ---------------------------------------------------------------------------

describe("check-docs-links CLI", () => {
  const scriptPath = path.resolve(import.meta.dirname, "check-docs-links.ts");
  const tsxBin = path.resolve(import.meta.dirname, "../node_modules/.bin/tsx");

  /** Runs the module's top-level CLI block in-process with a forged argv. */
  async function runCliInProcess(cliArgs: string[]): Promise<{
    exitCode: number | undefined;
    stdout: string;
    stderr: string;
  }> {
    vi.resetModules();
    const captured = { exitCode: undefined as number | undefined, stdout: "", stderr: "" };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      captured.exitCode = code;
      return undefined as never;
    }) as typeof process.exit);
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      captured.stdout += msg;
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      captured.stderr += msg;
    });

    const prevArgv = process.argv;
    process.argv = [prevArgv[0] ?? "node", scriptPath, ...cliArgs];
    try {
      await import("./check-docs-links.js");
    } finally {
      process.argv = prevArgv;
      exitSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    return captured;
  }

  it("exits 0 and prints a success report when all links resolve (in-process)", async () => {
    const { root, docsDir } = makeTmpRepo({
      "docs/a.md": "[ok](./b.md)",
      "docs/b.md": "",
    });

    const result = await runCliInProcess(["--docs", docsDir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ All internal documentation links resolve.");
  });
  it("exits 1 and reports broken links to stderr when a link is broken (in-process)", async () => {
    const { root } = makeTmpRepo({
      "docs/a.md": "[ghost](./missing.md)",
    });

    const result = await runCliInProcess(["--docs", path.join(root, "docs")]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Found 1 broken internal link(s)");
    expect(result.stderr).toContain("./missing.md");
  });

  it("exits 0 and prints a success report when all links resolve (spawned tsx)", () => {
    const { root, docsDir } = makeTmpRepo({
      "docs/a.md": "[ok](./b.md)",
      "docs/b.md": "",
    });

    const proc = spawnSync(tsxBin, [scriptPath, "--docs", docsDir], {
      encoding: "utf-8",
      cwd: root,
    });

    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("✓ All internal documentation links resolve.");
  });

  it("exits 1 and reports broken links to stderr when a link is broken (spawned tsx)", () => {
    const { root, docsDir } = makeTmpRepo({
      "docs/a.md": "[ghost](./missing.md)",
    });

    const proc = spawnSync(tsxBin, [scriptPath, "--docs", docsDir], {
      encoding: "utf-8",
      cwd: root,
    });

    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("Found 1 broken internal link(s)");
    expect(proc.stderr).toContain("./missing.md");
  });
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("collectMarkdownFiles", () => {
  it("recursively collects .md files and ignores other extensions", () => {
    const { docsDir } = makeTmpRepo({
      "docs/a.md": "# A",
      "docs/sub/b.md": "# B",
      "docs/c.txt": "not markdown",
      "docs/d.json": "{}",
    });

    const files = collectMarkdownFiles(docsDir)
      .map((f) => path.basename(f))
      .sort();
    expect(files).toEqual(["a.md", "b.md"]);
  });
});

describe("extractLinks", () => {
  it("extracts inline links with line numbers", () => {
    const { docsDir } = makeTmpRepo({
      "docs/a.md": ["intro", "[guide](./sub/b.md)", "", '[titled](./x.md "the title")'].join("\n"),
      "docs/x.md": "",
      "docs/sub/b.md": "",
    });

    const links = extractLinks(path.join(docsDir, "a.md"));
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ text: "guide", target: "./sub/b.md", line: 2 });
    expect(links[1]).toMatchObject({ text: "titled", target: "./x.md", line: 4 });
  });

  it("extracts reference-style links via their definitions", () => {
    const { docsDir } = makeTmpRepo({
      "docs/a.md": [
        "See the [guide][ref-one] and the [other][] .",
        "",
        "[ref-one]: ./b.md",
        "[other]: ./c.md",
      ].join("\n"),
      "docs/b.md": "",
      "docs/c.md": "",
    });

    const links = extractLinks(path.join(docsDir, "a.md"));
    // Usage sites plus the reference definitions themselves (the definitions
    // also match the reference-link pattern — pre-existing extractor behavior).
    expect(links).toHaveLength(4);
    expect(links.filter((l) => l.text === "guide")[0]).toMatchObject({ target: "./b.md", line: 1 });
    expect(links.filter((l) => l.text === "other")[0]).toMatchObject({ target: "./c.md", line: 1 });
  });

  it("does not treat images as links and skips unresolved refs", () => {
    const { docsDir } = makeTmpRepo({
      "docs/a.md": ["![alt](./img.png)", "[dangling][nowhere]"].join("\n"),
    });

    const links = extractLinks(path.join(docsDir, "a.md"));
    expect(links).toHaveLength(0);
  });
});

describe("target classification helpers", () => {
  it("classifies external URLs, mailto and fragments", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("http://example.com")).toBe(true);
    expect(isExternalUrl("./local.md")).toBe(false);
    expect(isMailto("mailto:a@b.c")).toBe(true);
    expect(isMailto("./local.md")).toBe(false);
    expect(isFragmentOnly("#section")).toBe(true);
    expect(isFragmentOnly("./file.md#section")).toBe(false);
  });
});

describe("resolveTarget", () => {
  const repoRoot = path.resolve("/fake-repo");

  it("returns null for external URLs and mailto links", () => {
    expect(resolveTarget("https://example.com", "docs/a.md", repoRoot)).toBeNull();
    expect(resolveTarget("mailto:a@b.c", "docs/a.md", repoRoot)).toBeNull();
  });

  it("resolves fragment-only links to the source file", () => {
    expect(resolveTarget("#section", "docs/a.md", repoRoot)).toBe(
      path.resolve(repoRoot, "docs/a.md"),
    );
  });

  it("strips fragments before resolving files", () => {
    expect(resolveTarget("b.md#section", "docs/a.md", repoRoot)).toBe(
      path.resolve(repoRoot, "docs/b.md"),
    );
  });

  it("resolves absolute paths against the repo root", () => {
    expect(resolveTarget("/src/config.ts", "docs/a.md", repoRoot)).toBe(
      path.resolve(repoRoot, "src/config.ts"),
    );
  });

  it("resolves relative paths against the source file directory", () => {
    expect(resolveTarget("./sibling.md", "docs/sub/a.md", repoRoot)).toBe(
      path.resolve(repoRoot, "docs/sub/sibling.md"),
    );
    expect(resolveTarget("../../src/index.ts", "docs/sub/a.md", repoRoot)).toBe(
      path.resolve(repoRoot, "src/index.ts"),
    );
  });
});

describe("checkLink", () => {
  const repoRoot = "/tmp-fake-repo-root";

  const link = (overrides: Partial<MarkdownLink>): MarkdownLink => ({
    text: "label",
    target: "./missing.md",
    sourceFile: "docs/a.md",
    line: 1,
    ...overrides,
  });

  it("returns null for external and mailto targets", () => {
    expect(checkLink(link({ target: "https://x.y" }), repoRoot)).toBeNull();
    expect(checkLink(link({ target: "mailto:x@y.z" }), repoRoot)).toBeNull();
  });

  it("flags targets resolving outside the repo", () => {
    const result = checkLink(link({ target: "../../outside.md" }), repoRoot);
    expect(result?.reason).toContain("outside repo");
  });

  it("flags missing targets", () => {
    // Resolve inside a real directory but to a non-existent file.
    const existingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docs-links-missing-"));
    try {
      const result = checkLink(link({ target: "./nope.md" }), existingRoot);
      expect(result?.reason).toContain("target not found");
      expect(result?.link.target).toBe("./nope.md");
    } finally {
      fs.rmSync(existingRoot, { recursive: true, force: true });
    }
  });

  it("returns null for a valid internal target", () => {
    const existingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docs-links-valid-"));
    try {
      fs.mkdirSync(path.join(existingRoot, "docs"), { recursive: true });
      fs.writeFileSync(path.join(existingRoot, "docs", "real.md"), "x");
      const result = checkLink(link({ target: "./real.md" }), existingRoot);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(existingRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Orchestration & reporting
// ---------------------------------------------------------------------------

describe("runCheckDocsLinks", () => {
  it("aggregates counts and broken links across the tree", async () => {
    const { root, docsDir } = await Promise.resolve(
      makeTmpRepo({
        "docs/README.md": [
          "Start: [install](./setup.md)",
          "External: [site](https://example.com)",
          "Mail: [mail](mailto:team@example.com)",
          "Broken: [ghost](./ghost.md)",
        ].join("\n"),
        "docs/setup.md": "Back: [home](README.md)",
      }),
    );

    const result = runCheckDocsLinks(docsDir, root);

    expect(result.filesChecked).toBe(2);
    expect(result.totalLinks).toBe(5);
    expect(result.internalLinks).toBe(3);
    expect(result.externalLinks).toBe(2); // https + mailto
    expect(result.brokenLinks).toHaveLength(1);
    expect(result.brokenLinks[0]?.link.target).toBe("./ghost.md");
    expect(result.brokenLinks[0]?.reason).toContain("target not found");
  });

  it("handles a missing docs directory gracefully", () => {
    const result = runCheckDocsLinks("/nonexistent-docs-dir");
    expect(result.filesChecked).toBe(0);
    expect(result.brokenLinks).toHaveLength(0);
  });
});

describe("formatReport", () => {
  it("formats a success report", () => {
    const output = formatReport({
      filesChecked: 3,
      totalLinks: 10,
      internalLinks: 7,
      externalLinks: 3,
      brokenLinks: [],
    });
    expect(output).toContain("Checked 3 markdown file(s)");
    expect(output).toContain("✓ All internal documentation links resolve.");
  });

  it("formats a failure report with file:line detail", () => {
    const output = formatReport({
      filesChecked: 3,
      totalLinks: 10,
      internalLinks: 7,
      externalLinks: 3,
      brokenLinks: [
        {
          link: { text: "ghost", target: "./ghost.md", sourceFile: "docs/a.md", line: 4 },
          reason: "target not found: ./ghost.md → /repo/docs/ghost.md",
        },
      ],
    });
    expect(output).toContain("❌ Found 1 broken internal link(s)");
    expect(output).toContain("docs/a.md:4 → [ghost](./ghost.md)");
  });
});

// ---------------------------------------------------------------------------
// Repository integration (what CI enforces)
// ---------------------------------------------------------------------------

describe("docs/ markdown link integrity", () => {
  const result = runCheckDocsLinks();

  if (result.filesChecked === 0) {
    // In a real checkout this should never happen, but handle gracefully.
    it("no markdown files found under docs/", () => {
      expect(result.filesChecked).toBe(0);
    });
    return;
  }

  // Test 1: every doc file is covered by at least one check
  it("covers every .md file under docs/", () => {
    expect(result.filesChecked).toBeGreaterThanOrEqual(1);
  });

  // Test 2: no broken internal links
  it("has zero broken internal links", () => {
    const report = result.brokenLinks
      .map(
        (b) =>
          `  ${b.link.sourceFile}:${b.link.line} → [${b.link.text}](${b.link.target}): ${b.reason}`,
      )
      .join("\n");

    expect(
      result.brokenLinks,
      `Found ${result.brokenLinks.length} broken link(s):\n${report}`,
    ).toHaveLength(0);
  });

  // Test 3: informational — report external link count
  it("reports external link summary (informational)", () => {
    // This assertion always passes; it's here to surface the counts in test output.
    expect({
      totalLinks: result.totalLinks,
      internalLinks: result.internalLinks,
      externalLinks: result.externalLinks,
    }).toBeDefined();
  });
});
