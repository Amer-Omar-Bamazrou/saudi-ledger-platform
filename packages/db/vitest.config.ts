import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: ["verbose"],
    // RLS setup/teardown touches a shared database; keep it serial.
    fileParallelism: false,
  },
});
