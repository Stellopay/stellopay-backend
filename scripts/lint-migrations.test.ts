import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as url from "node:url";
import { lintMigrations, getMigrationsDir, isMainModule } from "./lint-migrations";

vi.mock("node:fs");

describe("lintMigrations script", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getMigrationsDir", () => {
    it("should return parsed out directory from drizzle.config.ts if exists", () => {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        if (p.toString().includes("drizzle.config.ts")) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        return `export default { out: "./custom/dir" };`;
      });

      const dir = getMigrationsDir();
      expect(dir.replace(/\\/g, "/")).toMatch(/\/custom\/dir$/);
    });

    it("should fallback to src/db/migrations if drizzle.config.ts does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const dir = getMigrationsDir();
      expect(dir.replace(/\\/g, "/")).toMatch(/\/src\/db\/migrations$/);
    });

    it("should fallback to src/db/migrations if regex fails", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("export default {};");
      const dir = getMigrationsDir();
      expect(dir.replace(/\\/g, "/")).toMatch(/\/src\/db\/migrations$/);
    });
  });

  describe("lintMigrations", () => {
    it("should return false if directory does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = lintMigrations("dummy");
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Migrations directory not found"));
    });

    it("should return true for valid timestamp prefixed files", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101120000_init.sql",
        "1715260500123_alter.sql"
      ] as unknown as fs.Dirent[]);
      
      const result = lintMigrations("dummy");
      expect(result).toBe(true);
    });

    it("should return false for files that match neither scheme", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101120000_init.sql",
        "0000_bad.sql",
        "123_too_short.sql"
      ] as unknown as fs.Dirent[]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const result = lintMigrations("dummy");
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("does not match any recognized convention"));
    });

    it("should detect duplicate timestamp prefixes", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101000000_init.sql",
        "20240101000000_second.sql",
      ] as unknown as fs.Dirent[]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const result = lintMigrations("dummy");
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Duplicate migration prefix"),
      );
    });

    it("should detect duplicate sequence prefixes", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Both files are unregistered (no journal mock), so both are flagged
      // as unregistered sequence files. The duplicate check still runs.
      vi.mocked(fs.readdirSync).mockReturnValue([
        "0003_first.sql",
        "0003_second.sql",
      ] as unknown as fs.Dirent[]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const result = lintMigrations("dummy");
      expect(result).toBe(false);
      // Should report both unregistered AND duplicate
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Duplicate migration prefix"),
      );
    });

    it("should detect mixed naming schemes with unregistered files", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101120000_init.sql",
        "0003_unregistered.sql",
      ] as unknown as fs.Dirent[]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const result = lintMigrations("dummy");
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("uses sequence prefix but is not registered"),
      );
    });

    it("should grandfather registered journal entries with sequence prefix", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101120000_init.sql",
        "0003_registered.sql",
      ] as unknown as fs.Dirent[]);
      // Mock the journal read: first call is for drizzle.config.ts check, second for journal
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = p.toString();
        if (pathStr.includes("_journal.json")) {
          return JSON.stringify({
            entries: [
              { idx: 0, when: 100, tag: "0003_registered" },
            ],
          });
        }
        return "";
      });
      
      const result = lintMigrations("dummy");
      expect(result).toBe(true);
    });

    it("should allow both sequence and timestamp files when all sequence files are registered", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101120000_init.sql",
        "20240102120000_add_sessions.sql",
        "0003_fk_constraints.sql",
        "0004_backfill.sql",
      ] as unknown as fs.Dirent[]);
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = p.toString();
        if (pathStr.includes("_journal.json")) {
          return JSON.stringify({
            entries: [
              { idx: 0, when: 100, tag: "0003_fk_constraints" },
              { idx: 1, when: 200, tag: "0004_backfill" },
            ],
          });
        }
        return "";
      });
      
      const result = lintMigrations("dummy");
      expect(result).toBe(true);
    });

    it("should accept all-sequence files when no timestamp files exist (no mixed scheme)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "0003_first.sql",
        "0004_second.sql",
      ] as unknown as fs.Dirent[]);
      
      const result = lintMigrations("dummy");
      // All-sequence is one consistent scheme, so no mixed-scheme error
      expect(result).toBe(true);
    });

    it("should accept all-timestamp files with unique prefixes", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101000000_init.sql",
        "20240102000000_add_sessions.sql",
        "20240103000000_add_constraints.sql",
      ] as unknown as fs.Dirent[]);
      
      const result = lintMigrations("dummy");
      expect(result).toBe(true);
    });
  });

  describe("isMainModule", () => {
    it("should correctly identify main module", () => {
      const mockPath = "/a/b/c.ts";
      const moduleUrl = url.pathToFileURL(path.resolve(mockPath)).href;
      expect(isMainModule(mockPath, moduleUrl)).toBe(true);
      expect(isMainModule("/another/path.ts", moduleUrl)).toBe(false);
      expect(isMainModule(undefined, moduleUrl)).toBe(false);
    });
  });
});
