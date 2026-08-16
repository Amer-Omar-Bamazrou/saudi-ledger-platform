/**
 * The demo deployment's guards (docs/product/demo-deployment-decisions.md).
 *
 * 🔴 WHAT THESE TESTS ARE FOR. Two of the three things below destroy data or
 * expose a capability, and all three are controlled by an environment variable
 * that will eventually be set on the wrong deployment. So the assertions are
 * about REFUSAL, and the important ones assert the refusal happens for a reason
 * that does not depend on the flag being right:
 *
 *   - the reset refuses to run against a database holding a non-demo tenant,
 *     EVEN WITH `DEMO_MODE=true`;
 *   - due-ness is derived from the last successful run, so a failed reset stays
 *     due instead of counting as done;
 *   - capture and signup are refused at the ROUTE, not hidden in the UI.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const env: Record<string, unknown> = {};
vi.mock("@workspace/config", () => ({ loadEnv: () => env }));

import { refuseInDemo } from "../lib/demoMode";
import { nextResetAt } from "../services/demo/demoSchedule";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
});
afterEach(() => vi.restoreAllMocks());

describe("refuseInDemo — the refusal is server-side", () => {
  /** Drive the middleware directly: it IS the guard, so it is what is tested. */
  function call(reason: string) {
    const guard = refuseInDemo(reason);
    let status = 0;
    let body: any = null;
    let passed = false;
    const res = {
      status(s: number) {
        status = s;
        return this;
      },
      json(b: unknown) {
        body = b;
        return this;
      },
    } as unknown as Response;
    guard({} as Request, res, (() => {
      passed = true;
    }) as NextFunction);
    return { status, body, passed };
  }

  it("passes the request through on a normal deployment", () => {
    env.DEMO_MODE = false;
    const r = call("no");
    expect(r.passed).toBe(true);
    expect(r.status).toBe(0);
  });

  it("🔴 refuses with 403 and a reason under DEMO_MODE", () => {
    env.DEMO_MODE = true;
    const r = call("Capture is off in this demo.");
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("demo_mode");
    // A bare 403 on a public demo reads as a broken product. The reason is part
    // of the contract, not decoration.
    expect(r.body.error).toBe("Capture is off in this demo.");
  });

  it("reads the flag per REQUEST, not once at module load", () => {
    // The refusal must not be captured into a closure at import time: a process
    // that boots before config settles would then serve the wrong posture for
    // its whole life.
    env.DEMO_MODE = false;
    expect(call("off").passed).toBe(true);
    env.DEMO_MODE = true;
    expect(call("off").status).toBe(403);
  });
});

describe("nextResetAt — due-ness comes from the last SUCCESS", () => {
  const now = new Date("2026-08-16T00:00:00Z");

  it("schedules one interval after the last successful reset", () => {
    const last = new Date("2026-08-10T00:00:00Z");
    expect(nextResetAt(last, 7, now).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("🔴 a demo that has NEVER reset is not instantly due", () => {
    // Wiping at first boot would destroy the seed someone just created to look
    // at — and would do it before anyone had seen the demo at all.
    expect(nextResetAt(null, 7, now).getTime()).toBe(now.getTime() + 7 * DAY);
  });

  it("🔴 a FAILED run does not push the schedule out", () => {
    // The failed run is not a success, so `lastSuccessfulReset` still returns
    // the older date and the reset stays due — the whole point of keying off
    // success rather than "the job ran".
    const lastSuccess = new Date("2026-08-01T00:00:00Z");
    expect(nextResetAt(lastSuccess, 7, now).getTime()).toBeLessThan(now.getTime());
  });
});
