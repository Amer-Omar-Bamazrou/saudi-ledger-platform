/**
 * F2 — what the operator job runner can actually REACH.
 *
 * 🔴 THE DEFECT. `POST /api/operator/zatca/jobs/:name/run` validated the
 * requested job against `getScheduler().names()` — the whole scheduler
 * registry. So the operator surface's reach grew every time any milestone
 * registered a background job, and nobody ever decided that it should:
 *
 *   the operator UI offers  3 buttons   (drain outbox, sweep archive, renewals)
 *   the route's comment names 3 jobs
 *   the API permitted        9
 *
 * The six nobody chose write into tenants' ledgers, email tenants' admins,
 * irreversibly promote captures into a store that by design cannot delete,
 * purge staged bytes, and reset the demo database.
 *
 * 🔴 Neither file was wrong on its own — `jobs/index.ts` must register every
 * job (that is how one stays operable with its timer off) and `routes/operator`
 * correctly validated against a list. The defect is the EDGE: a registration
 * decision silently doubled as an authorization decision. That is the
 * composition class in CLAUDE.md §3, and it is invisible to any review that
 * reads one file at a time — which is why this audit enumerated the privilege's
 * REACH rather than its routes.
 *
 * Two things are pinned here:
 *   A. the FORCING FUNCTION — registry and classification must agree in BOTH
 *      directions, so a new job cannot become operator-runnable by default and
 *      cannot be silently forgotten either;
 *   B. the BEHAVIOUR over HTTP — a forbidden job is refused, a permitted one
 *      runs, and the run is AUDITED. The job runner was the only operator route
 *      that recorded nothing, while being the most consequential one available.
 */

process.env.PORT ??= "3107";
process.env.SESSION_SECRET ??= "operator-job-reach-test-session-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { getScheduler } from "../jobs";
import {
  OPERATOR_JOB_RULES,
  isOperatorRunnable,
  operatorRunnableJobNames,
} from "../lib/operatorJobs";
import { operatorZatcaService } from "../services/operatorZatca.service";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");

// ── A. The forcing function — DB-free, always runs. ────────────────────────
describe("F2/A — the operator surface declares its own reach", () => {
  it("🔴 every REGISTERED job is classified — a new job cannot default to runnable", () => {
    const registered = getScheduler().names().sort();
    const classified = Object.keys(OPERATOR_JOB_RULES).sort();
    // Fails the day someone registers a job without deciding this. That is the
    // whole point: the decision becomes mandatory rather than inherited.
    expect(classified).toEqual(registered);
  });

  it("🔴 every CLASSIFIED job is registered — the list cannot rot", () => {
    // The other direction. A renamed or deleted job leaves a stale rule that
    // looks like a considered decision and governs nothing.
    const registered = new Set(getScheduler().names());
    for (const name of Object.keys(OPERATOR_JOB_RULES)) {
      expect(registered.has(name), `${name} is classified but not registered`).toBe(true);
    }
  });

  it("the reach is exactly the three the UI offers and the route documents", () => {
    expect(operatorRunnableJobNames().sort()).toEqual(
      ["einvoice-archive", "einvoice-outbox", "zatca-renewal-reminders"].sort(),
    );
  });

  it("🔴 the six that were reachable by accident are refused", () => {
    // Named individually rather than derived, so deleting a rule cannot quietly
    // shrink what this test claims to cover.
    for (const name of [
      "capture-promotion",
      "capture-purge",
      "recurring-documents",
      "platform-alarms",
      "demo-reset",
      "scheduled-findings",
    ]) {
      expect(getScheduler().names(), `${name} should still be registered`).toContain(name);
      expect(isOperatorRunnable(name), `${name} must not be operator-runnable`).toBe(false);
    }
  });

  it("every rule carries a REASON — a classification with no argument is a guess", () => {
    for (const [name, rule] of Object.entries(OPERATOR_JOB_RULES)) {
      expect(rule.reason.length, `${name} has no reason`).toBeGreaterThan(40);
    }
  });

  it("an unregistered name is refused rather than treated as unclassified", () => {
    expect(isOperatorRunnable("no-such-job")).toBe(false);
  });

  it("the service refuses a forbidden job WITHOUT reaching the scheduler", async () => {
    // Defence in depth: the route refuses first, but a second caller must not
    // be able to regain the reach. `demo-reset` would wipe a demo database.
    await expect(operatorZatcaService.runJob("demo-reset")).rejects.toThrow(/not operator-runnable/i);
  });

  it("ANTI-VACUITY: jobNames() is the operator set, not empty and not everything", () => {
    const names = operatorZatcaService.jobNames();
    expect(names.length).toBe(3);
    expect(names.length).toBeLessThan(getScheduler().names().length);
  });
});

// ── B. Behaviour over HTTP, including the audit record. ────────────────────
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[operator-job-reach] no real DATABASE_URL — skipping the HTTP half.");
}

describeMaybe("F2/B — refused, permitted, and audited", () => {
  let server: http.Server;
  let base = "";
  let operatorId = 0;
  const PW = "JobReachPw123!";
  const OP_EMAIL = "jobreach-operator@test.local";

  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'jobreach-%')`;
  const cleanup = async () => {
    await pool.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'jobreach-%'`);
  };

  let cookie = "";
  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) =>
      c.startsWith("ksa_ledger_sid="),
    );
    if (sid) cookie = sid.split(";")[0];
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }

  const jobRunEvents = async (job?: string) => {
    const { rows } = await pool.query(
      `SELECT action, metadata FROM security_audit_logs
        WHERE actor_user_id = $1 AND action = 'operator.job_run'`,
      [operatorId],
    );
    return job ? rows.filter((r: any) => r.metadata?.job === job) : rows;
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();

    const hash = await bcrypt.hash(PW, 12);
    operatorId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,'Job Reach Operator',$2,'viewer',true) RETURNING id`,
      [OP_EMAIL, hash],
    )).rows[0].id;
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;

    expect((await api("POST", "/auth/login", { email: OP_EMAIL, password: PW })).status).toBe(200);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("🔴 an operator CANNOT run demo-reset (it would wipe a demo database)", async () => {
    const r = await api("POST", "/operator/zatca/jobs/demo-reset/run");
    expect(r.status).toBe(400);
    // The refusal does not enumerate the forbidden jobs back to the caller.
    expect(r.body?.error).not.toMatch(/capture-purge|scheduled-findings/);
  });

  it("🔴 nor any of the other five that were reachable by accident", async () => {
    for (const name of [
      "capture-promotion",
      "capture-purge",
      "recurring-documents",
      "platform-alarms",
      "scheduled-findings",
    ]) {
      const r = await api("POST", `/operator/zatca/jobs/${name}/run`);
      expect(r.status, `${name} should be refused`).toBe(400);
    }
  });

  it("🔴 a refused run writes NO audit event — nothing happened, nothing recorded", async () => {
    expect(await jobRunEvents()).toHaveLength(0);
  });

  it("ANTI-VACUITY: a PERMITTED job still runs", async () => {
    // Without this the suite would pass just as well against a route that
    // refuses everything, which is an outage rather than a boundary.
    const r = await api("POST", "/operator/zatca/jobs/einvoice-archive/run");
    expect(r.status).toBe(200);
    expect(r.body?.job).toBe("einvoice-archive");
  });

  it("🔴 and the permitted run IS audited — the runner used to record nothing", async () => {
    const events = await jobRunEvents("einvoice-archive");
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("operator.job_run");
  });

  it("a non-operator cannot reach the runner at all (the guard still holds)", async () => {
    const hash = await bcrypt.hash(PW, 12);
    const plainId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ('jobreach-plain@test.local','Plain',$1,'viewer',true) RETURNING id`,
      [hash],
    )).rows[0].id;
    expect(plainId).toBeGreaterThan(0);

    cookie = "";
    expect((await api("POST", "/auth/login", { email: "jobreach-plain@test.local", password: PW })).status).toBe(200);
    const r = await api("POST", "/operator/zatca/jobs/einvoice-archive/run");
    expect(r.status).toBe(403);
  });
});
