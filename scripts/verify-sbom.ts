import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Expected shape of the package root (metadata.component) in a CycloneDX SBOM
 * generated from this repository.
 */
export interface SbomComponent {
  name: string;
  type: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * Minimal shape of a CycloneDX SBOM document. Only the fields needed for
 * validation are typed; the real document carries far more detail.
 */
export interface CycloneDxSbom {
  bomFormat: string;
  specVersion: string;
  metadata?: {
    component?: SbomComponent;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SbomVerifyResult {
  valid: boolean;
  errors: string[];
  componentName?: string;
  componentVersion?: string;
  specVersion?: string;
}

/**
 * Validates that a parsed CycloneDX SBOM object is well-formed and includes
 * the expected root package metadata.
 */
export function validateSbom(
  sbom: CycloneDxSbom,
  expectedName: string,
): SbomVerifyResult {
  const errors: string[] = [];

  // bomFormat must be "CycloneDX"
  if (!sbom.bomFormat || sbom.bomFormat !== "CycloneDX") {
    errors.push(
      `Invalid or missing bomFormat: expected "CycloneDX", got ${JSON.stringify(sbom.bomFormat)}`,
    );
  }

  // specVersion must be present (semver string)
  if (!sbom.specVersion || typeof sbom.specVersion !== "string") {
    errors.push(
      `Missing or invalid specVersion: ${JSON.stringify(sbom.specVersion)}`,
    );
  }

  // metadata.component must exist
  if (!sbom.metadata?.component) {
    errors.push("Missing metadata.component in SBOM");
  } else {
    const component = sbom.metadata.component;

    // Root component name must match the expected package name
    if (!component.name || component.name !== expectedName) {
      errors.push(
        `metadata.component.name mismatch: expected "${expectedName}", got ${JSON.stringify(component.name)}`,
      );
    }

    // Root component type should be "application" or "library"
    if (component.type && !["application", "library"].includes(component.type)) {
      errors.push(
        `Unexpected metadata.component.type: ${JSON.stringify(component.type)}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    componentName: sbom.metadata?.component?.name,
    componentVersion: sbom.metadata?.component?.version,
    specVersion: sbom.specVersion,
  };
}

/**
 * Reads a file, parses it as JSON, and validates it as a CycloneDX SBOM.
 * Returns a structured result rather than exiting so it is testable.
 */
export function verifySbomFile(
  filePath: string,
  expectedName: string,
): SbomVerifyResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      valid: false,
      errors: [
        `Failed to read SBOM file: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [
        `SBOM file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      errors: ["SBOM root is not a JSON object"],
    };
  }

  return validateSbom(parsed as CycloneDxSbom, expectedName);
}

/**
 * Formats a verify result into a human-readable string suitable for stdout.
 */
export function formatVerifyResult(result: SbomVerifyResult): string {
  if (result.valid) {
    const lines = ["✓ SBOM is valid CycloneDX JSON."];
    if (result.componentName) {
      lines.push(`  Root package: ${result.componentName}${result.componentVersion ? `@${result.componentVersion}` : ""}`);
    }
    if (result.specVersion) {
      lines.push(`  CycloneDX spec: ${result.specVersion}`);
    }
    return lines.join("\n");
  }

  const lines = ["❌ SBOM validation failed:"];
  for (const err of result.errors) {
    lines.push(`  - ${err}`);
  }
  return lines.join("\n");
}

// CLI entry point
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const expectedName = args[1] ?? "stellopay-backend";

  if (!filePath) {
    console.error("Usage: tsx scripts/verify-sbom.ts <path-to-bom.json> [expected-package-name]");
    process.exit(1);
  }

  const result = verifySbomFile(filePath, expectedName);
  const output = formatVerifyResult(result);
  if (result.valid) {
    console.log(output);
    process.exit(0);
  } else {
    console.error(output);
    process.exit(1);
  }
}
