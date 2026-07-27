/**
 * Agreement Index — In-memory index for fast agreement lookups
 *
 * This module maintains an in-memory index of agreements keyed by contract
 * address. Each contract address gets its own sub-index containing:
 *   - `byUser`: user address (normalized) → set of agreement IDs
 *   - `agreements`: agreement ID → metadata snapshot
 *   - `lastSyncedBlock`: the block number at which the index was last synced
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
 */

import { normalizeStarknetAddress as normalizeAddress } from "../utils/address.js";

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
};

const indices = new Map<string, AgreementIndex>();

function getOrCreateIndex(contractAddress: string): AgreementIndex {
  if (!indices.has(contractAddress)) {
    indices.set(contractAddress, {
      byUser: new Map(),
      agreements: new Map(),
      lastSyncedBlock: 0,
      contractAddress,
    });
  }
  return indices.get(contractAddress)!;
}

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
