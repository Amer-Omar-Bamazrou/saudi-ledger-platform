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
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/placeholder",
      PORT: process.env["PORT"] ?? "3000",
      SESSION_SECRET: process.env["SESSION_SECRET"] ?? "test-session-secret-not-used-for-real-auth",
      CORS_ALLOWED_ORIGINS: process.env["CORS_ALLOWED_ORIGINS"] ?? "http://localhost:5173",
    },
  },
});
