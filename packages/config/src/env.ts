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
})
  .superRefine((env, ctx) => {
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
