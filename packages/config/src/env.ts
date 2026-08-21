import { z } from "zod";

/**
 * The single source of truth for environment configuration across the platform.
 *
 * Every value the app depends on is declared here and validated once, at boot,
 * via {@link loadEnv}. If anything required is missing or malformed the process
 * throws with an aggregated, human-readable error instead of failing later in a
 * confusing way (or — worse — silently falling back to an insecure default).
 */

/** `"a, b ,c"` → `["a", "b", "c"]` (trimmed, empties dropped). */
const commaSeparated = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim()).filter(Boolean));

/**
 * An explicit on/off env var.
 *
 * 🔴 Do NOT reach for `z.coerce.boolean()` here. It applies JavaScript's
 * `Boolean()`, under which every non-empty string is true — so
 * `FLAG=false`, `FLAG=0` and `FLAG=off` all mean ON. For a flag that gates
 * transmissions to a government API, silently inverting the operator's
 * explicit "false" is not an acceptable failure mode. Anything unrecognised is
 * rejected at boot rather than guessed.
 */
const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
  .transform((value) => value === "true" || value === "1" || value === "yes" || value === "on");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  PORT: z.coerce
    .number({ message: "PORT is required and must be a number" })
    .int()
    .positive(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /**
   * C4 — malware scanning for user-supplied files. `none` (default) means no
   * scanner is deployed; the gate then stores the file and says so at debug
   * level rather than claiming a scan happened.
   */
  MALWARE_SCANNER: z.enum(["none", "clamd"]).default("none"),
  CLAMD_HOST: z.string().default("127.0.0.1"),
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),

  /**
   * AI provider seam (AI-1a). `none` = every AI feature degrades to its
   * deterministic path; `groq` = Groq's OpenAI-compatible API.
   *
   * 🔴 THE DATA BOUNDARY IS ENFORCED AT BOOT, not by convention. The owner's
   * standing rule (design-ai-layer §12a/§12b, CLAUDE.md): no tenant data may
   * reach Groq before the signed Enterprise agreement (Dammam pinning +
   * contractual ZDR) exists — the free tier routes globally. A production
   * deployment IS tenant data by definition, so `AI_PROVIDER=groq` in
   * production is REFUSED by the superRefine below unless
   * `GROQ_DATA_BOUNDARY_ACK` carries the exact acknowledgement string — the
   * same fail-closed posture as MAIL_PROVIDER=none and ZATCA's local-dev key.
   * Development/test carry fixture and dev-org data only, which the owner's
   * boundary explicitly allows.
   */
  AI_PROVIDER: z.enum(["none", "groq"]).default("none"),
  GROQ_API_KEY: z.string().min(1).optional(),
  /** Text model for the categorizer second opinion and future text features. */
  GROQ_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
  /** Vision model for the receipt-extraction benchmark harness. */
  GROQ_VISION_MODEL: z.string().min(1).default("meta-llama/llama-4-scout-17b-16e-instruct"),
  /**
   * Must equal "enterprise-dammam-zdr-signed" for AI_PROVIDER=groq to boot in
   * production. Deliberately a magic string rather than a boolean: setting it
   * is an attestation a human types after the agreement is signed, not a flag
   * a deploy template flips to true.
   */
  GROQ_DATA_BOUNDARY_ACK: z.string().optional(),

  /**
   * 🔴 What an UNAVAILABLE scanner means — an explicit, reviewable choice
   * rather than one implied by absence. `refuse` = fail-closed (correct once
   * untrusted tenants exist); `allow` = store it and log loudly (correct while
   * no scanner is deployed at all, which is today).
   */
  SCAN_UNAVAILABLE_POLICY: z.enum(["allow", "refuse"]).default("allow"),

  /**
   * C1 — how many reverse proxies rewrite `X-Forwarded-For` in front of this
   * process. It is a DEPLOYMENT FACT, not something to infer from NODE_ENV.
   *
   * 🔴 Both wrong directions are live risks: too LOW and `req.ip` is the
   * proxy's address, so every IP-keyed rate limit collapses into one bucket
   * (and the session cookie's `secure` gate misfires); too HIGH and a
   * client-supplied XFF hop is believed, which makes the same limits a no-op
   * for anyone who sets a header. Default 0 = direct, no proxy.
   */
  TRUST_PROXY_HOPS: z.coerce
    .number({ message: "TRUST_PROXY_HOPS must be a number (0 = no proxy in front of the API)" })
    .int()
    .min(0)
    .max(10)
    .default(0),

  /**
   * C1 — whether the session cookie requires HTTPS. Defaults to ON in
   * production, but is settable, because the audit found the `NODE_ENV ===
   * "production"` gate shipped auth cookies WITHOUT `Secure` on any
   * deployment named something else ("staging"). Setting it false in
   * production is refused below.
   */
  SESSION_COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  // The session-cookie signing key. A short/guessable secret lets an attacker
  // forge signed session cookies, so we enforce a minimum length and — unlike
  // the old app.ts — provide NO fallback. There is deliberately no default.
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters for a secure signing key"),

  // Explicit CORS allow-list (replaces the old reflect-any `origin: true`).
  // Comma-separated list of exact origins, e.g. "http://localhost:5173,https://app.example.sa".
  CORS_ALLOWED_ORIGINS: commaSeparated.pipe(
    z
      .array(z.string().url("each CORS origin must be a full URL, e.g. https://app.example.sa"))
      .min(1, "at least one allowed origin is required"),
  ),

  // The Postgres role the app drops to per request (via SET LOCAL ROLE) so that
  // Row-Level Security actually applies. Must be a non-owner, non-BYPASSRLS role
  // the login role is a member of. Defaults to Supabase's built-in `authenticated`.
  DB_APP_ROLE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "DB_APP_ROLE must be a valid SQL identifier")
    .default("authenticated"),

  // ── Document storage (M11.4) — Supabase Storage, reached over its REST API ──
  // OPTIONAL so the app boots without storage configured (document features are
  // simply unavailable and return 503). When set, they are validated. The
  // service-role key is a powerful secret and MUST stay server-side only — it is
  // never sent to the browser; all document I/O is brokered through the API.
  SUPABASE_URL: z
    .string()
    .url("SUPABASE_URL must be a full URL, e.g. https://<ref>.supabase.co or http://127.0.0.1:54321")
    .optional(),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, "SUPABASE_SERVICE_ROLE_KEY must not be empty when set")
    .optional(),
  // Private bucket that holds verification documents (org-prefixed object paths).
  VERIFICATION_DOCS_BUCKET: z.string().min(1).default("verification-documents"),

  // ── Invitations (M11.7) ─────────────────────────────────────────────────────
  // How long an invite link stays valid. Short enough that a leaked link ages
  // out, long enough for a colleague to act on it.
  INVITATION_EXPIRY_DAYS: z.coerce.number().int().positive().max(90).default(7),
  // Absolute base URL used to build invite links (e.g. https://app.example.sa).
  // Defaults to the first allowed CORS origin, which is the app's own origin.
  APP_BASE_URL: z.string().url().optional(),

  // ── ZATCA credential vault (M12.5) ──────────────────────────────────────────
  // Envelope encryption: a per-company data key (DEK) encrypts the private key,
  // and the DEK is wrapped by a KMS master key. The provider is chosen HERE, at
  // deployment — not compiled in — because the KSA data-residency question is
  // still open and committing to a KMS partially pre-decides the hosting
  // provider. Same hedge as M12.8's storage backend.
  ZATCA_KMS_PROVIDER: z.enum(["aws-kms", "local-dev"]).default("local-dev"),
  /** The CMK id/ARN. ONE platform key wrapping per-company DEKs — never one per tenant. */
  ZATCA_KMS_KEY_ID: z.string().min(1).optional(),
  ZATCA_KMS_REGION: z.string().min(1).optional(),
  /**
   * Local-development master key — 32 bytes, base64 or hex.
   *
   * 🔴 Refused in production by the superRefine below. This is the failure that
   * would silently ship fake cryptography, so it is blocked at boot AND again at
   * use (the signing service rejects any row stored with kms_provider
   * 'local-dev' when running in production).
   */
  ZATCA_DEV_MASTER_KEY: z.string().min(1).optional(),

  /**
   * Which ZATCA environment tenants onboard against (M12.4).
   *
   * `sandbox` needs no account and accepts ANY OTP; `simulation` and
   * `production` require a real Saudi VAT registration with ERAD credentials —
   * the M12.7/M12.9 dependency that does not exist yet.
   */
  ZATCA_ENVIRONMENT: z.enum(["sandbox", "simulation", "production"]).default("sandbox"),

  // ── Background jobs (M12.8) ────────────────────────────────────────────────
  /**
   * Run the in-process job scheduler: the e-invoice outbox worker, the archive
   * sweep and the certificate-renewal check.
   *
   * 🔴 M12.6 documented this flag in two code comments and NEVER DECLARED IT, so
   * nothing could read it and the worker was never started. Declared here in
   * M12.8 as part of connecting the outbox. Default OFF: the worker transmits to
   * a government API, so starting it must be a deliberate act, and every job is
   * separately runnable on demand from the operator surface.
   *
   * 🔴 NOT `z.coerce.boolean()`. `Boolean("false")` is `true`, so coercion turns
   * an explicit `ZATCA_WORKER_ENABLED=false` into ON — the exact opposite of the
   * intent, for a flag that starts transmissions to a government API.
   */
  ZATCA_WORKER_ENABLED: booleanFlag.default("false"),

  // ── DEMO deployment (docs/product/demo-deployment-decisions.md) ────────────
  /**
   * 🔴 A DEMO IS A DEPLOYMENT THAT REMOVES CAPABILITIES — never one that
   * silences guards.
   *
   * This flag does not relax a single production check. `NODE_ENV=production`
   * still refuses `local-dev` KMS, `MAIL_PROVIDER=none` and
   * `ALERT_PROVIDER=none`, and the demo satisfies all three truthfully
   * (decision D1/D2). What `DEMO_MODE` does is switch things OFF:
   *
   *   - the banner appears on every page, in both languages (D7);
   *   - document capture is refused (D3) — PDPL is unanswered and a promoted
   *     capture is undeletable, so this is the one place a demo could do
   *     IRREVERSIBLE harm;
   *   - public signup is refused (D4) — one shared login, no invitations;
   *   - the weekly reset job schedules (D6/D9).
   *
   * 🔴 And it is REFUSED alongside ZATCA (see the refinement below): a demo
   * that could transmit to a government API is not a demo. That refusal ADDS a
   * constraint; it removes none.
   */
  DEMO_MODE: booleanFlag.default("false"),

  /**
   * The demo's single login. Required when `DEMO_MODE` is on (refinement
   * below) — a demo with no credentials is a login screen, and the weekly reset
   * would re-create the tenant with no way in.
   *
   * The membership role is ADMIN by owner decision: the reviewer is trusted,
   * the weekly reset makes any mess temporary, and half a hidden product is a
   * worse review than a fully clickable one. The capabilities that must not be
   * exercised are refused at the ROUTE for every role, not withheld by grade.
   */
  DEMO_ADMIN_EMAIL: z.string().email().optional(),
  DEMO_ADMIN_PASSWORD: z.string().min(12).optional(),

  /**
   * How often the demo wipes and re-seeds itself, in days.
   *
   * 🔴 The banner does NOT quote this number as a fact about the past — it
   * reports the last run that actually SUCCEEDED, from `demo_reset_runs`. This
   * value only decides when the next attempt is due, and how long an overdue
   * reset may go before it pages someone.
   */
  DEMO_RESET_INTERVAL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /**
   * Absolute path to a built frontend (`apps/web/dist`) for this process to
   * serve. Unset — the default, and the state of every existing deployment —
   * means the API serves only `/api` and nothing else changes.
   *
   * 🔴 This is a DEPLOYMENT SHAPE option, not a demo flag, and the reason to
   * reach for it is security rather than convenience: auth is an httpOnly
   * session cookie, so putting the frontend on its own origin requires
   * `SameSite=None` and a credentialed CORS entry — two cookie protections
   * loosened to solve a hosting-layout problem. Same origin needs neither.
   */
  SERVE_WEB_DIST: z.string().min(1).optional(),

  // ── Email delivery (queue item B1) ─────────────────────────────────────────
  /**
   * Which mail provider actually sends. `none` is the dev/CI default and is
   * REFUSED in production (see the refinement below) — an alarm that silently
   * reaches nobody is the failure mode B1 exists to close.
   *
   * AWS SES is deliberately absent: it needs SigV4 signing or the SDK, which is
   * a deployment-time addition exactly like `@aws-sdk/client-kms`.
   */
  MAIL_PROVIDER: z.enum(["none", "resend", "postmark"]).default("none"),
  /** Provider API key / server token. Never logged. */
  MAIL_API_KEY: z.string().min(1).optional(),
  /** The verified sender address, e.g. "Saudi Ledger <no-reply@example.com>". */
  MAIL_FROM: z.string().min(3).optional(),

  // ── Operator alerting (queue item B2) ──────────────────────────────────────
  /**
   * Where platform alarms page a human. A generic webhook reaches PagerDuty,
   * Opsgenie and Slack alike, so the vendor stays a deployment decision.
   * `none` is refused in production: the alarms it carries (a stuck outbox
   * against a 24-hour ZATCA deadline, an expiring PCSID) both fail by QUIET
   * NEGLECT, which is precisely what a dashboard cannot catch.
   */
  ALERT_PROVIDER: z.enum(["none", "webhook"]).default("none"),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** How long a firing condition stays quiet before it re-pages. */
  ALERT_REPEAT_HOURS: z.coerce.number().int().min(1).default(6),
  /** Poll interval for the outbox worker. */
  ZATCA_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  /**
   * How long a document may sit unsubmitted before it is overdue.
   *
   * Simplified invoices must be REPORTED within 24 hours, so the alarm has to
   * fire with time left to act on it, not at the deadline.
   */
  ZATCA_OVERDUE_MINUTES: z.coerce.number().int().min(1).default(60),

  // ── E-invoice archive (M12.8) ─────────────────────────────────────────────
  /**
   * Where cleared/reported XML is retained for ZATCA's 6–11 year window.
   *
   * 🔴 The provider is chosen HERE, at deployment — the same hedge as
   * `ZATCA_KMS_PROVIDER`. ZATCA §5.5 explicitly permits cloud storage and does
   * NOT mandate in-country servers (a claim we carried from a secondary source
   * and corrected in M12.8); what it mandates is that the data be reachable by
   * a direct link given to the Authority. Residency pressure, if any, comes from
   * NCA/CSP or sector rules we have not verified. An unverified claim is not a
   * basis for committing hosting, and neither is its absence — so the backend
   * stays swappable and the region stays a deployment decision.
   */
  ZATCA_ARCHIVE_PROVIDER: z.enum(["supabase-storage", "local-fs"]).default("local-fs"),
  ZATCA_ARCHIVE_BUCKET: z.string().min(1).default("einvoice-archive"),
  /** Filesystem root for the `local-fs` provider (development and CI). */
  ZATCA_ARCHIVE_DIR: z.string().min(1).default(".archive/einvoice"),
  /** Retention floor in years. 6 by VAT regulation; 11 for certain services. */
  ZATCA_ARCHIVE_RETENTION_YEARS: z.coerce.number().int().min(6).max(20).default(6),
  /** TTL for a direct link handed to an auditor. */
  ZATCA_ARCHIVE_LINK_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),

  // ── Document capture (A1) ─────────────────────────────────────────────────
  /**
   * How long an untouched captured document survives before the purge job
   * treats it as abandoned.
   *
   * Only ever applies to `staged` and `discarded` captures. A capture posted to
   * a bill is evidence for an input-VAT deduction and is never purged — it is
   * promoted into the immutable archive with its own retention.
   */
  CAPTURE_PURGE_AFTER_DAYS: z.coerce.number().int().min(1).max(365).default(30),
})
  .superRefine((env, ctx) => {
    // ── AI-1a: the Groq data boundary, fail-closed ─────────────────────────
    if (env.AI_PROVIDER === "groq" && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["GROQ_API_KEY"],
        message: "AI_PROVIDER='groq' requires GROQ_API_KEY.",
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.AI_PROVIDER === "groq" &&
      env.GROQ_DATA_BOUNDARY_ACK !== "enterprise-dammam-zdr-signed"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["AI_PROVIDER"],
        message:
          "AI_PROVIDER='groq' is refused in production: a production deployment carries tenant data, " +
          "and no tenant data may reach Groq before the signed Enterprise agreement (Dammam pinning + " +
          "contractual ZDR) exists — the free tier routes globally. When the agreement is signed, set " +
          "GROQ_DATA_BOUNDARY_ACK='enterprise-dammam-zdr-signed' to attest it.",
      });
    }

    if (env.NODE_ENV === "production" && env.ZATCA_KMS_PROVIDER === "local-dev") {
      ctx.addIssue({
        code: "custom",
        path: ["ZATCA_KMS_PROVIDER"],
        message:
          "ZATCA_KMS_PROVIDER='local-dev' is refused in production — it would encrypt every " +
          "tenant's ZATCA signing key with a key from an env var. Set 'aws-kms' with " +
          "ZATCA_KMS_KEY_ID.",
      });
    }
    // ── B1: a configured provider needs its credentials, and production needs
    // a provider at all. ───────────────────────────────────────────────────────
    if (env.MAIL_PROVIDER !== "none" && !(env.MAIL_API_KEY && env.MAIL_FROM)) {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_PROVIDER"],
        message:
          `MAIL_PROVIDER='${env.MAIL_PROVIDER}' requires MAIL_API_KEY and MAIL_FROM. ` +
          "Fail at boot rather than discovering it when a certificate-expiry reminder " +
          "is the thing that did not send.",
      });
    }
    // 🔴 Same posture as refusing the `local-dev` key wrapper in production.
    // The PCSID renewal reminder's whole value is lead time for an action only
    // the tenant can take; with no provider it exists as a row and reaches no
    // one, and at expiry they simply cannot legally invoice. Shipping that
    // silently is worse than refusing to start.
    if (env.NODE_ENV === "production" && env.MAIL_PROVIDER === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_PROVIDER"],
        message:
          "MAIL_PROVIDER must be set in production (queue item B1). Renewal reminders and " +
          "invitations would otherwise be recorded and delivered to nobody.",
      });
    }
    // 🔴 C1 — an auth cookie without `Secure` in production is a session
    // token that travels in clear text on any downgraded request. The audit
    // found the old NODE_ENV gate shipped exactly that on a "staging" deploy;
    // making it settable must not make it disable-able where it matters.
    if (env.NODE_ENV === "production" && env.SESSION_COOKIE_SECURE === false) {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_COOKIE_SECURE"],
        message:
          "SESSION_COOKIE_SECURE cannot be false in production — the session cookie would " +
          "be sent over plain HTTP. Terminate TLS in front of the API instead.",
      });
    }
    if (env.ALERT_PROVIDER === "webhook" && !env.ALERT_WEBHOOK_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["ALERT_WEBHOOK_URL"],
        message: "ALERT_WEBHOOK_URL is required when ALERT_PROVIDER is 'webhook'",
      });
    }
    if (env.NODE_ENV === "production" && env.ALERT_PROVIDER === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["ALERT_PROVIDER"],
        message:
          "ALERT_PROVIDER must be set in production (queue item B2). A stuck e-invoice outbox " +
          "and an expiring PCSID both fail by quiet neglect — an operator panel only helps " +
          "someone already looking at it.",
      });
    }
    /**
     * 🔴 A demo must not be able to transmit to ZATCA.
     *
     * The e-invoice outbox submits real documents to a real government API. In
     * a demo the documents are fictional and the company's VAT number is
     * deliberately invalid, so a submission is at best rejected and at worst a
     * fictional filing against someone's registration. Refused rather than
     * defaulted, because a default can be overridden by a stray env var and a
     * refusal cannot.
     *
     * This is a constraint ADDED by demo mode. Nothing here relaxes a
     * production guard — see the note on DEMO_MODE above.
     */
    if (env.DEMO_MODE && env.ZATCA_WORKER_ENABLED) {
      ctx.addIssue({
        code: "custom",
        path: ["ZATCA_WORKER_ENABLED"],
        message:
          "ZATCA_WORKER_ENABLED must be false when DEMO_MODE is on. A demo submits fictional " +
          "documents from a company with a deliberately invalid VAT number; it must never " +
          "reach a government API.",
      });
    }
    // A demo whose login does not exist is a login screen. Fail at BOOT, not at
    // the first attempt to sign in — and not at the first weekly reset, which
    // would destroy the tenant and then be unable to re-create it.
    if (env.DEMO_MODE && (!env.DEMO_ADMIN_EMAIL || !env.DEMO_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: "custom",
        path: ["DEMO_ADMIN_EMAIL"],
        message:
          "DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD (min 12 chars) are required when DEMO_MODE " +
          "is on — the weekly reset re-creates the tenant from them, so without them a reset " +
          "leaves a demo nobody can log into.",
      });
    }
    if (env.ZATCA_KMS_PROVIDER === "aws-kms" && !env.ZATCA_KMS_KEY_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["ZATCA_KMS_KEY_ID"],
        message: "ZATCA_KMS_KEY_ID is required when ZATCA_KMS_PROVIDER is 'aws-kms'",
      });
    }
    if (
      env.ZATCA_ARCHIVE_PROVIDER === "supabase-storage" &&
      !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ZATCA_ARCHIVE_PROVIDER"],
        message:
          "ZATCA_ARCHIVE_PROVIDER='supabase-storage' requires SUPABASE_URL and " +
          "SUPABASE_SERVICE_ROLE_KEY. Fail at boot rather than discovering it when the " +
          "first cleared invoice cannot be archived.",
      });
    }
    // 🔴 A relative archive directory in production is almost certainly a
    // container's ephemeral filesystem — the archive would appear to work and be
    // gone at the next deploy, which is the worst possible failure for a 6–11
    // year legal retention obligation. `local-fs` IS a legitimate production
    // choice (ZATCA §5.5 permits on-premises storage), so it is not refused;
    // it just has to be pointed somewhere deliberately.
    if (
      env.NODE_ENV === "production" &&
      env.ZATCA_ARCHIVE_PROVIDER === "local-fs" &&
      !isAbsolutePath(env.ZATCA_ARCHIVE_DIR)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ZATCA_ARCHIVE_DIR"],
        message:
          "ZATCA_ARCHIVE_DIR must be an ABSOLUTE path when archiving to 'local-fs' in " +
          "production — a relative path resolves inside the container and the archive is " +
          "lost on redeploy. Point it at durable, backed-up storage.",
      });
    }
  });

/** Absolute on POSIX (`/srv/...`) or Windows (`C:\...`, `\\host\share`). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Parse and validate the environment. Cached after the first successful call so
 * repeated imports (index.ts, app.ts, resolveTenant) share one validated object.
 *
 * @throws if any required variable is missing or invalid — the app must not start.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}\n`);
  }

  cached = result.data;
  return cached;
}

/** Test-only: clear the memoized config so a fresh `loadEnv` re-parses. */
export function resetEnvCache(): void {
  cached = null;
}
