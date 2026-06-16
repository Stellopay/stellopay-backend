// Stub required env vars so modules that parse env at import-time don't throw
process.env.STARKNET_RPC_URL = process.env.STARKNET_RPC_URL ?? "http://localhost:9545";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
