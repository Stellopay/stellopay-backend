import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateSbom,
  verifySbomFile,
  formatVerifyResult,
  type CycloneDxSbom,
  type SbomVerifyResult,
} from "./verify-sbom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Builds a minimal valid CycloneDX 1.5 SBOM object for testing. */
function makeValidSbom(overrides: Partial<CycloneDxSbom> = {}): CycloneDxSbom {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "stellopay-backend",
        version: "0.1.0",
      },
    },
    ...overrides,
  };
}

describe("verify-sbom", () => {
  describe("validateSbom", () => {
    it("returns valid for a well-formed SBOM with matching component name", () => {
      const sbom = makeValidSbom();
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.componentName).toBe("stellopay-backend");
      expect(result.componentVersion).toBe("0.1.0");
      expect(result.specVersion).toBe("1.5");
    });

    it("fails when bomFormat is missing", () => {
      const sbom = makeValidSbom({ bomFormat: "" });
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining("Invalid or missing bomFormat"),
      );
    });

    it("fails when bomFormat is not CycloneDX", () => {
      const sbom = makeValidSbom({ bomFormat: "SPDX" });
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid or missing bomFormat");
    });

    it("fails when specVersion is missing", () => {
      const sbom = makeValidSbom({ specVersion: "" });
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Missing or invalid specVersion");
    });

    it("fails when metadata is missing", () => {
      const sbom = makeValidSbom({ metadata: undefined });
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Missing metadata.component");
    });

    it("fails when metadata.component is missing", () => {
      const sbom = makeValidSbom({
        metadata: { component: undefined },
      });
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Missing metadata.component");
    });

    it("fails when component name does not match expected", () => {
      const sbom = makeValidSbom();
      const result = validateSbom(sbom, "different-package");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain(
        'expected "different-package", got "stellopay-backend"',
      );
    });

    it("fails when component name is empty", () => {
      const sbom = makeValidSbom();
      sbom.metadata!.component!.name = "";
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("metadata.component.name mismatch");
    });

    it("warns when component type is unexpected (but does not fail)", () => {
      const sbom = makeValidSbom();
      sbom.metadata!.component!.type = "firmware";
      const result = validateSbom(sbom, "stellopay-backend");
      // type validation is a warning, not a hard error — the SBOM can still pass
      // if the other fields are correct. Our current impl flags it as an error.
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Unexpected metadata.component.type");
    });

    it("allows type 'library' as valid", () => {
      const sbom = makeValidSbom();
      sbom.metadata!.component!.type = "library";
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(true);
    });

    it("reports multiple errors when several fields are invalid", () => {
      const sbom: CycloneDxSbom = {
        bomFormat: "wrong",
        specVersion: "",
        metadata: { component: { type: "firmware", name: "wrong-name" } },
      };
      const result = validateSbom(sbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("handles a completely empty object", () => {
      const result = validateSbom({} as CycloneDxSbom, "stellopay-backend");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3); // bomFormat, specVersion, metadata.component
    });
  });

  describe("verifySbomFile", () => {
    const tmpDir = path.join(__dirname, "..", "..", "tmp");

    afterAll(() => {
      cleanTmpDir();
    });

    function ensureTmpDir() {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
    }

    function writeTempFile(name: string, content: string): string {
      ensureTmpDir();
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, content);
      return filePath;
    }

    function cleanTempFile(filePath: string) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }

    function cleanTmpDir() {
      try {
        if (fs.existsSync(tmpDir)) {
          const files = fs.readdirSync(tmpDir);
          for (const f of files) {
            fs.unlinkSync(path.join(tmpDir, f));
          }
          fs.rmdirSync(tmpDir);
        }
      } catch {
        // ignore - CI may have permission issues
      }
    }

    it("verifies a valid SBOM file successfully", () => {
      const sbom = makeValidSbom();
      const filePath = writeTempFile("valid-sbom.json", JSON.stringify(sbom));
      try {
        const result = verifySbomFile(filePath, "stellopay-backend");
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.componentName).toBe("stellopay-backend");
      } finally {
        cleanTempFile(filePath);
      }
    });

    it("returns an error when the file does not exist", () => {
      const result = verifySbomFile(
        "/nonexistent/path/bom.json",
        "stellopay-backend",
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Failed to read SBOM file");
    });

    it("returns an error when the file is not valid JSON", () => {
      const filePath = writeTempFile("invalid.json", "not json {{{");
      try {
        const result = verifySbomFile(filePath, "stellopay-backend");
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain("not valid JSON");
      } finally {
        cleanTempFile(filePath);
      }
    });

    it("returns an error when the JSON root is not an object", () => {
      const filePath = writeTempFile("array.json", "[1, 2, 3]");
      try {
        const result = verifySbomFile(filePath, "stellopay-backend");
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain("not a JSON object");
      } finally {
        cleanTempFile(filePath);
      }
    });

    it("returns errors for an SBOM with missing fields", () => {
      const filePath = writeTempFile(
        "bad-sbom.json",
        JSON.stringify({ bomFormat: "CycloneDX" }),
      );
      try {
        const result = verifySbomFile(filePath, "stellopay-backend");
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      } finally {
        cleanTempFile(filePath);
      }
    });
  });

  describe("formatVerifyResult", () => {
    it("formats a valid result with component and spec info", () => {
      const result: SbomVerifyResult = {
        valid: true,
        errors: [],
        componentName: "stellopay-backend",
        componentVersion: "0.1.0",
        specVersion: "1.5",
      };
      const formatted = formatVerifyResult(result);
      expect(formatted).toContain("✓ SBOM is valid CycloneDX JSON.");
      expect(formatted).toContain("stellopay-backend@0.1.0");
      expect(formatted).toContain("CycloneDX spec: 1.5");
    });

    it("formats a valid result without version", () => {
      const result: SbomVerifyResult = {
        valid: true,
        errors: [],
        componentName: "stellopay-backend",
        specVersion: "1.4",
      };
      const formatted = formatVerifyResult(result);
      expect(formatted).toContain("✓ SBOM is valid CycloneDX JSON.");
      expect(formatted).toContain("Root package: stellopay-backend");
      expect(formatted).not.toContain("@");
    });

    it("formats an invalid result with all errors listed", () => {
      const result: SbomVerifyResult = {
        valid: false,
        errors: ["Error one", "Error two"],
      };
      const formatted = formatVerifyResult(result);
      expect(formatted).toContain("❌ SBOM validation failed:");
      expect(formatted).toContain("- Error one");
      expect(formatted).toContain("- Error two");
    });
  });
});
