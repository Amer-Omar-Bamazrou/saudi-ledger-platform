/**
 * MIGRATION FOLLOW-UPS (2026-09-22) — the two acts on a COMMITTED opening item
 * that the accountant's answers 3 and 5 and Batch 1C's A4 permit:
 *
 *   correctOpenItem   "migrated receivable 100,000; correct 90,000: the
 *                     −10,000's other side is Opening Retained Earnings; no
 *                     OBE plug" (answer 5), inside A4's shape — the original
 *                     row STAYS, marked reversed by its own batch and carrying
 *                     the correction entry; a REPLACEMENT row with a new
 *                     `OPEN-<batch>-<seq>` number, linked to the original,
 *                     carries the corrected amount. ONE entry:
 *                       AR item, decrease:  Dr RETAINED_EARNINGS / Cr AR (customer)
 *                       AR item, increase:  Dr AR (customer)      / Cr RETAINED_EARNINGS
 *                       AP item, decrease:  Dr AP (vendor)        / Cr RETAINED_EARNINGS
 *                       AP item, increase:  Dr RETAINED_EARNINGS  / Cr AP (vendor)
 *                     dated the correction date in an OPEN month (a prior-
 *                     period error corrected through retained earnings — IAS 8
 *                     as SOCPA adopts it; the accountant's words). Refused on
 *                     an item anything has touched (allocation, note, payment,
 *                     write-off): that case is still the accountant's open
 *                     question (Batch 1C pack §16.12.5) and stays refused by
 *                     name.
 *   recordIdentity    the previous solution's e-invoicing identity of an
 *                     opening receivable (cleared / reported + UUID, or
 *                     pre_einvoicing), recorded ONCE when the migration did
 *                     not carry it — the fact a credit note through Fatoora
 *                     needs (answer 3). Never guessed, never changed.
 *
 * Both are audited; nothing is deleted; every link is a real FK.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { billsTable, db, invoicesTable, journalEntriesTable, migrationOpenItemsTable, type Invoice, type Bill } from "@workspace/db";
import { businessToday, openingReplacementNumber } from "@workspace/shared";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { money2, round2 } from "../lib/money";
import { assertDateString } from "../lib/writeGuards";
import { migrationRepository } from "../repositories/migration.repository";
import { checkPeriodOpen } from "./accounting/periodLock";
import { postJournalEntry } from "./accounting/glPosting";
import { auditService } from "./audit.service";

const num = (v: unknown) => (v == null ? 0 : Number(v));
const fmt = (n: number) => money2(n);
const TOL = 0.005;

export type OpeningEinvoicingStatus = "cleared" | "reported" | "pre_einvoicing";
const STATUSES: readonly string[] = ["cleared", "reported", "pre_einvoicing"];

async function stagedItem(itemId: number) {
  const [row] = await db.select().from(migrationOpenItemsTable).where(eq(migrationOpenItemsTable.id, itemId));
  if (!row) throw new NotFoundError("Migrated open item not found");
  return row;
}

/** The next free `OPEN-<batch>-<seq>` in a committed batch — after every ordinal the commit and earlier corrections used. */
async function nextReplacementSeq(batchId: number): Promise<number> {
  // split_part, not `substring(x from $1)`: an untyped bound parameter there resolves to the REGEX form and silently matches nothing (max → null → the same number twice)
  const pattern = `^OPEN-${batchId}-[0-9]+$`;
  const inv = (await db.execute<{ m: string | null }>(sql`SELECT max(split_part(invoice_number, '-', 3)::int)::text AS m FROM invoices WHERE invoice_number ~ ${pattern}`)).rows[0];
  const bill = (await db.execute<{ m: string | null }>(sql`SELECT max(split_part(bill_number, '-', 3)::int)::text AS m FROM bills WHERE bill_number ~ ${pattern}`)).rows[0];
  const staged = (await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM migration_open_items WHERE batch_id = ${batchId}`)).rows[0]?.n ?? "0";
  return Math.max(Number(inv?.m ?? 0), Number(bill?.m ?? 0), Number(staged)) + 1;
}

export const migrationCorrectionService = {
  /**
   * Correct a committed opening item's amount — the accountant's answer 5 in
   * A4's shape. `itemId` is the STAGING row (the migrated document's identity
   * survives every correction; the ledger rows chain through it).
   */
  async correctOpenItem(
    itemId: number,
    body: { correctOutstanding: unknown; reason?: unknown; date?: string | null; idempotencyKey?: string | null },
    userId: number | null,
  ) {
    const correct = Number(body.correctOutstanding);
    if (!Number.isFinite(correct) || correct <= 0) throw new BadRequestError("correctOutstanding must be a positive amount — a settled item is corrected by its own payments, never to zero here.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new BadRequestError("A reason for the correction is required (it is the audit trail's explanation).");
    const date = body.date ? assertDateString(body.date, "date") : businessToday();

    const item = await stagedItem(itemId);
    const batch = await migrationRepository.findBatchForUpdate(item.batchId);
    if (!batch[0] || batch[0].status !== "committed") {
      throw new BusinessRuleError(409, { code: "migration_not_committed", error: `Migration batch ${item.batchId} is ${batch[0]?.status ?? "missing"}; only an item of a COMMITTED migration is corrected in the books (staging is corrected by editing it and validating again).`, field: "itemId" });
    }
    if (date < batch[0].openingDate) {
      throw new BusinessRuleError(422, { code: "opening_correction_before_opening", error: `A correction cannot be dated ${date}, before the opening date ${batch[0].openingDate}.`, field: "date" });
    }
    await checkPeriodOpen(date);

    // the LIVE ledger row of this staging row: the last replacement in its chain, not reversed
    const isAr = item.itemType === "ar";
    const live = isAr
      ? (await db.select().from(invoicesTable).where(and(eq(invoicesTable.migrationOpenItemId, item.id), isNull(invoicesTable.reversedAt))))[0] ?? null
      : (await db.select().from(billsTable).where(and(eq(billsTable.migrationOpenItemId, item.id), isNull(billsTable.reversedAt))))[0] ?? null;
    if (!live) throw new BusinessRuleError(409, { code: "opening_item_not_live", error: `Migrated item ${item.documentNumber} has no live ledger row (its migration was reversed); correct the replacement migration instead.`, field: "itemId" });
    const current = round2(num(live.total));
    const delta = round2(correct - current);
    if (Math.abs(delta) < TOL) throw new BusinessRuleError(409, { code: "opening_correction_no_change", error: `${item.documentNumber} already stands at ${fmt(current)}.`, field: "correctOutstanding" });

    // 🔴 §16.12.5 — a touched item is still the accountant's open question: refused by name.
    const touches = await migrationRepository.touchesSinceCommit(isAr ? [live.id] : [], isAr ? [] : [live.id], []);
    if (touches.length > 0) {
      throw new BusinessRuleError(409, { code: "opening_item_partly_settled", error: `Migrated item ${item.documentNumber} has been acted on since the migration (${touches.join("; ")}). How a partly-settled opening item is corrected is an open question with the accountant (Batch 1C pack §16.12.5); until it is answered the item is corrected by dated journals, not here.`, field: "itemId" });
    }

    const number = isAr ? (live as Invoice).invoiceNumber : (live as Bill).billNumber;
    const partyId = isAr ? (live as Invoice).customerId! : (live as Bill).vendorId!;
    const party = isAr ? { type: "customer" as const, customerId: partyId } : { type: "vendor" as const, vendorId: partyId };
    const control = isAr ? { systemCode: "AR" as const, accountName: "Accounts Receivable" } : { systemCode: "AP" as const, accountName: "Accounts Payable" };
    const re = { systemCode: "RETAINED_EARNINGS" as const, accountName: "Retained earnings" };
    // decrease of a receivable: Dr RE / Cr AR; increase: Dr AR / Cr RE. Payables mirror.
    const controlDebit = isAr ? (delta > 0 ? delta : 0) : delta < 0 ? -delta : 0;
    const controlCredit = isAr ? (delta < 0 ? -delta : 0) : delta > 0 ? delta : 0;
    const je = await postJournalEntry({
      entryNumber: `OPEN-CORR-${item.id}-${Date.now()}`,
      date,
      description: `Migration correction: ${item.documentNumber} (${number}) ${fmt(current)} → ${fmt(correct)} — ${reason}`,
      reference: `migration:${item.batchId}`,
      source: "opening_correction",
      migrationBatchId: item.batchId,
      lines: [
        { systemCode: control.systemCode, accountName: control.accountName, description: `Correction of migrated item ${item.documentNumber}`, debitAmount: controlDebit, creditAmount: controlCredit, party },
        { systemCode: re.systemCode, accountName: re.accountName, description: `Opening retained earnings — correction of ${item.documentNumber}`, debitAmount: controlCredit, creditAmount: controlDebit },
      ],
    });

    // A4: the original stays, marked reversed by ITS batch (the trigger admits exactly that) and carrying the entry; then it is frozen.
    const now = new Date();
    if (isAr) {
      await db.update(invoicesTable).set({ reversedAt: now, reversedByMigrationBatchId: item.batchId, openingCorrectionJournalEntryId: je.id }).where(eq(invoicesTable.id, live.id));
    } else {
      await db.update(billsTable).set({ reversedAt: now, reversedByMigrationBatchId: item.batchId, openingCorrectionJournalEntryId: je.id }).where(eq(billsTable.id, live.id));
    }
    // the replacement: a NEW number, the corrected amount, every fact of the original carried, linked back
    const seq = await nextReplacementSeq(item.batchId);
    const replacementNumber = openingReplacementNumber(item.batchId, seq);
    const notes = `${(live as { notes?: string | null }).notes ?? ""}\nCorrected ${date} from ${fmt(current)} to ${fmt(correct)} (${reason}); replaces ${number}; other side retained earnings (entry ${je.entryNumber}).`.trim();
    let replacement: Invoice | Bill;
    if (isAr) {
      const src = live as Invoice;
      [replacement] = await migrationRepository.insertInvoice({
        invoiceNumber: replacementNumber, date: src.date, dueDate: src.dueDate, customerId: src.customerId, status: "sent",
        subtotal: fmt(correct), vatAmount: "0", discount: "0", total: fmt(correct), currency: "SAR", paidAmount: "0", notes,
        isOpening: true, migrationOpenItemId: item.id, replacesInvoiceId: src.id,
        openingSourceUuid: src.openingSourceUuid ?? null, openingEinvoicingStatus: src.openingEinvoicingStatus ?? null,
        badDebtReliefSource: src.badDebtReliefSource ?? null, badDebtReliefClaimedOn: src.badDebtReliefClaimedOn ?? null, badDebtReliefVatAmount: src.badDebtReliefVatAmount ?? null,
      } as Parameters<typeof migrationRepository.insertInvoice>[0]);
    } else {
      const src = live as Bill;
      [replacement] = await migrationRepository.insertBill({
        billNumber: replacementNumber, date: src.date, dueDate: src.dueDate, vendorId: src.vendorId, status: src.status,
        subtotal: fmt(correct), vatAmount: "0", total: fmt(correct), paidAmount: "0", notes,
        isOpening: true, migrationOpenItemId: item.id, replacesBillId: src.id,
      } as Parameters<typeof migrationRepository.insertBill>[0]);
    }
    await auditService.record({
      action: "opening_item_correct",
      entityType: isAr ? "invoice" : "bill",
      entityId: live.id,
      before: { number, total: current },
      after: { replacementId: replacement!.id, replacementNumber, total: correct, delta, reason, date, journalEntryId: je.id, otherSide: "RETAINED_EARNINGS", stagingItemId: item.id, sourceDocument: item.documentNumber },
    });
    return { original: { id: live.id, number, total: current }, replacement: { id: replacement!.id, number: replacementNumber, total: correct }, delta, journalEntryId: je.id, entryNumber: je.entryNumber, date };
  },

  /** Record, ONCE, the previous solution's e-invoicing identity of an opening receivable the migration did not carry. */
  async recordIdentity(itemId: number, body: { einvoicingStatus?: unknown; sourceUuid?: unknown }, userId: number | null) {
    const status = typeof body.einvoicingStatus === "string" ? body.einvoicingStatus : "";
    if (!STATUSES.includes(status)) throw new BadRequestError("einvoicingStatus must be cleared, reported or pre_einvoicing — what the previous solution did with the document; not stated is not a value here.");
    const sourceUuid = typeof body.sourceUuid === "string" && body.sourceUuid.trim() ? body.sourceUuid.trim() : null;
    if ((status === "cleared" || status === "reported") && !sourceUuid) throw new BadRequestError(`A ${status} document carries the previous solution's UUID (sourceUuid); it is not invented.`);
    if (sourceUuid && sourceUuid.length > 64) throw new BadRequestError("sourceUuid is too long.");
    const item = await stagedItem(itemId);
    if (item.itemType !== "ar") throw new BusinessRuleError(409, { code: "identity_ar_only", error: `Migrated item ${item.documentNumber} is a payable; an e-invoicing identity belongs to a tax invoice the previous solution issued.`, field: "itemId" });
    const live = (await db.select().from(invoicesTable).where(and(eq(invoicesTable.migrationOpenItemId, item.id), isNull(invoicesTable.reversedAt))))[0] ?? null;
    if (!live) throw new BusinessRuleError(409, { code: "opening_item_not_live", error: `Migrated item ${item.documentNumber} has no live ledger row.`, field: "itemId" });
    if (live.openingEinvoicingStatus) {
      throw new BusinessRuleError(409, { code: "opening_identity_already_recorded", error: `${live.invoiceNumber} already carries its identity (${live.openingEinvoicingStatus}${live.openingSourceUuid ? ` · ${live.openingSourceUuid}` : ""}); an identity is recorded once and never changed.`, field: "itemId" });
    }
    const [updated] = await db.update(invoicesTable).set({ openingEinvoicingStatus: status, openingSourceUuid: status === "pre_einvoicing" ? sourceUuid : sourceUuid }).where(eq(invoicesTable.id, live.id)).returning();
    await auditService.record({ action: "opening_identity_record", entityType: "invoice", entityId: live.id, before: { einvoicingStatus: null, sourceUuid: null }, after: { einvoicingStatus: status, sourceUuid, stagingItemId: item.id, sourceDocument: item.documentNumber, by: userId } });
    return { invoiceId: updated!.id, invoiceNumber: updated!.invoiceNumber, einvoicingStatus: status, sourceUuid };
  },

  /** What a credit note through Fatoora needs of an opening receivable, and whether it is there. */
  async noteEligibility(invoice: Invoice): Promise<{ eligible: true; referenceNumber: string; status: OpeningEinvoicingStatus; sourceUuid: string | null } | { eligible: false; code: string; error: string }> {
    if (!invoice.isOpening) return { eligible: true, referenceNumber: invoice.invoiceNumber, status: "cleared", sourceUuid: null };
    const item = invoice.migrationOpenItemId != null ? (await db.select().from(migrationOpenItemsTable).where(eq(migrationOpenItemsTable.id, invoice.migrationOpenItemId)))[0] ?? null : null;
    const referenceNumber = item?.documentNumber ?? invoice.invoiceNumber;
    const status = (invoice.openingEinvoicingStatus ?? null) as OpeningEinvoicingStatus | null;
    if (!status) {
      return { eligible: false, code: "opening_item_einvoicing_identity_missing", error: `${invoice.invoiceNumber} is an opening item migrated from the previous system (source document ${referenceNumber}) and the migration did not state whether that document was cleared, reported or issued before e-invoicing. A credit note must name it through Fatoora (accountant, 2026-09-22) — record its e-invoicing identity on the migrated item first (Migration → open items → identity), with the previous solution's UUID for a cleared or reported document.` };
    }
    if ((status === "cleared" || status === "reported") && !invoice.openingSourceUuid) {
      return { eligible: false, code: "opening_item_source_uuid_missing", error: `${invoice.invoiceNumber} was ${status} by the previous solution but its UUID was not recorded; the credit note's reference to it needs the original's identity. Record it on the migrated item first.` };
    }
    return { eligible: true, referenceNumber, status, sourceUuid: invoice.openingSourceUuid ?? null };
  },
};

/** The journal entries table is imported so the module's dependency on `source = 'opening_correction'` is visible to the reader; the posting seam validates the value. */
void journalEntriesTable;
