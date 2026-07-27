import { describe, it, expect, beforeEach } from "vitest";

import {
  addAgreementToIndex,
  getUserAgreements,
  getAgreementMetadata,
  clearIndex,
  getAllIndices,
} from "./agreement-index.js";

// Helper to reset all indices between tests
function resetAllIndices() {
  // Snapshot keys before mutating to avoid iteration-while-deleting edge cases
  for (const key of [...getAllIndices().keys()]) {
    clearIndex(key);
  }
}

const CONTRACT_A = "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4";
const CONTRACT_B = "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd";

describe("Agreement Index — basic functionality", () => {
  beforeEach(() => {
    resetAllIndices();
  });

  it("stores an agreement for the employer on addAgreementToIndex", () => {
    addAgreementToIndex(CONTRACT_A, "1", "0xabc", "0xdef");
    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["1"]);
  });

  it("stores an agreement for the contributor when contributor is non-zero", () => {
    addAgreementToIndex(CONTRACT_A, "2", "0xabc", "0xdef");
    expect(getUserAgreements(CONTRACT_A, "0xdef")).toEqual(["2"]);
  });

  it("does NOT add the contributor entry when contributor is 0x0", () => {
    addAgreementToIndex(CONTRACT_A, "3", "0xabc", "0x0");
    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["3"]);
    expect(getUserAgreements(CONTRACT_A, "0x0")).toEqual([]);
  });

  it("returns agreement metadata from getAgreementMetadata", () => {
    const metadata = {
      status: 1,
      mode: 0,
      total_amount: "1000000",
      paid_amount: "500000",
    };
    addAgreementToIndex(CONTRACT_A, "4", "0xabc", "0xdef", metadata);
    const result = getAgreementMetadata(CONTRACT_A, "4");
    expect(result).toBeDefined();
    expect(result!.agreement_id).toBe("4");
    expect(result!.employer).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000abc",
    );
    expect(result!.contributor).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000def",
    );
    expect(result!.status).toBe(1);
    expect(result!.mode).toBe(0);
    expect(result!.total_amount).toBe("1000000");
    expect(result!.paid_amount).toBe("500000");
  });

  it("stores metadata with the normalized (lowercased, padded) addresses", () => {
    addAgreementToIndex(
      CONTRACT_A,
      "5",
      "0xABCDEF",
      "0x123456",
      { status: 2, mode: 1, total_amount: "500", paid_amount: "250" },
    );
    const result = getAgreementMetadata(CONTRACT_A, "5");
    // Addresses should be normalized (lower-cased, 64-char padded)
    expect(result!.employer).toMatch(/^0x0+abcdef$/);
    expect(result!.contributor).toMatch(/^0x0+123456$/);
  });

  it("normalizes addresses (case-insensitive lookups)", () => {
    addAgreementToIndex(CONTRACT_A, "6", "0xABCDEF", "0x000000");

    // Look up with different casing. Only all-lowercase and all-uppercase are
    // valid here because normalizeStarknetAddress rejects mixed-case inputs
    // that fail the SNIP-23/EIP-55 checksum.
    expect(getUserAgreements(CONTRACT_A, "0xabcdef")).toEqual(["6"]);
    expect(getUserAgreements(CONTRACT_A, "0xABCDEF")).toEqual(["6"]);
  });

  it("supports multiple agreements for the same user", () => {
    addAgreementToIndex(CONTRACT_A, "7", "0xaaa", "0x0");
    addAgreementToIndex(CONTRACT_A, "8", "0xaaa", "0x0");
    addAgreementToIndex(CONTRACT_A, "9", "0xaaa", "0x0");

    const results = getUserAgreements(CONTRACT_A, "0xaaa");
    expect(results).toHaveLength(3);
    expect(results).toEqual(expect.arrayContaining(["7", "8", "9"]));
  });

  it("isolates indices per contract address", () => {
    addAgreementToIndex(CONTRACT_A, "10", "0xaaa", "0x0");
    addAgreementToIndex(CONTRACT_B, "20", "0xbbb", "0x0");

    expect(getUserAgreements(CONTRACT_A, "0xaaa")).toEqual(["10"]);
    expect(getUserAgreements(CONTRACT_A, "0xbbb")).toEqual([]);
    expect(getUserAgreements(CONTRACT_B, "0xbbb")).toEqual(["20"]);
    expect(getUserAgreements(CONTRACT_B, "0xaaa")).toEqual([]);
  });

  it("clears the index for a specific contract with clearIndex", () => {
    addAgreementToIndex(CONTRACT_A, "11", "0xaaa", "0x0");
    addAgreementToIndex(CONTRACT_B, "21", "0xbbb", "0x0");

    clearIndex(CONTRACT_A);

    expect(getUserAgreements(CONTRACT_A, "0xaaa")).toEqual([]);
    expect(getAgreementMetadata(CONTRACT_A, "11")).toBeUndefined();

    // Contract B is unaffected
    expect(getUserAgreements(CONTRACT_B, "0xbbb")).toEqual(["21"]);
  });

  it("isolates contract indices after multiple add/clear cycles", () => {
    addAgreementToIndex(CONTRACT_A, "a1", "0xaaa", "0x0");
    clearIndex(CONTRACT_A);
    addAgreementToIndex(CONTRACT_A, "a2", "0xaaa", "0x0");
    addAgreementToIndex(CONTRACT_B, "b1", "0xaaa", "0x0");

    expect(getUserAgreements(CONTRACT_A, "0xaaa")).toEqual(["a2"]);
    expect(getUserAgreements(CONTRACT_B, "0xaaa")).toEqual(["b1"]);
  });
});

// ---------------------------------------------------------------------------
// Edge case: lookup before initial sync
// ---------------------------------------------------------------------------
describe("Agreement Index — lookup before sync", () => {
  beforeEach(() => {
    resetAllIndices();
  });

  it("returns empty array from getUserAgreements when no agreements exist", () => {
    const result = getUserAgreements(CONTRACT_A, "0xabc");
    expect(result).toEqual([]);
  });

  it("returns undefined from getAgreementMetadata when no agreements exist", () => {
    const result = getAgreementMetadata(CONTRACT_A, "anything");
    expect(result).toBeUndefined();
  });

  it("does not throw when neither contract nor user exist in the index", () => {
    expect(() => getUserAgreements(CONTRACT_A, "0xabc")).not.toThrow();
    expect(() => getAgreementMetadata(CONTRACT_A, "ghost-id")).not.toThrow();
  });

  it("returns empty results for a contract that was never populated", () => {
    addAgreementToIndex(CONTRACT_B, "1", "0xabc", "0x0");
    // CONTRACT_A was never populated
    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual([]);
    expect(getAgreementMetadata(CONTRACT_A, "1")).toBeUndefined();
  });

  it("returns empty results when user has no agreements in an otherwise-populated index", () => {
    addAgreementToIndex(CONTRACT_A, "1", "0xabc", "0x0");
    // Another user exists in the index but has no agreements
    expect(getUserAgreements(CONTRACT_A, "0xdef")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge case: evicted-entry lookup
// ---------------------------------------------------------------------------
describe("Agreement Index — evicted / removed entry", () => {
  beforeEach(() => {
    resetAllIndices();
  });

  it("returns empty array from getUserAgreements after clearIndex", () => {
    addAgreementToIndex(CONTRACT_A, "1", "0xabc", "0x0");
    clearIndex(CONTRACT_A);
    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual([]);
  });

  it("returns undefined from getAgreementMetadata after clearIndex", () => {
    addAgreementToIndex(
      CONTRACT_A,
      "2",
      "0xabc",
      "0x0",
      { status: 1, mode: 0, total_amount: "100", paid_amount: "50" },
    );
    clearIndex(CONTRACT_A);
    expect(getAgreementMetadata(CONTRACT_A, "2")).toBeUndefined();
  });

  it("does not throw when looking up after clearIndex", () => {
    addAgreementToIndex(CONTRACT_A, "3", "0xabc", "0x0");
    clearIndex(CONTRACT_A);
    expect(() => getUserAgreements(CONTRACT_A, "0xabc")).not.toThrow();
    expect(() => getAgreementMetadata(CONTRACT_A, "3")).not.toThrow();
  });

  it("re-populating after clearIndex works as expected", () => {
    addAgreementToIndex(CONTRACT_A, "4", "0xabc", "0x0");
    clearIndex(CONTRACT_A);
    addAgreementToIndex(CONTRACT_A, "5", "0xabc", "0x0");
    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["5"]);
    expect(getUserAgreements(CONTRACT_A, "0xabc")).not.toContain("4");
  });

  it("clearing an already-empty index is a no-op", () => {
    expect(() => clearIndex(CONTRACT_A)).not.toThrow();
    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge case: concurrent read during a refresh cycle
// ---------------------------------------------------------------------------
describe("Agreement Index — concurrent read / refresh", () => {
  beforeEach(() => {
    resetAllIndices();
  });

  it("returns partial results when read is interleaved mid-refresh", async () => {
    // Simulate a refresh cycle that adds entries in batches:
    //   batch 1: employer 0xabc gets agreement "a1"
    //   batch 2: employer 0xabc gets agreement "a2"
    // A reader that reads after batch 1 should see exactly that partial state.

    // First batch — added immediately
    addAgreementToIndex(CONTRACT_A, "a1", "0xabc", "0x0");

    // Reader sees partial state (batch 1 done, batch 2 not yet)
    const afterBatch1 = getUserAgreements(CONTRACT_A, "0xabc");
    expect(afterBatch1).toEqual(["a1"]);

    // Second batch — delayed via microtask
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        addAgreementToIndex(CONTRACT_A, "a2", "0xabc", "0x0");
        resolve();
      });
    });

    // Now both entries are visible
    const afterBatch2 = getUserAgreements(CONTRACT_A, "0xabc");
    expect(afterBatch2).toHaveLength(2);
    expect(afterBatch2).toEqual(expect.arrayContaining(["a1", "a2"]));
  });

  it("does not corrupt the index when many entries are added in rapid succession", () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `rapid-${i}`;
      ids.push(id);
      addAgreementToIndex(CONTRACT_A, id, "0xabc", "0x0");
    }

    const results = getUserAgreements(CONTRACT_A, "0xabc");
    expect(results).toHaveLength(100);
    expect(results).toEqual(expect.arrayContaining(ids));
  });

  it("does not corrupt metadata when read and write are interleaved", async () => {
    // Add entry 1, read metadata, then add entry 2
    addAgreementToIndex(
      CONTRACT_A,
      "entry-1",
      "0xabc",
      "0xdef",
      { status: 1, mode: 0, total_amount: "100", paid_amount: "50" },
    );

    // Read entry 1's metadata
    const meta1 = getAgreementMetadata(CONTRACT_A, "entry-1");
    expect(meta1).toBeDefined();
    expect(meta1!.status).toBe(1);

    // Add entry 2 asynchronously
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        addAgreementToIndex(
          CONTRACT_A,
          "entry-2",
          "0xabc",
          "0xdef",
          { status: 2, mode: 1, total_amount: "200", paid_amount: "100" },
        );
        resolve();
      });
    });

    // Both entries should be valid
    const meta2 = getAgreementMetadata(CONTRACT_A, "entry-2");
    expect(meta2).toBeDefined();
    expect(meta2!.status).toBe(2);
    expect(meta2!.contributor).toMatch(/0x0+def$/);

    // Entry 1 should be unchanged
    const meta1After = getAgreementMetadata(CONTRACT_A, "entry-1");
    expect(meta1After!.status).toBe(1);
  });

  it("returns correct per-user results when multiple users are added concurrently", async () => {
    await Promise.all([
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          addAgreementToIndex(CONTRACT_A, "u1-a", "0xabc", "0x0");
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          addAgreementToIndex(CONTRACT_A, "u2-a", "0xdef", "0x0");
          resolve();
        });
      }),
    ]);

    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["u1-a"]);
    expect(getUserAgreements(CONTRACT_A, "0xdef")).toEqual(["u2-a"]);
  });

  it("adds entries for both employer and contributor atomically from reader perspective", () => {
    addAgreementToIndex(CONTRACT_A, "atomic-1", "0xabc", "0xdef");

    expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["atomic-1"]);
    expect(getUserAgreements(CONTRACT_A, "0xdef")).toEqual(["atomic-1"]);
  });
});
