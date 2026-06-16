import { Router } from "express";
import { z } from "zod";
import { shortString } from "starknet";
import { agreementContract, escrowContract, provider } from "../starknet/client.js";
import { u256ToString, toHexString } from "../utils/codec.js";

const AddressParam = z.string().min(3);

function asU256FromResult(result: string[]) {
  if (!Array.isArray(result) || result.length < 2) return null;
  return { low: result[0], high: result[1] };
}

async function callContractResult(contractAddress: string, entrypoint: string, calldata: string[] = []) {
  const out = await provider.callContract({
    contractAddress,
    entrypoint,
    calldata,
  });
  return Array.isArray(out) ? out : (out as any)?.result;
}

async function erc20BalanceOf(token: string, owner: string) {
  // Minimal ERC20 balance read (Cairo ERC20s typically expose `balance_of(address) -> u256`)
  const result = await callContractResult(token, "balance_of", [owner]);
  const u256 = asU256FromResult(result);
  if (!u256) {
    throw new Error(`Unexpected balance_of result: ${JSON.stringify(result)}`);
  }
  return u256ToString(u256);
}

async function erc20Decimals(token: string) {
  const result = await callContractResult(token, "decimals", []);
  if (!Array.isArray(result) || result.length < 1) {
    throw new Error(`Unexpected decimals result: ${JSON.stringify(result)}`);
  }
  return Number(BigInt(result[0]));
}

async function erc20Symbol(token: string) {
  const result = await callContractResult(token, "symbol", []);
  if (!Array.isArray(result) || result.length < 1) {
    throw new Error(`Unexpected symbol result: ${JSON.stringify(result)}`);
  }
  try {
    return shortString.decodeShortString(result[0]);
  } catch {
    return result[0];
  }
}

export const readRouter = Router();

// -------- token / balances --------
readRouter.get("/token/:token/balance/:owner", async (req, res, next) => {
  try {
    const token = AddressParam.parse(req.params.token);
    const owner = AddressParam.parse(req.params.owner);
    const balance = await erc20BalanceOf(token, owner);
    res.json({ token, owner, balance });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/token/:token/decimals", async (req, res, next) => {
  try {
    const token = AddressParam.parse(req.params.token);
    const decimals = await erc20Decimals(token);
    res.json({ token, decimals });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/token/:token/symbol", async (req, res, next) => {
  try {
    const token = AddressParam.parse(req.params.token);
    const symbol = await erc20Symbol(token);
    res.json({ token, symbol });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/escrow/:address/balance/:agreement_id", async (req, res, next) => {
  try {
    const escrowAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const escrow = escrowContract(escrowAddress);
    const balance = await escrow.get_agreement_balance(agreement_id);
    res.json({ 
      escrow: escrowAddress, 
      agreement_id: agreement_id.toString(),
      balance: u256ToString(balance) 
    });
  } catch (e) {
    next(e);
  }
});

// -------- summaries (UI-friendly) --------
readRouter.get("/escrow/:address/summary/:agreement_id", async (req, res, next) => {
  try {
    const escrowAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const escrow = escrowContract(escrowAddress);
    const [token, balance, employer] = await Promise.all([
      escrow.get_token(),
      escrow.get_agreement_balance(agreement_id),
      escrow.get_agreement_employer(agreement_id),
    ]);
    res.json({
      escrow: escrowAddress,
      agreement_id: agreement_id.toString(),
      employer: toHexString(employer),
      token: toHexString(token),
      balance: u256ToString(balance),
    });
  } catch (e) {
    next(e);
  }
});

readRouter.get("/agreement/:address/summary/:agreement_id", async (req, res, next) => {
  try {
    const agreementAddress = AddressParam.parse(req.params.address);
    const agreement_id = z.coerce.bigint().positive().parse(req.params.agreement_id);
    const agreement = agreementContract(agreementAddress);
    const [employer, contributor, token, escrow, total, paid, status, mode, dispute_status] = await Promise.all([
      agreement.get_employer(agreement_id),
      agreement.get_contributor(agreement_id),
      agreement.get_token(agreement_id),
      agreement.get_escrow(),
      agreement.get_total_amount(agreement_id),
      agreement.get_paid_amount(agreement_id),
      agreement.get_status(agreement_id),
      agreement.get_agreement_mode(agreement_id),
      agreement.get_dispute_status(agreement_id),
    ]);
    res.json({
      agreement: agreementAddress,
      agreement_id: agreement_id.toString(),
      employer: toHexString(employer),
      contributor: toHexString(contributor),
      token: toHexString(token),
      escrow: toHexString(escrow),
      total_amount: u256ToString(total),
      paid_amount: u256ToString(paid),
      status: Number(status),
      mode: Number(mode), // 0 = Escrow, 1 = Payroll
      dispute_status: Number(dispute_status), // 0 = None, 1 = Raised, 2 = Resolved
    });
  } catch (e) {
    next(e);
  }
});


