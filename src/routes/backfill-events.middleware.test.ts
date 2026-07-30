import { describe, it, expect, vi } from "vitest";

// Must mock config.js before any module that transitively imports it
// (backfill-events → auth/middleware → session → config).
vi.mock("../config.js", () => ({
  env: { ADMIN_ADDRESSES: ["0xabc1"] },
}));

vi.mock("../auth/session.js", () => ({
  requireSession: vi.fn(async () => true),
}));

import { backfillEventsRouter } from "./backfill-events.js";

/**
 * Issue #263: locks the authorization contract for every route on this
 * router by inspecting Express's own registered middleware stack, so
 * requireAuth/requireAdmin cannot be silently dropped or reordered by a
 * future edit without a test failing here — independent of whether any
 * other test file mocks the auth middleware away.
 */
describe("backfillEventsRouter — authorization contract (Issue #263)", () => {
  const routeLayers = (backfillEventsRouter as any).stack.filter(
    (layer: any) => layer.route,
  );

  it("registers exactly the two expected POST routes", () => {
    const paths = routeLayers.map((l: any) => l.route.path);
    expect(paths).toEqual([
      "/backfill/employee-events",
      "/backfill/milestone-events",
    ]);
  });

  it.each(routeLayers.map((l: any) => [l.route.path, l.route.stack]))(
    "%s requires auth then admin before its handler",
    (_path: string, stack: any[]) => {
      const names = stack.map((s: any) => s.name);
      const authIdx = names.indexOf("requireAuth");
      const adminIdx = names.indexOf("requireAdmin");

      expect(authIdx).toBeGreaterThanOrEqual(0);
      expect(adminIdx).toBeGreaterThanOrEqual(0);
      expect(authIdx).toBeLessThan(adminIdx);
      expect(adminIdx).toBeLessThan(stack.length - 1); // a handler still follows
    },
  );
});
