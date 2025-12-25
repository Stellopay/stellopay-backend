import { Router } from "express";
import { z } from "zod";
import { provider } from "../starknet/client.js";
import { parseU256, toHexString } from "../utils/codec.js";
import { requireSession } from "../auth/session.js";

const AddressParam = z.string().min(3);

const WalletSession = z.object({
  wallet_address: z.string().min(3),
  session_token: z.string().min(10),
});

const ApproveBody = WalletSession.extend({
  spender: z.string().min(3),
  amount: z.string().min(1),
});

// Minimal ERC20 ABI for approve and allowance
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [{ type: "core::bool" }],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "core::starknet::contract_address::ContractAddress" },
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
    ],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
];

export const tokenRouter = Router();

// Get current allowance
tokenRouter.get("/token/:address/allowance/:owner/:spender", async (req, res, next) => {
  try {
    const tokenAddress = AddressParam.parse(req.params.address);
    const owner = AddressParam.parse(req.params.owner);
    const spender = AddressParam.parse(req.params.spender);
    
    const { Contract } = await import("starknet");
    const tokenContract = new Contract(ERC20_ABI, tokenAddress, provider);
    const result = await tokenContract.call("allowance", [owner, spender]);
    // Handle the result - it might be a bigint or wrapped in a result object
    const allowance = typeof result === 'bigint' ? result : (result as any).allowance || result;
    res.json({ 
      token: tokenAddress,
      owner,
      spender,
      allowance: toHexString(allowance),
    });
  } catch (e) {
    next(e);
  }
});

// Prepare approve transaction
tokenRouter.post("/prepare/token/:address/approve", async (req, res, next) => {
  try {
    const tokenAddress = AddressParam.parse(req.params.address);
    const body = ApproveBody.parse(req.body);
    
    if (!requireSession(body.wallet_address, body.session_token)) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const tokenContract = new (await import("starknet")).Contract(ERC20_ABI, tokenAddress, provider);
    const call = tokenContract.populate("approve", [
      body.spender,
      parseU256(body.amount),
    ]);
    const nonce = await provider.getNonceForAddress(body.wallet_address, "pending");
    const chainId = await provider.getChainId();
    res.json({ call, wallet_address: body.wallet_address, nonce, chain_id: chainId });
  } catch (e) {
    next(e);
  }
});

