/**
 * Agreement Index - In-memory cache for fast agreement lookups
 *
 * This module maintains an index of agreements by user address for instant lookups.
 * It can be populated by:
 * 1. Listening to AgreementCreated events
 * 2. Scanning the contract on startup (one-time)
 * 3. Real-time updates when agreements are created
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
  maxEntries: number;
};

const indices = new Map<string, AgreementIndex>();
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_STALE_AFTER_BLOCKS = 100;

function getOrCreateIndex(contractAddress: string): AgreementIndex {
  if (!indices.has(contractAddress)) {
    indices.set(contractAddress, {
      byUser: new Map(),
      agreements: new Map(),
      lastSyncedBlock: 0,
      contractAddress,
      maxEntries: DEFAULT_MAX_ENTRIES,
    });
  }
  return indices.get(contractAddress)!;
}

function removeAgreementFromUser(index: AgreementIndex, userAddress: string, agreementId: string) {
  const agreementIds = index.byUser.get(userAddress);
  if (!agreementIds) return;
  agreementIds.delete(agreementId);
  if (!agreementIds.size) {
    index.byUser.delete(userAddress);
  }
}

function removeAgreement(index: AgreementIndex, agreementId: string) {
  const metadata = index.agreements.get(agreementId);
  if (metadata) {
    removeAgreementFromUser(index, metadata.employer, agreementId);
    if (metadata.contributor !== "0x0") {
      removeAgreementFromUser(index, metadata.contributor, agreementId);
    }
  } else {
    for (const userAddress of index.byUser.keys()) {
      removeAgreementFromUser(index, userAddress, agreementId);
    }
  }
  index.agreements.delete(agreementId);
}

function evictOldestAgreement(index: AgreementIndex) {
  const oldestAgreementId = index.agreements.keys().next().value as string | undefined;
  if (!oldestAgreementId) return;
  removeAgreement(index, oldestAgreementId);
}

function enforceMaxEntries(index: AgreementIndex) {
  while (index.agreements.size > index.maxEntries) {
    evictOldestAgreement(index);
  }
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
  removeAgreement(index, agreementId);
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
    enforceMaxEntries(index);
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

export function invalidateAgreement(contractAddress: string, agreementId: string) {
  const index = getOrCreateIndex(contractAddress);
  removeAgreement(index, agreementId);
}

export function clearIndex(contractAddress: string) {
  indices.delete(contractAddress);
}

export function clearAllIndices() {
  indices.clear();
}

export function markIndexSynced(contractAddress: string, blockNumber: number) {
  const index = getOrCreateIndex(contractAddress);
  index.lastSyncedBlock = Math.max(index.lastSyncedBlock, blockNumber);
}

export function getIndexStatus(
  contractAddress: string,
  currentBlock?: number,
  staleAfterBlocks = DEFAULT_STALE_AFTER_BLOCKS,
) {
  const index = getOrCreateIndex(contractAddress);
  const blocksBehind =
    currentBlock === undefined ? null : Math.max(0, currentBlock - index.lastSyncedBlock);
  return {
    contractAddress,
    agreementCount: index.agreements.size,
    userCount: index.byUser.size,
    lastSyncedBlock: index.lastSyncedBlock,
    maxEntries: index.maxEntries,
    blocksBehind,
    isStale: blocksBehind === null ? index.lastSyncedBlock === 0 : blocksBehind > staleAfterBlocks,
  };
}

export async function refreshIndexIfStale(
  contractAddress: string,
  currentBlock: number,
  refresh: () => Promise<void>,
  staleAfterBlocks = DEFAULT_STALE_AFTER_BLOCKS,
) {
  if (!getIndexStatus(contractAddress, currentBlock, staleAfterBlocks).isStale) {
    return false;
  }
  await refresh();
  markIndexSynced(contractAddress, currentBlock);
  return true;
}

export function configureIndex(contractAddress: string, options: { maxEntries?: number }) {
  const index = getOrCreateIndex(contractAddress);
  if (options.maxEntries !== undefined) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    index.maxEntries = options.maxEntries;
    enforceMaxEntries(index);
  }
}

export function getAllIndices(): Map<string, AgreementIndex> {
  return indices;
}
