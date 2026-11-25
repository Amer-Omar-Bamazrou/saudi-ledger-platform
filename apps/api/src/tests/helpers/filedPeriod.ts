/**
 * 🔴 L5 (owner, 2026-11-25) — a FIXTURE of the filed state for tests whose subject is not the filing: Art. 40(7)(a) now
 * needs an invoice's month inside a VAT return recorded filed before its bad-debt relief. The row is written directly —
 * the original filing for that one month, if no original filing covers it yet — WITHOUT the clearing entry the product's
 * own path posts (POST /tax/vat-return-filings), so the GL and the VAT-return figures those tests assert do not move.
 * The product's path, clearing included, is proven by l5-bad-debt-40-7.test.ts.
 */
import { pool } from "@workspace/db";

export async function fileInvoiceMonthForFixture(invoiceId: number): Promise<void> {
  const { rows } = await pool.query(`SELECT organization_id, company_id, date FROM invoices WHERE id = $1`, [invoiceId]);
  const inv = rows[0];
  if (!inv) throw new Error(`fileInvoiceMonthForFixture: invoice ${invoiceId} not found`);
  const month = String(inv.date).slice(0, 7);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const after = new Date(Date.UTC(y, m, 15)).toISOString().slice(0, 10); // a filing date after the month ends
  await pool.query(
    `INSERT INTO vat_return_filings (organization_id, company_id, period_from, period_to, kind, filed_on, zatca_reference)
     SELECT $1, $2, $3, $3, 'original', $4::date, $5
      WHERE NOT EXISTS (SELECT 1 FROM vat_return_filings f WHERE f.company_id = $2 AND f.kind = 'original' AND f.period_from <= $3 AND $3 <= f.period_to)`,
    [inv.organization_id, inv.company_id, month, after, `FIXTURE-${month}-${invoiceId}`],
  );
}
