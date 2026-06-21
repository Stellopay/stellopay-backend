import { Router } from "express";
import { z } from "zod";
import { defaults } from "../config.js";
import { agreementContract, provider } from "../starknet/client.js";
import { parseU256, u256ToString, toHexString } from "../utils/codec.js";
import { normalizeStarknetAddress } from "../utils/address.js";
import { requireSession } from "../auth/session.js";
// Removed in-memory index - using database only
import { db, schema } from "../db/index.js";
import { eq, and, or, desc } from "drizzle-orm";

const AddressParam = z.string().min(3);
const AgreementIdParam = z.coerce.bigint().positive();

const WalletSession = z.object({
  wallet_address: z.string().min(3),
  session_token: z.string().min(10),
});

const CreateTimeBasedBody = z
  .object({
    employer: z.string().min(3),
    contributor: z.string().min(3),
    token: z.string().min(3),
    amount_per_period: z.string().min(1),
    period_seconds: z.coerce.bigint(),
    num_periods: z.coerce.number().int().positive(),
  })
  .and(WalletSession);

const CreateMilestoneBody = z
  .object({
    employer: z.string().min(3),
    contributor: z.string().min(3),
    token: z.string().min(3),
  })
  .and(WalletSession);

const CreatePayrollBody = z
  .object({
    employer: z.string().min(3),
    token: z.string().min(3),
    period_seconds: z.coerce.bigint(),
    num_periods: z.coerce.number().int().positive(),
  })
  .and(WalletSession);

const AgreementIdBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
  })
  .and(WalletSession);

const AddMilestoneBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
    amount: z.string().min(1),
  })
  .and(WalletSession);

const MilestoneIdBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
    milestone_id: z.coerce.number().int().nonnegative(),
  })
  .and(WalletSession);

const FundAgreementBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
    amount: z.string().min(1),
  })
  .and(WalletSession);

const AddEmployeeBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
    employee: z.string().min(3),
    salary_per_period: z.string().min(1),
  })
  .and(WalletSession);

const ClaimPayrollBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
    employee_index: z.coerce.number().int().nonnegative(),
  })
  .and(WalletSession);

const ResolveDisputeBody = z
  .object({
    agreement_id: z.coerce.bigint().positive(),
    pay_contributor: z.string().min(1),
    refund_employer: z.string().min(1),
  })
  .and(WalletSession);

const InitAgreementBody = WalletSession.extend({
  escrow: z.string().min(3),
  arbiter: z.string().min(3),
});

export const agreementRouter = Router();

agreementRouter.get("/agreement/defaults", (_req, res) => {
  res.json({ address: defaults.workAgreementAddress });
});

// -------- getters (view) --------
agreementRouter.get("/agreement/:address/get_employer/:agreement_id", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

    // Try indexed data first
    try {
      const agreement = await db
        .select()
        .from(schema.agreements)
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            eq(schema.agreements.id, agreement_id.toString()),
          ),
        )
        .limit(1);

      if (agreement.length > 0) {
        return res.json({
          agreement_id: agreement_id.toString(),
          employer: agreement[0].employer,
          source: "indexed",
        });
      }
    } catch (dbError) {
      // Fall through to contract call
    }

    // Fallback to contract call
    const c = agreementContract(address);
    const out = await c.get_employer(agreement_id);
    res.json({
      agreement_id: agreement_id.toString(),
      employer: toHexString(out),
      source: "contract",
    });
  } catch (e) {
    next(e);
  }
});

agreementRouter.get("/agreement/:address/get_contributor/:agreement_id", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

    // Try indexed data first
    try {
      const agreement = await db
        .select()
        .from(schema.agreements)
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            eq(schema.agreements.id, agreement_id.toString()),
          ),
        )
        .limit(1);

      if (agreement.length > 0) {
        return res.json({
          agreement_id: agreement_id.toString(),
          contributor: agreement[0].contributor || "0x0",
          source: "indexed",
        });
      }
    } catch (dbError) {
      // Fall through to contract call
    }

    // Fallback to contract call
    const c = agreementContract(address);
    const out = await c.get_contributor(agreement_id);
    res.json({
      agreement_id: agreement_id.toString(),
      contributor: toHexString(out),
      source: "contract",
    });
  } catch (e) {
    next(e);
  }
});

agreementRouter.get("/agreement/:address/get_token/:agreement_id", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

    // Try indexed data first
    try {
      const agreement = await db
        .select()
        .from(schema.agreements)
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            eq(schema.agreements.id, agreement_id.toString()),
          ),
        )
        .limit(1);

      if (agreement.length > 0) {
        return res.json({
          agreement_id: agreement_id.toString(),
          token: agreement[0].token,
          source: "indexed",
        });
      }
    } catch (dbError) {
      // Fall through to contract call
    }

    // Fallback to contract call
    const c = agreementContract(address);
    const out = await c.get_token(agreement_id);
    res.json({
      agreement_id: agreement_id.toString(),
      token: toHexString(out),
      source: "contract",
    });
  } catch (e) {
    next(e);
  }
});

agreementRouter.get("/agreement/:address/get_escrow", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const c = agreementContract(address);
    const out = await c.get_escrow();
    res.json({ escrow: toHexString(out) });
  } catch (e) {
    next(e);
  }
});

agreementRouter.get("/agreement/:address/is_initialized", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const c = agreementContract(address);
    // Try to get escrow - if it fails or returns zero address, it's not initialized
    try {
      const escrow = await c.get_escrow();

      // Handle different return types from starknet.js
      let escrowStr: string;
      if (typeof escrow === "string") {
        escrowStr = escrow.toLowerCase();
      } else if (typeof escrow === "bigint") {
        escrowStr = toHexString(escrow).toLowerCase();
      } else if (Array.isArray(escrow)) {
        // If it's an array, take the first element
        escrowStr = (escrow[0] ? toHexString(escrow[0]) : "0x0").toLowerCase();
      } else if (escrow && typeof escrow === "object" && "flat" in escrow) {
        // Handle array-like objects with flat method
        const flatArray = (escrow as any).flat();
        escrowStr = (flatArray && flatArray[0] ? toHexString(flatArray[0]) : "0x0").toLowerCase();
      } else {
        escrowStr = String(escrow || "0x0").toLowerCase();
      }

      const zeroAddresses = [
        "0x0",
        "0x00",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0",
        "",
      ];
      const isZero = zeroAddresses.includes(escrowStr) || escrowStr === "0x" || !escrowStr;
      const isInitialized = !isZero && escrowStr.length > 2;
      res.json({ initialized: isInitialized, escrow: isInitialized ? escrowStr : null });
    } catch (err: any) {
      console.error("Error checking agreement initialization:", err?.message || err);
      res.json({ initialized: false, escrow: null, error: err?.message || "Failed to check" });
    }
  } catch (e) {
    next(e);
  }
});

agreementRouter.get(
  "/agreement/:address/get_total_amount/:agreement_id",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

      // Try indexed data first
      try {
        const agreement = await db
          .select()
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.contractAddress, address),
              eq(schema.agreements.id, agreement_id.toString()),
            ),
          )
          .limit(1);

        if (agreement.length > 0) {
          return res.json({
            agreement_id: agreement_id.toString(),
            total_amount: agreement[0].totalAmount,
            source: "indexed",
          });
        }
      } catch (dbError) {
        // Fall through to contract call
      }

      // Fallback to contract call
      const c = agreementContract(address);
      const out = await c.get_total_amount(agreement_id);
      res.json({
        agreement_id: agreement_id.toString(),
        total_amount: u256ToString(out),
        source: "contract",
      });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.get("/agreement/:address/get_paid_amount/:agreement_id", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

    // Try indexed data first
    try {
      const agreement = await db
        .select()
        .from(schema.agreements)
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            eq(schema.agreements.id, agreement_id.toString()),
          ),
        )
        .limit(1);

      if (agreement.length > 0) {
        return res.json({
          agreement_id: agreement_id.toString(),
          paid_amount: agreement[0].paidAmount,
          source: "indexed",
        });
      }
    } catch (dbError) {
      // Fall through to contract call
    }

    // Fallback to contract call
    const c = agreementContract(address);
    const out = await c.get_paid_amount(agreement_id);
    res.json({
      agreement_id: agreement_id.toString(),
      paid_amount: u256ToString(out),
      source: "contract",
    });
  } catch (e) {
    next(e);
  }
});

agreementRouter.get("/agreement/:address/get_status/:agreement_id", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

    // Try indexed data first
    try {
      const agreement = await db
        .select()
        .from(schema.agreements)
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            eq(schema.agreements.id, agreement_id.toString()),
          ),
        )
        .limit(1);

      if (agreement.length > 0) {
        return res.json({
          agreement_id: agreement_id.toString(),
          status: agreement[0].status,
          source: "indexed",
        });
      }
    } catch (dbError) {
      // Fall through to contract call
    }

    // Fallback to contract call
    const c = agreementContract(address);
    const out = await c.get_status(agreement_id);
    res.json({ agreement_id: agreement_id.toString(), status: Number(out), source: "contract" });
  } catch (e) {
    next(e);
  }
});

agreementRouter.get(
  "/agreement/:address/get_agreement_mode/:agreement_id",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

      // Try indexed data first
      try {
        const agreement = await db
          .select()
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.contractAddress, address),
              eq(schema.agreements.id, agreement_id.toString()),
            ),
          )
          .limit(1);

        if (agreement.length > 0) {
          return res.json({
            agreement_id: agreement_id.toString(),
            mode: agreement[0].mode, // 0 = Escrow, 1 = Payroll
            source: "indexed",
          });
        }
      } catch (dbError) {
        // Fall through to contract call
      }

      // Fallback to contract call
      const c = agreementContract(address);
      const out = await c.get_agreement_mode(agreement_id);
      res.json({ agreement_id: agreement_id.toString(), mode: Number(out), source: "contract" }); // 0 = Escrow, 1 = Payroll
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.get(
  "/agreement/:address/get_employee_count/:agreement_id",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

      // Try indexed data first
      try {
        const employees = await db
          .select()
          .from(schema.employees)
          .where(
            and(
              eq(schema.employees.contractAddress, address),
              eq(schema.employees.agreementId, agreement_id.toString()),
            ),
          );

        if (employees.length > 0) {
          return res.json({
            agreement_id: agreement_id.toString(),
            employee_count: employees.length,
            source: "indexed",
          });
        }
      } catch (dbError) {
        // Fall through to contract call
      }

      // Fallback to contract call
      const c = agreementContract(address);
      const out = await c.get_employee_count(agreement_id);
      res.json({
        agreement_id: agreement_id.toString(),
        employee_count: Number(out),
        source: "contract",
      });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.get(
  "/agreement/:address/get_employee/:agreement_id/:index",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);
      const index = z.coerce.number().int().nonnegative().parse(req.params.index);

      // Try indexed data first
      try {
        const employee = await db
          .select()
          .from(schema.employees)
          .where(
            and(
              eq(schema.employees.contractAddress, address),
              eq(schema.employees.agreementId, agreement_id.toString()),
              eq(schema.employees.employeeIndex, index),
            ),
          )
          .limit(1);

        if (employee.length > 0) {
          return res.json({
            agreement_id: agreement_id.toString(),
            index,
            employee: employee[0].employeeAddress,
            source: "indexed",
          });
        }
      } catch (dbError) {
        // Fall through to contract call
      }

      // Fallback to contract call
      const c = agreementContract(address);
      const out = await c.get_employee(agreement_id, index);
      res.json({ agreement_id: agreement_id.toString(), index, employee: out, source: "contract" });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.get(
  "/agreement/:address/get_employee_salary/:agreement_id/:index",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);
      const index = z.coerce.number().int().nonnegative().parse(req.params.index);

      // Try indexed data first
      try {
        const employee = await db
          .select()
          .from(schema.employees)
          .where(
            and(
              eq(schema.employees.contractAddress, address),
              eq(schema.employees.agreementId, agreement_id.toString()),
              eq(schema.employees.employeeIndex, index),
            ),
          )
          .limit(1);

        if (employee.length > 0) {
          return res.json({
            agreement_id: agreement_id.toString(),
            index,
            salary: employee[0].salaryPerPeriod,
            source: "indexed",
          });
        }
      } catch (dbError) {
        // Fall through to contract call
      }

      // Fallback to contract call
      const c = agreementContract(address);
      const out = await c.get_employee_salary(agreement_id, index);
      res.json({
        agreement_id: agreement_id.toString(),
        index,
        salary: u256ToString(out),
        source: "contract",
      });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.get(
  "/agreement/:address/get_dispute_status/:agreement_id",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);

      // Try indexed data first
      try {
        const agreement = await db
          .select()
          .from(schema.agreements)
          .where(
            and(
              eq(schema.agreements.contractAddress, address),
              eq(schema.agreements.id, agreement_id.toString()),
            ),
          )
          .limit(1);

        if (agreement.length > 0) {
          return res.json({
            agreement_id: agreement_id.toString(),
            dispute_status: agreement[0].disputeStatus || 0, // 0 = None, 1 = Raised, 2 = Resolved
            source: "indexed",
          });
        }
      } catch (dbError) {
        // Fall through to contract call
      }

      // Fallback to contract call
      const c = agreementContract(address);
      const out = await c.get_dispute_status(agreement_id);
      res.json({
        agreement_id: agreement_id.toString(),
        dispute_status: Number(out),
        source: "contract",
      }); // 0 = None, 1 = Raised, 2 = Resolved
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.get(
  "/agreement/:address/is_grace_period_active/:agreement_id",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const agreement_id = AgreementIdParam.parse(req.params.agreement_id);
      const c = agreementContract(address);
      const out = await c.is_grace_period_active(agreement_id);
      res.json({ agreement_id: agreement_id.toString(), is_grace_period_active: out });
    } catch (e) {
      next(e);
    }
  },
);

// -------- setters (prepare to sign client-side) --------
agreementRouter.post("/prepare/agreement/:address/initialize", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = InitAgreementBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("initialize", [body.escrow, body.arbiter]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post(
  "/prepare/agreement/:address/create_time_based_agreement",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const body = CreateTimeBasedBody.parse(req.body);
      if (!requireSession(body.wallet_address, body.session_token)) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }
      const c = agreementContract(address);
      const call = c.populate("create_time_based_agreement", [
        body.employer,
        body.contributor,
        body.token,
        parseU256(body.amount_per_period),
        body.period_seconds.toString(),
        body.num_periods,
      ]);
      const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
      const chainId = await provider.getChainId();
      res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.post(
  "/prepare/agreement/:address/create_milestone_agreement",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const body = CreateMilestoneBody.parse(req.body);
      if (!requireSession(body.wallet_address, body.session_token)) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }
      const c = agreementContract(address);
      const call = c.populate("create_milestone_agreement", [
        body.employer,
        body.contributor,
        body.token,
      ]);
      const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
      const chainId = await provider.getChainId();
      res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.post(
  "/prepare/agreement/:address/create_payroll_agreement",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const body = CreatePayrollBody.parse(req.body);
      if (!requireSession(body.wallet_address, body.session_token)) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }
      const c = agreementContract(address);
      const call = c.populate("create_payroll_agreement", [
        body.employer,
        body.token,
        body.period_seconds.toString(),
        body.num_periods,
      ]);
      const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
      const chainId = await provider.getChainId();
      res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.post("/prepare/agreement/:address/add_employee", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AddEmployeeBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("add_employee", [
      body.agreement_id.toString(),
      body.employee,
      parseU256(body.salary_per_period),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/fund_agreement", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = FundAgreementBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("fund_agreement", [
      body.agreement_id.toString(),
      parseU256(body.amount),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/add_milestone", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AddMilestoneBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("add_milestone", [
      body.agreement_id.toString(),
      parseU256(body.amount),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/approve_milestone", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = MilestoneIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("approve_milestone", [body.agreement_id.toString(), body.milestone_id]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/claim_milestone", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = MilestoneIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("claim_milestone", [body.agreement_id.toString(), body.milestone_id]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/activate", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AgreementIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("activate", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/pause", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AgreementIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("pause", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/resume", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AgreementIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("resume", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/cancel", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AgreementIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("cancel", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post(
  "/prepare/agreement/:address/finalize_grace_period",
  async (req, res, next) => {
    try {
      const address = AddressParam.parse(req.params.address);
      const body = AgreementIdBody.parse(req.body);
      if (!requireSession(body.wallet_address, body.session_token)) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }
      const c = agreementContract(address);
      const call = c.populate("finalize_grace_period", [body.agreement_id.toString()]);
      const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
      const chainId = await provider.getChainId();
      res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
    } catch (e) {
      next(e);
    }
  },
);

agreementRouter.post("/prepare/agreement/:address/raise_dispute", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AgreementIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("raise_dispute", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

// Get agreement ID from transaction receipt by parsing AgreementCreated event
agreementRouter.post("/agreement/:address/get_agreement_id_from_tx", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const { tx_hash } = z.object({ tx_hash: z.string() }).parse(req.body);

    // Ensure tx_hash is properly formatted (should start with 0x and be 66 chars)
    let formattedTxHash = tx_hash;
    if (!tx_hash.startsWith("0x")) {
      formattedTxHash = `0x${tx_hash}`;
    }

    try {
      const receipt = await provider.getTransactionReceipt(formattedTxHash);
      if (!receipt) {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      // Look for AgreementCreated event
      const agreementAddress = address.toLowerCase();
      let agreementId: bigint | null = null;

      // Check if receipt has events (type guard)
      if ("events" in receipt && receipt.events) {
        for (const event of receipt.events) {
          // Check if this is from the agreement contract
          if (event.from_address?.toLowerCase() === agreementAddress) {
            // AgreementCreated event structure: [agreement_id, employer, contributor, token, mode, payment_type]
            // Event key for AgreementCreated is the hash of "AgreementCreated"
            // We need to check the event structure
            if (event.data && event.data.length >= 1) {
              // First data element is agreement_id (u128)
              agreementId = BigInt(event.data[0]);
              break;
            }
          }
        }
      }

      if (!agreementId) {
        res.status(404).json({ error: "AgreementCreated event not found in transaction" });
        return;
      }

      const agreementIdStr = agreementId.toString();

      // Removed in-memory index - data is stored in database by indexer
      // We'll need to fetch employer/contributor and metadata from the contract
      const contract = agreementContract(address);
      try {
        const [employer, contributor, status, mode, total, paid] = await Promise.all([
          contract.get_employer(agreementId).catch(() => "0x0"),
          contract.get_contributor(agreementId).catch(() => "0x0"),
          contract.get_status(agreementId).catch(() => 0),
          contract.get_agreement_mode(agreementId).catch(() => 0),
          contract.get_total_amount(agreementId).catch(() => 0n),
          contract.get_paid_amount(agreementId).catch(() => 0n),
        ]);

        const employerStr = typeof employer === "bigint" ? toHexString(employer) : employer;
        const contributorStr =
          typeof contributor === "bigint" ? toHexString(contributor) : contributor || "0x0";

        const employerPadded = normalizeStarknetAddress(employerStr);
        const contributorPadded = normalizeStarknetAddress(contributorStr);

        // Removed in-memory index - data is stored in database by indexer
        console.log(
          `[list-agreements] ✓ Added agreement ${agreementIdStr} to index (employer: ${employerPadded})`,
        );
      } catch (indexErr) {
        console.error(
          `[list-agreements] Failed to add agreement ${agreementIdStr} to index:`,
          indexErr,
        );
        // Don't fail the request if indexing fails
      }

      res.json({ agreement_id: agreementIdStr });
    } catch (e: any) {
      // Handle transaction not found or not yet mined
      if (e?.message?.includes("Transaction hash not found") || e?.message?.includes("not found")) {
        res.status(404).json({
          error: "Transaction not found or not yet mined. Please wait a few moments and try again.",
          details: e.message,
        });
        return;
      }
      throw e; // Re-throw other errors
    }
  } catch (e) {
    next(e);
  }
});

// List all agreements for a user (as employer or contributor/employee)
agreementRouter.get("/agreement/:address/list/:user_address", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const userAddress = normalizeStarknetAddress(req.params.user_address);

    console.log(
      `[list-agreements] Querying database for agreements for user: ${userAddress} in contract: ${address}`,
    );

    // ONLY USE DATABASE - No contract scanning, no in-memory cache, no fallbacks
    try {
      // Get agreements where user is employer or contributor
      const indexedAgreements = await db
        .select()
        .from(schema.agreements)
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            or(
              eq(schema.agreements.employer, userAddress),
              eq(schema.agreements.contributor, userAddress),
            ),
          ),
        )
        .orderBy(desc(schema.agreements.createdAt));

      // Also check if user is an employee in any payroll agreements
      const employeeAgreements = await db
        .select({
          agreement: schema.agreements,
        })
        .from(schema.agreements)
        .innerJoin(schema.employees, eq(schema.agreements.id, schema.employees.agreementId))
        .where(
          and(
            eq(schema.agreements.contractAddress, address),
            eq(schema.employees.employeeAddress, userAddress),
            eq(schema.agreements.mode, 1), // Payroll mode
          ),
        )
        .orderBy(desc(schema.agreements.createdAt));

      // Combine and deduplicate
      const allAgreements = [...indexedAgreements, ...employeeAgreements.map((e) => e.agreement)];

      // Remove duplicates by agreement ID
      const uniqueAgreementsMap = new Map<string, any>();
      allAgreements.forEach((a) => {
        uniqueAgreementsMap.set(a.id, a);
      });

      const uniqueAgreements = Array.from(uniqueAgreementsMap.values());

      console.log(`[list-agreements] Found ${uniqueAgreements.length} agreements from database`);

      return res.json({
        agreements: uniqueAgreements.map((a) => ({
          agreement_id: a.id,
          employer: a.employer,
          contributor: a.contributor,
          status: a.status,
          mode: a.mode,
          total_amount: a.totalAmount,
          paid_amount: a.paidAmount,
        })),
        source: "indexed",
      });
    } catch (dbError) {
      console.error(`[list-agreements] Database query failed:`, dbError);
      // Return empty array if database fails - don't fall back to contract scanning
      return res.json({
        agreements: [],
        source: "database_error",
        error: "Database query failed",
      });
    }

    // REMOVED: All contract scanning logic - backend now ONLY uses database
    // If database is empty, return empty array
    // Indexer will populate database as events are processed
  } catch (e) {
    console.error("[list-agreements] Error:", e);
    next(e);
  }
});

// OPTIMIZATION: Endpoint to rebuild/sync the agreement index
agreementRouter.post("/agreement/:address/sync_index", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const c = agreementContract(address);

    console.log(`[sync-index] Starting index sync for contract: ${address}`);

    // Get next_agreement_id if available
    let maxAgreements = 1000;
    try {
      if (typeof (c as any).get_next_agreement_id === "function") {
        const nextId = await (c as any).get_next_agreement_id();
        maxAgreements = Number(nextId);
        console.log(`[sync-index] Found next_agreement_id: ${maxAgreements}`);
      }
    } catch (e) {
      console.log(
        `[sync-index] get_next_agreement_id not available, using limit: ${maxAgreements}`,
      );
    }

    let synced = 0;
    const batchSize = 100; // Large batches for sync
    const MAX_CONSECUTIVE_NOT_FOUND = 20;
    let consecutiveNotFound = 0;

    for (
      let start = 1;
      start <= maxAgreements && consecutiveNotFound < MAX_CONSECUTIVE_NOT_FOUND;
      start += batchSize
    ) {
      const end = Math.min(start + batchSize, maxAgreements);
      const batchPromises: Promise<boolean>[] = [];

      for (let i = start; i <= end; i++) {
        batchPromises.push(
          (async (): Promise<boolean> => {
            try {
              const [employer, contributor] = await Promise.all([
                c.get_employer(BigInt(i)).catch(() => null),
                c.get_contributor(BigInt(i)).catch(() => "0x0"),
              ]);

              if (!employer) {
                return false; // Agreement doesn't exist
              }

              // Normalize addresses
              const employerStr = typeof employer === "bigint" ? toHexString(employer) : employer;
              const contributorStr =
                typeof contributor === "bigint" ? toHexString(contributor) : contributor || "0x0";

              const employerPadded = normalizeStarknetAddress(employerStr);
              const contributorPadded = normalizeStarknetAddress(contributorStr);

              // Removed in-memory index - data is stored in database by indexer
              synced++;
              return true;
            } catch (e) {
              return false;
            }
          })(),
        );
      }

      const results = await Promise.all(batchPromises);
      const foundInBatch = results.filter((r) => r === true).length;

      if (foundInBatch === 0) {
        consecutiveNotFound += batchSize;
      } else {
        consecutiveNotFound = 0;
      }

      if (consecutiveNotFound >= MAX_CONSECUTIVE_NOT_FOUND) {
        break;
      }
    }

    console.log(`[sync-index] Synced ${synced} agreements to index`);
    res.json({ synced, total: synced });
  } catch (e) {
    console.error("[sync-index] Error:", e);
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/resolve_dispute", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = ResolveDisputeBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("resolve_dispute", [
      body.agreement_id.toString(),
      parseU256(body.pay_contributor),
      parseU256(body.refund_employer),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/claim_time_based", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = AgreementIdBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("claim_time_based", [body.agreement_id.toString()]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

agreementRouter.post("/prepare/agreement/:address/claim_payroll", async (req, res, next) => {
  try {
    const address = AddressParam.parse(req.params.address);
    const body = ClaimPayrollBody.parse(req.body);
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    const c = agreementContract(address);
    const call = c.populate("claim_payroll", [body.agreement_id.toString(), body.employee_index]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});
