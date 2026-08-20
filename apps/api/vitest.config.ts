import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    reporters: ["verbose"],
    // `ubl-zatca-validator.test.ts` shells out to ZATCA's Java SDK — several
    // JVM launches plus schematron transforms, each taking tens of CPU-heavy
    // seconds. That contention starved the DB-backed suites, whose `beforeAll`
    // hooks then timed out at the 10s default even though nothing was wrong
    // with them. A generous hook timeout absorbs the contention.
    //
    // NOTE: do NOT "fix" this with `fileParallelism: false`. Serialising the
    // files makes the suite several times slower AND couples the suites to each
    // other's leftover state — `operator.test.ts` fails under that ordering
    // while passing in isolation.
    hookTimeout: 60_000,
    // Same contention, applied to the TESTS: a band of async DB tests measures
    // 1–3.6s under full parallel load (16 forks + the JVM launches above), so
    // the 5s default intermittently kills the slowest of them — measured at
    // 3.3s PASSING, i.e. a 1.5x load spike from green to dead. The sync
    // Java-shelling tests never showed this because a blocked event loop
    // cannot be interrupted — 16s sync tests "passed" while 4s async ones
    // died, which is why the flakes clustered on the invoice-approval suites.
    // A timeout is a harness bound, not an assertion: raising it weakens no
    // correctness property (unlike raising a rate limit, which deletes the
    // thing under test — see the note below).
    testTimeout: 30_000,
    // Provide a placeholder DATABASE_URL so importing @workspace/db (which
    // constructs a lazy pg Pool at module load) doesn't throw. The RBAC tests
    // never open a connection — they prime the permission cache directly — so a
    // real database is not required to run the API unit tests.
    //
    // The rest mirror what `loadEnv()` requires at boot. Tests drive services
    // directly and so skip the boot call; before M12.8 nothing on a service path
    // read config, so an incomplete environment went unnoticed. Issuance now
    // consults `ZATCA_ENVIRONMENT` to decide whether to queue a document, and
    // `loadEnv` validates the WHOLE schema — so a missing PORT surfaced as 21
    // failing invoice tests. It cannot happen in production: `loadEnv` is
    // memoized and runs at boot, so the process would never have started.
    env: {
      // Vitest sets this itself, but the rate-limit store keys its test
      // isolation off it (C1) — an assumption about a default is exactly the
      // kind this repo has been bitten by, so it is stated.
      NODE_ENV: "test",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/placeholder",
      PORT: process.env["PORT"] ?? "3000",
      SESSION_SECRET: process.env["SESSION_SECRET"] ?? "test-session-secret-not-used-for-real-auth",
      CORS_ALLOWED_ORIGINS: process.env["CORS_ALLOWED_ORIGINS"] ?? "http://localhost:5173",
      // The M12.5 vault refuses to boot without a dev master key, and refuses
      // `local-dev` entirely in production — so a test value here is safe and is
      // never reachable from a real deployment. Set centrally rather than in each
      // suite: `zatca-credential-vault.test.ts` set it at its own file scope,
      // which worked only because it was the sole vault-touching suite. M12.8
      // added two more and they failed in CI while passing locally, where a
      // developer's `.env` happened to supply it.
      ZATCA_KMS_PROVIDER: process.env["ZATCA_KMS_PROVIDER"] ?? "local-dev",
      ZATCA_DEV_MASTER_KEY:
        process.env["ZATCA_DEV_MASTER_KEY"] ?? "vitest-master-key-not-a-real-secret-0123456789",
    },
  },
});
