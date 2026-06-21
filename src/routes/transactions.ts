import { Router } from "express";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, and, or, desc, gte, lte, inArray, sql, count } from "drizzle-orm";
import { agreementContract } from "../starknet/client.js";
import { toHexString } from "../utils/codec.js";
import { normalizeStarknetAddress as normalizeAddr } from "../utils/address.js";
import { env } from "../config.js";

const AddressParam = z.string().min(3);

export const transactionsRouter = Router();

/**
 * Emits verbose token-matching and fetch diagnostics only when LOG_LEVEL is set
 * to "debug". These lines are noisy on the request hot path and can include
 * token addresses, so at the default "info" level, and in production, they stay
 * silent: this keeps sensitive routing data out of default-level logs and stops
 * the per-request flood that previously ran on every transaction list. Genuine
 * failures still use console.error and console.warn so errors stay visible.
 *
 * @param args - Values forwarded to console.debug when debug logging is on.
 */
function debugLog(...args: unknown[]): void {
  if (env.LOG_LEVEL === "debug") {
    console.debug(...args);
  }
}

// Helper to format address for display (truncate like 0x1234...5678)
function formatAddress(addr: string): string {
  if (!addr || addr === "N/A") return addr;
  const normalized = normalizeAddr(addr);
  if (normalized.length <= 10) return normalized;
  // Show first 6 chars and last 4 chars
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

// Token addresses from environment variables (with defaults)
const STRK_TOKEN_ADDRESS =
  env.TOKEN_STRK || "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const USDC_TOKEN_ADDRESS =
  env.TOKEN_USDC || "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080";
const USDT_TOKEN_ADDRESS =
  env.TOKEN_USDT || "0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb";

// Normalize token addresses once at module load
const NORMALIZED_STRK = normalizeAddr(STRK_TOKEN_ADDRESS);
const NORMALIZED_USDC = normalizeAddr(USDC_TOKEN_ADDRESS);
const NORMALIZED_USDT = normalizeAddr(USDT_TOKEN_ADDRESS);

// Log known token addresses on module load (debug level only)
debugLog(`[transactions] Known token addresses configured:`);
debugLog(`  - STRK: ${STRK_TOKEN_ADDRESS} (normalized: ${NORMALIZED_STRK})`);
debugLog(`  - USDC: ${USDC_TOKEN_ADDRESS} (normalized: ${NORMALIZED_USDC})`);
debugLog(`  - USDT: ${USDT_TOKEN_ADDRESS} (normalized: ${NORMALIZED_USDT})`);

// Helper to get token info from token address
function getTokenInfo(tokenAddress: string | null | undefined): {
  name: string;
  icon: string;
  decimals: number;
  isSTRK: boolean;
} {
  if (!tokenAddress) {
    debugLog(`[transactions] getTokenInfo: No token address provided, returning "-"`);
    return { name: "-", icon: "", decimals: 0, isSTRK: false };
  }

  const normalized = normalizeAddr(tokenAddress);

  debugLog(`[transactions] getTokenInfo: Comparing token ${normalized}`);
  debugLog(
    `[transactions]   vs STRK: ${NORMALIZED_STRK} (match: ${normalized === NORMALIZED_STRK})`,
  );
  debugLog(
    `[transactions]   vs USDC: ${NORMALIZED_USDC} (match: ${normalized === NORMALIZED_USDC})`,
  );
  debugLog(
    `[transactions]   vs USDT: ${NORMALIZED_USDT} (match: ${normalized === NORMALIZED_USDT})`,
  );

  if (normalized === NORMALIZED_STRK) {
    debugLog(`[transactions] getTokenInfo: Identified as STRK`);
    return {
      name: "STRK",
      icon: "/strk-logo.png", // Update with actual icon path
      decimals: 18, // STRK uses 18 decimals
      isSTRK: true,
    };
  } else if (normalized === NORMALIZED_USDC) {
    debugLog(`[transactions] getTokenInfo: Identified as USDC`);
    return {
      name: "USDC",
      icon: "/usdc-logo.png",
      decimals: 6, // USDC uses 6 decimals
      isSTRK: false,
    };
  } else if (normalized === NORMALIZED_USDT) {
    debugLog(`[transactions] getTokenInfo: Identified as USDT`);
    return {
      name: "USDT",
      icon: "/usdt-logo.png",
      decimals: 6, // USDT uses 6 decimals
      isSTRK: false,
    };
  }

  // Default to USDC format for unknown tokens
  debugLog(`[transactions] getTokenInfo: Unknown token, defaulting to USDC format`);
  return {
    name: "USDC",
    icon: "/usdc-logo.png",
    decimals: 6,
    isSTRK: false,
  };
}

// Helper to format amount based on token type
function formatAmount(
  amount: string | bigint,
  tokenInfo: { name: string; decimals: number; isSTRK: boolean },
): string {
  if (!amount || amount === "0" || amount === BigInt(0)) {
    debugLog(`[transactions] formatAmount: Amount is zero or empty, returning "-"`);
    return "-";
  }

  const amountBigInt = typeof amount === "string" ? BigInt(amount) : amount;
  const divisor = BigInt(10 ** tokenInfo.decimals);
  const wholePart = amountBigInt / divisor;
  const fractionalPart = amountBigInt % divisor;

  debugLog(`[transactions] formatAmount: Processing amount`);
  debugLog(`  - Raw amount: ${amount} (type: ${typeof amount})`);
  debugLog(`  - Amount as BigInt: ${amountBigInt.toString()}`);
  debugLog(`  - Token decimals: ${tokenInfo.decimals}`);
  debugLog(`  - Divisor: ${divisor.toString()}`);
  debugLog(`  - Whole part: ${wholePart.toString()}`);
  debugLog(`  - Fractional part: ${fractionalPart.toString()}`);

  if (tokenInfo.isSTRK) {
    // Format STRK: show decimals like "0.434 strk"
    const fractionalStr = fractionalPart.toString().padStart(tokenInfo.decimals, "0");
    // Remove trailing zeros
    const fractionalTrimmed = fractionalStr.replace(/0+$/, "");
    if (fractionalTrimmed === "") {
      const result = `${wholePart.toString()} ${tokenInfo.name}`;
      debugLog(`[transactions] formatAmount: STRK result (no fractional): ${result}`);
      return result;
    }
    // Show up to 6 significant digits in fractional part
    const fractionalDisplay = fractionalTrimmed.slice(0, 6);
    const result = `${wholePart.toString()}.${fractionalDisplay} ${tokenInfo.name}`;
    debugLog(`[transactions] formatAmount: STRK result: ${result}`);
    return result;
  } else {
    // Format USDC: show as dollar amount
    const amountNum = Number(amountBigInt) / Number(divisor);
    const result = `$${amountNum.toFixed(2)}`;
    debugLog(`[transactions] formatAmount: USDC/USDT calculation:`);
    debugLog(`  - Amount as number: ${amountNum}`);
    debugLog(`  - Result: ${result}`);
    return result;
  }
}

// Check if event type is fund-related
function isFundRelatedEvent(eventType: string): boolean {
  return eventType === "Funded" || eventType === "Released" || eventType === "Refunded";
}

// Cache for token addresses to avoid repeated contract calls
const tokenCache = new Map<string, { token: string; timestamp: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Helper to fetch token from agreement contract
async function getTokenFromAgreementContract(
  agreementContractAddress: string,
  agreementId: string,
): Promise<string | null> {
  const cacheKey = `${agreementContractAddress}:${agreementId}`;
  const cached = tokenCache.get(cacheKey);

  // Return cached value if still valid
  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
    debugLog(`[transactions] Using cached token for agreement ${agreementId}: ${cached.token}`);
    return cached.token;
  }

  try {
    debugLog(
      `[transactions] Fetching token from agreement contract ${agreementContractAddress} for agreement ${agreementId}`,
    );
    const c = agreementContract(agreementContractAddress);
    const out = await c.get_token(agreementId);
    const tokenAddress = toHexString(out);
    const normalizedToken = normalizeAddr(tokenAddress);

    debugLog(`[transactions] Successfully fetched token for agreement ${agreementId}:`);
    debugLog(`  - Raw token: ${tokenAddress}`);
    debugLog(`  - Normalized token: ${normalizedToken}`);
    debugLog(`  - Token info: ${JSON.stringify(getTokenInfo(normalizedToken))}`);

    // Cache the result
    tokenCache.set(cacheKey, { token: normalizedToken, timestamp: Date.now() });

    return normalizedToken;
  } catch (error: any) {
    console.error(
      `[transactions] Failed to fetch token from agreement contract ${agreementContractAddress} for agreement ${agreementId}:`,
      error,
    );
    console.error(`[transactions] Error details:`, {
      message: error?.message,
      stack: error?.stack,
      agreementContractAddress,
      agreementId,
    });
    return null;
  }
}

// Batch fetch tokens for multiple agreements
async function batchGetTokensFromAgreementContracts(
  agreements: Array<{ agreementContractAddress: string; agreementId: string }>,
): Promise<Map<string, string>> {
  debugLog(`[transactions] Batch fetching tokens for ${agreements.length} agreements`);
  const tokenMap = new Map<string, string>();
  const uncachedAgreements: Array<{
    agreementContractAddress: string;
    agreementId: string;
    key: string;
  }> = [];

  // Check cache first
  for (const agreement of agreements) {
    const cacheKey = `${agreement.agreementContractAddress}:${agreement.agreementId}`;
    const cached = tokenCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL_MS) {
      debugLog(
        `[transactions] Using cached token for agreement ${agreement.agreementId}: ${cached.token}`,
      );
      tokenMap.set(agreement.agreementId, cached.token);
    } else {
      uncachedAgreements.push({ ...agreement, key: cacheKey });
    }
  }

  debugLog(
    `[transactions] Need to fetch ${uncachedAgreements.length} tokens from contracts (${agreements.length - uncachedAgreements.length} from cache)`,
  );

  // Fetch uncached tokens in parallel (limit concurrency to avoid overwhelming RPC)
  const BATCH_SIZE = 10;
  for (let i = 0; i < uncachedAgreements.length; i += BATCH_SIZE) {
    const batch = uncachedAgreements.slice(i, i + BATCH_SIZE);
    debugLog(
      `[transactions] Fetching batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} agreements)`,
    );
    const fetchPromises = batch.map(async (agreement) => {
      try {
        const token = await getTokenFromAgreementContract(
          agreement.agreementContractAddress,
          agreement.agreementId,
        );
        if (token) {
          tokenMap.set(agreement.agreementId, token);
        } else {
          console.warn(`[transactions] No token returned for agreement ${agreement.agreementId}`);
        }
      } catch (error) {
        console.error(
          `[transactions] Error in batch fetch for agreement ${agreement.agreementId}:`,
          error,
        );
      }
    });

    await Promise.all(fetchPromises);
  }

  debugLog(
    `[transactions] Batch fetch complete. Got ${tokenMap.size} tokens out of ${agreements.length} agreements`,
  );
  return tokenMap;
}

// Format date helper
function formatDate(date: Date) {
  const d = new Date(date);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sept",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const mins = minutes.toString().padStart(2, "0");
  return {
    date: `${month} ${day}, ${year}`,
    time: `${hour12}:${mins}${ampm}`,
  };
}

// Helper function to format event type for display
function formatEventType(eventType: string): string {
  const eventTypeMap: Record<string, string> = {
    // WorkAgreement events
    AgreementCreated: "Agreement Created",
    AgreementActivated: "Agreement Activated",
    AgreementPaused: "Agreement Paused",
    AgreementResumed: "Agreement Resumed",
    AgreementCancelled: "Agreement Cancelled",
    AgreementCompleted: "Agreement Completed",
    AgreementStatusChange: "Agreement Status Changed",
    PaymentSent: "Payment Sent",
    PaymentReceived: "Payment Received",
    MilestoneAdded: "Milestone Added",
    MilestoneApproved: "Milestone Approved",
    MilestoneClaimed: "Milestone Claimed",
    EmployeeAdded: "Employee Added",
    PayrollClaimed: "Payroll Claimed",
    DisputeRaised: "Dispute Raised",
    DisputeResolved: "Dispute Resolved",
    // PayrollEscrow events
    Funded: "Agreement Funded",
    Released: "Payment Released",
    Refunded: "Refund Received",
    // Fallback for unknown events
    Unknown: "Unknown Event",
  };
  return eventTypeMap[eventType] || eventType.replace(/([A-Z])/g, " $1").trim();
}

// Get all transactions for a user (from payments and escrow events)
transactionsRouter.get("/transactions/:user_address", async (req, res, next) => {
  try {
    const userAddress = normalizeAddr(req.params.user_address);
    const requestedLimit =
      z.coerce.number().int().positive().optional().parse(req.query.limit) || 50;
    const limit = Math.min(requestedLimit, 100);
    const offset = z.coerce.number().int().nonnegative().optional().parse(req.query.offset) || 0;
    const queryLimit = offset + limit;

    // Get filter for event types (comma-separated list)
    const eventTypesFilter = req.query.eventTypes
      ? (req.query.eventTypes as string)
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : null;

    // Get payments where user is sender or receiver
    const paymentConditions = [
      or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
    ];
    // Apply event type filter if provided
    if (eventTypesFilter && eventTypesFilter.length > 0) {
      const paymentEventTypes = eventTypesFilter.filter(
        (et) => et === "PaymentSent" || et === "PaymentReceived",
      );
      if (paymentEventTypes.length > 0) {
        paymentConditions.push(inArray(schema.payments.eventType, paymentEventTypes));
      } else {
        // If filter is active but no matching event types for this table, ensure it returns empty
        paymentConditions.push(sql`FALSE`);
      }
    }

    // Get escrow events where user is employer or recipient
    const escrowConditions = [
      or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress)),
    ];
    // Apply event type filter if provided
    if (eventTypesFilter && eventTypesFilter.length > 0) {
      const escrowEventTypes = eventTypesFilter.filter(
        (et) => et === "Funded" || et === "Released" || et === "Refunded",
      );
      if (escrowEventTypes.length > 0) {
        escrowConditions.push(inArray(schema.escrowEvents.eventType, escrowEventTypes));
      } else {
        escrowConditions.push(sql`FALSE`);
      }
    }

    const agreementEventConditions =
      eventTypesFilter && eventTypesFilter.length > 0
        ? and(
            or(...eventTypesFilter.map((et) => eq(schema.agreementEvents.eventType, et))),
            or(
              eq(schema.agreements.employer, userAddress),
              eq(schema.agreements.contributor, userAddress),
            ),
          )
        : or(
            eq(schema.agreements.employer, userAddress),
            eq(schema.agreements.contributor, userAddress),
          );

    const employeeConditions = [
      or(
        eq(schema.agreements.employer, userAddress),
        eq(schema.employees.employeeAddress, userAddress),
      ),
    ];
    if (eventTypesFilter && eventTypesFilter.length > 0) {
      if (!eventTypesFilter.includes("EmployeeAdded")) {
        employeeConditions.push(sql`FALSE`);
      }
    }

    const milestoneConditions = [
      or(
        eq(schema.agreements.employer, userAddress),
        eq(schema.agreements.contributor, userAddress),
      ),
    ];
    if (eventTypesFilter && eventTypesFilter.length > 0) {
      if (!eventTypesFilter.includes("MilestoneAdded")) {
        milestoneConditions.push(sql`FALSE`);
      }
    }

    const [paymentsCount, escrowCount, agreementEventsCount, employeesCount, milestonesCount] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(schema.payments)
          .where(and(...paymentConditions)),
        db
          .select({ count: count() })
          .from(schema.escrowEvents)
          .where(and(...escrowConditions)),
        db
          .select({ count: count() })
          .from(schema.agreementEvents)
          .innerJoin(
            schema.agreements,
            eq(schema.agreementEvents.agreementId, schema.agreements.id),
          )
          .where(agreementEventConditions),
        db
          .select({ count: count() })
          .from(schema.employees)
          .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
          .where(and(...employeeConditions)),
        db
          .select({ count: count() })
          .from(schema.milestones)
          .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
          .where(and(...milestoneConditions)),
      ]);

    const total =
      Number(paymentsCount[0].count) +
      Number(escrowCount[0].count) +
      Number(agreementEventsCount[0].count) +
      Number(employeesCount[0].count) +
      Number(milestonesCount[0].count);

    const payments = await db
      .select()
      .from(schema.payments)
      .where(and(...paymentConditions))
      .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
      .limit(queryLimit);

    const escrowEvents = await db
      .select()
      .from(schema.escrowEvents)
      .where(and(...escrowConditions))
      .orderBy(desc(schema.escrowEvents.createdAt), desc(schema.escrowEvents.id))
      .limit(queryLimit);

    const agreementEvents = await db
      .select({
        id: schema.agreementEvents.id,
        agreementId: schema.agreementEvents.agreementId,
        contractAddress: schema.agreementEvents.contractAddress,
        eventType: schema.agreementEvents.eventType,
        blockNumber: schema.agreementEvents.blockNumber,
        transactionHash: schema.agreementEvents.transactionHash,
        createdAt: schema.agreementEvents.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
      })
      .from(schema.agreementEvents)
      .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
      .where(agreementEventConditions)
      .orderBy(desc(schema.agreementEvents.createdAt), desc(schema.agreementEvents.id))
      .limit(queryLimit);

    const employeeEventsData = await db
      .select({
        id: schema.employees.id,
        agreementId: schema.employees.agreementId,
        contractAddress: schema.employees.contractAddress,
        blockNumber: schema.employees.blockNumber,
        transactionHash: schema.employees.transactionHash,
        createdAt: schema.employees.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
        employeeAddress: schema.employees.employeeAddress,
        amount: schema.employees.salaryPerPeriod,
      })
      .from(schema.employees)
      .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
      .where(and(...employeeConditions))
      .orderBy(desc(schema.employees.createdAt), desc(schema.employees.id))
      .limit(queryLimit);

    const milestoneEventsData = await db
      .select({
        id: schema.milestones.id,
        agreementId: schema.milestones.agreementId,
        contractAddress: schema.milestones.contractAddress,
        blockNumber: schema.milestones.blockNumber,
        transactionHash: schema.milestones.transactionHash,
        createdAt: schema.milestones.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
        amount: schema.milestones.amount,
      })
      .from(schema.milestones)
      .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
      .where(and(...milestoneConditions))
      .orderBy(desc(schema.milestones.createdAt), desc(schema.milestones.id))
      .limit(queryLimit);

    const employeeEvents = employeeEventsData.map((e) => ({
      ...e,
      eventType: "EmployeeAdded" as const,
    }));
    const milestoneEvents = milestoneEventsData.map((m) => ({
      ...m,
      eventType: "MilestoneAdded" as const,
    }));

    const uniqueAgreementEvents = Array.from(
      new Map(agreementEvents.map((a) => [a.id, a])).values(),
    );

    const agreementIds = [...new Set(escrowEvents.map((e) => e.agreementId))];

    const agreements =
      agreementIds.length > 0
        ? await db
            .select({
              id: schema.agreements.id,
              token: schema.agreements.token,
              contractAddress: schema.agreements.contractAddress, // This is the agreement contract address
            })
            .from(schema.agreements)
            .where(inArray(schema.agreements.id, agreementIds))
        : [];

    // Fetch tokens from agreement contracts
    const agreementsForTokenFetch = agreements
      .filter((a) => a.contractAddress) // Only if we have contract address
      .map((a) => ({
        agreementContractAddress: a.contractAddress!,
        agreementId: a.id,
      }));

    const contractTokenMap = await batchGetTokensFromAgreementContracts(agreementsForTokenFetch);

    // Create final map: agreementId -> tokenAddress (prefer contract, fallback to database)
    const tokenMap = new Map<string, string>();
    for (const agreement of agreements) {
      const contractToken = contractTokenMap.get(agreement.id);
      const dbToken = agreement.token;
      tokenMap.set(agreement.id, contractToken || dbToken);
    }

    const formatEventType = (eventType: string): string => {
      const eventTypeMap: Record<string, string> = {
        AgreementCreated: "Agreement Created",
        AgreementActivated: "Agreement Activated",
        AgreementPaused: "Agreement Paused",
        AgreementResumed: "Agreement Resumed",
        AgreementCancelled: "Agreement Cancelled",
        AgreementCompleted: "Agreement Completed",
        EmployeeAdded: "Employee Added",
        MilestoneAdded: "Milestone Added",
        MilestoneApproved: "Milestone Approved",
        MilestoneClaimed: "Milestone Claimed",
        PayrollClaimed: "Payroll Claimed",
        DisputeRaised: "Dispute Raised",
        DisputeResolved: "Dispute Resolved",
      };
      return eventTypeMap[eventType] || eventType;
    };

    const allTransactions = [
      ...uniqueAgreementEvents.map((a) => {
        const dateTime = formatDate(a.createdAt);
        return {
          id: a.transactionHash.slice(0, 10),
          type: formatEventType(a.eventType),
          address: formatAddress(a.employer === userAddress ? a.contributor || "N/A" : a.employer),
          date: dateTime.date,
          time: dateTime.time,
          token: "-",
          amount: "-",
          status: "Completed" as const,
          tokenIcon: "",
          txHash: a.transactionHash,
          createdAt: a.createdAt, // Add for sorting
        };
      }),
      ...payments.map((p) => {
        const dateTime = formatDate(p.createdAt);
        const tokenInfo = getTokenInfo(p.token);
        const amountStr = formatAmount(p.amount, tokenInfo);
        const isReceived = p.eventType === "PaymentReceived";
        const sign = isReceived ? "+" : "-";
        const finalAmount = amountStr !== "-" ? `${sign}${amountStr}` : amountStr;

        return {
          id: p.transactionHash.slice(0, 10),
          type: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
          address: formatAddress(isReceived ? p.from : p.to),
          date: dateTime.date,
          time: dateTime.time,
          token: tokenInfo.name,
          amount: finalAmount,
          status: "Completed" as const,
          tokenIcon: tokenInfo.icon,
          txHash: p.transactionHash,
          createdAt: p.createdAt, // Add for sorting
        };
      }),
      ...escrowEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const tokenAddress = tokenMap.get(e.agreementId) || null;
        const tokenInfo = getTokenInfo(tokenAddress);
        const amountStr = formatAmount(e.amount, tokenInfo);
        const isIncoming = e.eventType === "Released" || e.eventType === "Refunded";
        const sign = isIncoming ? "+" : "-";
        const finalAmount = amountStr !== "-" ? `${sign}${amountStr}` : amountStr;

        return {
          id: e.transactionHash.slice(0, 10),
          type:
            e.eventType === "Funded"
              ? "Agreement Funded"
              : e.eventType === "Released"
                ? "Payment Released"
                : "Refund Received",
          address: formatAddress(e.eventType === "Funded" ? e.employer : e.to || ""),
          date: dateTime.date,
          time: dateTime.time,
          token: tokenInfo.name,
          amount: finalAmount,
          status: "Completed" as const,
          tokenIcon: tokenInfo.icon,
          txHash: e.transactionHash,
          createdAt: e.createdAt, // Add for sorting
        };
      }),
      ...employeeEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const address =
          e.employer === userAddress
            ? e.employeeAddress || "N/A"
            : e.employer || e.employeeAddress || "N/A";
        return {
          id: e.transactionHash.slice(0, 10),
          type: "Employee Added",
          address: formatAddress(address),
          date: dateTime.date,
          time: dateTime.time,
          token: "-",
          amount: "-",
          status: "Completed" as const,
          tokenIcon: "",
          txHash: e.transactionHash,
          createdAt: e.createdAt, // Add for sorting
        };
      }),
      ...milestoneEvents.map((m) => {
        const dateTime = formatDate(m.createdAt);
        const address = m.employer === userAddress ? m.contributor || "N/A" : m.employer || "N/A";
        return {
          id: m.transactionHash.slice(0, 10),
          type: "Milestone Added",
          address: formatAddress(address),
          date: dateTime.date,
          time: dateTime.time,
          token: "-",
          amount: "-",
          status: "Completed" as const,
          tokenIcon: "",
          txHash: m.transactionHash,
          createdAt: m.createdAt, // Add for sorting
        };
      }),
    ].sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.txHash.localeCompare(b.txHash);
    });

    const paginatedTransactions = allTransactions.slice(offset, offset + limit);
    const hasMore = total > offset + limit;

    res.json({ transactions: paginatedTransactions, total, hasMore, limit, offset });
  } catch (e) {
    next(e);
  }
});
transactionsRouter.get("/transactions/:user_address/filtered", async (req, res, next) => {
  try {
    const userAddress = normalizeAddr(req.params.user_address);
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
    const requestedLimit =
      z.coerce.number().int().positive().optional().parse(req.query.limit) || 50;
    const limit = Math.min(requestedLimit, 100);
    const offset = z.coerce.number().int().nonnegative().optional().parse(req.query.offset) || 0;
    const queryLimit = offset + limit;

    // Build where conditions
    const paymentConditions = [
      or(eq(schema.payments.from, userAddress), eq(schema.payments.to, userAddress)),
    ];
    const escrowConditions = [
      or(eq(schema.escrowEvents.employer, userAddress), eq(schema.escrowEvents.to, userAddress)),
    ];
    const agreementEventConditions = [
      or(
        eq(schema.agreements.employer, userAddress),
        eq(schema.agreements.contributor, userAddress),
      ),
    ];

    if (startDate) {
      paymentConditions.push(gte(schema.payments.createdAt, startDate));
      escrowConditions.push(gte(schema.escrowEvents.createdAt, startDate));
      agreementEventConditions.push(gte(schema.agreementEvents.createdAt, startDate));
    }
    if (endDate) {
      paymentConditions.push(lte(schema.payments.createdAt, endDate));
      escrowConditions.push(lte(schema.escrowEvents.createdAt, endDate));
      agreementEventConditions.push(lte(schema.agreementEvents.createdAt, endDate));
    }

    const employeeConditions = [eq(schema.employees.employeeAddress, userAddress)];
    const milestoneConditions = [
      or(
        eq(schema.agreements.employer, userAddress),
        eq(schema.agreements.contributor, userAddress),
      ),
    ];

    if (startDate) {
      employeeConditions.push(gte(schema.employees.createdAt, startDate));
      milestoneConditions.push(gte(schema.milestones.createdAt, startDate));
    }
    if (endDate) {
      employeeConditions.push(lte(schema.employees.createdAt, endDate));
      milestoneConditions.push(lte(schema.milestones.createdAt, endDate));
    }

    const [paymentsCount, escrowCount, agreementEventsCount, employeesCount, milestonesCount] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(schema.payments)
          .where(and(...paymentConditions)),
        db
          .select({ count: count() })
          .from(schema.escrowEvents)
          .where(and(...escrowConditions)),
        db
          .select({ count: count() })
          .from(schema.agreementEvents)
          .innerJoin(
            schema.agreements,
            eq(schema.agreementEvents.agreementId, schema.agreements.id),
          )
          .where(and(...agreementEventConditions)),
        db
          .select({ count: count() })
          .from(schema.employees)
          .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
          .where(and(...employeeConditions)),
        db
          .select({ count: count() })
          .from(schema.milestones)
          .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
          .where(and(...milestoneConditions)),
      ]);

    const total =
      Number(paymentsCount[0].count) +
      Number(escrowCount[0].count) +
      Number(agreementEventsCount[0].count) +
      Number(employeesCount[0].count) +
      Number(milestonesCount[0].count);

    const [payments, escrowEvents, employeeEventsData, milestoneEventsData] = await Promise.all([
      db
        .select()
        .from(schema.payments)
        .where(and(...paymentConditions))
        .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
        .limit(queryLimit),
      db
        .select()
        .from(schema.escrowEvents)
        .where(and(...escrowConditions))
        .orderBy(desc(schema.escrowEvents.createdAt), desc(schema.escrowEvents.id))
        .limit(queryLimit),
      db
        .select({
          id: schema.employees.id,
          agreementId: schema.employees.agreementId,
          contractAddress: schema.employees.contractAddress,
          blockNumber: schema.employees.blockNumber,
          transactionHash: schema.employees.transactionHash,
          createdAt: schema.employees.createdAt,
          employer: schema.agreements.employer,
          contributor: schema.agreements.contributor,
          token: schema.agreements.token,
          employeeAddress: schema.employees.employeeAddress,
          amount: schema.employees.salaryPerPeriod,
        })
        .from(schema.employees)
        .leftJoin(schema.agreements, eq(schema.employees.agreementId, schema.agreements.id))
        .where(and(...employeeConditions))
        .orderBy(desc(schema.employees.createdAt), desc(schema.employees.id))
        .limit(queryLimit),
      db
        .select({
          id: schema.milestones.id,
          agreementId: schema.milestones.agreementId,
          contractAddress: schema.milestones.contractAddress,
          blockNumber: schema.milestones.blockNumber,
          transactionHash: schema.milestones.transactionHash,
          createdAt: schema.milestones.createdAt,
          employer: schema.agreements.employer,
          contributor: schema.agreements.contributor,
          token: schema.agreements.token,
          amount: schema.milestones.amount,
        })
        .from(schema.milestones)
        .leftJoin(schema.agreements, eq(schema.milestones.agreementId, schema.agreements.id))
        .where(and(...milestoneConditions))
        .orderBy(desc(schema.milestones.createdAt), desc(schema.milestones.id))
        .limit(queryLimit),
    ]);

    const employeeEvents = employeeEventsData.map((e) => ({
      ...e,
      eventType: "EmployeeAdded" as const,
    }));
    const milestoneEvents = milestoneEventsData.map((m) => ({
      ...m,
      eventType: "MilestoneAdded" as const,
    }));

    const escrowAgreementIds = [...new Set(escrowEvents.map((e) => e.agreementId))];

    const escrowAgreements =
      escrowAgreementIds.length > 0
        ? await db
            .select({
              id: schema.agreements.id,
              token: schema.agreements.token,
              contractAddress: schema.agreements.contractAddress,
            })
            .from(schema.agreements)
            .where(inArray(schema.agreements.id, escrowAgreementIds))
        : [];

    const agreementsForTokenFetch = escrowAgreements
      .filter((a) => a.contractAddress)
      .map((a) => ({
        agreementContractAddress: a.contractAddress!,
        agreementId: a.id,
      }));

    const contractTokenMap = await batchGetTokensFromAgreementContracts(agreementsForTokenFetch);

    const escrowTokenMap = new Map<string, string>();
    for (const agreement of escrowAgreements) {
      const contractToken = contractTokenMap.get(agreement.id);
      const dbToken = agreement.token;
      const finalToken = contractToken || dbToken;
      escrowTokenMap.set(agreement.id, finalToken);
    }

    const agreementEvents = await db
      .select({
        id: schema.agreementEvents.id,
        agreementId: schema.agreementEvents.agreementId,
        contractAddress: schema.agreementEvents.contractAddress,
        eventType: schema.agreementEvents.eventType,
        blockNumber: schema.agreementEvents.blockNumber,
        transactionHash: schema.agreementEvents.transactionHash,
        createdAt: schema.agreementEvents.createdAt,
        employer: schema.agreements.employer,
        contributor: schema.agreements.contributor,
        token: schema.agreements.token,
      })
      .from(schema.agreementEvents)
      .innerJoin(schema.agreements, eq(schema.agreementEvents.agreementId, schema.agreements.id))
      .where(and(...agreementEventConditions))
      .orderBy(desc(schema.agreementEvents.createdAt), desc(schema.agreementEvents.id))
      .limit(queryLimit);

    const allTransactions = [
      ...agreementEvents.map((a) => {
        const dateTime = formatDate(a.createdAt);
        return {
          id: a.transactionHash.slice(0, 10),
          type: formatEventType(a.eventType),
          address: formatAddress(a.employer === userAddress ? a.contributor || "N/A" : a.employer),
          date: dateTime.date,
          time: dateTime.time,
          token: "-",
          amount: "-",
          status: "Completed" as const,
          tokenIcon: "",
          txHash: a.transactionHash,
          createdAt: a.createdAt,
        };
      }),
      ...payments.map((p) => {
        const dateTime = formatDate(p.createdAt);
        const tokenInfo = getTokenInfo(p.token);
        const amountStr = formatAmount(p.amount, tokenInfo);
        const isReceived = p.eventType === "PaymentReceived";
        const sign = isReceived ? "+" : "-";
        const finalAmount = amountStr !== "-" ? `${sign}${amountStr}` : amountStr;

        return {
          id: p.transactionHash.slice(0, 10),
          type: p.eventType === "PaymentSent" ? "Payment Sent" : "Payment Received",
          address: formatAddress(isReceived ? p.from : p.to),
          date: dateTime.date,
          time: dateTime.time,
          token: tokenInfo.name,
          amount: finalAmount,
          status: "Completed" as const,
          tokenIcon: tokenInfo.icon,
          txHash: p.transactionHash,
          createdAt: p.createdAt,
        };
      }),
      ...escrowEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const tokenAddress = escrowTokenMap.get(e.agreementId) || null;
        const tokenInfo = getTokenInfo(tokenAddress);
        const amountStr = formatAmount(e.amount, tokenInfo);
        const isIncoming = e.eventType === "Released" || e.eventType === "Refunded";
        const sign = isIncoming ? "+" : "-";
        const finalAmount = amountStr !== "-" ? `${sign}${amountStr}` : amountStr;

        return {
          id: e.transactionHash.slice(0, 10),
          type:
            e.eventType === "Funded"
              ? "Agreement Funded"
              : e.eventType === "Released"
                ? "Payment Released"
                : "Refund Received",
          address: formatAddress(e.eventType === "Funded" ? e.employer : e.to || ""),
          date: dateTime.date,
          time: dateTime.time,
          token: tokenInfo.name,
          amount: finalAmount,
          status: "Completed" as const,
          tokenIcon: tokenInfo.icon,
          txHash: e.transactionHash,
          createdAt: e.createdAt,
        };
      }),
      ...employeeEvents.map((e) => {
        const dateTime = formatDate(e.createdAt);
        const addressToFormat = e.employer === userAddress ? e.employeeAddress : e.employer;
        return {
          id: e.transactionHash.slice(0, 10),
          type: "Employee Added",
          address: formatAddress(addressToFormat || ""),
          date: dateTime.date,
          time: dateTime.time,
          token: "-",
          amount: "-",
          status: "Completed" as const,
          tokenIcon: "",
          txHash: e.transactionHash,
          createdAt: e.createdAt,
        };
      }),
      ...milestoneEvents.map((m) => {
        const dateTime = formatDate(m.createdAt);
        const addressToFormat = m.employer === userAddress ? m.contributor || "N/A" : m.employer;
        return {
          id: m.transactionHash.slice(0, 10),
          type: "Milestone Added",
          address: formatAddress(addressToFormat || ""),
          date: dateTime.date,
          time: dateTime.time,
          token: "-",
          amount: "-",
          status: "Completed" as const,
          tokenIcon: "",
          txHash: m.transactionHash,
          createdAt: m.createdAt,
        };
      }),
    ].sort((a, b) => {
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.txHash.localeCompare(b.txHash);
    });

    const paginatedTransactions = allTransactions.slice(offset, offset + limit);
    const hasMore = total > offset + limit;

    res.json({ transactions: paginatedTransactions, total, hasMore, limit, offset });
  } catch (e) {
    next(e);
  }
});
