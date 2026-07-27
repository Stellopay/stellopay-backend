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

    it("should return false for invalid timestamp prefixed files", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "20240101120000_init.sql",
        "0000_bad.sql",
        "123_too_short.sql"
      ] as unknown as fs.Dirent[]);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      const result = lintMigrations("dummy");
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("does not follow the timestamp-prefixed convention"));
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
