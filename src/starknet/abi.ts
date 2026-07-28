import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type ContractClassJson = {
  abi?: unknown;
};

/**
 * The shape of a Starknet contract class returned by `starknet_getClassAt`.
 * The `abi` field is a JSON-encoded string in Sierra classes (v2) but an
 * array in legacy (v0) classes — we normalise both in `extractOnChainAbi`.
 */
type OnChainContractClass = {
  abi?: string | unknown[] | null;
  contract_class_version?: string;
  [k: string]: unknown;
};

/**
 * Minimal provider surface needed for ABI verification.
 * Satisfied by the starknet.js `RpcProvider` and by any test double.
 */
export interface AbiVerificationProvider {
  getClassAt(contractAddress: string, blockIdentifier?: string): Promise<OnChainContractClass>;
}

export type AbiVerificationMode = "fail" | "warn";

export interface AbiVerificationOptions {
  /** Starknet RPC provider used to fetch the deployed contract class. */
  provider: AbiVerificationProvider;
  /** Human-readable label used in log / error messages (e.g. "escrow"). */
  label: string;
  /** Deployed contract address to check against. */
  contractAddress: string;
  /** The bundled ABI array loaded from local disk. */
  bundledAbi: unknown[];
  /**
   * What to do when a mismatch is detected.
   * - `"fail"` — throw an Error (default, causes startup abort).
   * - `"warn"` — log a prominent warning and continue.
   */
  mode: AbiVerificationMode;
}

export interface AbiVerificationResult {
  /** Whether the bundled ABI matches the on-chain ABI. */
  match: boolean;
  /** SHA-256 hex digest of the *bundled* ABI (canonical JSON). */
  bundledFingerprint: string;
  /** SHA-256 hex digest of the *on-chain* ABI (canonical JSON), or null when fetch failed. */
  onChainFingerprint: string | null;
  /** Human-readable description of the outcome. */
  message: string;
}

/**
 * Computes a stable SHA-256 fingerprint over an ABI array.
 *
 * The ABI is serialised as canonical JSON (keys sorted alphabetically at
 * every level, no extra whitespace) before hashing, so that cosmetic
 * differences in key order between on-chain and bundled representations do
 * not produce false-positive mismatches.
 */
export function fingerprintAbi(abi: unknown[]): string {
  const canonical = JSON.stringify(canonicalize(abi));
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Recursively sorts object keys alphabetically so that JSON serialisation
 * is deterministic regardless of insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Extracts and normalises the ABI array from a raw on-chain contract class.
 *
 * Sierra contract classes (v2+) encode the ABI as a JSON *string*; legacy
 * classes expose it as a parsed array.  Both shapes are handled here.
 *
 * @throws Error when the ABI field is missing or cannot be parsed.
 */
export function extractOnChainAbi(contractClass: OnChainContractClass): unknown[] {
  const raw = contractClass.abi;

  if (raw === undefined || raw === null) {
    throw new Error("On-chain contract class has no 'abi' field");
  }

  // Sierra classes: abi is a JSON-encoded string
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Failed to parse on-chain ABI JSON string: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new Error("On-chain ABI parsed from string is not an array");
    }
    return parsed as unknown[];
  }

  // Legacy classes: abi is already an array
  if (Array.isArray(raw)) {
    return raw as unknown[];
  }

  throw new Error(`Unexpected on-chain ABI type: ${typeof raw}`);
}

/**
 * Verifies that the locally bundled ABI matches the ABI of the deployed
 * contract on-chain.
 *
 * Strategy:
 *  1. Fetch the contract class via `starknet_getClassAt` for the given address.
 *  2. Extract and normalise the on-chain ABI (handles both Sierra string and
 *     legacy array formats).
 *  3. Compute SHA-256 fingerprints over canonical JSON of both ABIs.
 *  4. Compare fingerprints — a mismatch either throws or warns depending on
 *     `options.mode`.
 *
 * @returns A {@link AbiVerificationResult} describing the outcome.
 * @throws Error on mismatch when `options.mode === "fail"`.
 * @throws Error when the RPC fetch fails (regardless of mode, so the caller
 *         can decide whether to treat an unavailable RPC as non-fatal).
 */
export async function verifyAbiCompatibility(
  options: AbiVerificationOptions,
): Promise<AbiVerificationResult> {
  const { provider, label, contractAddress, bundledAbi, mode } = options;

  const bundledFingerprint = fingerprintAbi(bundledAbi);

  let contractClass: OnChainContractClass;
  try {
    contractClass = await provider.getClassAt(contractAddress, "latest");
  } catch (cause) {
    throw new Error(
      `[abi-verify] Failed to fetch contract class for ${label} at ${contractAddress}: ${(cause as Error).message}`,
      { cause },
    );
  }

  let onChainAbi: unknown[];
  try {
    onChainAbi = extractOnChainAbi(contractClass);
  } catch (cause) {
    throw new Error(
      `[abi-verify] Could not extract ABI from on-chain contract class for ${label}: ${(cause as Error).message}`,
      { cause },
    );
  }

  const onChainFingerprint = fingerprintAbi(onChainAbi);
  const match = bundledFingerprint === onChainFingerprint;

  if (match) {
    const message =
      `[abi-verify] ✓ ${label} ABI matches on-chain contract at ${contractAddress} ` +
      `(fingerprint: ${bundledFingerprint.slice(0, 16)}…)`;
    return { match: true, bundledFingerprint, onChainFingerprint, message };
  }

  // Mismatch detected
  const message =
    `[abi-verify] ✗ ABI MISMATCH for ${label} contract at ${contractAddress}. ` +
    `Bundled fingerprint: ${bundledFingerprint} | ` +
    `On-chain fingerprint: ${onChainFingerprint}. ` +
    `The deployed contract may have been upgraded. ` +
    `Update the bundled ABI or set ABI_VERIFICATION_MODE=warn to suppress this error.`;

  if (mode === "warn") {
     
    console.warn(`\n${"=".repeat(72)}\n⚠  ${message}\n${"=".repeat(72)}\n`);
    return { match: false, bundledFingerprint, onChainFingerprint, message };
  }

  // mode === "fail"
  throw new Error(message);
}

export function loadAbiFromContractClassJsonPath(p: string): unknown[] {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const raw = fs.readFileSync(abs, "utf-8");
  const parsed: ContractClassJson = JSON.parse(raw);
  if (!parsed.abi || !Array.isArray(parsed.abi)) {
    throw new Error(`ABI not found in contract_class json at: ${abs}`);
  }
  return parsed.abi as unknown[];
}
