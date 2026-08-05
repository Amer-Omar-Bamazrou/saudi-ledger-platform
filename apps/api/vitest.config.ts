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
    env: {
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/placeholder",
    },
  },
});
