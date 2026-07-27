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
  starknetRpcUrls: ["https://rpc.test.invalid"],
  defaults: {
    payrollEscrowAddress: "0x0",
    workAgreementAddress: "0x0",
  },
}));

import {
  loadAbiFromContractClassJsonPath,
  fingerprintAbi,
  extractOnChainAbi,
  verifyAbiCompatibility,
  type AbiVerificationProvider,
} from "./abi";
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

describe("fingerprintAbi", () => {
  it("produces a 64-character hex SHA-256 digest", () => {
    const abi = [{ type: "function", name: "foo" }];
    const fingerprint = fingerprintAbi(abi);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces identical fingerprints for the same ABI", () => {
    const abi = [
      { type: "function", name: "transfer", inputs: [{ name: "to", type: "felt" }] },
    ];
    expect(fingerprintAbi(abi)).toBe(fingerprintAbi(abi));
  });

  it("produces identical fingerprints regardless of object key order", () => {
    const abi1 = [{ name: "foo", type: "function", inputs: [] }];
    const abi2 = [{ type: "function", inputs: [], name: "foo" }];
    expect(fingerprintAbi(abi1)).toBe(fingerprintAbi(abi2));
  });

  it("produces different fingerprints for different ABIs", () => {
    const abi1 = [{ type: "function", name: "foo" }];
    const abi2 = [{ type: "function", name: "bar" }];
    expect(fingerprintAbi(abi1)).not.toBe(fingerprintAbi(abi2));
  });

  it("handles empty ABIs without error", () => {
    expect(fingerprintAbi([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles nested structures and arrays", () => {
    const abi = [
      {
        type: "struct",
        name: "Point",
        members: [
          { name: "x", type: "felt" },
          { name: "y", type: "felt" },
        ],
      },
    ];
    expect(fingerprintAbi(abi)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractOnChainAbi", () => {
  it("extracts ABI from a Sierra contract class (JSON string format)", () => {
    const abiArray = [{ type: "function", name: "foo" }];
    const contractClass = { abi: JSON.stringify(abiArray), contract_class_version: "0.1.0" };
    expect(extractOnChainAbi(contractClass)).toEqual(abiArray);
  });

  it("extracts ABI from a legacy contract class (array format)", () => {
    const abiArray = [{ type: "function", name: "bar" }];
    const contractClass = { abi: abiArray };
    expect(extractOnChainAbi(contractClass)).toEqual(abiArray);
  });

  it("throws when abi field is missing", () => {
    const contractClass = { contract_class_version: "0.1.0" };
    expect(() => extractOnChainAbi(contractClass)).toThrow(/no 'abi' field/i);
  });

  it("throws when abi field is null", () => {
    const contractClass = { abi: null };
    expect(() => extractOnChainAbi(contractClass)).toThrow(/no 'abi' field/i);
  });

  it("throws when abi string is malformed JSON", () => {
    const contractClass = { abi: "{ this is not valid json" };
    expect(() => extractOnChainAbi(contractClass)).toThrow(/Failed to parse on-chain ABI JSON/i);
  });

  it("throws when abi string parses to a non-array", () => {
    const contractClass = { abi: JSON.stringify({ not: "an array" }) };
    expect(() => extractOnChainAbi(contractClass)).toThrow(/not an array/i);
  });

  it("throws when abi field is an unexpected type", () => {
    const contractClass = { abi: 42 };
    expect(() => extractOnChainAbi(contractClass)).toThrow(/Unexpected on-chain ABI type/i);
  });
});

describe("verifyAbiCompatibility", () => {
  const TEST_ADDRESS = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
  const sampleAbi = [
    { type: "function", name: "transfer", inputs: [{ name: "to", type: "felt" }] },
  ];

  function createMockProvider(onChainAbi: unknown[]): AbiVerificationProvider {
    return {
      async getClassAt(_address: string, _block?: string) {
        return { abi: JSON.stringify(onChainAbi), contract_class_version: "0.1.0" };
      },
    };
  }

  it("returns match:true when bundled and on-chain ABIs are identical", async () => {
    const provider = createMockProvider(sampleAbi);
    const result = await verifyAbiCompatibility({
      provider,
      label: "test-contract",
      contractAddress: TEST_ADDRESS,
      bundledAbi: sampleAbi,
      mode: "fail",
    });

    expect(result.match).toBe(true);
    expect(result.bundledFingerprint).toBe(result.onChainFingerprint);
    expect(result.message).toContain("✓");
    expect(result.message).toContain("matches");
  });

  it("returns match:true even when object key order differs", async () => {
    const bundled = [{ name: "foo", type: "function" }];
    const onChain = [{ type: "function", name: "foo" }];
    const provider = createMockProvider(onChain);

    const result = await verifyAbiCompatibility({
      provider,
      label: "test-contract",
      contractAddress: TEST_ADDRESS,
      bundledAbi: bundled,
      mode: "fail",
    });

    expect(result.match).toBe(true);
  });

  it("throws when ABIs mismatch and mode is 'fail'", async () => {
    const bundled = [{ type: "function", name: "foo" }];
    const onChain = [{ type: "function", name: "bar" }];
    const provider = createMockProvider(onChain);

    await expect(
      verifyAbiCompatibility({
        provider,
        label: "test-contract",
        contractAddress: TEST_ADDRESS,
        bundledAbi: bundled,
        mode: "fail",
      }),
    ).rejects.toThrow(/ABI MISMATCH/i);
  });

  it("warns but does not throw when ABIs mismatch and mode is 'warn'", async () => {
    const bundled = [{ type: "function", name: "foo" }];
    const onChain = [{ type: "function", name: "bar" }];
    const provider = createMockProvider(onChain);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await verifyAbiCompatibility({
      provider,
      label: "test-contract",
      contractAddress: TEST_ADDRESS,
      bundledAbi: bundled,
      mode: "warn",
    });

    expect(result.match).toBe(false);
    expect(result.bundledFingerprint).not.toBe(result.onChainFingerprint);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ABI MISMATCH"));

    warnSpy.mockRestore();
  });

  it("throws when RPC fetch fails", async () => {
    const provider: AbiVerificationProvider = {
      async getClassAt() {
        throw new Error("Network timeout");
      },
    };

    await expect(
      verifyAbiCompatibility({
        provider,
        label: "test-contract",
        contractAddress: TEST_ADDRESS,
        bundledAbi: sampleAbi,
        mode: "fail",
      }),
    ).rejects.toThrow(/Failed to fetch contract class/i);
  });

  it("throws when on-chain ABI extraction fails", async () => {
    const provider: AbiVerificationProvider = {
      async getClassAt() {
        return { abi: "invalid json {" };
      },
    };

    await expect(
      verifyAbiCompatibility({
        provider,
        label: "test-contract",
        contractAddress: TEST_ADDRESS,
        bundledAbi: sampleAbi,
        mode: "fail",
      }),
    ).rejects.toThrow(/Could not extract ABI/i);
  });

  it("includes both fingerprints in mismatch error message", async () => {
    const bundled = [{ type: "function", name: "foo" }];
    const onChain = [{ type: "function", name: "bar" }];
    const provider = createMockProvider(onChain);

    try {
      await verifyAbiCompatibility({
        provider,
        label: "test-contract",
        contractAddress: TEST_ADDRESS,
        bundledAbi: bundled,
        mode: "fail",
      });
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Bundled fingerprint:");
      expect(message).toContain("On-chain fingerprint:");
      expect(message).toContain(fingerprintAbi(bundled));
      expect(message).toContain(fingerprintAbi(onChain));
    }
  });

  it("handles legacy ABI format (array, not string)", async () => {
    const provider: AbiVerificationProvider = {
      async getClassAt() {
        return { abi: sampleAbi }; // legacy format: already an array
      },
    };

    const result = await verifyAbiCompatibility({
      provider,
      label: "test-contract",
      contractAddress: TEST_ADDRESS,
      bundledAbi: sampleAbi,
      mode: "fail",
    });

    expect(result.match).toBe(true);
  });
});

