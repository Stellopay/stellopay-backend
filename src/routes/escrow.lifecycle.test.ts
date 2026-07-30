import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { agreementRouter } from "./agreement.js";
import { escrowRouter, clearEscrowIdempotencyStore } from "./escrow.js";
import { transactionsRouter } from "./transactions.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { normalizeStarknetAddress } from "../utils/address.js";

// Setup Express application mounting the relevant routers
const app = express();
app.use(express.json());
app.use(agreementRouter);
app.use(escrowRouter);
app.use(transactionsRouter);

describe("Escrow & Agreement End-to-End Lifecycle E2E", () => {
  const contractAddress = normalizeStarknetAddress(
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
  const escrowAddress = normalizeStarknetAddress(
    "0x0223456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
  const employerAddress = normalizeStarknetAddress(
    "0x0333333333333333333333333333333333333333333333333333333333333333"
  );
  const contributorAddress = normalizeStarknetAddress(
    "0x0444444444444444444444444444444444444444444444444444444444444444"
  );
  const tokenAddress = normalizeStarknetAddress(
    "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
  );

  const agreementId = "1001";
  const sessionToken = "valid_session_token_12345";
  const fundingAmount = "1000000000000000000"; // 1 token (18 decimals)

  beforeEach(async () => {
    clearEscrowIdempotencyStore();

    // Clean up test records
    await db.delete(schema.payments).where(eq(schema.payments.agreementId, agreementId));
    await db.delete(schema.escrowEvents).where(eq(schema.escrowEvents.agreementId, agreementId));
    await db.delete(schema.agreementEvents).where(eq(schema.agreementEvents.agreementId, agreementId));
    await db.delete(schema.agreements).where(eq(schema.agreements.id, agreementId));
  });

  it("drives the full agreement, funding, activation, event indexing, and release lifecycle", async () => {
    // -------------------------------------------------------------------------
    // Step 1: Seed Initial Agreement Record in Database
    // -------------------------------------------------------------------------
    await db.insert(schema.agreements).values({
      id: agreementId,
      contractAddress: contractAddress,
      employer: employerAddress,
      contributor: contributorAddress,
      token: tokenAddress,
      totalAmount: fundingAmount,
      paidAmount: "0",
      status: 0, // Pending / Unfunded
      mode: 0,   // Escrow mode
      createdAt: new Date(),
    });

    // Verify seeded state via GET route
    const statusRes = await request(app)
      .get(`/agreement/${contractAddress}/get_status/${agreementId}`)
      .expect(200);

    expect(statusRes.body).toEqual({
      agreement_id: agreementId,
      status: 0,
      source: "indexed",
    });

    // -------------------------------------------------------------------------
    // Step 2: Failure Branch - Attempt release before funding
    // -------------------------------------------------------------------------
    const releasePayload = {
      wallet_address: employerAddress,
      session_token: sessionToken,
      agreement_id: agreementId,
      to: contributorAddress,
      amount: fundingAmount,
    };

    const failReleaseRes = await request(app)
      .post(`/prepare/escrow/${escrowAddress}/release`)
      .set("Idempotency-Key", "idempotency-key-early-release")
      .send(releasePayload)
      .expect(400);

    expect(failReleaseRes.body).toEqual({
      error: "Insufficient agreement balance",
    });

    // Confirm DB state remains unaltered
    const dbPaymentsBefore = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.agreementId, agreementId));
    expect(dbPaymentsBefore).toHaveLength(0);

    // -------------------------------------------------------------------------
    // Step 3: Funding Phase
    // -------------------------------------------------------------------------
    const fundPrepRes = await request(app)
      .post(`/prepare/escrow/${escrowAddress}/fund_agreement`)
      .send({
        wallet_address: employerAddress,
        session_token: sessionToken,
        agreement_id: agreementId,
        employer: employerAddress,
        amount: fundingAmount,
      })
      .expect(200);

    expect(fundPrepRes.body).toHaveProperty("call");

    // Index the Funded event (simulating indexer processing on-chain event)
    await db.insert(schema.escrowEvents).values({
      id: "tx_fund_1001_0",
      contractAddress: escrowAddress,
      agreementId: agreementId,
      eventType: "Funded",
      amount: fundingAmount,
      employer: employerAddress,
      to: escrowAddress,
      blockNumber: 100,
      transactionHash: "0xfund1001hash",
      createdAt: new Date(),
    });

    // Verify balance is now updated via API
    const balanceRes = await request(app)
      .get(`/escrow/${escrowAddress}/get_agreement_balance/${agreementId}`)
      .expect(200);

    expect(balanceRes.body).toEqual({
      agreement_id: agreementId,
      balance: fundingAmount,
      source: "indexed",
    });

    // -------------------------------------------------------------------------
    // Step 4: Agreement Activation
    // -------------------------------------------------------------------------
    await request(app)
      .post(`/prepare/agreement/${contractAddress}/activate`)
      .send({
        wallet_address: employerAddress,
        session_token: sessionToken,
        agreement_id: agreementId,
      })
      .expect(200);

    // Update agreement status and index Activation event
    await db
      .update(schema.agreements)
      .set({ status: 1 }) // 1 = Active
      .where(eq(schema.agreements.id, agreementId));

    await db.insert(schema.agreementEvents).values({
      id: "tx_act_1001_0",
      contractAddress: contractAddress,
      agreementId: agreementId,
      eventType: "AgreementActivated",
      blockNumber: 101,
      transactionHash: "0xact1001hash",
      createdAt: new Date(),
    });

    // -------------------------------------------------------------------------
    // Step 5: Payment Release Phase
    // -------------------------------------------------------------------------
    const releasePrepRes = await request(app)
      .post(`/prepare/escrow/${escrowAddress}/release`)
      .set("Idempotency-Key", "idempotency-key-valid-release")
      .send(releasePayload)
      .expect(200);

    expect(releasePrepRes.body).toHaveProperty("call");

    // Index Released and PaymentSent events upon transaction execution
    await db.insert(schema.escrowEvents).values({
      id: "tx_rel_1001_0",
      contractAddress: escrowAddress,
      agreementId: agreementId,
      eventType: "Released",
      amount: fundingAmount,
      employer: employerAddress,
      to: contributorAddress,
      blockNumber: 102,
      transactionHash: "0xrel1001hash",
      createdAt: new Date(),
    });

    await db.insert(schema.payments).values({
      id: "tx_pay_1001_0",
      agreementId: agreementId,
      contractAddress: contractAddress,
      eventType: "PaymentSent",
      from: employerAddress,
      to: contributorAddress,
      token: tokenAddress,
      amount: fundingAmount,
      blockNumber: 102,
      transactionHash: "0xrel1001hash",
      createdAt: new Date(),
    });

    await db
      .update(schema.agreements)
      .set({ paidAmount: fundingAmount, status: 2 }) // 2 = Completed
      .where(eq(schema.agreements.id, agreementId));

    // -------------------------------------------------------------------------
    // Step 6: Final Assertions Across Routers & Unified Feed
    // -------------------------------------------------------------------------
    // 1. Escrow balance should now resolve to 0
    const finalBalanceRes = await request(app)
      .get(`/escrow/${escrowAddress}/get_agreement_balance/${agreementId}`)
      .expect(200);

    expect(finalBalanceRes.body.balance).toBe("0");

    // 2. Agreement status should be Completed (2)
    const finalStatusRes = await request(app)
      .get(`/agreement/${contractAddress}/get_status/${agreementId}`)
      .expect(200);

    expect(finalStatusRes.body.status).toBe(2);

    // 3. Transactions route should reflect all merged events
    const txFeedRes = await request(app)
      .get(`/transactions/${employerAddress}`)
      .expect(200);

    expect(txFeedRes.body.total).toBeGreaterThanOrEqual(3);
    const txTypes = txFeedRes.body.transactions.map((t: { type: string }) => t.type);
    expect(txTypes).toContain("Agreement Activated");
    expect(txTypes).toContain("Agreement Funded");
    expect(txTypes).toContain("Payment Sent");
  });
});