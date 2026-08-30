/**
 * Server-allocated document numbers for the ledger-facing documents that are
 * not invoices.
 *
 * ── 🔴 WHY THIS EXISTS: THE SWEEP AFTER AUD-1 ──────────────────────────────
 * AUD-1 caught the browser minting invoice numbers from a clock and fixed
 * invoices and credit notes. It did not sweep the shape. The sweep found FIVE
 * instances of the same mint — journal entries, bills (twice), assets and
 * employees — of which the fix had covered two.
 *
 * 🔴 The unfixed ones were WORSE. `Date.now().toString().slice(-6)` keeps the
 * last six digits of a millisecond clock, so it wraps every ~16.7 minutes; and
 * unlike `invoices`, none of those columns carries a unique index. A collision
 * on an invoice number was REFUSED by the database. A collision on an entry or
 * bill number is accepted — two financial records claiming to be the same
 * document, silently, in the ledger.
 *
 * ── The allocation ─────────────────────────────────────────────────────────
 * One atomic UPSERT, exactly as C12's invoice allocator does, and for the same
 * reason it does: a read-then-write allocator collapses concurrent allocations
 * onto one number, which C12 proved by re-injection (8 → 1). There is no
 * advisory lock here because there is no chain to protect — sequential and
 * unique is the whole requirement.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** The document types this counter serves. Mirrors the DB CHECK on 0063. */
export type CountedDocument = "journal_entry" | "bill";

const PREFIX: Record<CountedDocument, string> = {
  journal_entry: "JE",
  bill: "BILL",
};

export const documentNumbersRepository = {
  /**
   * The next number for this company and document type, e.g. `JE-000042`.
   *
   * 🔴 Monotonic and never reset. The year is NOT part of the number here:
   * C12's reasoning about a resetting series applies to ZATCA invoice numbering,
   * and copying a year prefix into an internal reference would invent a rule
   * nobody stated — the same "a mirror is a hypothesis" trap M21.3 recorded.
   */
  async allocate(type: CountedDocument): Promise<string> {
    const res = await db.execute<{ last_value: number }>(sql`
      INSERT INTO document_number_counters (organization_id, company_id, document_type, last_value)
      VALUES (DEFAULT, DEFAULT, ${type}, 1)
      ON CONFLICT (company_id, document_type)
      DO UPDATE SET last_value = document_number_counters.last_value + 1
      RETURNING last_value
    `);
    const next = Number(res.rows[0]?.last_value ?? 1);
    return `${PREFIX[type]}-${String(next).padStart(6, "0")}`;
  },
};
