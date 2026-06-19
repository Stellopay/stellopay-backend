import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// getEscrowAbi / getAgreementAbi read abiPaths from config, so config is mocked
// to expose unset (null) paths. abi.ts reads no config, so its own tests below
// are unaffected by this mock.
vi.mock("../config.js", () => ({
  env: { STARKNET_RPC_URL: "https://rpc.test.invalid" },
  abiPaths: { escrow: null, agreement: null },
}));

import { loadAbiFromContractClassJsonPath } from "./abi";
import { getEscrowAbi, getAgreementAbi } from "./client";

const tmpFiles: string[] = [];

/** Writes content to a unique temp file and tracks it for cleanup. */
function writeTmp(content: string): string {
  const p = path.join(
    os.tmpdir(),
    `abi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(p, content, "utf-8");
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    try {
      fs.unlinkSync(tmpFiles.pop() as string);
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("loadAbiFromContractClassJsonPath", () => {
  it("loads the abi array from a valid contract class JSON", () => {
    const p = writeTmp(JSON.stringify({ abi: [{ type: "function", name: "foo" }], extra: 1 }));
    expect(loadAbiFromContractClassJsonPath(p)).toEqual([{ type: "function", name: "foo" }]);
  });

  it("throws for a missing file given an absolute path", () => {
    const missing = path.join(os.tmpdir(), "abi-test-missing-does-not-exist.json");
    expect(() => loadAbiFromContractClassJsonPath(missing)).toThrow();
  });

  it("resolves a relative path against the cwd and throws when it is missing", () => {
    expect(() => loadAbiFromContractClassJsonPath("does/not/exist.json")).toThrow();
  });

  it("throws for non-JSON content", () => {
    const p = writeTmp("definitely not json {");
    expect(() => loadAbiFromContractClassJsonPath(p)).toThrow();
  });

  it("throws a clear error when the JSON has no abi key", () => {
    const p = writeTmp(JSON.stringify({ notAbi: true }));
    expect(() => loadAbiFromContractClassJsonPath(p)).toThrow(/ABI not found/i);
  });

  it("throws a clear error when abi is present but is not an array", () => {
    const p = writeTmp(JSON.stringify({ abi: { not: "an array" } }));
    expect(() => loadAbiFromContractClassJsonPath(p)).toThrow(/ABI not found/i);
  });

  it("parses file contents as data only and never evaluates them", () => {
    // a code-like value must stay an inert string, never executed
    const p = writeTmp(JSON.stringify({ abi: [], payload: "process.exit(1)" }));
    expect(loadAbiFromContractClassJsonPath(p)).toEqual([]);
  });
});

describe("getEscrowAbi / getAgreementAbi when ABI paths are not configured", () => {
  it("getEscrowAbi throws the documented 'path is not configured' error", () => {
    expect(() => getEscrowAbi()).toThrow(/ESCROW_CONTRACT_CLASS_JSON path is not configured/);
  });

  it("getAgreementAbi throws the documented 'path is not configured' error", () => {
    expect(() => getAgreementAbi()).toThrow(/AGREEMENT_CONTRACT_CLASS_JSON path is not configured/);
  });
});
