/**
 * The GL balance guard — the accounting core's own throws, positive direction.
 *
 * 🔴 WHY THIS FILE EXISTS. The audit of the accounting core's throws (the last
 * of the 2026-08-20 audit's stated blind spots) found 14 throws across
 * `glPosting` / `periodLock` / the approval adapters. Thirteen were typed
 * `AppError`s or a deliberate diagnostic-500. One was not:
 *
 *   throw new Error(`GL entry does not balance: Dr ... vs Cr ...`)
 *
 * — a bare Error guarding "debits equal credits", the single most important
 * invariant in the system. Two consequences, both closed here:
 *
 *   1. The central error handler duck-types on `statusCode`, so a bare Error
 *      became the generic 500 wall: the caller saw "Internal server error" and
 *      the two totals lived only in the log. The C5 shape (fail-closed posture
 *      correct, diagnosis absent) on the most consequential guard in the core.
 *
 *   2. 🔴 NOTHING PROVED IT FIRES. The suite mentioned the message exactly
 *      twice, both times in a test asserting the guard does NOT fire (the
 *      line-level rounding fix). A guard whose only coverage asserts its
 *      SILENCE is the obsolete-assertion family: widen the tolerance, invert
 *      the comparison, delete the `throw` — the suite stays green either way.
 *      So these tests are deliberately PRESENCE assertions.
 *
 * The third test is the forcing function for the second finding: the same
 * invariant was enforced at TWO tolerances by two writers (`journalEntries`
 * at > 0.01, the GL at > 0.005), the user-facing gate looser than the ledger's.
 * Nothing crossed the two today — a manual entry posts through its own
 * approvable and never reaches `postJournalEntry` — so it was latent, not live.
 * Latent is how it stays only if one number cannot become two again.
 *
 * DB-free: this exercises the guard, which runs before any write.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GL_BALANCE_TOLERANCE,
  UnbalancedEntryError,
  postJournalEntry,
} from "../services/accounting/glPosting";

const entry = (debit: number, credit: number) => ({
  entryNumber: "BAL-TEST",
  date: "2026-08-27",
  description: "balance guard",
  lines: [
    { accountId: 1, accountName: "A", debitAmount: debit, creditAmount: 0 },
    { accountId: 2, accountName: "B", debitAmount: 0, creditAmount: credit },
  ],
});

describe("postJournalEntry — the balance guard FIRES", () => {
  it("🔴 refuses an entry whose debits and credits differ", async () => {
    await expect(postJournalEntry(entry(100.0, 99.0))).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it("🔴 the refusal NAMES both totals, the difference and the tolerance", async () => {
    // The whole point of typing it: a caller who hits this must be able to see
    // WHAT did not balance without reading the server log.
    await expect(postJournalEntry(entry(100.0, 99.0))).rejects.toThrow(
      /Dr 100\.00 vs Cr 99\.00.*difference 1\.0000.*tolerance 0\.005/s,
    );
  });

  it("🔴 says nothing was posted — the caller needs to know the ledger is untouched", async () => {
    await expect(postJournalEntry(entry(100.0, 99.0))).rejects.toThrow(/Nothing was posted/);
  });

  it("carries statusCode 500, so the handler does not fall through to the generic wall", async () => {
    const err = await postJournalEntry(entry(5, 4)).catch((e) => e);
    expect(err).toBeInstanceOf(UnbalancedEntryError);
    expect((err as { statusCode: number }).statusCode).toBe(500);
    // A bare Error has no statusCode — that is exactly what this replaced, and
    // asserting its ABSENCE would have been the assertion that aged badly.
    expect(err.name).toBe("UnbalancedEntryError");
  });

  it("fires on a difference just OVER the tolerance", async () => {
    // 0.006 > 0.005. The realistic imbalance is a fraction of a halala, not a
    // whole riyal, so the boundary is the case worth pinning.
    await expect(postJournalEntry(entry(10.006, 10.0))).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it("ANTI-VACUITY: does NOT fire at or under the tolerance", async () => {
    // Without this, "it throws" could mean "it always throws", which is not a
    // guard, it is an outage. This one gets past the balance check and fails
    // later (no DB / no chart) — what matters is that it is NOT an imbalance.
    const err = await postJournalEntry(entry(10.004, 10.0)).catch((e) => e);
    expect(err).not.toBeInstanceOf(UnbalancedEntryError);
  });
});

describe("one invariant, one number", () => {
  it("🔴 the manual-JE gate imports the GL tolerance instead of restating it", () => {
    // A forcing function, not a style check: the two guards drifted apart once
    // (0.01 vs 0.005, the user-facing one LOOSER than the ledger's). A literal
    // reappearing in that file is that drift starting again, and it is invisible
    // in review because both numbers look reasonable in isolation.
    const src = readFileSync(
      fileURLToPath(new URL("../services/journalEntries.service.ts", import.meta.url)),
      "utf8",
    );
    const balanceGuard = src.slice(src.indexOf("Math.abs(totalDebit - totalCredit)"));
    expect(balanceGuard.slice(0, 120)).toContain("GL_BALANCE_TOLERANCE");
    expect(src).toContain('from "./accounting/glPosting"');
  });

  it("the tolerance is half a halala — anything larger rounds to different money", () => {
    expect(GL_BALANCE_TOLERANCE).toBe(0.005);
  });
});
