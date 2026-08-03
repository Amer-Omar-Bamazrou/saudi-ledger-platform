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
});

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
