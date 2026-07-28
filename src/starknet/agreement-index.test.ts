import { describe, it, expect, beforeEach } from "vitest";

import {
  addAgreementToIndex,
  getUserAgreements,
  getAgreementMetadata,
  clearIndex,
  getAllIndices,
  removeAgreementsAtBlock,
  rollbackToBlock,
  getPendingBlockRange,
  getConfirmationDepth,
  setConfirmationDepth,
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

// ---------------------------------------------------------------------------
// Reorg handling
// ---------------------------------------------------------------------------
describe("Agreement Index — reorg handling", () => {
  const meta = { status: 1, mode: 0, total_amount: "1000", paid_amount: "0" };

  beforeEach(() => {
    resetAllIndices();
    // Reset confirmation depth to default before each test
    setConfirmationDepth(5);
  });

  // -----------------------------------------------------------------------
  // Confirmation depth config
  // -----------------------------------------------------------------------
  describe("confirmation depth configuration", () => {
    it("returns the default confirmation depth of 5", () => {
      expect(getConfirmationDepth()).toBe(5);
    });

    it("allows setting a custom confirmation depth", () => {
      setConfirmationDepth(10);
      expect(getConfirmationDepth()).toBe(10);
    });

    it("allows setting confirmation depth to 0 (no reorg protection)", () => {
      setConfirmationDepth(0);
      expect(getConfirmationDepth()).toBe(0);
    });

    it("throws on negative confirmation depth", () => {
      expect(() => setConfirmationDepth(-1)).toThrow("non-negative integer");
    });

    it("throws on non-integer confirmation depth", () => {
      expect(() => setConfirmationDepth(3.5)).toThrow("non-negative integer");
    });
  });

  // -----------------------------------------------------------------------
  // Block-level tracking
  // -----------------------------------------------------------------------
  describe("block-level entry tracking", () => {
    it("tracks entries by block number when blockNumber is provided", () => {
      addAgreementToIndex(CONTRACT_A, "b100-1", "0xabc", "0xdef", meta, 100);
      addAgreementToIndex(CONTRACT_A, "b101-1", "0xabc", "0x0", meta, 101);

      // Both should be visible
      const results = getUserAgreements(CONTRACT_A, "0xabc");
      expect(results).toEqual(expect.arrayContaining(["b100-1", "b101-1"]));
    });

    it("advances lastSyncedBlock as entries are added", () => {
      addAgreementToIndex(CONTRACT_A, "b100", "0xabc", "0x0", meta, 100);
      addAgreementToIndex(CONTRACT_A, "b105", "0xabc", "0x0", meta, 105);

      const index = getAllIndices().get(CONTRACT_A)!;
      expect(index.lastSyncedBlock).toBe(105);
    });

    it("does not regress lastSyncedBlock when older blocks are added", () => {
      addAgreementToIndex(CONTRACT_A, "b105", "0xabc", "0x0", meta, 105);
      addAgreementToIndex(CONTRACT_A, "b100", "0xabc", "0x0", meta, 100);

      const index = getAllIndices().get(CONTRACT_A)!;
      expect(index.lastSyncedBlock).toBe(105);
    });
  });

  // -----------------------------------------------------------------------
  // removeAgreementsAtBlock
  // -----------------------------------------------------------------------
  describe("removeAgreementsAtBlock", () => {
    it("removes only entries from the targeted block", () => {
      addAgreementToIndex(CONTRACT_A, "keep-1", "0xabc", "0xdef", meta, 100);
      addAgreementToIndex(CONTRACT_A, "remove-1", "0xabc", "0xdef", meta, 101);
      addAgreementToIndex(CONTRACT_A, "keep-2", "0xabc", "0x0", meta, 102);

      removeAgreementsAtBlock(CONTRACT_A, 101);

      // Kept entries are still present
      expect(getAgreementMetadata(CONTRACT_A, "keep-1")).toBeDefined();
      expect(getAgreementMetadata(CONTRACT_A, "keep-2")).toBeDefined();

      // Removed entry is gone
      expect(getAgreementMetadata(CONTRACT_A, "remove-1")).toBeUndefined();

      // User still has the kept entries
      const userAgreements = getUserAgreements(CONTRACT_A, "0xabc");
      expect(userAgreements).toContain("keep-1");
      expect(userAgreements).toContain("keep-2");
      expect(userAgreements).not.toContain("remove-1");
    });

    it("removes entries from both employer and contributor byUser sets", () => {
      addAgreementToIndex(CONTRACT_A, "dual-1", "0xabc", "0xdef", meta, 100);

      removeAgreementsAtBlock(CONTRACT_A, 100);

      expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual([]);
      expect(getUserAgreements(CONTRACT_A, "0xdef")).toEqual([]);
    });

    it("is a no-op for a non-existent contract", () => {
      expect(() => removeAgreementsAtBlock(CONTRACT_A, 100)).not.toThrow();
    });

    it("is a no-op for a block with no entries", () => {
      addAgreementToIndex(CONTRACT_A, "x", "0xabc", "0x0", meta, 100);
      expect(() => removeAgreementsAtBlock(CONTRACT_A, 999)).not.toThrow();
      expect(getAgreementMetadata(CONTRACT_A, "x")).toBeDefined();
    });

    it("handles entries without metadata (no metadata stored)", () => {
      // Add without metadata — only byUser tracking, no agreements map entry
      addAgreementToIndex(CONTRACT_A, "no-meta", "0xabc", "0x0", undefined, 100);

      removeAgreementsAtBlock(CONTRACT_A, 100);

      // The agreement should be gone from user lookups
      expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // rollbackToBlock
  // -----------------------------------------------------------------------
  describe("rollbackToBlock", () => {
    it("removes entries from all blocks after the safe block", () => {
      addAgreementToIndex(CONTRACT_A, "b100", "0xabc", "0x0", meta, 100);
      addAgreementToIndex(CONTRACT_A, "b101", "0xabc", "0x0", meta, 101);
      addAgreementToIndex(CONTRACT_A, "b102", "0xabc", "0x0", meta, 102);

      rollbackToBlock(CONTRACT_A, 100);

      expect(getAgreementMetadata(CONTRACT_A, "b100")).toBeDefined();
      expect(getAgreementMetadata(CONTRACT_A, "b101")).toBeUndefined();
      expect(getAgreementMetadata(CONTRACT_A, "b102")).toBeUndefined();

      expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["b100"]);
    });

    it("resets lastSyncedBlock to the safe block", () => {
      addAgreementToIndex(CONTRACT_A, "b105", "0xabc", "0x0", meta, 105);

      rollbackToBlock(CONTRACT_A, 102);

      const index = getAllIndices().get(CONTRACT_A)!;
      expect(index.lastSyncedBlock).toBe(102);
    });

    it("is a no-op when safeBlock >= lastSyncedBlock", () => {
      addAgreementToIndex(CONTRACT_A, "b100", "0xabc", "0x0", meta, 100);

      rollbackToBlock(CONTRACT_A, 999);

      expect(getAgreementMetadata(CONTRACT_A, "b100")).toBeDefined();
      expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["b100"]);
    });

    it("is a no-op for a non-existent contract", () => {
      expect(() => rollbackToBlock(CONTRACT_A, 50)).not.toThrow();
    });

    it("allows re-indexing after rollback with new canonical data", () => {
      // Original chain: block 100 has agreement "orig-100"
      addAgreementToIndex(CONTRACT_A, "orig-100", "0xabc", "0x0", meta, 100);
      addAgreementToIndex(
        CONTRACT_A,
        "orig-101",
        "0xabc",
        "0x0",
        { ...meta, total_amount: "2000" },
        101,
      );

      // Reorg at block 101 — roll back to 100
      rollbackToBlock(CONTRACT_A, 100);
      expect(getAgreementMetadata(CONTRACT_A, "orig-101")).toBeUndefined();

      // Re-index block 101 with different canonical data
      const newMeta = { status: 2, mode: 1, total_amount: "5000", paid_amount: "1000" };
      addAgreementToIndex(CONTRACT_A, "canonical-101", "0xdef", "0x0", newMeta, 101);

      // Old reorged entry is gone
      expect(getAgreementMetadata(CONTRACT_A, "orig-101")).toBeUndefined();
      // New canonical entry is present
      expect(getAgreementMetadata(CONTRACT_A, "canonical-101")).toBeDefined();
      expect(getAgreementMetadata(CONTRACT_A, "canonical-101")!.total_amount).toBe("5000");
      // Original block 100 entry is untouched
      expect(getAgreementMetadata(CONTRACT_A, "orig-100")).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end reorg simulation
  // -----------------------------------------------------------------------
  describe("end-to-end reorg simulation", () => {
    it("converges to canonical state after a multi-block reorg", () => {
      // Phase 1: Index blocks 100-105 (original chain)
      const employers = ["0xaaa", "0xbbb", "0xccc", "0xddd", "0xeee", "0xfff"];
      for (let block = 100; block <= 105; block++) {
        const employer = employers[block - 100];
        addAgreementToIndex(
          CONTRACT_A,
          `orig-${block}`,
          employer,
          "0x0",
          { ...meta, total_amount: `${block * 100}` },
          block,
        );
      }

      // Verify all 6 entries exist
      for (let block = 100; block <= 105; block++) {
        expect(getAgreementMetadata(CONTRACT_A, `orig-${block}`)).toBeDefined();
      }

      // Phase 2: Simulate a reorg at block 103 (blocks 103-105 are orphaned)
      rollbackToBlock(CONTRACT_A, 102);

      // Blocks 100-102 should survive
      expect(getAgreementMetadata(CONTRACT_A, "orig-100")).toBeDefined();
      expect(getAgreementMetadata(CONTRACT_A, "orig-101")).toBeDefined();
      expect(getAgreementMetadata(CONTRACT_A, "orig-102")).toBeDefined();

      // Blocks 103-105 should be gone
      expect(getAgreementMetadata(CONTRACT_A, "orig-103")).toBeUndefined();
      expect(getAgreementMetadata(CONTRACT_A, "orig-104")).toBeUndefined();
      expect(getAgreementMetadata(CONTRACT_A, "orig-105")).toBeUndefined();

      // Phase 3: Re-index the new canonical blocks 103-105
      const newEmployers = ["0x111", "0x222", "0x333"];
      for (let block = 103; block <= 105; block++) {
        const employer = newEmployers[block - 103];
        addAgreementToIndex(
          CONTRACT_A,
          `canonical-${block}`,
          employer,
          "0x0",
          { ...meta, total_amount: `${block * 200}` },
          block,
        );
      }

      // Phase 4: Verify convergence to canonical state
      // Old orphaned entries remain gone
      expect(getAgreementMetadata(CONTRACT_A, "orig-103")).toBeUndefined();
      expect(getAgreementMetadata(CONTRACT_A, "orig-104")).toBeUndefined();
      expect(getAgreementMetadata(CONTRACT_A, "orig-105")).toBeUndefined();

      // New canonical entries are present with correct data
      expect(getAgreementMetadata(CONTRACT_A, "canonical-103")!.total_amount).toBe("20600");
      expect(getAgreementMetadata(CONTRACT_A, "canonical-104")!.total_amount).toBe("20800");
      expect(getAgreementMetadata(CONTRACT_A, "canonical-105")!.total_amount).toBe("21000");

      // Original surviving entries are intact
      expect(getAgreementMetadata(CONTRACT_A, "orig-100")!.total_amount).toBe("10000");
      expect(getAgreementMetadata(CONTRACT_A, "orig-101")!.total_amount).toBe("10100");
      expect(getAgreementMetadata(CONTRACT_A, "orig-102")!.total_amount).toBe("10200");

      // User lookups reflect canonical state
      expect(getUserAgreements(CONTRACT_A, "0x111")).toEqual(["canonical-103"]);
      expect(getUserAgreements(CONTRACT_A, "0x222")).toEqual(["canonical-104"]);
      expect(getUserAgreements(CONTRACT_A, "0x333")).toEqual(["canonical-105"]);

      // Orphaned employers have no agreements
      expect(getUserAgreements(CONTRACT_A, "0xddd")).toEqual([]);
      expect(getUserAgreements(CONTRACT_A, "0xeee")).toEqual([]);
      expect(getUserAgreements(CONTRACT_A, "0xfff")).toEqual([]);
    });

    it("handles a single-block reorg correctly", () => {
      // Index blocks 100-102
      addAgreementToIndex(CONTRACT_A, "a100", "0xabc", "0x0", meta, 100);
      addAgreementToIndex(CONTRACT_A, "a101", "0xabc", "0x0", meta, 101);
      addAgreementToIndex(
        CONTRACT_A,
        "a102-old",
        "0xabc",
        "0x0",
        { ...meta, total_amount: "OLD" },
        102,
      );

      // Reorg only block 102
      rollbackToBlock(CONTRACT_A, 101);

      // Re-index block 102 with new data
      addAgreementToIndex(
        CONTRACT_A,
        "a102-new",
        "0xdef",
        "0x0",
        { ...meta, total_amount: "NEW" },
        102,
      );

      // Old block 102 entry is gone
      expect(getAgreementMetadata(CONTRACT_A, "a102-old")).toBeUndefined();
      // New block 102 entry is present
      expect(getAgreementMetadata(CONTRACT_A, "a102-new")!.total_amount).toBe("NEW");
      // Earlier blocks are untouched
      expect(getAgreementMetadata(CONTRACT_A, "a100")).toBeDefined();
      expect(getAgreementMetadata(CONTRACT_A, "a101")).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Entries without blockNumber (backward compatibility)
  // -----------------------------------------------------------------------
  describe("backward compatibility — entries without blockNumber", () => {
    it("entries without blockNumber are not affected by rollbackToBlock", () => {
      // Add entries with and without block numbers
      addAgreementToIndex(CONTRACT_A, "tracked", "0xabc", "0x0", meta, 100);
      addAgreementToIndex(CONTRACT_A, "untracked", "0xabc", "0x0", meta);

      // Roll back past the tracked entry
      rollbackToBlock(CONTRACT_A, 50);

      // Tracked entry is removed
      expect(getAgreementMetadata(CONTRACT_A, "tracked")).toBeUndefined();
      // Untracked entry survives — backward compatible
      expect(getAgreementMetadata(CONTRACT_A, "untracked")).toBeDefined();
      expect(getUserAgreements(CONTRACT_A, "0xabc")).toEqual(["untracked"]);
    });

    it("entries without blockNumber are not affected by removeAgreementsAtBlock", () => {
      addAgreementToIndex(CONTRACT_A, "untracked", "0xabc", "0x0", meta);

      removeAgreementsAtBlock(CONTRACT_A, 100);

      expect(getAgreementMetadata(CONTRACT_A, "untracked")).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // getPendingBlockRange
  // -----------------------------------------------------------------------
  describe("getPendingBlockRange", () => {
    it("returns null for a non-existent index", () => {
      expect(getPendingBlockRange(CONTRACT_A)).toBeNull();
    });

    it("returns null for an index that has never been synced", () => {
      // Create an index by looking up (lastSyncedBlock stays 0)
      getUserAgreements(CONTRACT_A, "0xabc");
      expect(getPendingBlockRange(CONTRACT_A)).toBeNull();
    });

    it("returns the correct pending range with default depth", () => {
      setConfirmationDepth(5);
      addAgreementToIndex(CONTRACT_A, "x", "0xabc", "0x0", meta, 100);

      const range = getPendingBlockRange(CONTRACT_A);
      expect(range).toEqual({ from: 96, to: 100 });
    });

    it("returns the correct pending range with custom depth", () => {
      setConfirmationDepth(10);
      addAgreementToIndex(CONTRACT_A, "x", "0xabc", "0x0", meta, 50);

      const range = getPendingBlockRange(CONTRACT_A);
      expect(range).toEqual({ from: 41, to: 50 });
    });

    it("clamps `from` to 1 when depth exceeds the block number", () => {
      setConfirmationDepth(100);
      addAgreementToIndex(CONTRACT_A, "x", "0xabc", "0x0", meta, 5);

      const range = getPendingBlockRange(CONTRACT_A);
      expect(range).toEqual({ from: 1, to: 5 });
    });
  });
});
