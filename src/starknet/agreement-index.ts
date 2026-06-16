/**
 * Agreement Index - In-memory cache for fast agreement lookups
 * 
 * This module maintains an index of agreements by user address for instant lookups.
 * It can be populated by:
 * 1. Listening to AgreementCreated events
 * 2. Scanning the contract on startup (one-time)
 * 3. Real-time updates when agreements are created
 */

type AgreementIndex = {
  // Map: user address (normalized) -> array of agreement IDs
  byUser: Map<string, Set<string>>;
  // Map: agreement ID -> agreement metadata
  agreements: Map<string, {
    agreement_id: string;
    employer: string;
    contributor: string;
    status: number;
    mode: number;
    total_amount: string;
    paid_amount: string;
  }>;
  // Last sync block number
  lastSyncedBlock: number;
  // Contract address
  contractAddress: string;
};

import { normalizeStarknetAddress } from "../utils/codec.js";

const normalizeAddress = normalizeStarknetAddress;

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
  }
) {
  const index = getOrCreateIndex(contractAddress);
  const normalizedEmployer = normalizeAddress(employer);
  const normalizedContributor = contributor && contributor !== "0x0" ? normalizeAddress(contributor) : null;

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

export function getUserAgreements(
  contractAddress: string,
  userAddress: string
): string[] {
  const index = getOrCreateIndex(contractAddress);
  const normalizedUser = normalizeAddress(userAddress);
  const agreementIds = index.byUser.get(normalizedUser);
  return agreementIds ? Array.from(agreementIds) : [];
}

export function getAgreementMetadata(
  contractAddress: string,
  agreementId: string
) {
  const index = getOrCreateIndex(contractAddress);
  return index.agreements.get(agreementId);
}

export function clearIndex(contractAddress: string) {
  indices.delete(contractAddress);
}

export function getAllIndices(): Map<string, AgreementIndex> {
  return indices;
}








