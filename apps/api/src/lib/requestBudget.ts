/**
 * The REQUEST BUDGET — rate limiting for every authenticated request.
 *
 * Design record, with the threat model and the measurement behind every
 * number: `docs/product/design-rate-limiting.md`. The 429 contract and the
 * pre-session limiters live in `lib/rateLimit.ts`; both count in the shared
 * Postgres store (`lib/rateLimitStore.ts`).
 *
 * ── What is counted ────────────────────────────────────────────────────────
 * Each request is counted against several BUCKETS at once, in ONE statement:
 *
 *   - the USER's budget (a 10-second burst and a 60-second sustained window),
 *   - the ORGANIZATION's budget — so a tenant cannot multiply its allowance by
 *     creating accounts, and one tenant's flood is capped before it is the
 *     platform's problem,
 *   - and, for the classes below, that CLASS's user and organization budgets:
 *     writes, report reads, PDF/exports, uploads, bulk imports, AI calls, the
 *     ZATCA OTP exchange, and the operator's break-glass reset.
 *
 * A request is refused when ANY of its buckets is over its limit, and it is
 * told to wait for the LONGEST of them. Refused requests are counted too (a
 * fixed window does not extend, so hammering does not lengthen the wait — it
 * only fails to shorten it).
 *
 * ── Where it runs, and why there ───────────────────────────────────────────
 * After `resolveTenant` (business routes) or at the three pre-tenant mounts
 * (`/orgs`, `/onboarding`, `/operator`), and BEFORE permission checks,
 * validation, idempotency lookups, the tenant transaction and any posting:
 *
 *   - the identity is known (session user; the tenant's organization), so the
 *     buckets are exact — no guessing an organization from a session field;
 *   - 🔴 the tenant connection is LAZY (`packages/db` `LazyTenantClient`):
 *     until the handler's first query no connection is checked out and no
 *     BEGIN has run, so a 429 here executes NOTHING — no partial posting, no
 *     consumed sequence number, no idempotency key recorded. The client may
 *     retry with the same idempotency key and the request will run exactly
 *     once. (The counter itself is written on the owner pool, outside any
 *     tenant transaction, so it is never rolled back with a request.)
 *   - a request that PASSES is never interrupted: the limiter decides once,
 *     before the handler, and nothing it does can stop a transaction midway.
 *
 * Fail-CLOSED: if the counter cannot be written the request is refused with
 * 503 `rate_limit_unavailable` (see the store) and, again, nothing ran.
 *
 * ── No role is exempt ──────────────────────────────────────────────────────
 * Organization admins and platform operators are counted like everyone else.
 * A privileged session is the MORE valuable one to steal, not the less.
 */
import type { NextFunction, Request, Response } from "express";
import { PostgresRateLimitStore } from "./rateLimitStore";
import { logRateLimitCrossing, retryAfterSecondsFrom, sendRateLimited } from "./rateLimit";

interface Limit {
  limit: number;
  windowMs: number;
}

interface ClassPolicy {
  user: Limit;
  /** Absent → the class has no organization bucket. */
  org?: Limit;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * Every number, in one place. The measurement: three CI browser runs of the
 * full suite (`e2e`, 2026-10-05, ~7,500 API requests each) — a robot driving
 * the real UI faster than any person — peaked, for ALL users combined, at:
 * 99 requests / 10 s and 389 / 60 s overall; 83 writes / 60 s; 131 report
 * reads / 60 s; 6 exports / 10 min; 25 uploads / 10 min; 24 bulk imports /
 * 10 min. Each user limit is about THREE TIMES that combined peak (more where
 * the peak was tiny), so no person using the product can meet it; each
 * organization limit is three users' worth. AI and the ZATCA OTP have no
 * traffic to measure (the AI layer is dark), so theirs are set by cost.
 * The reasoning per line is in the design record.
 */
export const BUDGET_POLICY = {
  burst: { user: { limit: 300, windowMs: 10 * SECOND } },
  general: { user: { limit: 1_200, windowMs: MINUTE }, org: { limit: 3_600, windowMs: MINUTE } },
  write: { user: { limit: 300, windowMs: MINUTE }, org: { limit: 900, windowMs: MINUTE } },
  report: { user: { limit: 400, windowMs: MINUTE }, org: { limit: 1_200, windowMs: MINUTE } },
  export: { user: { limit: 30, windowMs: 10 * MINUTE }, org: { limit: 90, windowMs: 10 * MINUTE } },
  upload: { user: { limit: 75, windowMs: 10 * MINUTE }, org: { limit: 225, windowMs: 10 * MINUTE } },
  bulk: { user: { limit: 120, windowMs: 10 * MINUTE }, org: { limit: 360, windowMs: 10 * MINUTE } },
  ai: { user: { limit: 20, windowMs: 10 * MINUTE }, org: { limit: 60, windowMs: 10 * MINUTE } },
  zatca_otp: { user: { limit: 10, windowMs: 60 * MINUTE }, org: { limit: 10, windowMs: 60 * MINUTE } },
  break_glass: { user: { limit: 10, windowMs: 60 * MINUTE } },
} as const satisfies Record<string, ClassPolicy>;

export type BudgetClass = keyof typeof BUDGET_POLICY;
type SpecialClass = Exclude<BudgetClass, "burst" | "general" | "write">;

/**
 * The endpoints that carry a class beyond the general budget, matched on the
 * NORMALIZED path (below). First match wins. `tests/rate-limit-budget.test.ts`
 * proves every rule refuses a real route, so a rule cannot silently point at
 * nothing.
 */
export const CLASS_RULES: readonly { cls: SpecialClass; methods: readonly string[]; path: RegExp }[] = [
  // Chromium renders (a shared browser, no concurrency cap of its own).
  { cls: "export", methods: ["GET"], path: /^\/api\/reports\/export(\/|$)/ },
  { cls: "export", methods: ["GET"], path: /^\/api\/invoices\/[^/]+\/document$/ },
  // Aggregations over the whole ledger, with no date-range cap.
  { cls: "report", methods: ["GET"], path: /^\/api\/(reports|analytics|finance-hub|cash-position)(\/|$)/ },
  // Multipart bodies buffered in process memory (up to 10 MB each).
  { cls: "upload", methods: ["POST"], path: /^\/api\/capture$/ },
  { cls: "upload", methods: ["PUT"], path: /^\/api\/companies\/current\/logo$/ },
  { cls: "upload", methods: ["POST"], path: /^\/api\/onboarding\/documents$/ },
  // Calls to a model provider (several per request: /ask makes three, /llm/compare up to fifty).
  { cls: "ai", methods: ["POST"], path: /^\/api\/llm\/(categorize|compare)$/ },
  { cls: "ai", methods: ["GET"], path: /^\/api\/llm\/(status|demo)$/ },
  { cls: "ai", methods: ["POST"], path: /^\/api\/ask$/ },
  { cls: "ai", methods: ["POST"], path: /^\/api\/findings\/run$/ },
  // Many rows per request.
  { cls: "bulk", methods: ["POST"], path: /^\/api\/transactions\/upload$/ },
  { cls: "bulk", methods: ["POST"], path: /^\/api\/categorize$/ },
  { cls: "bulk", methods: ["POST"], path: /^\/api\/recognition-schedules\/runs$/ },
  { cls: "bulk", methods: ["PUT"], path: /^\/api\/migration\/batches\/[^/]+\/(chart|parties|open-items|advances|assets)$/ },
  { cls: "bulk", methods: ["POST"], path: /^\/api\/migration\/batches\/[^/]+\/(validate|commit|reverse)$/ },
  // A CSR plus ~eight synchronous ZATCA calls per attempt, keyed by a one-time password.
  { cls: "zatca_otp", methods: ["POST"], path: /^\/api\/zatca\/onboarding(\/renew)?$/ },
  // Issues a temporary password for any non-operator account.
  { cls: "break_glass", methods: ["POST"], path: /^\/api\/operator\/users\/reset-password$/ },
];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The path the ROUTER will match, in the form the rules are written in.
 *
 * 🔴 Express routes case-INSENSITIVELY and ignores a trailing slash, so
 * `/API/Reports/vat-return/` reaches the same handler as `/api/reports/vat-return`.
 * A classifier that compared the raw path would hand that spelling the
 * general budget instead of the report budget — a bypass by capitalisation.
 * Normalising the same ways the router does closes it.
 */
export function normalizedApiPath(req: Pick<Request, "baseUrl" | "path">): string {
  const p = `${req.baseUrl}${req.path}`.toLowerCase().replace(/\/{2,}/g, "/");
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Every class a request is counted in. HEAD is a GET to the router, so it is one here. */
export function classesOf(method: string, path: string): BudgetClass[] {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const out: BudgetClass[] = ["burst", "general"];
  if (WRITE_METHODS.has(m)) out.push("write");
  const rule = CLASS_RULES.find((r) => r.methods.includes(m) && r.path.test(path));
  if (rule) out.push(rule.cls);
  return out;
}

/** The shared store's namespace for the budget (keys `budget:<class>:<u|o>:<id>`). */
export const budgetStore = new PostgresRateLimitStore("budget");

export function budgetKey(cls: BudgetClass, dimension: "user" | "org", id: string | number): string {
  return `${cls}:${dimension === "user" ? "u" : "o"}:${id}`;
}

const COUNTED = Symbol("requestBudgetCounted");

interface Bucket {
  cls: BudgetClass;
  dimension: "user" | "org";
  key: string;
  limit: Limit;
}

function bucketsFor(classes: BudgetClass[], userId: number, orgId: string | null): Bucket[] {
  const out: Bucket[] = [];
  for (const cls of classes) {
    const policy: ClassPolicy = BUDGET_POLICY[cls];
    out.push({ cls, dimension: "user", key: budgetKey(cls, "user", userId), limit: policy.user });
    if (policy.org && orgId) out.push({ cls, dimension: "org", key: budgetKey(cls, "org", orgId), limit: policy.org });
  }
  return out;
}

function setPolicyHeaders(res: Response, b: Bucket, used: number, msLeft: number): void {
  if (res.headersSent) return;
  res.setHeader("RateLimit-Policy", `${b.limit.limit};w=${Math.ceil(b.limit.windowMs / SECOND)}`);
  res.setHeader("RateLimit-Limit", String(b.limit.limit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, b.limit.limit - used)));
  res.setHeader("RateLimit-Reset", String(retryAfterSecondsFrom(msLeft)));
}

/**
 * The middleware. Counts a request once even if it passes two mount points
 * (a pre-tenant mount that does not handle the path falls through to the
 * business chain).
 */
export async function requestBudget(req: Request, res: Response, next: NextFunction): Promise<void> {
  const r = req as Request & { [COUNTED]?: true };
  if (r[COUNTED]) return next();
  const userId = req.tenant?.userId ?? req.session.userId;
  if (!userId) return next(); // unreachable behind requireAuth; nothing to key on
  r[COUNTED] = true;

  const buckets = bucketsFor(classesOf(req.method, normalizedApiPath(req)), userId, req.tenant?.organizationId ?? null);
  // Throws RateLimitUnavailableError (503) when the store fails; Express 5 forwards it.
  const counts = await budgetStore.incrementMany(buckets.map((b) => ({ key: b.key, windowMs: b.limit.windowMs })));

  type Seen = { b: Bucket; used: number; msLeft: number };
  let refused: Seen | undefined;
  let tightest: (Seen & { share: number }) | undefined;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    const { totalHits: used, msLeft } = counts[i]!;
    if (used > b.limit.limit) {
      logRateLimitCrossing(req, {
        policy: `budget.${b.cls}`,
        dimension: b.dimension === "user" ? "user" : "organization",
        used,
        limit: b.limit.limit,
        retryAfterSeconds: retryAfterSecondsFrom(msLeft),
        subject: b.dimension === "user" ? { userId } : { userId, organizationId: req.tenant?.organizationId },
      });
      // Wait for the LONGEST refusing window: retrying when only one has reset is refused again.
      if (!refused || msLeft > refused.msLeft) refused = { b, used, msLeft };
    }
    const share = used / b.limit.limit;
    if (!tightest || share > tightest.share) tightest = { b, used, msLeft, share };
  }

  if (refused) {
    setPolicyHeaders(res, refused.b, refused.used, refused.msLeft);
    sendRateLimited(res, retryAfterSecondsFrom(refused.msLeft));
    return;
  }
  if (tightest) setPolicyHeaders(res, tightest.b, tightest.used, tightest.msLeft);
  next();
}
