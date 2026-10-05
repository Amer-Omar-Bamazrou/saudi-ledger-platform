/**
 * Rate limiting BEFORE a session exists (2026-10-05): login per IP and per
 * ACCOUNT, change-password sharing the account budget, and the two limiters C1
 * left in process memory (invitations, onboarding upload) — over real HTTP,
 * at production numbers.
 *
 * 🔴 The enumeration property is asserted directly: the account limit refuses
 * an email that has no account exactly as it refuses one that does.
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { PostgresRateLimitStore } from "../lib/rateLimitStore";
import { accountKeyOf, clientIpKey } from "../lib/rateLimit";
import { budgetKey, budgetStore } from "../lib/requestBudget";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[rate-limit-login] no real DATABASE_URL — skipping.");

const P = "rll";
const PASSWORD = "rll-http-pw-1";
const email = (k: string) => `${P}-${k}@test.local`;
const LOOPBACK = clientIpKey("127.0.0.1");

/** Key builders with the SAME namespaces the routes use — a renamed store fails these tests. */
const keyIn = (name: string, clientKey: string) => new PostgresRateLimitStore(name).key(clientKey);

describeMaybe("rate limits before a session: login per IP and per account, invitations, onboarding upload", () => {
  let server: http.Server;
  let base = "";
  let orgX = "";
  let victimId = 0;

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const U = `(SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`;
      await c.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${U} OR target_user_id IN ${U} OR organization_id IN (SELECT id FROM organizations WHERE slug LIKE '${P}-%')`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN ${U}`);
      await c.query(`DELETE FROM organization_memberships WHERE user_id IN ${U}`);
      await c.query(`DELETE FROM users WHERE email LIKE '${P}-%@test.local'`);
      await c.query(`DELETE FROM companies WHERE organization_id IN (SELECT id FROM organizations WHERE slug LIKE '${P}-%')`);
      await c.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  };

  type Res = { status: number; json: any; text: string; headers: Headers };
  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
      const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="));
      if (sid) cookie = sid.split(";")[0]!;
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: res.status, json, text, headers: res.headers };
    };
  }

  async function plant(key: string, hits: number, msLeft = 60_000) {
    await pool.query(
      `INSERT INTO rate_limit_hits (key, hits, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET hits = EXCLUDED.hits, expires_at = EXCLUDED.expires_at`,
      [key, hits, msLeft],
    );
  }
  async function hitsOf(key: string): Promise<number | null> {
    const { rows } = await pool.query(`SELECT hits FROM rate_limit_hits WHERE key = $1 AND expires_at >= now()`, [key]);
    return rows[0] ? Number(rows[0].hits) : null;
  }
  /** The refund runs after the response is sent; wait for the count to settle. */
  async function settledHits(key: string): Promise<number | null> {
    let last = await hitsOf(key);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const now = await hitsOf(key);
      if (now === last) return now;
      last = now;
    }
    return last;
  }
  const acct = (e: string) => keyIn("auth-account", accountKeyOf(e));

  function expect429(r: Res) {
    expect(r.status, r.text).toBe(429);
    expect(r.json).toEqual({ code: "rate_limited", retryAfterSeconds: expect.any(Number), error: expect.any(String) });
    expect(r.headers.get("retry-after")).toBe(String(r.json.retryAfterSeconds));
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgX = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,'pending_review') RETURNING id`, [`${P}-x`])).rows[0].id;
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'rll co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgX]);
    const hash = await bcrypt.hash(PASSWORD, 4);
    victimId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'RLL',$2,'viewer',true) RETURNING id`, [email("victim"), hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [victimId, orgX]);
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  }, 60_000);
  beforeEach(async () => { await __resetRateLimitsForTests(); });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await __resetRateLimitsForTests();
    await cleanup();
  });

  it("🔴 the IP limit: ten attempts, then 429 — and rotating X-Forwarded-For, the User-Agent or the email does not buy an eleventh", async () => {
    const anon = client();
    for (let i = 0; i < 10; i++) {
      const r = await anon("POST", "/auth/login", { email: email(`nobody-${i}`), password: "wrong-password" },
        { "x-forwarded-for": `198.51.100.${i}`, "user-agent": `probe/${i}` });
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const over = await anon("POST", "/auth/login", { email: email("nobody-x"), password: "wrong-password" }, { "x-forwarded-for": "203.0.113.250" });
    expect429(over);
    expect(over.json.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    expect(over.headers.get("ratelimit-limit")).toBe("10");
    expect(await hitsOf(keyIn("auth", LOOPBACK)), "every attempt landed in the ONE loopback bucket").toBe(11);
  });

  it("🔴 the ACCOUNT limit refuses even the CORRECT password, and signs nobody in", async () => {
    await plant(acct(email("victim")), 60);
    const c = client();
    expect429(await c("POST", "/auth/login", { email: email("victim"), password: PASSWORD }));
    expect((await c("GET", "/auth/me")).status, "no session was created").toBe(401);
    // the IP bucket is nowhere near its limit — the refusal is the account's
    expect(await hitsOf(keyIn("auth", LOOPBACK))).toBe(1);
    // movement: with the account's budget clear, the very same request signs in — the refusal was the budget
    await plant(acct(email("victim")), 0);
    expect((await client()("POST", "/auth/login", { email: email("victim"), password: PASSWORD })).status).toBe(200);
  });

  it("🔴 ENUMERATION: an email with NO account is refused exactly as one with an account", async () => {
    await pool.query(
      `INSERT INTO rate_limit_hits (key, hits, expires_at) VALUES ($1, 60, now() + interval '30 minutes'), ($2, 60, now() + interval '30 minutes')
       ON CONFLICT (key) DO UPDATE SET hits = EXCLUDED.hits, expires_at = EXCLUDED.expires_at`,
      [acct(email("victim")), acct(email("ghost-never-registered"))]);
    const real = await client()("POST", "/auth/login", { email: email("victim"), password: "a-guess" });
    const ghost = await client()("POST", "/auth/login", { email: email("ghost-never-registered"), password: "a-guess" });
    expect429(real);
    expect429(ghost);
    const shape = (r: Res) => ({ ...r.json, retryAfterSeconds: 0, error: String(r.json.error).replace(/\d+/g, "N") });
    expect(shape(ghost)).toEqual(shape(real));
    expect(Math.abs(real.json.retryAfterSeconds - ghost.json.retryAfterSeconds)).toBeLessThanOrEqual(1);
    expect(Object.keys(ghost.json).sort()).toEqual(Object.keys(real.json).sort());
  });

  it("🔴 a NUL byte in the email is counted like any attempt — not read as a store outage (no 503, no page)", async () => {
    const r = await client()("POST", "/auth/login", { email: "\u0000rll-nul@test.local", password: "x" });
    // The LIMITER's property only: it counted the attempt and did not fail. (What the login
    // handler then answers for a NUL email is its own input handling, outside rate limiting.)
    expect(r.status, r.text).not.toBe(503);
    expect(r.json?.code).not.toBe("rate_limit_unavailable");
    expect(await settledHits(acct("\u0000rll-nul@test.local")), "counted under its digest").toBe(1);
  });

  it("the account key ignores case and surrounding space — a variant spelling is the same account budget", async () => {
    await plant(acct(email("victim")), 60);
    expect429(await client()("POST", "/auth/login", { email: `  ${email("victim").toUpperCase()} `, password: PASSWORD }));
  });

  it("🔴 FAILURES are counted and a SUCCESS is refunded — the owner logging in does not spend what an attacker drains", async () => {
    const key = acct(email("victim"));
    expect((await client()("POST", "/auth/login", { email: email("victim"), password: "wrong" })).status).toBe(401);
    expect(await settledHits(key)).toBe(1);
    expect((await client()("POST", "/auth/login", { email: email("victim"), password: PASSWORD })).status).toBe(200);
    expect(await settledHits(key), "counted then refunded: still one").toBe(1);
    expect((await client()("POST", "/auth/login", { email: email("victim"), password: "wrong-again" })).status).toBe(401);
    expect(await settledHits(key)).toBe(2);
    // the IP limit counts every attempt, successes included
    expect(await hitsOf(keyIn("auth", LOOPBACK))).toBe(3);
  });

  it("a refund that FAILS is logged and leaves the hit counted — it never takes the process down", async () => {
    const original = pool.query.bind(pool);
    const spy = vi.spyOn(pool, "query").mockImplementation(((q: unknown, ...rest: unknown[]) => {
      const text = typeof q === "string" ? q : (q as { text?: string })?.text ?? "";
      if (/UPDATE rate_limit_hits SET hits = GREATEST/.test(text)) return Promise.reject(new Error("simulated refund failure"));
      return (original as (...a: unknown[]) => unknown)(q, ...rest);
    }) as never);
    try {
      expect((await client()("POST", "/auth/login", { email: email("victim"), password: PASSWORD })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 200)); // let the finish listener run
    } finally {
      spy.mockRestore();
    }
    expect(await hitsOf(acct(email("victim"))), "no refund happened, so the success stays counted").toBe(1);
    expect((await client()("GET", "/healthz")).status, "the server is alive").toBe(200);
  });

  it("change-password spends the SAME account budget as login", async () => {
    const c = client();
    expect((await c("POST", "/auth/login", { email: email("victim"), password: PASSWORD })).status).toBe(200);
    await plant(acct(email("victim")), 60);
    expect429(await c("POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: "a-new-password-1" }));
    await plant(acct(email("victim")), 0);
    expect((await client()("POST", "/auth/login", { email: email("victim"), password: PASSWORD })).status, "the password did not change").toBe(200);
  });

  it("🔴 invitations count in the SHARED store (they counted in process memory) and refuse with the contract", async () => {
    const key = keyIn("invite", LOOPBACK);
    expect((await client()("GET", "/invitations/no-such-token-0001")).status).toBe(404);
    expect(await hitsOf(key), "a row in Postgres — MemoryStore would leave none").toBe(1);
    await plant(key, 20);
    expect429(await client()("GET", "/invitations/no-such-token-0002"));
    expect429(await client()("POST", "/invitations/no-such-token-0003/accept", { name: "x", password: "y" }));
  });

  it("🔴 onboarding upload counts in the SHARED store per IP, and in the request budget per USER", async () => {
    const c = client();
    expect((await c("POST", "/auth/login", { email: email("victim"), password: PASSWORD })).status).toBe(200);
    const r = await c("POST", "/onboarding/documents", {});
    expect(r.status, r.text).toBe(400);
    expect(await hitsOf(keyIn("onboarding-upload", LOOPBACK)), "the IP limiter's row").toBe(1);
    const { rows } = await pool.query(`SELECT hits FROM rate_limit_hits WHERE key = $1`, [budgetStore.key(budgetKey("upload", "user", victimId))]);
    expect(Number(rows[0]?.hits), "the user's upload budget").toBe(1);
    await plant(keyIn("onboarding-upload", LOOPBACK), 20, 30 * 60_000);
    expect429(await c("POST", "/onboarding/documents", {}));
  });
});
