/**
 * THE PRIVILEGE SURFACE MAP — what each privilege can REACH, derived from the
 * running application rather than from what the routes intend.
 *
 * ── Why an artefact instead of an audit ────────────────────────────────────
 * The same argument that produced `route-reachability` and
 * `org-seed-trigger`: a mechanical artefact that FAILS when reality drifts
 * beats a review someone remembers to repeat. Five audits read these routes
 * and none of them produced a list of what each privilege actually reaches,
 * because a reviewer reads a file and this reads the middleware stack.
 *
 * ── What makes it a measurement and not a restatement ──────────────────────
 * It is built from `app`'s LIVE router stack — the layers Express will really
 * execute, in the order it will really execute them — and cross-checked against
 * the mounts declared in `routes/index.ts`. Two independent sources must agree:
 *
 *   - a prefix declared in source that matches no live layer  → FAIL
 *   - a live router layer matching no declared prefix         → FAIL
 *
 * So the map cannot quietly diverge from either the code or the runtime. The
 * privilege TIER of a route is positional — it is decided by which guard layers
 * precede it — which is exactly how Express decides it, so this reads the real
 * rule rather than a documented one.
 *
 * ── 🔴 ITS LIMITS, STATED SO IT IS NOT OVERSOLD ────────────────────────────
 * This covers ONE of the two shapes that have actually bitten this codebase,
 * and it is important that nobody reads it as covering both:
 *
 *   ✅ **A guard that exempts a class from itself**, and its neighbours: a
 *      route mounted on the wrong side of a guard, a business route with no
 *      `requirePermission`, a new public surface, a privilege tier silently
 *      widening. Those are all POSITIONAL facts about the middleware stack, and
 *      the map is exactly a measurement of positions.
 *
 *   ❌ **F1 — and this is the honest part. THE MAP WOULD NOT HAVE CAUGHT F1.**
 *      Every route involved in F1 was mounted in the right tier behind the
 *      right guard. `POST /orgs/:orgId/members` is correctly authenticated and
 *      correctly checks org-admin; `POST /auth/users/:id/reset-password` is
 *      correctly authenticated and correctly checks admin scope. The map would
 *      have rendered both as perfectly placed — because they were. F1 lived in
 *      a DATA-FLOW relationship between two correct routes: one WROTE the fact
 *      the other TRUSTED. That is not a position in a stack, and no amount of
 *      stack introspection reveals it.
 *      The countermeasure for F1's shape is the different question recorded in
 *      CLAUDE.md §3 — for each privilege, list the state it can WRITE, then
 *      grep every guard that READS that state. That stays human.
 *
 * Two shapes, two countermeasures. This file is one of them.
 */

process.env.PORT ??= "3109";
process.env.SESSION_SECRET ??= "privilege-surface-map-test-session-secret-01234";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A guard layer that decides a tier boundary, by the function's own name. */
const LADDER = ["requireAuth", "requirePlatformOperator", "resolveTenant"] as const;

type Tier = "public" | "authenticated" | "operator" | "tenant";

interface MountedRoute {
  prefix: string;
  tier: Tier;
  /** Guard layers mounted between the previous router and this one. */
  ownGuards: number;
}

interface SurfaceMap {
  ladder: { name: string; index: number }[];
  routes: MountedRoute[];
  unmatchedLayers: number[];
  unmatchedPrefixes: string[];
}

let map: SurfaceMap;

beforeAll(async () => {
  const app: any = (await import("../app")).default;

  // The main application router: the layer whose handle carries the mounts.
  const root = (app.router ?? app._router).stack;
  const main = root.find((l: any) => (l.handle?.stack?.length ?? 0) > 10);
  expect(main, "could not find the main router layer").toBeTruthy();
  const layers: any[] = main.handle.stack;

  // SOURCE half: every prefix `routes/index.ts` declares it mounts.
  const src = readFileSync(
    fileURLToPath(new URL("../routes/index.ts", import.meta.url)),
    "utf8",
  );
  const declared = [...src.matchAll(/^router\.use\(\s*"([^"]+)"/gm)].map((m) => m[1]);
  // Multi-line mounts (`router.use(\n  "/zatca/onboarding",`) too.
  const declaredMultiline = [...src.matchAll(/^router\.use\(\s*\n\s*"([^"]+)"/gm)].map((m) => m[1]);
  const prefixes = [...new Set([...declared, ...declaredMultiline])];

  const ladder = LADDER.map((name) => ({
    name,
    index: layers.findIndex((l) => l.name === name),
  }));

  const authIdx = ladder.find((l) => l.name === "requireAuth")!.index;
  const tenantIdx = ladder.find((l) => l.name === "resolveTenant")!.index;
  const operatorIdx = ladder.find((l) => l.name === "requirePlatformOperator")!.index;

  const routes: MountedRoute[] = [];
  const unmatchedLayers: number[] = [];
  const matchedPrefixes = new Set<string>();
  let guardsSinceLastRouter = 0;

  layers.forEach((layer, i) => {
    if (layer.name !== "router") {
      guardsSinceLastRouter += 1;
      return;
    }
    // Recover the mount prefix by asking the layer what it matches — the
    // runtime's own answer, not a re-derivation of the source.
    const prefix = prefixes.find((p) => {
      try {
        return !!layer.matchers?.[0]?.(p);
      } catch {
        return false;
      }
    });
    if (!prefix) {
      unmatchedLayers.push(i);
      guardsSinceLastRouter = 0;
      return;
    }
    matchedPrefixes.add(prefix);

    const tier: Tier =
      i < authIdx ? "public"
      : i > tenantIdx ? "tenant"
      : i > operatorIdx ? "operator"
      : "authenticated";

    routes.push({ prefix, tier, ownGuards: guardsSinceLastRouter });
    guardsSinceLastRouter = 0;
  });

  map = {
    ladder,
    routes,
    unmatchedLayers,
    unmatchedPrefixes: prefixes.filter((p) => !matchedPrefixes.has(p)),
  };
});

describe("privilege surface map — the two sources agree", () => {
  it("🔴 every live router layer maps to a declared mount", () => {
    // A live mount nobody declared is a surface nobody reviewed.
    expect(map.unmatchedLayers).toEqual([]);
  });

  it("🔴 every declared mount is live", () => {
    // A declared mount that matches no layer means the map is describing a
    // route the runtime does not have — the map rotting rather than the code.
    expect(map.unmatchedPrefixes).toEqual([]);
  });

  it("the guard ladder exists, in order", () => {
    for (const rung of map.ladder) {
      expect(rung.index, `${rung.name} is not mounted at all`).toBeGreaterThanOrEqual(0);
    }
    const indices = map.ladder.map((l) => l.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe("privilege surface map — what each privilege reaches", () => {
  it("🔴 the PUBLIC surface is exactly these four, and nothing joins it silently", () => {
    // The single highest-value assertion here. Anything mounted above
    // `requireAuth` is reachable with no session at all, and mount ORDER is the
    // only thing that decides it — a one-line move, invisible in review.
    expect(map.routes.filter((r) => r.tier === "public").map((r) => r.prefix).sort()).toEqual(
      ["/auth", "/deployment", "/healthz", "/invitations"].sort(),
    );
  });

  it("🔴 the OPERATOR surface is exactly one mount, behind requirePlatformOperator", () => {
    const operatorRoutes = map.routes.filter((r) => r.tier === "operator");
    expect(operatorRoutes.map((r) => r.prefix)).toEqual(["/operator"]);
    // Mounted WITH its guard: `router.use("/operator", requirePlatformOperator, operator)`
    // puts the guard immediately before the router, so it must not be bare.
    expect(operatorRoutes[0].ownGuards).toBeGreaterThanOrEqual(1);
  });

  it("the AUTHENTICATED-but-not-tenant-scoped surface is exactly these two", () => {
    // These run before `resolveTenant`, so they have NO RLS backstop and their
    // authorization is entirely explicit in the service. Adding one is a real
    // decision — F1 lived on one of them.
    expect(map.routes.filter((r) => r.tier === "authenticated").map((r) => r.prefix).sort()).toEqual(
      ["/onboarding", "/orgs"].sort(),
    );
  });

  it("🔴 every TENANT route is preceded by at least one guard — none is mounted bare", () => {
    // `requirePermission(resource)` is an anonymous closure, so it cannot be
    // identified by name; what IS checkable is that a guard layer sits between
    // the previous router and this one. A business route mounted with no guard
    // would show ownGuards === 0.
    const bare = map.routes.filter((r) => r.tier === "tenant" && r.ownGuards === 0);
    expect(bare.map((r) => r.prefix)).toEqual([]);
  });

  it("ANTI-VACUITY: the map actually found the surface it claims to measure", () => {
    // Without this, an empty or broken map would satisfy every assertion above
    // — "no bare routes" is trivially true of no routes.
    expect(map.routes.length).toBeGreaterThanOrEqual(30);
    expect(map.routes.filter((r) => r.tier === "tenant").length).toBeGreaterThanOrEqual(25);
    expect(new Set(map.routes.map((r) => r.tier)).size).toBe(4);
  });

  it("prints the map, so a reviewer sees reach rather than intent", () => {
    const byTier: Record<string, string[]> = {};
    for (const r of map.routes) (byTier[r.tier] ??= []).push(r.prefix);
    const rendered = (["public", "authenticated", "operator", "tenant"] as Tier[])
      .map((t) => `  ${t.padEnd(15)} ${(byTier[t] ?? []).length.toString().padStart(2)}  ${(byTier[t] ?? []).join(" ")}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.log(`\nPRIVILEGE SURFACE MAP (from the live middleware stack)\n${rendered}\n`);
    expect(rendered).toContain("/operator");
  });
});
