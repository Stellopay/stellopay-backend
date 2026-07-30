import { describe, it, expect } from "vitest";
import {
  extractConfigEnvKeys,
  extractExampleEnvKeys,
  compareEnvKeys,
  formatSyncDiff,
  runCheckEnvSync,
} from "./check-env-sync.js";
import { EnvSchema } from "../src/config.js";

describe("check-env-sync", () => {
  describe("extractConfigEnvKeys", () => {
    it("extracts environment variable keys from z.object schema in AST", () => {
      const code = `
        import { z } from "zod";
        export const EnvSchema = z.object({
          VAR_ONE: z.string(),
          VAR_TWO: z.number().default(42),
          "VAR_THREE": z.boolean(),
        });
      `;
      const keys = extractConfigEnvKeys(code);
      expect(keys).toEqual(["VAR_ONE", "VAR_TWO", "VAR_THREE"]);
    });

    it("returns empty array if EnvSchema variable declaration is not present", () => {
      const code = `const OtherSchema = z.object({ FOO: z.string() });`;
      const keys = extractConfigEnvKeys(code);
      expect(keys).toEqual([]);
    });

    it("returns empty array if EnvSchema is initialized without an object literal argument", () => {
      const code = `const EnvSchema = z.object();`;
      const keys = extractConfigEnvKeys(code);
      expect(keys).toEqual([]);
    });
  });

  describe("extractExampleEnvKeys", () => {
    it("extracts key names from dotenv formatted content", () => {
      const content = `
        # Comment line
        PORT=4000
        # CORS_ORIGIN=*
        STARKNET_RPC_URL=https://rpc.test.invalid
        EMPTY_VAR=
      `;
      const keys = extractExampleEnvKeys(content);
      expect(keys).toEqual(["PORT", "STARKNET_RPC_URL", "EMPTY_VAR"]);
    });
  });

  describe("compareEnvKeys", () => {
    it("returns inSync: true when config keys and example keys match exactly", () => {
      const configKeys = ["PORT", "STARKNET_RPC_URL"];
      const exampleKeys = ["STARKNET_RPC_URL", "PORT"];
      const result = compareEnvKeys(configKeys, exampleKeys);

      expect(result.inSync).toBe(true);
      expect(result.missingInExample).toEqual([]);
      expect(result.extraInExample).toEqual([]);
    });

    it("fixture test: fails when a variable is added to config but missing from env.example", () => {
      const configKeys = ["PORT", "STARKNET_RPC_URL", "NEW_FEATURE_FLAG"];
      const exampleKeys = ["PORT", "STARKNET_RPC_URL"];
      const result = compareEnvKeys(configKeys, exampleKeys);

      expect(result.inSync).toBe(false);
      expect(result.missingInExample).toEqual(["NEW_FEATURE_FLAG"]);
      expect(result.extraInExample).toEqual([]);
    });

    it("fails when an extra variable is in env.example but not in src/config.ts", () => {
      const configKeys = ["PORT"];
      const exampleKeys = ["PORT", "OLD_LEGACY_VAR"];
      const result = compareEnvKeys(configKeys, exampleKeys);

      expect(result.inSync).toBe(false);
      expect(result.missingInExample).toEqual([]);
      expect(result.extraInExample).toEqual(["OLD_LEGACY_VAR"]);
    });

    it("fails and reports both missing and extra keys when both drift", () => {
      const configKeys = ["PORT", "NEW_VAR"];
      const exampleKeys = ["PORT", "OLD_VAR"];
      const result = compareEnvKeys(configKeys, exampleKeys);

      expect(result.inSync).toBe(false);
      expect(result.missingInExample).toEqual(["NEW_VAR"]);
      expect(result.extraInExample).toEqual(["OLD_VAR"]);
    });
  });

  describe("formatSyncDiff", () => {
    it("formats success message when inSync is true", () => {
      const result = {
        inSync: true,
        configKeys: ["PORT", "STARKNET_RPC_URL"],
        exampleKeys: ["PORT", "STARKNET_RPC_URL"],
        missingInExample: [],
        extraInExample: [],
      };
      const formatted = formatSyncDiff(result);
      expect(formatted).toContain("✓ env.example is in sync with src/config.ts");
      expect(formatted).toContain("2 variables checked");
    });

    it("formats error message with missing and extra keys when out of sync", () => {
      const result = {
        inSync: false,
        configKeys: ["PORT", "NEW_VAR"],
        exampleKeys: ["PORT", "OLD_VAR"],
        missingInExample: ["NEW_VAR"],
        extraInExample: ["OLD_VAR"],
      };
      const formatted = formatSyncDiff(result);
      expect(formatted).toContain("❌ Environment variable mismatch detected");
      expect(formatted).toContain("Missing from env.example (defined in src/config.ts):");
      expect(formatted).toContain("- NEW_VAR");
      expect(formatted).toContain("Extra in env.example (not defined in src/config.ts):");
      expect(formatted).toContain("- OLD_VAR");
    });
  });

  describe("repository verification (runCheckEnvSync)", () => {
    it("passes when the real src/config.ts and env.example are in sync", () => {
      const result = runCheckEnvSync();
      expect(
        result.inSync,
        `env.example is out of sync with src/config.ts:\n` +
          `  Missing in env.example: ${result.missingInExample.join(", ") || "none"}\n` +
          `  Extra in env.example:   ${result.extraInExample.join(", ") || "none"}`,
      ).toBe(true);
    });

    it("verifies AST extraction matches runtime Zod EnvSchema shape keys", () => {
      const schemaKeys = Object.keys(EnvSchema.shape);
      const result = runCheckEnvSync();
      expect(result.configKeys).toEqual(schemaKeys);
    });
  });
});
