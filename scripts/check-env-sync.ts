import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import * as ts from "typescript";

export interface SyncResult {
  inSync: boolean;
  configKeys: string[];
  exampleKeys: string[];
  missingInExample: string[];
  extraInExample: string[];
}

/**
 * Extracts environment variable key names defined in src/config.ts by parsing
 * the EnvSchema z.object(...) declaration AST.
 */
export function extractConfigEnvKeys(fileContent: string): string[] {
  const sourceFile = ts.createSourceFile("config.ts", fileContent, ts.ScriptTarget.Latest, true);
  const keys: string[] = [];

  /**
   * Finds the schema's object literal from a call expression initializer.
   *
   * Handles chained builders — e.g. `z.object({ ... }).superRefine(...)` or
   * `z.object({ ... }).refine(...).transform(...)` — by walking down the
   * member-expression chain when the call's own first argument is not the
   * object literal (for `.superRefine(fn)` the argument is a function).
   */
  function findSchemaObjectLiteral(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) {
      return undefined;
    }

    const firstArg = node.arguments[0];
    if (ts.isObjectLiteralExpression(firstArg)) {
      return firstArg;
    }

    // z.object({...}).superRefine(...) → recurse into `z.object({...})`.
    if (ts.isPropertyAccessExpression(node.expression)) {
      return findSchemaObjectLiteral(node.expression.expression);
    }

    return undefined;
  }

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "EnvSchema" &&
      node.initializer
    ) {
      const obj = findSchemaObjectLiteral(node.initializer);
      if (obj) {
        for (const prop of obj.properties) {
          if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
            if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
              keys.push(prop.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // The schema may declare a key more than once (a duplicate property in the
  // object literal). Zod keeps the last value but lists each key once, in
  // first-occurrence order — mirror that so key sets compare cleanly.
  return [...new Set(keys)];
}

/**
 * Extracts environment variable key names defined in env.example using dotenv.parse.
 */
export function extractExampleEnvKeys(fileContent: string): string[] {
  const parsed = dotenv.parse(fileContent);
  return Object.keys(parsed);
}

/**
 * Compares config keys against example keys and returns diff details.
 */
export function compareEnvKeys(configKeys: string[], exampleKeys: string[]): SyncResult {
  const missingInExample = configKeys.filter((key) => !exampleKeys.includes(key)).sort();
  const extraInExample = exampleKeys.filter((key) => !configKeys.includes(key)).sort();

  return {
    inSync: missingInExample.length === 0 && extraInExample.length === 0,
    configKeys,
    exampleKeys,
    missingInExample,
    extraInExample,
  };
}

/**
 * Formats diff results into a human-readable string.
 */
export function formatSyncDiff(result: SyncResult): string {
  if (result.inSync) {
    return `✓ env.example is in sync with src/config.ts (${result.configKeys.length} variables checked).`;
  }

  const lines: string[] = [
    "❌ Environment variable mismatch detected between src/config.ts and env.example:",
  ];

  if (result.missingInExample.length > 0) {
    lines.push("");
    lines.push("  Missing from env.example (defined in src/config.ts):");
    for (const key of result.missingInExample) {
      lines.push(`    - ${key}`);
    }
  }

  if (result.extraInExample.length > 0) {
    lines.push("");
    lines.push("  Extra in env.example (not defined in src/config.ts):");
    for (const key of result.extraInExample) {
      lines.push(`    - ${key}`);
    }
  }

  lines.push("");
  lines.push("Please update env.example or src/config.ts so they stay in sync.");

  return lines.join("\n");
}

/**
 * Reads config.ts and env.example relative to project root and runs the sync check.
 */
export function runCheckEnvSync(projectRoot = process.cwd()): SyncResult {
  const configPath = path.resolve(projectRoot, "src/config.ts");
  const examplePath = path.resolve(projectRoot, "env.example");

  const configContent = fs.readFileSync(configPath, "utf-8");
  const exampleContent = fs.readFileSync(examplePath, "utf-8");

  const configKeys = extractConfigEnvKeys(configContent);
  const exampleKeys = extractExampleEnvKeys(exampleContent);

  return compareEnvKeys(configKeys, exampleKeys);
}

// CLI entry point
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const result = runCheckEnvSync();
  const output = formatSyncDiff(result);
  if (result.inSync) {
    console.log(output);
    process.exit(0);
  } else {
    console.error(output);
    process.exit(1);
  }
}
