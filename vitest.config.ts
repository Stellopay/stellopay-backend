import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    // config.ts requires STARKNET_RPC_URL at import time. Provide a dummy value so
    // any test file that imports config (directly or transitively) loads cleanly;
    // no test performs real network calls.
    env: {
      STARKNET_RPC_URL: "https://starknet-sepolia.public.invalid/rpc",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Enforced on the core auth/codec modules this PR adds tests for. Full-repo
      // coverage of the DB/RPC-bound routes is a larger follow-up.
      include: [
        "src/utils/codec.ts",
        "src/auth/session.ts",
        "src/auth/challenge.ts",
        "src/config.ts",
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 90,
      },
    },
  },
});
