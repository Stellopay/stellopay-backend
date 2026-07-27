import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Same DB/Starknet mocks the existing test suite already uses.
vi.mock("../db/index.js", () => ({
  db: {
      insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
              select: vi.fn().mockReturnThis(),
                  from: vi.fn().mockReturnThis(),
                      where: vi.fn().mockReturnThis(),
                          orderBy: vi.fn().mockReturnThis(),
                              limit: vi.fn().mockReturnThis(),
                                  values: vi.fn().mockReturnThis(),
                                      onConflictDoNothing: vi.fn().mockResolvedValue({}),
                                          onConflictDoUpdate: vi.fn().mockResolvedValue({}),
                                              set: vi.fn().mockReturnThis(),
                                                },
                                                  schema: {
                                                      agreementEvents: {
                                                            id: "agreementEvents",
                                                                  eventType: "AgreementStatusChange",
                                                                        blockNumber: "blockNumber",
                                                                              eventIndex: "eventIndex",
                                                                                  },
                                                                                    },
                                                                                    }));

                                                                                    vi.mock("../starknet/client.js", () => ({
                                                                                      provider: { getTransactionReceipt: vi.fn() },
                                                                                      }));

                                                                                      vi.mock("../starknet/abi.js", () => ({
                                                                                        loadAbiFromContractClassJsonPath: vi.fn().mockReturnValue([]),
                                                                                        }));

                                                                                        // Deliberately NOT mocking ../auth/middleware.js — requireAuth/requireAdmin
                                                                                        // run for real. We only stub their one DB-dependent dependency
                                                                                        // (requireSession) and fix ADMIN_ADDRESSES, mirroring how the rest of this
                                                                                        // suite already mocks the DB layer rather than the business logic.
                                                                                        const ADMIN_ADDRESS = "0xadmin00000000000000000000000000000000000";
                                                                                        const NON_ADMIN_ADDRESS = "0xnotadmin0000000000000000000000000000000";
                                                                                        const VALID_TOKEN = "valid-session-token";

                                                                                        vi.mock("../auth/session.js", () => ({
                                                                                          requireSession: vi.fn(async (_address: string, token: string) => token === VALID_TOKEN),
                                                                                          }));

                                                                                          vi.mock("../config.js", () => ({
                                                                                            env: { ADMIN_ADDRESSES: [ADMIN_ADDRESS] },
                                                                                              defaults: { workAgreementAddress: "0x1", payrollEscrowAddress: "0x2" },
                                                                                                abiPaths: { agreement: "/fake/agreement.json", escrow: "/fake/escrow.json" },
                                                                                                }));

                                                                                                import { reprocessEventsRouter } from "./reprocess-events.js";

                                                                                                function buildApp() {
                                                                                                  const app = express();
                                                                                                    app.use(express.json());
                                                                                                      app.use("/api/v1", reprocessEventsRouter);
                                                                                                        app.use((err: any, _req: any, res: any, _next: any) => {
                                                                                                            res.status(err.status || 500).json({ error: err.message });
                                                                                                              });
                                                                                                                return app;
                                                                                                                }

                                                                                                                const VALID_TX_HASH = "0x" + "1".repeat(64);

                                                                                                                const protectedRoutes: { path: string; body?: Record<string, unknown> }[] = [
                                                                                                                  { path: `/reprocess-events/tx/${VALID_TX_HASH}` },
                                                                                                                    { path: "/reprocess-events/batch", body: { tx_hashes: [VALID_TX_HASH] } },
                                                                                                                      { path: "/reprocess-events/status-changes" },
                                                                                                                      ];

                                                                                                                      describe("Reprocess Events — authorization boundary, real middleware (Issue #273)", () => {
                                                                                                                        let app: express.Express;

                                                                                                                          beforeEach(() => {
                                                                                                                              app = buildApp();
                                                                                                                                });

                                                                                                                                  describe("no credentials → 401", () => {
                                                                                                                                      for (const route of protectedRoutes) {
                                                                                                                                            it(`POST ${route.path}`, async () => {
                                                                                                                                                    const req = request(app).post(`/api/v1${route.path}`);
                                                                                                                                                            const res = await (route.body ? req.send(route.body) : req);
                                                                                                                                                                    expect(res.status).toBe(401);
                                                                                                                                                                          });
                                                                                                                                                                              }
                                                                                                                                                                                });

                                                                                                                                                                                  describe("valid session but non-admin address → 401", () => {
                                                                                                                                                                                      for (const route of protectedRoutes) {
                                                                                                                                                                                            it(`POST ${route.path}`, async () => {
                                                                                                                                                                                                    const req = request(app)
                                                                                                                                                                                                              .post(`/api/v1${route.path}`)
                                                                                                                                                                                                                        .set("x-user-address", NON_ADMIN_ADDRESS)
                                                                                                                                                                                                                                  .set("Authorization", `Bearer ${VALID_TOKEN}`);
                                                                                                                                                                                                                                          const res = await (route.body ? req.send(route.body) : req);
                                                                                                                                                                                                                                                  expect(res.status).toBe(401);
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                            }
                                                                                                                                                                                                                                                              });

                                                                                                                                                                                                                                                                describe("admin address but invalid session token → 401", () => {
                                                                                                                                                                                                                                                                    for (const route of protectedRoutes) {
                                                                                                                                                                                                                                                                          it(`POST ${route.path}`, async () => {
                                                                                                                                                                                                                                                                                  const req = request(app)
                                                                                                                                                                                                                                                                                            .post(`/api/v1${route.path}`)
                                                                                                                                                                                                                                                                                                      .set("x-user-address", ADMIN_ADDRESS)
                                                                                                                                                                                                                                                                                                                .set("Authorization", "Bearer wrong-token");
                                                                                                                                                                                                                                                                                                                        const res = await (route.body ? req.send(route.body) : req);
                                                                                                                                                                                                                                                                                                                                expect(res.status).toBe(401);
                                                                                                                                                                                                                                                                                                                                      });
                                                                                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                                                                                            });

                                                                                                                                                                                                                                                                                                                                              describe("valid admin session → passes the auth gate", () => {
                                                                                                                                                                                                                                                                                                                                                  for (const route of protectedRoutes) {
                                                                                                                                                                                                                                                                                                                                                        it(`POST ${route.path} is not rejected by auth`, async () => {
                                                                                                                                                                                                                                                                                                                                                                const req = request(app)
                                                                                                                                                                                                                                                                                                                                                                          .post(`/api/v1${route.path}`)
                                                                                                                                                                                                                                                                                                                                                                                    .set("x-user-address", ADMIN_ADDRESS)
                                                                                                                                                                                                                                                                                                                                                                                              .set("Authorization", `Bearer ${VALID_TOKEN}`);
                                                                                                                                                                                                                                                                                                                                                                                                      const res = await (route.body ? req.send(route.body) : req);
                                                                                                                                                                                                                                                                                                                                                                                                              // Downstream logic may still fail (mocked DB/Starknet return empty
                                                                                                                                                                                                                                                                                                                                                                                                                      // data) — this only asserts the auth gate itself let the request through.
                                                                                                                                                                                                                                                                                                                                                                                                                              expect(res.status).not.toBe(401);
                                                                                                                                                                                                                                                                                                                                                                                                                                    });
                                                                                                                                                                                                                                                                                                                                                                                                                                        }
                                                                                                                                                                                                                                                                                                                                                                                                                                          });
                                                                                                                                                                                                                                                                                                                                                                                                                                          });