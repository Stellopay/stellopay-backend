import fs from "node:fs";
import path from "node:path";

type ContractClassJson = {
  abi?: unknown;
};

export function loadAbiFromContractClassJsonPath(p: string): unknown[] {
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const raw = fs.readFileSync(abs, "utf-8");
  const parsed: ContractClassJson = JSON.parse(raw);
  if (!parsed.abi || !Array.isArray(parsed.abi)) {
    throw new Error(`ABI not found in contract_class json at: ${abs}`);
  }
  return parsed.abi as unknown[];
}


