import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { judgeCapture } from "./fieldClassCapture";

/**
 * 🔴 19B — DEFAULT DENY IS ON, AND THIS SUITE FAILS ON ANYTHING IT WITHHELD (owner, 2026-11-26: "make it ON by default
 * in code, so CI's API and browser suites run with it … If something is withheld that shouldn't be, find whether it's
 * the classification, a grant or the enforcement, fix that").
 *
 * The server this suite runs against applies default deny as production does. It writes each response in which a field
 * had no class to the capture file Playwright names for it (playwright.config.ts → FIELD_CLASS_CAPTURE_FILE;
 * `lib/fieldClasses/seam.ts`). This teardown reads the file; `judgeCapture` (./fieldClassCapture.ts) decides.
 */
export const CAPTURE_FILE = fileURLToPath(new URL("../.field-class-capture.jsonl", import.meta.url));

export default function globalTeardown(): void {
  const verdict = judgeCapture(existsSync(CAPTURE_FILE) ? readFileSync(CAPTURE_FILE, "utf8") : null, !!process.env.CI);
  if (!verdict.ok) throw new Error(verdict.error);
  console.log(verdict.note);
}
