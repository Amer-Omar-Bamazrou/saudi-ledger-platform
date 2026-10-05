/**
 * Rate limiting — the ONE 429 contract, the client identities, and the
 * limiters for routes that run BEFORE a session or a tenant exists.
 *
 * Design record: `docs/product/design-rate-limiting.md` (the threat model, the
 * endpoint classification, every number and the measurement behind it). The
 * authenticated surface is limited by `lib/requestBudget.ts`; both count in the
 * same shared Postgres store (`lib/rateLimitStore.ts`, C1).
 *
 * ── The contract ───────────────────────────────────────────────────────────
 * Every limiter refuses the same way:
 *
 *     429 { error, code: "rate_limited", retryAfterSeconds }
 *     Retry-After: <seconds>          (an integer ≥ 1, equal to the body field)
 *     RateLimit-Limit / -Remaining / -Reset   (IETF draft-6, as C1 already sent)
 *
 * The UI keys on `code`, never on the words (CLAUDE.md §3: key the UI on the
 * structured CODE), so the copy can change without breaking the Arabic text the
 * client renders in its place.
 *
 * 🔴 ENUMERATION: the body never says WHICH limit refused, and the per-account
 * login limit counts an email whether or not an account exists, so a 429 is
 * not an oracle for "this account exists".
 */
import type { Request, Response, RequestHandler } from "express";
import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import rateLimit from "express-rate-limit";
import { PostgresRateLimitStore } from "./rateLimitStore";
import { logger } from "./logger";

export const RATE_LIMITED = "rate_limited" as const;

/** The refusal body. One sentence, the same for every limiter. */
export function rateLimitedBody(retryAfterSeconds: number): { error: string; code: typeof RATE_LIMITED; retryAfterSeconds: number } {
  return {
    error: `Too many requests. Please wait ${retryAfterSeconds} seconds and try again.`,
    code: RATE_LIMITED,
    retryAfterSeconds,
  };
}

/** Seconds a client must wait — never 0 (a `Retry-After: 0` invites an immediate retry). */
export function retryAfterSecondsFrom(msLeft: number): number {
  return Math.max(1, Math.ceil(msLeft / 1000));
}

/**
 * The client-IP key.
 *
 * `req.ip` is the socket address unless `TRUST_PROXY_HOPS` says a proxy
 * rewrites `X-Forwarded-For` (C1, `app.ts`) — so with the default of 0 a
 * client cannot choose its key by sending that header.
 *
 * 🔴 IPv6 is keyed by its /56 PREFIX, not the address. One subscriber is
 * normally given a /64 or a /56 — 2^64 addresses or more — so keying the full
 * address hands every IPv6 client an unlimited supply of fresh buckets: the
 * login limit becomes a formality. /56 is the allocation most ISPs give a
 * household and what express-rate-limit v8 adopted as its default. An
 * IPv4-mapped address (`::ffff:a.b.c.d`, in any spelling) is the IPv4 client
 * it names.
 */
export function clientIpKey(ip: string | undefined): string {
  if (!ip) return "ip:unknown";
  if (isIPv4(ip)) return `ip:${ip}`;
  if (!isIPv6(ip)) return "ip:unknown";
  const n = ipv6Groups(ip);
  if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) {
    return `ip:${n[6]! >> 8}.${n[6]! & 0xff}.${n[7]! >> 8}.${n[7]! & 0xff}`;
  }
  return `ip6:${n[0]!.toString(16)}:${n[1]!.toString(16)}:${n[2]!.toString(16)}:${(n[3]! & 0xff00).toString(16)}::/56`;
}

/**
 * True when a request carries `X-Forwarded-For` but this process trusts no
 * proxy (`TRUST_PROXY_HOPS=0`). Behind a real proxy that is the C1
 * misconfiguration: `req.ip` is the PROXY's address, so every client shares
 * ONE bucket of each IP limit (10 logins per 15 minutes for everyone).
 */
export function forwardedForIgnored(req: Pick<Request, "headers" | "app">): boolean {
  return req.headers["x-forwarded-for"] !== undefined && !req.app.get("trust proxy");
}

/**
 * 🔴 express-rate-limit's OWN key generator makes this check
 * (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`); a CUSTOM key generator — which the
 * /56 IPv6 key needs — silently drops it, and with it the only runtime signal
 * of a collapsed limiter (final review, 2026-10-05; the deployment runbook did
 * not set the variable). Restored here, logged once per process. A direct
 * deployment can be made to log it once by any client sending the header,
 * exactly as the library could — the line says "if a proxy is in front".
 */
let forwardedForWarned = false;
function warnIfForwardedForIgnored(req: Request): void {
  if (forwardedForWarned || !forwardedForIgnored(req)) return;
  forwardedForWarned = true;
  logger.error(
    { event: "rate_limit.xff_untrusted" },
    "X-Forwarded-For arrived but TRUST_PROXY_HOPS is 0. If a proxy is in front of this process, every client " +
      "behind it shares ONE rate-limit bucket (login, signup, invitations, uploads): set TRUST_PROXY_HOPS to the " +
      "number of proxies that rewrite the header (CLAUDE.md §5, C1).",
  );
}

/** An IPv6 address as its eight 16-bit groups (the first 56 bits are the key above). */
function ipv6Groups(ip: string): number[] {
  let addr = ip.split("%")[0]!.toLowerCase(); // a zone id is not part of the address
  // A trailing dotted quad (e.g. 64:ff9b::1.2.3.4) is the last two hextets.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    addr = addr.slice(0, quad.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = addr.includes("::") ? addr.split("::") as [string, string] : [addr, undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((g) => parseInt(g || "0", 16));
}

/**
 * The account key for a login email: trimmed and case-folded, so `A@x` and
 * `a@x ` share one budget — then HASHED (SHA-256).
 *
 * 🔴 Hashed for two reasons. The email is typed by an anonymous caller, and a
 * value Postgres cannot store (a NUL byte) once made the counter write FAIL —
 * which the store reads as an outage: a 503 and a critical page, from one
 * request (security review, 2026-10-05). A hex digest can always be stored.
 * And the counter table then holds no email addresses at all.
 */
export function accountKeyOf(email: string): string {
  return `acct:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

/**
 * What a log line may carry for an account: a short one-way digest, enough to
 * see that one account is under attack across many IPs without writing the
 * email address into the logs.
 */
function accountDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Logged ONCE per key per window when a limit is first exceeded, and once more
 * if the same window reaches ten times its limit (sustained abuse). The count
 * is atomic, so exactly one request observes each of those two values — a
 * flood produces two log lines, not one per refused request. Every refusal is
 * also in the access log as a 429.
 */
export function logRateLimitCrossing(
  req: Request,
  info: { policy: string; dimension: string; used: number; limit: number; retryAfterSeconds: number; subject: Record<string, unknown> },
): void {
  const first = info.used === info.limit + 1;
  const sustained = info.used === info.limit * 10 + 1;
  if (!first && !sustained) return;
  const area = (req.baseUrl + req.path).split("/").slice(0, 3).join("/"); // "/api/<mount>" — never a token or an id
  const line = {
    event: sustained ? "rate_limit.sustained" : "rate_limit.exceeded",
    policy: info.policy,
    dimension: info.dimension,
    limit: info.limit,
    used: info.used,
    retryAfterSeconds: info.retryAfterSeconds,
    method: req.method,
    area,
    ...info.subject,
  };
  if (sustained) req.log.error(line, "rate limit exceeded tenfold in one window");
  else req.log.warn(line, "rate limit exceeded");
}

/** Send the 429. `Retry-After` and the body field are the same number. */
export function sendRateLimited(res: Response, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json(rateLimitedBody(retryAfterSeconds));
}

type Dimension = "ip" | "account";

interface PreSessionLimiterSpec {
  /** Store namespace — also the policy name in logs. Existing names are kept so live counters carry over. */
  name: string;
  windowMs: number;
  limit: number;
  dimension: Dimension;
  /** Required for `account`: the account a request is about, or null to skip counting it. */
  accountOf?: (req: Request) => string | null;
  /** Count only FAILED attempts (a success refunds its hit). */
  countFailuresOnly?: boolean;
}

/**
 * A limiter for a route that runs before the request budget can see a user:
 * the credential endpoints, signup, invitations, onboarding upload. Always on
 * the SHARED store — the two limiters built without one (invitations,
 * onboarding upload) were C1's sweep missed: they enforced their stated number
 * per PROCESS, so N instances allowed N times as many.
 */
export function preSessionLimiter(spec: PreSessionLimiterSpec): RequestHandler & { store: PostgresRateLimitStore } {
  const store = new PostgresRateLimitStore(spec.name);
  const keyOf = (req: Request): string => {
    if (spec.dimension === "account") return accountKeyOf(spec.accountOf!(req)!);
    warnIfForwardedForIgnored(req);
    return clientIpKey(req.ip);
  };
  const handler = rateLimit({
    store,
    windowMs: spec.windowMs,
    limit: spec.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: spec.countFailuresOnly ?? false,
    skip: spec.dimension === "account" ? (req) => spec.accountOf!(req) === null : undefined,
    keyGenerator: keyOf,
    handler: (req, res) => {
      const info = (req as Request & { rateLimit: { used: number; limit: number; resetTime?: Date } }).rateLimit;
      const retryAfterSeconds = retryAfterSecondsFrom((info.resetTime?.getTime() ?? Date.now() + spec.windowMs) - Date.now());
      const key = keyOf(req);
      logRateLimitCrossing(req, {
        policy: spec.name,
        dimension: spec.dimension,
        used: info.used,
        limit: info.limit,
        retryAfterSeconds,
        subject: spec.dimension === "account" ? { account: accountDigest(key), ip: clientIpKey(req.ip) } : { ip: key },
      });
      sendRateLimited(res, retryAfterSeconds);
    },
  });
  return Object.assign(handler, { store });
}

/** The login email on the request body, or null when there is nothing a real attempt could be about. */
export function loginEmailOf(req: Request): string | null {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.trim() !== "" && email.length <= 320 ? email : null;
}
