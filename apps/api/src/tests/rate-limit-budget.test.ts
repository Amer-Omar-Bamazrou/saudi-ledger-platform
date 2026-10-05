/**
 * The REQUEST BUDGET over real HTTP (rate limiting, 2026-10-05).
 *
 * The limits are PRODUCTION numbers — nothing here lowers one. A bucket is
 * driven to its edge by planting its count in the shared store (the same row
 * a long stream of requests would leave), and then REAL requests cross it:
 * so what is tested is the middleware's position, keys and arithmetic as they
 * ship, not a toy limiter built for the test.
 *
 * Every refusal is paired with a request that PASSES — another user, another
 * organization, another class, the window after — so a 429 cannot pass
 * because everything is refused, and every "counted" claim reads the counter.
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { BUDGET_POLICY, CLASS_RULES, budgetKey, budgetStore, type BudgetClass } from "../lib/requestBudget";
import { sweepExpiredRateLimits } from "../lib/rateLimitStore";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[rate-limit-budget] no real DATABASE_URL — skipping.");

const P = "rlb";
const PASSWORD = "rlb-http-pw-1";
const email = (k: string) => `${P}-${k}@test.local`;
const GENERAL = BUDGET_POLICY.general.user.limit;

describeMaybe("the request budget — per user, per organization, per class; before anything runs", () => {
  let server: http.Server;
  let base = "";
  let orgX = "", orgY = "";
  const ids: Record<string, number> = {};

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const O = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${O}`);
      await c.query(`DELETE FROM platform_operators WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local') OR target_user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM users WHERE email LIKE '${P}-%@test.local'`);
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
  const as = { admin: client(), book: client(), y: client(), op: client() };

  async function org(slug: string) {
    const id = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,'approved') RETURNING id`, [slug])).rows[0].id as string;
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,$2,1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [id, `${slug} co`]);
    return id;
  }
  async function user(key: string, orgId: string | null, role: string) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const id = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'RLB',$2,'viewer',true) RETURNING id`, [email(key), hash])).rows[0].id as number;
    if (orgId) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [id, orgId, role]);
    ids[key] = id;
    return id;
  }

  /** The stored row for a bucket — exactly the key the middleware writes. */
  const rowKey = (cls: BudgetClass, dim: "user" | "org", id: string | number) => budgetStore.key(budgetKey(cls, dim, id));
  async function plant(cls: BudgetClass, dim: "user" | "org", id: string | number, hits: number, msLeft = 60_000) {
    await pool.query(
      `INSERT INTO rate_limit_hits (key, hits, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET hits = EXCLUDED.hits, expires_at = EXCLUDED.expires_at`,
      [rowKey(cls, dim, id), hits, msLeft],
    );
  }
  async function hits(cls: BudgetClass, dim: "user" | "org", id: string | number): Promise<number | null> {
    const { rows } = await pool.query(`SELECT hits FROM rate_limit_hits WHERE key = $1 AND expires_at >= now()`, [rowKey(cls, dim, id)]);
    return rows[0] ? Number(rows[0].hits) : null;
  }
  const count = async (sql: string, args: unknown[]) => Number((await pool.query(sql, args)).rows[0].n);

  function expect429(r: Res) {
    expect(r.status, r.text).toBe(429);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.json).toEqual({ code: "rate_limited", retryAfterSeconds: expect.any(Number), error: expect.any(String) });
    expect(r.headers.get("retry-after"), "Retry-After equals the body's wait").toBe(String(r.json.retryAfterSeconds));
    expect(r.json.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgX = await org(`${P}-x`);
    orgY = await org(`${P}-y`);
    await user("admin", orgX, "admin");
    await user("book", orgX, "bookkeeper");
    await user("y", orgY, "admin");
    const opId = await user("op", null, "admin");
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [opId]);
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const k of ["admin", "book", "y", "op"] as const) expect((await as[k]("POST", "/auth/login", { email: email(k), password: PASSWORD })).status, k).toBe(200);
  }, 120_000);
  beforeEach(async () => { await __resetRateLimitsForTests(); });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await __resetRateLimitsForTests();
    await cleanup();
  });

  it("below the limit passes; one past it is refused with the contract — 429, the code, Retry-After = the body's wait, the RateLimit headers", async () => {
    await plant("general", "user", ids.admin!, GENERAL - 1);
    const last = await as.admin("GET", "/customers");
    expect(last.status, "the request that REACHES the limit is still served").toBe(200);
    expect(last.headers.get("ratelimit-remaining")).toBe("0");
    const over = await as.admin("GET", "/customers");
    expect429(over);
    expect(over.json.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(over.headers.get("ratelimit-limit")).toBe(String(GENERAL));
    expect(over.headers.get("ratelimit-remaining")).toBe("0");
    expect(await hits("general", "user", ids.admin!), "the refused request was counted too").toBe(GENERAL + 1);
  });

  it("🔴 users do not share a budget; an ORGANIZATION's users do share the organization's; another organization is untouched", async () => {
    await plant("general", "user", ids.admin!, GENERAL);
    expect429(await as.admin("GET", "/customers"));
    // the other user of the same organization is NOT refused by the first user's bucket…
    expect((await as.book("GET", "/customers")).status).toBe(200);
    expect(await hits("general", "user", ids.book!), "…and is counted in their OWN bucket").toBe(1);
    expect(await hits("general", "org", orgX), "both users' requests landed in the one organization bucket").toBe(2);

    await plant("general", "org", orgX, BUDGET_POLICY.general.org.limit);
    expect429(await as.book("GET", "/customers"));
    // movement: organization Y is served and counted in its own bucket — the refusal is not "everything".
    expect((await as.y("GET", "/customers")).status).toBe(200);
    expect(await hits("general", "org", orgY)).toBe(1);
  });

  it("🔴 the classes: an exhausted REPORT budget refuses reports and nothing else — however the path is spelled", async () => {
    await plant("report", "user", ids.admin!, BUDGET_POLICY.report.user.limit);
    expect429(await as.admin("GET", "/reports/trial-balance"));
    // Express routes case-insensitively and ignores a trailing slash: each spelling reaches the
    // same report handler, so each must hit the same report budget (else: a bypass by capitalisation).
    expect429(await as.admin("GET", "/REPORTS/Trial-Balance"));
    expect429(await as.admin("GET", "/reports/trial-balance/"));
    expect429(await as.admin("GET", "/reports/trial-balance?asOf=2026-01-01&x=1"));
    const head = await as.admin("HEAD", "/reports/trial-balance"); // a HEAD answer has no body — status and header only
    expect(head.status).toBe(429);
    expect(Number(head.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await as.admin("GET", "/customers")).status, "the general budget is not the report budget").toBe(200);
    expect((await as.book("GET", "/reports/trial-balance")).status, "nor is another user's").toBe(200);
  });

  it("an exhausted WRITE budget refuses writes and still serves reads", async () => {
    await plant("write", "user", ids.admin!, BUDGET_POLICY.write.user.limit);
    const before = await count(`SELECT count(*) n FROM customers WHERE organization_id = $1`, [orgX]);
    expect429(await as.admin("POST", "/customers", { name: "Refused Customer" }));
    expect429(await as.admin("PATCH", "/customers/999999", { name: "x" }));
    expect(await count(`SELECT count(*) n FROM customers WHERE organization_id = $1`, [orgX]), "a refused create created nothing").toBe(before);
    expect((await as.admin("GET", "/customers")).status).toBe(200);
  });

  it("🔴 ACCOUNTING: a refused payment executed NOTHING, and the same idempotency key then posts exactly once", async () => {
    const bank = await as.admin("POST", "/bank-accounts", { name: "RLB Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, bank.text).toBe(201);
    const cust = await as.admin("POST", "/customers", { name: "RLB Payer" });
    expect(cust.status, cust.text).toBe(201);
    const key = `rlb-pay-${Date.now()}`;
    const body = { customerId: cust.json.id, amount: 250, bankAccountId: bank.json.id, method: "transfer", reference: "RLB-1", allocations: [], idempotencyKey: key };
    const payments = () => count(`SELECT count(*) n FROM payments WHERE organization_id = $1 AND idempotency_key = $2`, [orgX, key]);
    const journals = () => count(`SELECT count(*) n FROM journal_entries WHERE organization_id = $1`, [orgX]);
    const je0 = await journals();

    await plant("write", "user", ids.admin!, BUDGET_POLICY.write.user.limit);
    expect429(await as.admin("POST", "/payments", body));
    expect(await payments(), "no payment row").toBe(0);
    expect(await journals(), "no journal entry").toBe(je0);

    await __resetRateLimitsForTests(); // the window passes
    const first = await as.admin("POST", "/payments", body);
    expect(first.status, first.text).toBe(201);
    const replay = await as.admin("POST", "/payments", body);
    expect(replay.status, replay.text).toBe(201);
    expect(replay.json.id, "the retry is the SAME payment").toBe(first.json.id);
    expect(await payments(), "exactly one payment for the key").toBe(1);
    expect(await journals(), "exactly one posting, after the 429 and the replay").toBe(je0 + 1);
  });

  it("🔴 concurrency cannot overspend: twenty parallel requests against five remaining → exactly five served", async () => {
    await plant("general", "user", ids.book!, GENERAL - 5);
    const results = await Promise.all(Array.from({ length: 20 }, () => as.book("GET", "/customers")));
    const served = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 429).length;
    expect({ served, refused }).toEqual({ served: 5, refused: 15 });
    expect(await hits("general", "user", ids.book!)).toBe(GENERAL + 15);
  });

  it("Retry-After is the time LEFT in the window, and the next window starts from zero", async () => {
    await plant("general", "user", ids.admin!, GENERAL, 30_000);
    const r = await as.admin("GET", "/customers");
    expect429(r);
    expect(r.json.retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect(r.json.retryAfterSeconds).toBeLessThanOrEqual(30);
    // the window has passed (expired 1 s ago, with a count far over the limit)
    await plant("general", "user", ids.admin!, GENERAL + 500, -1_000);
    expect((await as.admin("GET", "/customers")).status).toBe(200);
    expect(await hits("general", "user", ids.admin!), "a new window counts from one").toBe(1);
  });

  it("when TWO buckets refuse, the wait is the LONGER one — retrying when only one has reset is refused again", async () => {
    await plant("general", "user", ids.admin!, GENERAL, 20_000);
    await plant("general", "org", orgX, BUDGET_POLICY.general.org.limit, 50_000);
    const r = await as.admin("GET", "/customers");
    expect429(r);
    expect(r.json.retryAfterSeconds).toBeGreaterThanOrEqual(48);
    expect(r.json.retryAfterSeconds).toBeLessThanOrEqual(50);
  });

  it("🔴 no role is exempt: a platform operator is counted on /operator, and refused there", async () => {
    expect((await as.op("GET", "/operator/applications")).status).toBe(200);
    expect(await hits("general", "user", ids.op!), "the operator's request was counted").toBe(1);
    await plant("general", "user", ids.op!, GENERAL);
    expect429(await as.op("GET", "/operator/applications"));
    // the break-glass class, with the general budget fresh: the refusal is the class's own
    await __resetRateLimitsForTests();
    await plant("break_glass", "user", ids.op!, BUDGET_POLICY.break_glass.user.limit);
    const reset = await as.op("POST", "/operator/users/reset-password", { email: email("book") });
    expect429(reset);
    // the break-glass did not run: the bookkeeper's password still logs in
    const fresh = client();
    expect((await fresh("POST", "/auth/login", { email: email("book"), password: PASSWORD })).status).toBe(200);
  });

  it("the pre-tenant mounts and the business routes spend ONE user budget, and only business routes spend the organization's", async () => {
    expect((await as.admin("GET", "/orgs")).status).toBe(200);
    expect((await as.admin("GET", "/customers")).status).toBe(200);
    expect(await hits("general", "user", ids.admin!)).toBe(2);
    expect(await hits("general", "org", orgX)).toBe(1);
  });

  it("🔴 BOTH DIRECTIONS: every mount behind the session is counted, and the public mounts are not", async () => {
    const src = readFileSync(fileURLToPath(new URL("../routes/index.ts", import.meta.url)), "utf8");
    const authAt = src.indexOf("router.use(requireAuth);");
    expect(authAt).toBeGreaterThan(0);
    const mounts = [...src.matchAll(/router\.use\(\s*"(\/[^"]+)"/g)].map((m) => ({ path: m[1]!, isPublic: m.index! < authAt }));
    const pub = mounts.filter((m) => m.isPublic).map((m) => m.path);
    const priv = mounts.filter((m) => !m.isPublic).map((m) => m.path);
    expect(pub.sort()).toEqual(["/auth", "/deployment", "/healthz", "/invitations"]);
    expect(priv.length, "the authenticated surface (a guard against a parse that finds nothing)").toBeGreaterThan(40);

    await plant("general", "user", ids.admin!, GENERAL + 1_000, 120_000);
    const notRefused: string[] = [];
    for (const m of priv) {
      const r = await as.admin("GET", m);
      if (r.status !== 429) notRefused.push(`${m} → ${r.status}`);
    }
    expect(notRefused, "mounts the budget does not cover").toEqual([]);

    // The public side: refused nowhere by a user budget, even an exhausted one.
    expect((await as.admin("GET", "/healthz")).status).toBe(200);
    expect((await as.admin("GET", "/deployment")).status).toBe(200);
    expect((await as.admin("GET", "/auth/me")).status).toBe(200);
    expect((await as.admin("GET", "/invitations/not-a-token")).status).not.toBe(429);
  }, 120_000);

  it("🔴 every class rule points at a REAL route and refuses it (no rule can silently point at nothing)", async () => {
    // One concrete request per rule; ids are placeholders — the budget runs before the handler.
    const examples: Record<string, { who: "admin" | "op"; method: string; path: string }> = {
      [String(/^\/api\/reports\/export(\/|$)/)]: { who: "admin", method: "GET", path: "/reports/export/trial-balance?format=csv" },
      [String(/^\/api\/invoices\/[^/]+\/document$/)]: { who: "admin", method: "GET", path: "/invoices/999999/document" },
      [String(/^\/api\/(reports|analytics|finance-hub|cash-position)(\/|$)/)]: { who: "admin", method: "GET", path: "/finance-hub/liquidity" },
      [String(/^\/api\/capture$/)]: { who: "admin", method: "POST", path: "/capture" },
      [String(/^\/api\/companies\/current\/logo$/)]: { who: "admin", method: "PUT", path: "/companies/current/logo" },
      [String(/^\/api\/onboarding\/documents$/)]: { who: "admin", method: "POST", path: "/onboarding/documents" },
      [String(/^\/api\/llm\/(categorize|compare)$/)]: { who: "admin", method: "POST", path: "/llm/categorize" },
      [String(/^\/api\/llm\/(status|demo)$/)]: { who: "admin", method: "GET", path: "/llm/status" },
      [String(/^\/api\/ask$/)]: { who: "admin", method: "POST", path: "/ask" },
      [String(/^\/api\/findings\/run$/)]: { who: "admin", method: "POST", path: "/findings/run" },
      [String(/^\/api\/transactions\/upload$/)]: { who: "admin", method: "POST", path: "/transactions/upload" },
      [String(/^\/api\/categorize$/)]: { who: "admin", method: "POST", path: "/categorize" },
      [String(/^\/api\/recognition-schedules\/runs$/)]: { who: "admin", method: "POST", path: "/recognition-schedules/runs" },
      [String(/^\/api\/migration\/batches\/[^/]+\/(chart|parties|open-items|advances|assets)$/)]: { who: "admin", method: "PUT", path: "/migration/batches/00000000-0000-0000-0000-000000000000/chart" },
      [String(/^\/api\/migration\/batches\/[^/]+\/(validate|commit|reverse)$/)]: { who: "admin", method: "POST", path: "/migration/batches/00000000-0000-0000-0000-000000000000/validate" },
      [String(/^\/api\/zatca\/onboarding(\/renew)?$/)]: { who: "admin", method: "POST", path: "/zatca/onboarding" },
      [String(/^\/api\/operator\/users\/reset-password$/)]: { who: "op", method: "POST", path: "/operator/users/reset-password" },
    };
    expect(Object.keys(examples).sort(), "one example per rule — a new rule needs one here").toEqual(CLASS_RULES.map((r) => String(r.path)).sort());
    for (const rule of CLASS_RULES) {
      const ex = examples[String(rule.path)]!;
      await __resetRateLimitsForTests();
      // the class bucket, and ONLY it, is at its limit: the refusal must come from the class.
      await plant(rule.cls, "user", ids[ex.who]!, BUDGET_POLICY[rule.cls].user.limit);
      const r = await as[ex.who](ex.method, ex.path, ex.method === "GET" ? undefined : {});
      expect(r.status, `${rule.cls} ${ex.method} ${ex.path}: ${r.text.slice(0, 120)}`).toBe(429);
      expect(await hits("general", "user", ids[ex.who]!), `${ex.path}: the general bucket was nowhere near its limit`).toBe(1);
    }
    // …and each example REACHES a route when nothing is exhausted: not the router's
    // "Cannot GET" (an HTML 404), which would make the 429 above prove nothing.
    for (const rule of CLASS_RULES) {
      if (rule.cls === "ai" || rule.cls === "bulk" || rule.cls === "zatca_otp") continue; // no side effects wanted; covered by the classifier unit test's paths
      const ex = examples[String(rule.path)]!;
      await __resetRateLimitsForTests();
      const r = await as[ex.who](ex.method, ex.path, ex.method === "GET" ? undefined : {});
      expect(r.headers.get("content-type") ?? "", `${ex.method} ${ex.path} → ${r.status} ${r.text.slice(0, 80)}`).not.toMatch(/text\/html/);
    }
  }, 120_000);

  it("🔴 FAIL-CLOSED: when the counter cannot be written the request is refused 503 — and nothing ran", async () => {
    const original = pool.query.bind(pool);
    const spy = vi.spyOn(pool, "query").mockImplementation(((q: unknown, ...rest: unknown[]) => {
      const text = typeof q === "string" ? q : (q as { text?: string })?.text ?? "";
      if (/INSERT INTO rate_limit_hits/.test(text)) return Promise.reject(new Error("simulated store outage"));
      return (original as (...a: unknown[]) => unknown)(q, ...rest);
    }) as never);
    try {
      const before = await count(`SELECT count(*) n FROM customers WHERE organization_id = $1`, [orgX]);
      const r = await as.admin("POST", "/customers", { name: "Never Created" });
      expect(r.status, r.text).toBe(503);
      expect(r.json).toEqual({ code: "rate_limit_unavailable", error: expect.any(String) });
      expect(await count(`SELECT count(*) n FROM customers WHERE organization_id = $1`, [orgX])).toBe(before);
    } finally {
      spy.mockRestore();
    }
    expect((await as.admin("GET", "/customers")).status, "and recovers when the store does").toBe(200);
  });

  it("the counter table: UNLOGGED (no WAL per request) and still owner-only", async () => {
    const { rows } = await pool.query(`SELECT relpersistence FROM pg_class WHERE relname = 'rate_limit_hits'`);
    expect(rows[0]?.relpersistence).toBe("u");
    const grants = await pool.query(
      `SELECT grantee FROM information_schema.role_table_grants WHERE table_name = 'rate_limit_hits' AND grantee IN ('anon','authenticated','service_role','app_user')`);
    expect(grants.rows).toEqual([]);
  });

  it("the sweep deletes EXPIRED counters and keeps live ones", async () => {
    const dead = budgetStore.key("sweep-test:dead"), live = budgetStore.key("sweep-test:live");
    await pool.query(`INSERT INTO rate_limit_hits (key, hits, expires_at) VALUES ($1, 9, now() - interval '1 second'), ($2, 9, now() + interval '1 minute')
                      ON CONFLICT (key) DO UPDATE SET hits = EXCLUDED.hits, expires_at = EXCLUDED.expires_at`, [dead, live]);
    const { deleted } = await sweepExpiredRateLimits();
    expect(deleted).toBeGreaterThanOrEqual(1);
    // a row whose window ran out is gone; a row whose window runs on is kept — whatever else the table holds
    const { rows } = await pool.query(`SELECT key FROM rate_limit_hits WHERE key IN ($1, $2)`, [dead, live]);
    expect(rows.map((r) => r.key)).toEqual([live]);
  });
});
