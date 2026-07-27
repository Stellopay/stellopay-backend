import { describe, it, expect } from "vitest";
import { reprocessEventsRouter } from "./reprocess-events.js";

/**
 * Issue #273: locks the authorization contract for every route on this
  * router by inspecting Express's own registered middleware stack, so
   * requireAuth/requireAdmin cannot be silently dropped or reordered by a
    * future edit without a test failing here — independent of whether any
     * other test file mocks the auth middleware away.
      */
      describe("reprocessEventsRouter — authorization contract (Issue #273)", () => {
        const routeLayers = (reprocessEventsRouter as any).stack.filter(
            (layer: any) => layer.route,
              );

                it("registers exactly the three expected routes", () => {
                    const paths = routeLayers.map((l: any) => l.route.path);
                        expect(paths).toEqual([
                              "/reprocess-events/tx/:tx_hash",
                                    "/reprocess-events/batch",
                                          "/reprocess-events/status-changes",
                                              ]);
                                                });

                                                  it.each(routeLayers.map((l: any) => [l.route.path, l.route.stack]))(
                                                      "%s requires auth then admin before its handler",
                                                          (_path: string, stack: any[]) => {
                                                                const names = stack.map((s) => s.name);
                                                                      const authIdx = names.indexOf("requireAuth");
                                                                            const adminIdx = names.indexOf("requireAdmin");

                                                                                  expect(authIdx).toBeGreaterThanOrEqual(0);
                                                                                        expect(adminIdx).toBeGreaterThanOrEqual(0);
                                                                                              expect(authIdx).toBeLessThan(adminIdx);
                                                                                                    expect(adminIdx).toBeLessThan(stack.length - 1); // a handler still follows
                                                                                                        },
                                                                                                          );
                                                                                                          });