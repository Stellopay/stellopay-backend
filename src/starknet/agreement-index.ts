/**
 * Agreement Index — In-memory index for fast agreement lookups
 *
 * This module maintains an in-memory index of agreements keyed by contract
 * address. Each contract address gets its own sub-index containing:
 *   - `byUser`: user address (normalized) → set of agreement IDs
 *   - `agreements`: agreement ID → metadata snapshot
 *   - `lastSyncedBlock`: the block number at which the index was last synced
 *   - `blockEntries`: block number → set of agreement IDs indexed from that block
 *
 * The index can be populated by:
 * 1. Listening to AgreementCreated on-chain events
 * 2. Scanning the contract on startup (one-time backfill)
 * 3. Real-time calls to `addAgreementToIndex` as agreements are created
 *
 * ---
 * Staleness / consistency guarantees
 *
 * - **Lookup before any entry is added** (`getUserAgreements` / `getAgreementMetadata`
 *   without a prior `addAgreementToIndex`): returns `[]` / `undefined`. Never
 *   throws or returns stale data from a different contract.
 *
 * - **Eviction** is all-or-nothing per contract address via `clearIndex`. There
 *   is no per-entry TTL or LRU eviction. After `clearIndex`, all lookups for
 *   that contract behave as if never synced.
 *
 * - **No automatic refresh**: the index does NOT poll the chain or track block
 *   progress beyond `lastSyncedBlock`. Downstream callers (e.g. route handlers)
 *   are responsible for triggering a re-sync before trusting the index for
 *   authorization decisions.
 *
 * - **Concurrent access safety**: because JavaScript's event loop executes on a
 *   single thread, plain `Map` / `Set` mutations interleaved with reads on the
 *   same tick are safe. However, async operations that `await` between read and
 *   write may observe intermediate states. No external locking is provided.
 *
 * - **Cardinality warning**: entries live forever until `clearIndex()` is called.
 *   At large agreement volumes the in-memory maps should be periodically trimmed
 *   via `clearIndex()` + re-sync, or by introducing a TTL eviction layer.
 *
 * ---
 * Chain reorganization (reorg) handling
 *
 * Blocks near the chain tip can be reorged — replaced by a competing fork.
 * When this happens, events from orphaned blocks are no longer canonical and
 * must be removed from the index.
 *
 * The index provides:
 *   - **Block-level tracking**: each entry optionally records the block number
 *     it was indexed from via the `blockNumber` parameter on
 *     `addAgreementToIndex`. Entries without a block number are considered
 *     "untracked" and are never affected by rollback operations.
 *   - **`CONFIRMATION_DEPTH`** (default 5): a configurable threshold. Blocks
 *     within this depth of `lastSyncedBlock` are considered *pending* and
 *     subject to rollback. Only blocks deeper than this should be treated as
 *     final by downstream callers.
 *   - **`rollbackToBlock(contract, safeBlock)`**: removes all entries from
 *     blocks strictly greater than `safeBlock` and resets `lastSyncedBlock`.
 *   - **`removeAgreementsAtBlock(contract, block)`**: surgically removes all
 *     entries from a single block.
 */

import { normalizeStarknetAddress as normalizeAddress } from "../utils/address.js";

// ---------------------------------------------------------------------------
// Confirmation depth — blocks within this many blocks of the tip are pending
// ---------------------------------------------------------------------------

let CONFIRMATION_DEPTH = 5;

/**
 * Return the current confirmation-depth threshold.
 *
 * Blocks within this many blocks of `lastSyncedBlock` are considered pending
 * and may be rolled back if a reorg is detected.
 */
export function getConfirmationDepth(): number {
  return CONFIRMATION_DEPTH;
}

/**
 * Override the confirmation-depth threshold. Useful in tests or when a
 * deployment targets a chain with different finality characteristics.
 *
 * @param depth — must be a non-negative integer. Passing 0 means every block
 *   is considered final immediately (no reorg protection).
 */
export function setConfirmationDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error("Confirmation depth must be a non-negative integer");
  }
  CONFIRMATION_DEPTH = depth;
}

// ---------------------------------------------------------------------------
// Index types
// ---------------------------------------------------------------------------

type AgreementIndex = {
  // Map: user address (normalized) -> array of agreement IDs
  byUser: Map<string, Set<string>>;
  // Map: agreement ID -> agreement metadata
  agreements: Map<
    string,
    {
      agreement_id: string;
      employer: string;
      contributor: string;
      status: number;
      mode: number;
      total_amount: string;
      paid_amount: string;
    }
  >;
  // Last sync block number
  lastSyncedBlock: number;
  // Contract address
  contractAddress: string;
  // Map: block number -> set of agreement IDs indexed from that block
  blockEntries: Map<number, Set<string>>;
};

const indices = new Map<string, AgreementIndex>();

function getOrCreateIndex(contractAddress: string): AgreementIndex {
  if (!indices.has(contractAddress)) {
    indices.set(contractAddress, {
      byUser: new Map(),
      agreements: new Map(),
      lastSyncedBlock: 0,
      contractAddress,
      blockEntries: new Map(),
    });
  }
  return indices.get(contractAddress)!;
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

export function addAgreementToIndex(
  contractAddress: string,
  agreementId: string,
  employer: string,
  contributor: string,
  metadata?: {
    status: number;
    mode: number;
    total_amount: string;
    paid_amount: string;
  },
  blockNumber?: number,
) {
  const index = getOrCreateIndex(contractAddress);
  const normalizedEmployer = normalizeAddress(employer);
  const normalizedContributor =
    contributor && contributor !== "0x0" ? normalizeAddress(contributor) : null;

  // Add to user index
  if (!index.byUser.has(normalizedEmployer)) {
    index.byUser.set(normalizedEmployer, new Set());
  }
  index.byUser.get(normalizedEmployer)!.add(agreementId);

  if (normalizedContributor) {
    if (!index.byUser.has(normalizedContributor)) {
      index.byUser.set(normalizedContributor, new Set());
    }
    index.byUser.get(normalizedContributor)!.add(agreementId);
  }

  // Store agreement metadata
  if (metadata) {
    index.agreements.set(agreementId, {
      agreement_id: agreementId,
      employer: normalizedEmployer,
      contributor: normalizedContributor || "0x0",
      ...metadata,
    });
  }

  // Track which block this entry came from (for reorg rollback)
  if (blockNumber !== undefined) {
    if (!index.blockEntries.has(blockNumber)) {
      index.blockEntries.set(blockNumber, new Set());
    }
    index.blockEntries.get(blockNumber)!.add(agreementId);

    // Advance the high-water mark
    if (blockNumber > index.lastSyncedBlock) {
      index.lastSyncedBlock = blockNumber;
    }
  }
}

export function getUserAgreements(contractAddress: string, userAddress: string): string[] {
  const index = getOrCreateIndex(contractAddress);
  const normalizedUser = normalizeAddress(userAddress);
  const agreementIds = index.byUser.get(normalizedUser);
  return agreementIds ? Array.from(agreementIds) : [];
}

export function getAgreementMetadata(contractAddress: string, agreementId: string) {
  const index = getOrCreateIndex(contractAddress);
  return index.agreements.get(agreementId);
}

export function clearIndex(contractAddress: string) {
  indices.delete(contractAddress);
}

export function getAllIndices(): Map<string, AgreementIndex> {
  return indices;
}

// ---------------------------------------------------------------------------
// Reorg handling
// ---------------------------------------------------------------------------

/**
 * Remove all index entries that were recorded at a specific block number.
 *
 * This is the low-level primitive: it removes agreement IDs from `byUser`,
 * deletes their metadata from `agreements`, and cleans up the `blockEntries`
 * tracking map.
 *
 * Entries that were added *without* a `blockNumber` are never affected.
 */
export function removeAgreementsAtBlock(contractAddress: string, blockNumber: number): void {
  const index = indices.get(contractAddress);
  if (!index) return;

  const ids = index.blockEntries.get(blockNumber);
  if (!ids || ids.size === 0) return;

  for (const agreementId of ids) {
    // Remove metadata to find employer/contributor for byUser cleanup
    const meta = index.agreements.get(agreementId);
    if (meta) {
      // Remove from employer's set
      const employerSet = index.byUser.get(meta.employer);
      if (employerSet) {
        employerSet.delete(agreementId);
        if (employerSet.size === 0) index.byUser.delete(meta.employer);
      }
      // Remove from contributor's set
      if (meta.contributor && meta.contributor !== "0x0") {
        const contributorSet = index.byUser.get(meta.contributor);
        if (contributorSet) {
          contributorSet.delete(agreementId);
          if (contributorSet.size === 0) index.byUser.delete(meta.contributor);
        }
      }
      index.agreements.delete(agreementId);
    } else {
      // No metadata — scan all byUser sets (slower but correct)
      for (const [, userSet] of index.byUser) {
        userSet.delete(agreementId);
      }
      // Clean up empty sets
      for (const [addr, userSet] of index.byUser) {
        if (userSet.size === 0) index.byUser.delete(addr);
      }
    }
  }

  index.blockEntries.delete(blockNumber);
}

/**
 * Roll back the index to a safe block, removing all entries from blocks
 * strictly greater than `safeBlock`. Resets `lastSyncedBlock` to `safeBlock`.
 *
 * This is the high-level reorg-recovery function. After calling this, the
 * caller should re-index from `safeBlock + 1` using the new canonical chain.
 *
 * If `safeBlock` is greater than or equal to the current `lastSyncedBlock`,
 * this is a no-op — nothing is removed.
 */
export function rollbackToBlock(contractAddress: string, safeBlock: number): void {
  const index = indices.get(contractAddress);
  if (!index) return;

  // Nothing to do if safeBlock >= head
  if (safeBlock >= index.lastSyncedBlock) return;

  // Collect all block numbers that need to be removed
  const blocksToRemove: number[] = [];
  for (const blockNum of index.blockEntries.keys()) {
    if (blockNum > safeBlock) {
      blocksToRemove.push(blockNum);
    }
  }

  // Remove entries from each orphaned block
  for (const blockNum of blocksToRemove) {
    removeAgreementsAtBlock(contractAddress, blockNum);
  }

  // Reset high-water mark
  index.lastSyncedBlock = safeBlock;
}

/**
 * Return the range of blocks that are not yet considered final — i.e. blocks
 * within `CONFIRMATION_DEPTH` of the current `lastSyncedBlock`.
 *
 * Returns `null` if the index does not exist or has never been synced.
 *
 * The returned `from` is inclusive and `to` is inclusive (the current head).
 */
export function getPendingBlockRange(
  contractAddress: string,
): { from: number; to: number } | null {
  const index = indices.get(contractAddress);
  if (!index || index.lastSyncedBlock === 0) return null;

  const from = Math.max(1, index.lastSyncedBlock - CONFIRMATION_DEPTH + 1);
  return { from, to: index.lastSyncedBlock };
}
