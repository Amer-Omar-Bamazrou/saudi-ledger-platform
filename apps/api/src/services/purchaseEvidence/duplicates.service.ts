/**
 * Phase 13A — POSSIBLE DUPLICATES of a purchase document. 🔴 WARN, NEVER
 * REFUSE (owner decision): two identical receipts on the same day can be two
 * real purchases, so the check shows the earlier documents and the user
 * decides. Deterministic, strongest evidence first:
 *
 *   same_file                 the identical file (SHA-256) captured before
 *   same_supplier_invoice     the same supplier (or a supplier record with the
 *                             same VAT number) and the same SUPPLIER'S invoice
 *                             number — the strongest signal a user can type
 *   same_supplier_date_amount the same supplier, date and total
 *
 * Scoped to the organisation by RLS and to the company by an explicit
 * predicate (N1): another company's books are not "a duplicate".
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { capturedDocumentsRepository } from "../../repositories/capturedDocuments.repository";

export type DuplicateReason = "same_file" | "same_supplier_invoice" | "same_supplier_date_amount";

export interface PossibleDuplicate {
  reason: DuplicateReason;
  billId: number | null;
  billNumber: string | null;
  status: string | null;
  date: string | null;
  total: number | null;
  vendorReference: string | null;
  captureId: string | null;
  capturedAt: string | null;
}

const COMPANY = sql`b.company_id::text = current_setting('app.current_company_id', true)`;

type BillHit = { id: number; bill_number: string; status: string; date: string; total: string; vendor_reference: string | null };
const toDup = (reason: DuplicateReason, r: BillHit): PossibleDuplicate => ({
  reason, billId: Number(r.id), billNumber: r.bill_number, status: r.status, date: r.date, total: Number(r.total),
  vendorReference: r.vendor_reference, captureId: null, capturedAt: null,
});

export const duplicatesService = {
  /** Earlier captures of the SAME FILE, and the bills they became. */
  async forCapture(captureId: string, sha256: string): Promise<PossibleDuplicate[]> {
    const hits = await capturedDocumentsRepository.sameFile(sha256, captureId);
    const out: PossibleDuplicate[] = [];
    for (const h of hits) {
      let bill: BillHit | undefined;
      if (h.billId != null) {
        const { rows } = await db.execute<BillHit>(sql`
          SELECT b.id, b.bill_number, b.status, b.date, b.total::text AS total, b.vendor_reference
            FROM bills b WHERE b.id = ${h.billId} AND ${COMPANY}`);
        bill = rows[0];
      }
      out.push({
        reason: "same_file", billId: bill ? Number(bill.id) : null, billNumber: bill?.bill_number ?? null, status: bill?.status ?? h.status,
        date: bill?.date ?? null, total: bill ? Number(bill.total) : null, vendorReference: bill?.vendor_reference ?? null,
        captureId: h.id, capturedAt: h.capturedAt instanceof Date ? h.capturedAt.toISOString() : String(h.capturedAt),
      });
    }
    return out;
  },

  /** Bills that look like the document being entered — excluding itself. */
  async forBill(q: {
    billId?: number | null; vendorId?: number | null; vendorReference?: string | null;
    date?: string | null; total?: number | null; captureId?: string | null;
  }): Promise<PossibleDuplicate[]> {
    const out: PossibleDuplicate[] = [];
    const seen = new Set<string>();
    const add = (d: PossibleDuplicate) => {
      const k = `${d.reason}:${d.billId ?? d.captureId}`;
      if (!seen.has(k)) { seen.add(k); out.push(d); }
    };
    const self = q.billId ?? -1;

    if (q.captureId) {
      const cap = await capturedDocumentsRepository.findById(q.captureId);
      if (cap) for (const d of await this.forCapture(cap.id, cap.sha256)) if (d.billId !== self) add(d);
    }

    if (q.vendorId != null) {
      // The same supplier: this vendor record, or another record carrying the same VAT number.
      const sameSupplier = sql`(b.vendor_id = ${q.vendorId} OR b.vendor_id IN (
        SELECT v2.id FROM vendors v2, vendors v1
         WHERE v1.id = ${q.vendorId} AND v1.tax_number IS NOT NULL AND btrim(v1.tax_number) <> ''
           AND v2.tax_number = v1.tax_number))`;

      const ref = (q.vendorReference ?? "").trim();
      if (ref) {
        const { rows } = await db.execute<BillHit>(sql`
          SELECT b.id, b.bill_number, b.status, b.date, b.total::text AS total, b.vendor_reference
            FROM bills b
           WHERE ${COMPANY} AND b.id <> ${self} AND ${sameSupplier}
             AND lower(btrim(b.vendor_reference)) = lower(${ref})
           ORDER BY b.date DESC, b.id DESC LIMIT 20`);
        for (const r of rows) add(toDup("same_supplier_invoice", r));
      }
      if (q.date && q.total != null && Number(q.total) > 0) {
        const { rows } = await db.execute<BillHit>(sql`
          SELECT b.id, b.bill_number, b.status, b.date, b.total::text AS total, b.vendor_reference
            FROM bills b
           WHERE ${COMPANY} AND b.id <> ${self} AND ${sameSupplier}
             AND b.date = ${q.date} AND b.total = ${Number(q.total).toFixed(2)}::numeric
           ORDER BY b.id DESC LIMIT 20`);
        for (const r of rows) add(toDup("same_supplier_date_amount", r));
      }
    }
    return out;
  },
};
