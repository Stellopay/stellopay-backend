import dotenv from "dotenv";
import { z } from "zod";
import path from "node:path";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: z.coerce.number().int().positive().optional().default(4000),
  CORS_ORIGIN: z.string().optional().default("*"),

  // Required: Starknet RPC URL (v0_8)
  // Provide via environment variable (e.g. in `.env` or inline `STARKNET_RPC_URL=... pnpm dev`)
  STARKNET_RPC_URL: z.string().min(1),
  // Users sign transactions client-side; backend does not require account keys.

  PAYROLL_ESCROW_ADDRESS: z.string().optional(),
  WORK_AGREEMENT_ADDRESS: z.string().optional(),

  // ABI file paths - should be absolute paths or relative to project root
  // In production, these should point to the actual location of the contract class JSON files
  ESCROW_CONTRACT_CLASS_JSON: z.string().optional(),
  AGREEMENT_CONTRACT_CLASS_JSON: z.string().optional(),
  
  // Database connection for indexed data
  POSTGRES_CONNECTION_STRING: z.string().optional().default("postgresql://localhost:5432/stellopay_indexer"),
  
  // Token addresses (optional, with defaults)
  TOKEN_STRK: z.string().optional(),
  TOKEN_USDC: z.string().optional(),
  TOKEN_USDT: z.string().optional(),
  
  // Email configuration for contact form
  EMAIL_USER: z.string().optional(),
  EMAIL_PASSWORD: z.string().optional(),

  // Feature flags
  BILLING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0")
    .default("true"),
});

export const env = EnvSchema.parse(process.env);

// Resolve ABI paths - use provided paths or fallback to local contracts directory
// In production, these should be set as absolute paths or paths relative to the deployed location
export const abiPaths = {
  escrow: env.ESCROW_CONTRACT_CLASS_JSON || 
    (process.env.NODE_ENV === "production" 
      ? null 
      : path.resolve(process.cwd(), "contracts/starknet_contracts_PayrollEscrow.contract_class.json")),
  agreement: env.AGREEMENT_CONTRACT_CLASS_JSON || 
    (process.env.NODE_ENV === "production" 
      ? null 
      : path.resolve(process.cwd(), "contracts/starknet_contracts_WorkAgreement.contract_class.json")),
};

// Validate that ABI paths are set in production
if (process.env.NODE_ENV === "production") {
  if (!abiPaths.escrow || !abiPaths.agreement) {
    throw new Error(
      "ESCROW_CONTRACT_CLASS_JSON and AGREEMENT_CONTRACT_CLASS_JSON must be set in production environment"
    );
  }
}

export const defaults = {
  payrollEscrowAddress:
    env.PAYROLL_ESCROW_ADDRESS ??
    "0x06d3599196d6701a79eee56f8bba7a797431b100f6ab4df784514b14b04cb1d4",
  workAgreementAddress:
    env.WORK_AGREEMENT_ADDRESS ??
    "0x067812025b96919b93ea9d63267522467d8b9fef1175a6cf9de84932b674dacd",
};


