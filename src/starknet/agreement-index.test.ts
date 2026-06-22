import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAgreementToIndex,
  clearAllIndices,
  clearIndex,
  configureIndex,
  getAgreementMetadata,
  getIndexStatus,
  getUserAgreements,
  invalidateAgreement,
  markIndexSynced,
  refreshIndexIfStale,
} from "./agreement-index.js";
import { normalizeStarknetAddress } from "../utils/address.js";

const CONTRACT = "0xabc";
const EMPLOYER = "0x1";
const CONTRIBUTOR = "0x2";

function addAgreement(id: string, employer = EMPLOYER, contributor = CONTRIBUTOR) {
  addAgreementToIndex(CONTRACT, id, employer, contributor, {
    status: 1,
    mode: 0,
    total_amount: "100",
    paid_amount: "0",
  });
}

describe("agreement-index", () => {
  beforeEach(() => {
    clearAllIndices();
  });

  it("indexes agreements by normalized employer and contributor", () => {
    addAgreement("agreement-1", "0x0001", "2");

    expect(getUserAgreements(CONTRACT, EMPLOYER)).toEqual(["agreement-1"]);
    expect(getUserAgreements(CONTRACT, CONTRIBUTOR)).toEqual(["agreement-1"]);
    expect(getAgreementMetadata(CONTRACT, "agreement-1")).toMatchObject({
      agreement_id: "agreement-1",
      employer: normalizeStarknetAddress(EMPLOYER),
      contributor: normalizeStarknetAddress(CONTRIBUTOR),
    });
  });

  it("keeps normalized users isolated", () => {
    addAgreement("agreement-1", "0x1", "0x2");
    addAgreement("agreement-2", "0x10", "0x20");

    expect(getUserAgreements(CONTRACT, "0x1")).toEqual(["agreement-1"]);
    expect(getUserAgreements(CONTRACT, "0x10")).toEqual(["agreement-2"]);
  });

  it("invalidates agreement metadata and user lookups", () => {
    addAgreement("agreement-1");

    invalidateAgreement(CONTRACT, "agreement-1");

    expect(getAgreementMetadata(CONTRACT, "agreement-1")).toBeUndefined();
    expect(getUserAgreements(CONTRACT, EMPLOYER)).toEqual([]);
    expect(getUserAgreements(CONTRACT, CONTRIBUTOR)).toEqual([]);
  });

  it("clears one contract index without clearing other contracts", () => {
    addAgreement("agreement-1");
    addAgreementToIndex("0xdef", "agreement-2", EMPLOYER, CONTRIBUTOR);

    clearIndex(CONTRACT);

    expect(getUserAgreements(CONTRACT, EMPLOYER)).toEqual([]);
    expect(getUserAgreements("0xdef", EMPLOYER)).toEqual(["agreement-2"]);
  });

  it("reports and refreshes stale indexes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);

    markIndexSynced(CONTRACT, 100);
    expect(getIndexStatus(CONTRACT, 120, 25).isStale).toBe(false);
    expect(await refreshIndexIfStale(CONTRACT, 120, refresh, 25)).toBe(false);

    expect(await refreshIndexIfStale(CONTRACT, 200, refresh, 25)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(getIndexStatus(CONTRACT, 200, 25)).toMatchObject({
      lastSyncedBlock: 200,
      blocksBehind: 0,
      isStale: false,
    });
  });

  it("evicts oldest metadata and user links when max entries is exceeded", () => {
    configureIndex(CONTRACT, { maxEntries: 2 });
    addAgreement("agreement-1");
    addAgreement("agreement-2");
    addAgreement("agreement-3");

    expect(getAgreementMetadata(CONTRACT, "agreement-1")).toBeUndefined();
    expect(getUserAgreements(CONTRACT, EMPLOYER)).toEqual(["agreement-2", "agreement-3"]);
    expect(getIndexStatus(CONTRACT)).toMatchObject({
      agreementCount: 2,
      maxEntries: 2,
    });
  });

  it("rejects invalid max entry limits", () => {
    expect(() => configureIndex(CONTRACT, { maxEntries: 0 })).toThrow(
      "maxEntries must be a positive integer",
    );
  });
});
