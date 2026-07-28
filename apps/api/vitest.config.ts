import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    reporters: ["verbose"],
    // Provide a placeholder DATABASE_URL so importing @workspace/db (which
    // constructs a lazy pg Pool at module load) doesn't throw. The RBAC tests
    // never open a connection — they prime the permission cache directly — so a
    // real database is not required to run the API unit tests.
    env: {
      DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/placeholder",
    },
  },
});
