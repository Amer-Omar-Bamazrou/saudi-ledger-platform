import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Web unit tests (A1).
 *
 * 🔴 DELIBERATELY `environment: "node"`, and deliberately scoped to PURE
 * FUNCTIONS.
 *
 * `receiptParser.ts` — the parser at the centre of the automation wedge — had
 * ~60 assertions in a hand-rolled script (`npx tsx receiptParser.test.ts`, its
 * own `expect()`, `process.exit(1)`) that **no runner ever executed**. A1's
 * OCR bake-off measures that parser, and measuring something which can regress
 * silently proves nothing.
 *
 * It has zero imports and touches no DOM, so it needs no jsdom and no
 * `@testing-library`. Keeping it that way is what made adding a runner small.
 *
 * ⚠️ Testing React components (`ScanReview.tsx`, `ReceiptScanner.tsx`) WOULD
 * need jsdom + `@testing-library/react` + a setup file, and that is a bigger
 * change taken on its own merits. **A1 explicitly excludes it.** If a test here
 * starts pulling toward jsdom, stop and raise it rather than widening `include`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
    reporters: ["verbose"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
