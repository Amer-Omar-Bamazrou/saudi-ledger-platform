/**
 * BATCH 1C — PHASE 3: the COMMIT, the reconciliation gates R1–R10, and the
 * REVERSAL.
 *
 * Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
 * §15.5 steps 3–11, §15.6 (R1–R10 and the invariants), §15.6 "Safety".
 *
 * ── THE COMMIT, in one transaction ──────────────────────────────────────────
 * The request IS the transaction (lib/tenant.ts: a 4xx/5xx rolls back
 * everything the request wrote). So every step below either all persists or
 * none does — no partial customer, item, deposit, bank state or journal can
 * exist. The order:
 *   0. lock the batch row; require `validated`; the content hash must still
 *      match; every control must still pass; the ledger before the opening
 *      date must be empty; the opening month must be open.
 *   1. parties → customers / vendors (created with their source identity, or
 *      an existing record that gains it — refused if it carries another).
 *   2. chart `create` rows → categories with `account_code` = the old code
 *      (headers first); every mapped row records its resolved category.
 *   3. open items → `opening` invoices / bills: the original number and
 *      dates, the outstanding as the total, no VAT, no ICV, no hash, no QR,
 *      no line items, no e-invoice document — the DB CHECKs refuse otherwise.
 *   4. THE OPENING JOURNAL through `postJournalEntry` — the only GL writer —
 *      dated cutover − 1, source = 'opening': AR per customer and AP per
 *      vendor from the items (with the party on the line), CUSTOMER_DEPOSITS
 *      per customer from the advances, each bank on its D-3 leaf, every
 *      other mapped balance on its account — and nothing else: a position
 *      that does not balance on those named accounts is REFUSED here (A5).
 *   5. advances → `payments` rows (direction in, source = 'opening') whose
 *      deposit line is inside the opening journal; their cash is inside the
 *      bank's opening balance, so they post no cash line of their own.
 *   6. banks → `opening_journal_entry_id` set; the typed opening balance now
 *      READS the posted figure and is refused edits (G2 closed).
 *   7. the opening month is locked, in the migration's name.
 *   8. R1–R10 against the POSTED ledger read back inside the transaction; any
 *      blocking failure throws → the whole commit rolls back.
 *   9. the batch becomes `committed` (one per company, by partial unique).
 *
 * ── THE REVERSAL ────────────────────────────────────────────────────────────
 * The likeliest correction a real migration meets (the opening AR was wrong
 * by 5,000 a week later). Designed against the schema, not as a status flip:
 *   - REFUSED while anything has touched what the commit created: a receipt
 *     allocated to an opening invoice, a credit note against one, a bill
 *     payment, a deposit allocated or refunded. Each is named; the operator
 *     unwinds it first (or posts dated correction journals instead — the
 *     pack's other route; a partly-settled item is the OPEN accountant
 *     question of pack §16.12.5 and nothing is built past this refusal).
 *   - The migration's own period lock on the opening month is lifted (only
 *     if it is still the migration's lock; a month closed by someone else
 *     since stays closed and blocks).
 *   - The opening journal is MIRRORED through `postJournalEntry`, dated the
 *     opening date, source = 'opening_reversal', `reversal_of` = the opening
 *     entry; the opening entry is marked `reversed` (in the books, netted —
 *     the JE_IN_BOOKS rule). The ledger keeps both entries forever.
 *   - 🔴 POLICY C (accountant A4, 2026-09-20; pack §16.12.1): the opening
 *     invoices, bills and deposit payments are NEVER deleted. Each invoice
 *     and bill is MARKED (`reversed_at`, `reversed_by_migration_batch_id` —
 *     once, only by this batch, only on an opening row; the row is then
 *     FROZEN by trigger); each deposit gets a SUPERSEDING RECORD in
 *     `migration_deposit_reversals` (payments stay append-only). Their
 *     staging rows keep pointing at them. Every reader of a receivable,
 *     payable or deposit figure excludes a marked row through the one
 *     predicate (repositories/openingReversal.ts, guarded by the reader
 *     sweep test); the mirror journal nets their GL effect. The audit record
 *     lists every row marked. (The pre-A4 build deleted them so the re-run
 *     could reuse the original numbers — withdrawn by the accountant.)
 *   - Customers, vendors and created accounts STAY, carrying their source
 *     identity / account code: a re-run resolves to them by construction
 *     (`use_existing` pre-decided by source id; `merge_into` by account code).
 *   - Banks: `opening_journal_entry_id` cleared; the typed opening balance is
 *     display-only again.
 *   - The batch becomes `reversed`. The next batch the company creates is
 *     its REPLACEMENT (`replaces_batch_id`): it imports the same source ids
 *     (identity is per batch), and at commit its opening items receive NEW
 *     Saudi Ledger numbers `OPEN-<batch>-<seq>` — never the source number,
 *     which stays verbatim on the reversed row and in
 *     `migration_open_items.document_number` (`ledger_document_number` records
 *     what the ledger row is called) — and each points back at the reversed
 *     row it replaces (`replaces_invoice_id` / `replaces_bill_id` /
 *     `replaces_payment_id`, matched by source id).
 *
 * ── NO BALANCING ACCOUNT ────────────────────────────────────────────────────
 * A source position that balances and is fully mapped needs no balancing
 * side: every balance — the old equity and retained earnings included —
 * lands on a named account. A source that does NOT balance (books kept
 * without equity detail, an incomplete export) is a migration FAILURE: the
 * operator classifies the difference into named rows before validation, or
 * the migration does not happen. There is no opening-balance-equity account,
 * no declared residual and no clearing journal (accountant A5, 2026-09-20;
 * decision pack §16.12.2). R6 below is the gate that proves it on the
 * posted ledger.
 */
import { SYSTEM_ACCOUNTS } from "@workspace/db";
import type { MigrationBatch, SystemAccountCode } from "@workspace/db";
import { openingReplacementNumber } from "@workspace/shared";
import { round2 } from "../lib/money";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { migrationRepository } from "../repositories/migration.repository";
import { customersRepository } from "../repositories/customers.repository";
import { vendorsRepository } from "../repositories/vendors.repository";
import { categoriesRepository } from "../repositories/categories.repository";
import { periodLocksRepository } from "../repositories/periodLocks.repository";
import { auditService } from "./audit.service";
import { postJournalEntry, type GLLine } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { migrationService, toBatchOut } from "./migration.service";
import { readStagedContent, type StagedContent } from "./migrationStaging.service";
import { computeOpeningPosition, contentHashOf, type ControlCheck } from "./migrationValidation.service";

const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toFixed(2);
const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;

type Refusal = { code: string; error: string; field?: string };
const refuse = (status: number, r: Refusal): never => { throw new BusinessRuleError(status, { error: r.error, code: r.code, field: r.field ?? "id" }); };

function assertCommittable(batch: MigrationBatch) {
  if (batch.status === "committed") return;
  if (batch.status === "reversed") refuse(409, { code: "migration_batch_reversed", error: `Migration batch ${batch.id} was reversed; start a new batch.` });
  if (batch.status === "discarded") refuse(409, { code: "migration_batch_discarded", error: `Migration batch ${batch.id} was discarded.` });
  if (batch.status !== "validated") refuse(409, { code: "migration_not_validated", error: `Migration batch ${batch.id} is ${batch.status}; validate it first — the commit only runs on a validated batch whose content has not moved.` });
}

/** Parents before children, by depth in the source hierarchy. */
function createOrder(rows: StagedContent["chart"]): StagedContent["chart"] {
  const byCode = new Map(rows.map((r) => [r.sourceCode, r]));
  const depth = (r: (typeof rows)[number]): number => {
    let d = 0, cur = r;
    const seen = new Set<string>();
    while (cur.sourceParentCode && byCode.has(cur.sourceParentCode) && !seen.has(cur.sourceCode)) { seen.add(cur.sourceCode); cur = byCode.get(cur.sourceParentCode)!; d += 1; }
    return d;
  };
  return [...rows].sort((a, b) => depth(a) - depth(b) || a.sourceCode.localeCompare(b.sourceCode));
}

export const migrationCommitService = {
  /**
   * Commit a validated batch. Idempotent: a batch already committed returns
   * as it is (no second journal); a concurrent second call waits on the row
   * lock and then sees `committed`.
   */
  async commit(batchId: number, userId: number | null) {
    const [locked] = await migrationRepository.findBatchForUpdate(batchId);
    if (!locked) throw new NotFoundError("Migration batch not found");
    if (locked.status === "committed") return migrationService.getBatch(batchId);
    assertCommittable(locked);
    const batch = locked;

    // 0. The content is exactly what was validated, and still passes.
    const content = await readStagedContent(batch);
    const hash = contentHashOf(content);
    if (hash !== batch.contentHash) refuse(409, { code: "migration_content_changed", error: "The staged content changed since validation; validate again before committing." });
    const position = await computeOpeningPosition(batch, content);
    // 🔴 A5: the position balances on named accounts or nothing posts — the
    // FIRST refusal, before any write, with its own code and the guidance.
    // Validation already refused this; it is re-asserted at the commit
    // boundary because a boundary that trusts an earlier check is a
    // convention wearing an invariant's clothes.
    if (!eq(position.totals.difference, 0)) {
      refuse(409, { code: "migration_unbalanced", error: `The opening position does not balance: ${fmt(Math.abs(position.totals.difference))} ${position.totals.difference < 0 ? "on the debit side" : "on the credit side"} is unexplained. Classify the difference into named accounts and validate again; nothing is carried on a balancing account.` });
    }
    const failing = position.controls.filter((c) => c.status === "fail");
    if (failing.length > 0) refuse(409, { code: "migration_validation_failed", error: `Validation no longer passes: ${failing.map((c) => c.id).join(", ")}. Validate again.` });
    const [live] = await migrationRepository.findLiveBatch();
    if (live) refuse(409, { code: "migration_already_committed", error: `This company already has a committed migration (batch ${live.id}).` });
    await checkPeriodOpen(batch.openingDate);

    const { chart, parties, items, advances } = content;
    const pk = (type: string, sid: string) => `${type}:${sid}`;

    // 1. Parties → master data with source identity.
    const customerIdBySource = new Map<string, number>();
    const vendorIdBySource = new Map<string, number>();
    let customersCreated = 0, vendorsCreated = 0;
    for (const p of parties) {
      const identity = { sourceSystem: p.sourceSystem, sourceId: p.sourceId };
      if (p.partyType === "customer") {
        let id: number;
        if (p.decision === "use_existing") {
          const [existing] = await migrationRepository.customersByIds([p.existingCustomerId!]);
          if (!existing) refuse(422, { code: "reference_not_found", error: `Customer ${p.existingCustomerId} (party ${p.sourceId}) no longer exists.` });
          if (existing.sourceSystem != null && (existing.sourceSystem !== p.sourceSystem || existing.sourceId !== p.sourceId)) {
            refuse(422, { code: "source_identity_conflict", error: `Customer #${existing.id} ${existing.name} already represents ${existing.sourceSystem} ${existing.sourceId}; it cannot also be ${p.sourceSystem} ${p.sourceId}.` });
          }
          if (existing.sourceSystem == null) await customersRepository.update(existing.id, identity);
          id = existing.id;
        } else {
          const [created] = await customersRepository.insert({ name: p.name, nameAr: p.nameAr, taxNumber: p.taxNumber, crNumber: p.crNumber, phone: p.phone, email: p.email, address: p.address, city: p.city, ...identity });
          id = created.id; customersCreated += 1;
        }
        customerIdBySource.set(p.sourceId, id);
        await migrationRepository.updateParty(p.id, { resolvedCustomerId: id });
      } else {
        let id: number;
        if (p.decision === "use_existing") {
          const [existing] = await migrationRepository.vendorsByIds([p.existingVendorId!]);
          if (!existing) refuse(422, { code: "reference_not_found", error: `Vendor ${p.existingVendorId} (party ${p.sourceId}) no longer exists.` });
          if (existing.sourceSystem != null && (existing.sourceSystem !== p.sourceSystem || existing.sourceId !== p.sourceId)) {
            refuse(422, { code: "source_identity_conflict", error: `Vendor #${existing.id} ${existing.name} already represents ${existing.sourceSystem} ${existing.sourceId}; it cannot also be ${p.sourceSystem} ${p.sourceId}.` });
          }
          if (existing.sourceSystem == null) await vendorsRepository.update(existing.id, identity);
          id = existing.id;
        } else {
          const [created] = await vendorsRepository.insert({ name: p.name, nameAr: p.nameAr, taxNumber: p.taxNumber, crNumber: p.crNumber, phone: p.phone, email: p.email, address: p.address, city: p.city, ...identity });
          id = created.id; vendorsCreated += 1;
        }
        vendorIdBySource.set(p.sourceId, id);
        await migrationRepository.updateParty(p.id, { resolvedVendorId: id });
      }
    }

    // 2. Chart: created accounts (headers first), then every row's resolved category.
    const createdCategoryBySource = new Map<string, number>();
    let accountsCreated = 0;
    for (const row of createOrder(chart.filter((r) => r.decision === "create"))) {
      const parentFromSource = row.sourceParentCode ? createdCategoryBySource.get(row.sourceParentCode) : undefined;
      const [cat] = await categoriesRepository.insert({
        name: row.sourceName,
        nameAr: row.sourceNameAr ?? row.sourceName,
        type: row.sourceType,
        parentId: parentFromSource ?? row.targetCategoryId ?? null,
        isPosting: !row.sourceIsGroup,
        accountCode: row.sourceCode,
        description: `Migrated from ${batch.sourceSystem} (account ${row.sourceCode}) at cutover ${batch.cutoverDate}.`,
      });
      createdCategoryBySource.set(row.sourceCode, cat.id);
      accountsCreated += 1;
      await migrationRepository.updateChartRow(row.id, { resolvedCategoryId: cat.id });
    }
    const systemCats = new Map((await migrationRepository.systemCategories([...new Set(chart.filter((r) => r.decision === "map_to_system").map((r) => r.targetSystemCode!))])).map((c) => [c.systemCode!, c]));
    const bankLeaves = new Map((await migrationRepository.bankLeaves([...new Set(chart.filter((r) => r.decision === "map_to_bank").map((r) => r.targetBankAccountId!))])).map((l) => [l.bankAccountId!, l]));
    for (const row of chart) {
      if (row.decision === "map_to_system") await migrationRepository.updateChartRow(row.id, { resolvedCategoryId: systemCats.get(row.targetSystemCode!)!.id });
      else if (row.decision === "map_to_bank") await migrationRepository.updateChartRow(row.id, { resolvedCategoryId: bankLeaves.get(row.targetBankAccountId!)!.id });
      else if (row.decision === "merge_into") await migrationRepository.updateChartRow(row.id, { resolvedCategoryId: row.targetCategoryId! });
    }

    // 3. Open items → opening invoices / bills. Amount-only; no VAT, no ICV, no hash, no QR, no lines.
    // Policy C numbering: a FIRST migration keeps the source number as the ledger
    // number; a REPLACEMENT batch mints OPEN-<batch>-<seq> (seq = the item's
    // ordinal in the batch's staged order — payables first, then receivables,
    // by party, issue date, row — so it is deterministic) and links each row to the reversed
    // row it replaces, matched by (item type, source id) in the reversed batch.
    const replaced = batch.replacesBatchId != null ? await migrationRepository.openItems(batch.replacesBatchId) : [];
    const replacedByKey = new Map(replaced.map((r) => [`${r.itemType}:${r.sourceId}`, r]));
    const invoiceIds: number[] = [], billIds: number[] = [];
    let seq = 0;
    for (const it of items) {
      seq += 1;
      const outstanding = fmt(num(it.outstandingAmount));
      const ledgerNumber = batch.replacesBatchId != null ? openingReplacementNumber(batch.id, seq) : it.documentNumber;
      const prior = replacedByKey.get(`${it.itemType}:${it.sourceId}`);
      // Art. 40(9): the bad-debt-relief answer travels onto the receivable as provenance TEXT (the structured value stays on the frozen staging row, reachable through migration_open_item_id); nothing reads it back to act.
      const relief = (it.historicalVat as { badDebtReliefClaimed?: boolean | null } | null)?.badDebtReliefClaimed ?? null;
      const notes = `Opening item migrated from ${batch.sourceSystem} (${it.sourceId}, source document ${it.documentNumber}); original amount ${fmt(num(it.originalAmount))}${it.compositionUnknown ? "; composition unknown — the previous system tracked only this party's balance" : ""}${relief == null ? "" : `; VAT bad-debt relief claimed in the previous system: ${relief ? "yes" : "no"}`}${it.description ? `; ${it.description}` : ""}${prior ? `; replaces the reversed opening item of migration batch ${batch.replacesBatchId}` : ""}.`;
      if (it.itemType === "ar") {
        const [inv] = await migrationRepository.insertInvoice({
          invoiceNumber: ledgerNumber, date: it.issueDate, dueDate: it.dueDate, customerId: customerIdBySource.get(it.partySourceId)!,
          status: "sent", subtotal: outstanding, vatAmount: "0", discount: "0", total: outstanding, currency: "SAR", paidAmount: "0", notes,
          isOpening: true, migrationOpenItemId: it.id, replacesInvoiceId: prior?.resolvedInvoiceId ?? null,
        });
        invoiceIds.push(inv.id);
        await migrationRepository.updateOpenItem(it.id, { resolvedInvoiceId: inv.id, ledgerDocumentNumber: ledgerNumber });
      } else {
        const [bill] = await migrationRepository.insertBill({
          billNumber: ledgerNumber, date: it.issueDate, dueDate: it.dueDate, vendorId: vendorIdBySource.get(it.partySourceId)!,
          status: "approved", subtotal: outstanding, vatAmount: "0", total: outstanding, currency: "SAR", paidAmount: "0", notes,
          isOpening: true, migrationOpenItemId: it.id, replacesBillId: prior?.resolvedBillId ?? null,
        });
        billIds.push(bill.id);
        await migrationRepository.updateOpenItem(it.id, { resolvedBillId: bill.id, ledgerDocumentNumber: ledgerNumber });
      }
    }

    // 4. THE OPENING JOURNAL, through the seam.
    const lines: GLLine[] = [];
    const desc = `Opening balances from ${batch.sourceSystem} as at ${batch.openingDate}`;
    for (const l of position.lines) {
      if (l.systemCode === SYSTEM_ACCOUNTS.AR || l.systemCode === SYSTEM_ACCOUNTS.AP || l.systemCode === SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS) continue; // per party, below
      if (l.targetKind === "bank") lines.push({ bankAccountId: l.bankAccountId!, debitAmount: l.debit, creditAmount: l.credit, description: `${desc} — ${l.sourceCodes.join(", ")}` });
      else if (l.targetKind === "create") lines.push({ accountId: createdCategoryBySource.get(l.sourceCodes[0]!)!, accountName: l.accountName, debitAmount: l.debit, creditAmount: l.credit, description: `${desc} — ${l.sourceCodes.join(", ")}` });
      else if (l.targetKind === "category") lines.push({ accountId: l.categoryId!, accountName: l.accountName, debitAmount: l.debit, creditAmount: l.credit, description: `${desc} — ${l.sourceCodes.join(", ")}` });
      else lines.push({ systemCode: l.systemCode as SystemAccountCode, accountName: l.accountName, debitAmount: l.debit, creditAmount: l.credit, description: `${desc} — ${l.sourceCodes.join(", ")}` });
    }
    for (const c of position.arByCustomer) lines.push({ systemCode: SYSTEM_ACCOUNTS.AR, accountName: "Accounts Receivable", debitAmount: c.total, creditAmount: 0, party: { type: "customer", customerId: customerIdBySource.get(c.partySourceId)! }, description: `${desc} — ${c.items} open item(s) of ${c.partyName ?? c.partySourceId}` });
    for (const v of position.apByVendor) lines.push({ systemCode: SYSTEM_ACCOUNTS.AP, accountName: "Accounts Payable", debitAmount: 0, creditAmount: v.total, party: { type: "vendor", vendorId: vendorIdBySource.get(v.partySourceId)! }, description: `${desc} — ${v.items} open item(s) of ${v.partyName ?? v.partySourceId}` });
    for (const d of position.depositsByCustomer) lines.push({ systemCode: SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS, accountName: "Customer deposits and advances", debitAmount: 0, creditAmount: d.total, party: { type: "customer", customerId: customerIdBySource.get(d.partySourceId)! }, description: `${desc} — ${d.items} advance(s) held for ${d.partyName ?? d.partySourceId}` });
    const je = await postJournalEntry({ entryNumber: `MIG-${batch.id}-OPEN`, date: batch.openingDate, description: desc, reference: `migration:${batch.id}`, lines, source: "opening", migrationBatchId: batch.id });

    // 5. Advances → deposits held: payments rows whose deposit line is in the opening journal.
    const bankByCode = new Map(chart.filter((r) => r.decision === "map_to_bank").map((r) => [r.sourceCode, r.targetBankAccountId!]));
    const replacedAdvances = new Map((batch.replacesBatchId != null ? await migrationRepository.advances(batch.replacesBatchId) : []).map((r) => [r.sourceId, r]));
    const paymentIds: number[] = [];
    for (const a of advances) {
      const [pay] = await migrationRepository.insertPayment({
        direction: "in", partyType: "customer", customerId: customerIdBySource.get(a.partySourceId)!, bankAccountId: bankByCode.get(a.bankSourceCode)!,
        amount: fmt(num(a.amount)), paidAt: a.receivedAt, method: null,
        reference: a.reference ?? (a.vatPosition === "invoiced" ? `advance invoice ${a.advanceInvoiceNumber}` : `advance ${a.sourceId} (VAT position unknown)`),
        source: "opening", journalEntryId: je.id, migrationAdvanceId: a.id, createdBy: userId,
        replacesPaymentId: replacedAdvances.get(a.sourceId)?.resolvedPaymentId ?? null,
      });
      paymentIds.push(pay.id);
      await migrationRepository.updateAdvance(a.id, { resolvedPaymentId: pay.id });
    }

    // 6. Banks: the opening balance is now the posted figure, read-only.
    for (const b of position.banks) await migrationRepository.updateBankAccount(b.bankAccountId, { openingJournalEntryId: je.id, openingBalance: fmt(b.balance) });

    // 7. Lock the opening month in the migration's name.
    const period = batch.openingDate.slice(0, 7);
    const [existingLock] = await migrationRepository.periodLockByPeriod(period);
    if (existingLock) refuse(423, { code: "period_locked", error: `${period} is already closed; the opening journal could not have posted.` });
    const [lock] = await periodLocksRepository.insert({ period, lockedBy: userId ?? null, notes: `Opening balances — migration batch ${batch.id} from ${batch.sourceSystem}` });
    await auditService.created("period_lock", lock.id, lock);

    // 8. THE GATES, against the posted ledger.
    const reconciliation = await this.reconcile(batch, content, position, je.id, { invoiceIds, billIds, paymentIds, customersCreated, vendorsCreated, accountsCreated });
    const blocking = reconciliation.checks.filter((c) => c.status === "fail");
    if (blocking.length > 0) {
      refuse(409, { code: "migration_reconciliation_failed", error: `The posted opening position does not reconcile: ${blocking.map((c) => `${c.id} — ${c.detail}`).join(" | ")}. Nothing was committed.` });
    }

    // 9. Committed.
    const now = new Date();
    const [updated] = await migrationRepository.updateBatch(batch.id, { status: "committed", committedBy: userId, committedAt: now, openingJournalEntryId: je.id, periodLockId: lock.id, reconciliation });
    await auditService.record({
      action: "migration_batch_commit", entityType: "migration_batch", entityId: batch.id,
      after: { openingJournalEntryId: je.id, periodLockId: lock.id, replacesBatchId: batch.replacesBatchId ?? null, customersCreated, vendorsCreated, accountsCreated, invoices: invoiceIds.length, bills: billIds.length, deposits: paymentIds.length, totals: position.totals, reconciliation: reconciliation.checks.map((c) => `${c.id}:${c.status}`), by: userId },
    });
    return { ...toBatchOut(updated), counts: await migrationRepository.counts(batch.id), validation: updated.validation ?? null, reconciliation };
  },

  /** R1–R10 read back from the ledger and the subledger tables inside the commit transaction. */
  async reconcile(
    batch: MigrationBatch, content: StagedContent, position: Awaited<ReturnType<typeof computeOpeningPosition>>, journalEntryId: number,
    created: { invoiceIds: number[]; billIds: number[]; paymentIds: number[]; customersCreated: number; vendorsCreated: number; accountsCreated: number },
  ) {
    const checks: ControlCheck[] = [];
    const push = (id: string, title: string, ok: boolean, expected: ControlCheck["expected"], actual: ControlCheck["actual"], detail: string, warnOnly = false) =>
      checks.push({ id, title, status: ok ? "pass" : warnOnly ? "warn" : "fail", expected, actual, detail });
    const jeLines = await migrationRepository.journalLines(journalEntryId);
    const ledger = await migrationRepository.ledgerBalancesUpTo(batch.openingDate);
    const ledgerByAccount = new Map(ledger.map((l) => [l.accountId, l]));
    // Re-read: the resolved ids were written during this commit, after `content` was read.
    const parties = await migrationRepository.parties(batch.id);
    const customerIdOf = (sid: string) => parties.find((p) => p.partyType === "customer" && p.sourceId === sid)?.resolvedCustomerId ?? null;
    const vendorIdOf = (sid: string) => parties.find((p) => p.partyType === "vendor" && p.sourceId === sid)?.resolvedVendorId ?? null;
    const chartRows = await migrationRepository.chartRows(batch.id);

    // R1: staged position (by target account) = opening journal (by account) = ledger read-back at the opening date, per account, P&L included.
    const jeByAccount = new Map<number, number>();
    for (const l of jeLines) jeByAccount.set(l.accountId!, round2((jeByAccount.get(l.accountId!) ?? 0) + num(l.debitAmount) - num(l.creditAmount)));
    const r1Problems: string[] = [];
    const resolvedByTarget = new Map<string, number>();
    for (const row of chartRows) {
      if (!row.decision || row.decision === "skip") continue;
      const key = row.decision === "map_to_system" ? `system:${row.targetSystemCode}` : row.decision === "map_to_bank" ? `bank:${row.targetBankAccountId}` : row.decision === "merge_into" ? `category:${row.targetCategoryId}` : `create:${row.sourceCode}`;
      resolvedByTarget.set(key, row.resolvedCategoryId!);
    }
    for (const l of position.lines) {
      const accountId = resolvedByTarget.get(l.target);
      const inJournal = accountId != null ? (jeByAccount.get(accountId) ?? 0) : NaN;
      const inLedger = accountId != null ? (ledgerByAccount.get(accountId)?.balance ?? 0) : NaN;
      if (accountId == null) r1Problems.push(`${l.target}: no resolved account`);
      else if (!eq(l.balance, inJournal) || !eq(l.balance, inLedger)) r1Problems.push(`${l.accountName}: staged ${fmt(l.balance)}, journal ${fmt(inJournal)}, ledger ${fmt(inLedger)}`);
    }
    const jeDebit = round2(jeLines.reduce((s, l) => s + num(l.debitAmount), 0)), jeCredit = round2(jeLines.reduce((s, l) => s + num(l.creditAmount), 0));
    push("R1", "Old ERP closing TB (mapped) = opening journal (by account) = ledger read-back at cutover − 1, per account, P&L included", r1Problems.length === 0 && eq(jeDebit, jeCredit), position.lines.length, r1Problems.length === 0 ? position.lines.length : `${position.lines.length - r1Problems.length} of ${position.lines.length}`, r1Problems.length === 0 ? `${position.lines.length} account(s) agree; journal Dr ${fmt(jeDebit)} = Cr ${fmt(jeCredit)}.` : r1Problems.join("; "));

    // R2 / R3: subledger (the opening invoices / bills as stored) = AR / AP party lines of the journal = staged items, per party and in total.
    const invoices = await migrationRepository.openingInvoices(batch.id);
    const bills = await migrationRepository.openingBills(batch.id);
    const arLedger = await migrationRepository.ledgerPartyBalancesUpTo(SYSTEM_ACCOUNTS.AR, batch.openingDate);
    const apLedger = await migrationRepository.ledgerPartyBalancesUpTo(SYSTEM_ACCOUNTS.AP, batch.openingDate);
    const r2Problems: string[] = [];
    for (const c of position.arByCustomer) {
      const cid = customerIdOf(c.partySourceId);
      const sub = round2(invoices.filter((i) => i.inv.customerId === cid).reduce((s, i) => s + num(i.inv.total) - num(i.inv.paidAmount) - num(i.inv.creditedAmount) - num(i.inv.writtenOffAmount), 0));
      const gl = round2(arLedger.filter((l) => l.customerId === cid).reduce((s, l) => s + l.balance, 0));
      if (!eq(c.total, sub) || !eq(c.total, gl)) r2Problems.push(`${c.partyName ?? c.partySourceId}: staged ${fmt(c.total)}, subledger ${fmt(sub)}, GL ${fmt(gl)}`);
    }
    const arTotalStaged = round2(position.arByCustomer.reduce((s, c) => s + c.total, 0));
    const arTotalGl = round2(arLedger.reduce((s, l) => s + l.balance, 0));
    const arControl = round2(ledger.filter((l) => l.systemCode === SYSTEM_ACCOUNTS.AR).reduce((s, l) => s + l.balance, 0));
    if (!eq(arTotalStaged, arTotalGl) || !eq(arTotalStaged, arControl)) r2Problems.push(`total: staged ${fmt(arTotalStaged)}, GL by party ${fmt(arTotalGl)}, AR control ${fmt(arControl)}`);
    push("R2", "Σ historical AR open items per customer = customer AR subledger = AR(party) lines; Σ = the AR control balance", r2Problems.length === 0, arTotalStaged, arControl, r2Problems.length === 0 ? `${invoices.length} opening invoice(s) over ${position.arByCustomer.length} customer(s) = ${fmt(arTotalStaged)}.` : r2Problems.join("; "));
    const r3Problems: string[] = [];
    for (const v of position.apByVendor) {
      const vid = vendorIdOf(v.partySourceId);
      const sub = round2(bills.filter((b) => b.bill.vendorId === vid).reduce((s, b) => s + num(b.bill.total) - num(b.bill.paidAmount), 0));
      const gl = round2(-apLedger.filter((l) => l.vendorId === vid).reduce((s, l) => s + l.balance, 0));
      if (!eq(v.total, sub) || !eq(v.total, gl)) r3Problems.push(`${v.partyName ?? v.partySourceId}: staged ${fmt(v.total)}, subledger ${fmt(sub)}, GL ${fmt(gl)}`);
    }
    const apTotalStaged = round2(position.apByVendor.reduce((s, v) => s + v.total, 0));
    const apControl = round2(-ledger.filter((l) => l.systemCode === SYSTEM_ACCOUNTS.AP).reduce((s, l) => s + l.balance, 0));
    if (!eq(apTotalStaged, apControl)) r3Problems.push(`total: staged ${fmt(apTotalStaged)}, AP control ${fmt(apControl)}`);
    push("R3", "The same for AP and suppliers; Σ = the AP control balance", r3Problems.length === 0, apTotalStaged, apControl, r3Problems.length === 0 ? `${bills.length} opening bill(s) over ${position.apByVendor.length} supplier(s) = ${fmt(apTotalStaged)}.` : r3Problems.join("; "));

    // R4: old ERP bank closing balance per bank = the bank leaf's ledger balance = the bank record's opening balance.
    const banksNow = await migrationRepository.bankAccountsByIds(position.banks.map((b) => b.bankAccountId));
    const r4Problems: string[] = [];
    for (const b of position.banks) {
      const leaf = ledger.find((l) => l.bankAccountId === b.bankAccountId);
      const rec = banksNow.find((x) => x.id === b.bankAccountId);
      const glBal = leaf?.balance ?? 0;
      if (!eq(b.balance, glBal) || !rec || !eq(num(rec.openingBalance), b.balance) || rec.openingJournalEntryId !== journalEntryId) r4Problems.push(`${b.bankName}: source ${fmt(b.balance)}, leaf ${fmt(glBal)}, record ${rec ? fmt(num(rec.openingBalance)) : "?"}${rec?.openingJournalEntryId !== journalEntryId ? ", opening journal not recorded on the bank" : ""}`);
    }
    push("R4", "Old ERP bank closing balance per bank = the D-3 leaf's balance = the bank record's opening balance (statement evidence on the row)", r4Problems.length === 0, position.banks.length, position.banks.length - r4Problems.length, r4Problems.length === 0 ? position.banks.map((b) => `${b.bankName} ${fmt(b.balance)}`).join("; ") || "no banks" : r4Problems.join("; "));

    // R5: assets = liabilities + equity (+ YTD result) at the opening date; Dr = Cr.
    const sumType = (t: string) => round2(ledger.filter((l) => l.type === t).reduce((s, l) => s + l.balance, 0));
    const nz = (n: number) => (n === 0 ? 0 : n); // never -0 in a stored figure
    const assets = nz(sumType("asset")), liabilities = nz(round2(-sumType("liability"))), equity = nz(round2(-sumType("equity"))), income = nz(round2(-sumType("income"))), expense = nz(sumType("expense"));
    const r5ok = eq(assets, round2(liabilities + equity + income - expense));
    push("R5", "Assets = Liabilities + Equity (+ YTD result) at cutover − 1; total debits = total credits", r5ok && eq(jeDebit, jeCredit), assets, round2(liabilities + equity + income - expense), `assets ${fmt(assets)}; liabilities ${fmt(liabilities)}; equity ${fmt(equity)}; YTD income ${fmt(income)} − expense ${fmt(expense)} = ${fmt(round2(income - expense))}.`);

    // R6 (A5, BLOCKING): every line of the posted opening journal lands on an
    // account the staged content NAMED — a mapped/created/merged chart target,
    // a bank leaf, or the AR / AP / CUSTOMER_DEPOSITS control the items and
    // advances derive — and the journal balances on those lines alone. A line
    // on any other account is a balancing line by definition, and there is
    // no account for one. R1 covers the AMOUNTS per named target; this
    // covers the SET of accounts written.
    const namedAccountIds = new Set<number>([...resolvedByTarget.values()]);
    for (const c of await migrationRepository.systemCategories([SYSTEM_ACCOUNTS.AR, SYSTEM_ACCOUNTS.AP, SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS])) namedAccountIds.add(c.id);
    const unnamedLines = jeLines.filter((l) => l.accountId == null || !namedAccountIds.has(l.accountId));
    const r6Problems = unnamedLines.map((l) => `line ${l.id} on account ${l.accountId ?? "NULL"} (${l.accountName ?? "?"}) Dr ${fmt(num(l.debitAmount))} / Cr ${fmt(num(l.creditAmount))} — not an account the staged content named`);
    if (!eq(jeDebit, jeCredit)) r6Problems.push(`journal Dr ${fmt(jeDebit)} ≠ Cr ${fmt(jeCredit)}`);
    push("R6", "Every opening-journal line lands on a NAMED account (mapped chart target, bank leaf, or the AR/AP/deposit control the items derive); no balancing-account line exists; Dr = Cr on those lines alone", r6Problems.length === 0, 0, unnamedLines.length, r6Problems.length === 0 ? `${jeLines.length} line(s), all on named accounts; Dr ${fmt(jeDebit)} = Cr ${fmt(jeCredit)}.` : r6Problems.join("; "));

    // R7: no opening item carries VAT, an ICV, a hash, a QR, a line item, an e-invoice document; none was created by the issuance path.
    const r7Problems: string[] = [];
    for (const i of invoices) if (num(i.inv.vatAmount) !== 0 || i.inv.icv != null || i.inv.invoiceHash != null || i.inv.qrCode != null || i.inv.issuedAt != null || !i.inv.isOpening) r7Problems.push(`invoice ${i.inv.invoiceNumber}`);
    for (const b of bills) if (num(b.bill.vatAmount) !== 0 || !b.bill.isOpening) r7Problems.push(`bill ${b.bill.billNumber}`);
    const traces = await migrationRepository.einvoiceTraces(created.invoiceIds);
    if (traces.einvoiceDocuments > 0) r7Problems.push(`${traces.einvoiceDocuments} e-invoice document(s)`);
    if (traces.lineItems > 0) r7Problems.push(`${traces.lineItems} line item(s)`);
    push("R7", "No opening item carries VAT, an ICV, a hash, a QR, a line item or an e-invoice document; none entered the issuance path", r7Problems.length === 0, 0, r7Problems.length, r7Problems.length === 0 ? `${invoices.length} invoice(s) and ${bills.length} bill(s) are amount-only opening items.` : r7Problems.join("; "));

    // R8: every opening AR/AP item has its party line in the journal, and every party line has its items — both directions.
    const r8Problems: string[] = [];
    const arLines = jeLines.filter((l) => l.customerId != null && ledgerByAccount.get(l.accountId!)?.systemCode === SYSTEM_ACCOUNTS.AR);
    const apLines = jeLines.filter((l) => l.vendorId != null && ledgerByAccount.get(l.accountId!)?.systemCode === SYSTEM_ACCOUNTS.AP);
    for (const i of invoices) if (!arLines.some((l) => l.customerId === i.inv.customerId)) r8Problems.push(`invoice ${i.inv.invoiceNumber} has no AR line for its customer`);
    for (const l of arLines) { const sub = round2(invoices.filter((i) => i.inv.customerId === l.customerId).reduce((s, i) => s + num(i.inv.total), 0)); if (!eq(sub, num(l.debitAmount) - num(l.creditAmount))) r8Problems.push(`AR line for customer #${l.customerId}: ${fmt(num(l.debitAmount) - num(l.creditAmount))} vs items ${fmt(sub)}`); }
    for (const b of bills) if (!apLines.some((l) => l.vendorId === b.bill.vendorId)) r8Problems.push(`bill ${b.bill.billNumber} has no AP line for its vendor`);
    for (const l of apLines) { const sub = round2(bills.filter((b) => b.bill.vendorId === l.vendorId).reduce((s, b) => s + num(b.bill.total), 0)); if (!eq(sub, num(l.creditAmount) - num(l.debitAmount))) r8Problems.push(`AP line for vendor #${l.vendorId}: ${fmt(num(l.creditAmount) - num(l.debitAmount))} vs items ${fmt(sub)}`); }
    push("R8", "Every opening AR/AP item has its party line in the opening journal, and every party line has its items (both directions)", r8Problems.length === 0, `${arLines.length} AR + ${apLines.length} AP lines`, `${invoices.length} invoices + ${bills.length} bills`, r8Problems.length === 0 ? "Both directions reconcile." : r8Problems.join("; "));

    // R9: VAT balances on the ledger = the last filed return's closing position as supplied.
    const vp = batch.vatPosition as { returnReference: string; outputVatPayable: number; inputVatReceivable: number } | null;
    const vatOut = round2(-ledger.filter((l) => l.systemCode === SYSTEM_ACCOUNTS.VAT_OUTPUT).reduce((s, l) => s + l.balance, 0));
    const vatIn = round2(ledger.filter((l) => l.systemCode === SYSTEM_ACCOUNTS.VAT_INPUT).reduce((s, l) => s + l.balance, 0));
    if (!vp) push("R9", "Imported VAT balances = the last filed return's closing position (with the return reference)", eq(vatOut, 0) && eq(vatIn, 0), "0 / 0", `${fmt(vatOut)} / ${fmt(vatIn)}`, eq(vatOut, 0) && eq(vatIn, 0) ? "No VAT balance imported; no return position supplied." : "VAT balances posted without a return position.");
    else push("R9", "Imported VAT balances = the last filed return's closing position (with the return reference)", eq(vatOut, num(vp.outputVatPayable)) && eq(vatIn, num(vp.inputVatReceivable)), `output ${fmt(num(vp.outputVatPayable))} / input ${fmt(num(vp.inputVatReceivable))}`, `output ${fmt(vatOut)} / input ${fmt(vatIn)}`, `Return ${vp.returnReference}.`);

    // R10: source totals = committed totals; deposits per customer = CUSTOMER_DEPOSITS(party) lines, each with its VAT position; replay is idempotent (one journal).
    const payments = await migrationRepository.openingPayments(batch.id);
    const depLedger = await migrationRepository.ledgerPartyBalancesUpTo(SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS, batch.openingDate);
    const r10Problems: string[] = [];
    for (const d of position.depositsByCustomer) {
      const cid = customerIdOf(d.partySourceId);
      const sub = round2(payments.filter((p) => p.pay.customerId === cid).reduce((s, p) => s + num(p.pay.amount), 0));
      const gl = round2(-depLedger.filter((l) => l.customerId === cid).reduce((s, l) => s + l.balance, 0));
      if (!eq(d.total, sub) || !eq(d.total, gl)) r10Problems.push(`${d.partyName ?? d.partySourceId}: staged ${fmt(d.total)}, deposits ${fmt(sub)}, GL ${fmt(gl)}`);
    }
    if (invoices.length !== content.items.filter((i) => i.itemType === "ar").length) r10Problems.push(`invoices ${invoices.length} ≠ staged AR items ${content.items.filter((i) => i.itemType === "ar").length}`);
    if (bills.length !== content.items.filter((i) => i.itemType === "ap").length) r10Problems.push(`bills ${bills.length} ≠ staged AP items`);
    if (payments.length !== content.advances.length) r10Problems.push(`deposits ${payments.length} ≠ staged advances ${content.advances.length}`);
    for (const a of content.advances) if (a.vatPosition !== "invoiced" && a.vatPosition !== "unknown") r10Problems.push(`advance ${a.sourceId} has no VAT position`);
    const unresolvedParties = parties.filter((p) => (p.partyType === "customer" ? p.resolvedCustomerId : p.resolvedVendorId) == null).length;
    if (unresolvedParties > 0) r10Problems.push(`${unresolvedParties} party(ies) unresolved`);
    const journals = (await migrationRepository.journalEntry(journalEntryId)).length;
    if (journals !== 1) r10Problems.push("opening journal not found");
    push("R10", "Source totals = committed totals (items, deposits per customer with VAT position, parties); the opening journal is one entry", r10Problems.length === 0, `${content.items.length} items, ${content.advances.length} advances, ${parties.length} parties`, `${invoices.length + bills.length} items, ${payments.length} deposits, ${parties.length - unresolvedParties} parties`, r10Problems.length === 0 ? `Deposits ${fmt(round2(position.depositsByCustomer.reduce((s, d) => s + d.total, 0)))} over ${position.depositsByCustomer.length} customer(s); ${created.customersCreated} customer(s), ${created.vendorsCreated} vendor(s), ${created.accountsCreated} account(s) created.` : r10Problems.join("; "));

    return { at: new Date().toISOString(), journalEntryId, checks, figures: { assets, liabilities, equity, ytdIncome: income, ytdExpense: expense, ytdResult: nz(round2(income - expense)), ar: nz(arControl), ap: nz(apControl), deposits: nz(round2(-ledger.filter((l) => l.systemCode === SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS).reduce((s, l) => s + l.balance, 0))), vatOutput: nz(vatOut), vatInput: nz(vatIn), journalDebit: jeDebit, journalCredit: jeCredit } };
  },

  /** Everything the reversal would have to undo, and what blocks it — computed, nothing written. */
  async reversalPreview(batchId: number) {
    const batch = await migrationService.requireBatch(batchId);
    if (batch.status !== "committed") refuse(409, { code: "migration_not_committed", error: `Migration batch ${batchId} is ${batch.status}; only a committed migration is reversed.` });
    const [invoices, bills, payments] = await Promise.all([migrationRepository.openingInvoices(batchId), migrationRepository.openingBills(batchId), migrationRepository.openingPayments(batchId)]);
    const blockers = await migrationRepository.touchesSinceCommit(invoices.map((i) => i.inv.id), bills.map((b) => b.bill.id), payments.map((p) => p.pay.id));
    const [opening] = batch.openingJournalEntryId != null ? await migrationRepository.journalEntry(batch.openingJournalEntryId) : [];
    if (!opening) blockers.push("the opening journal is missing");
    else if (opening.status !== "posted") blockers.push(`the opening journal is ${opening.status}`);
    const period = batch.openingDate.slice(0, 7);
    const [lockNow] = await migrationRepository.periodLockByPeriod(period);
    const ownLock = lockNow != null && batch.periodLockId != null && lockNow.id === batch.periodLockId;
    if (lockNow && !ownLock) blockers.push(`${period} was closed by someone else since the migration (lock #${lockNow.id}); reopen it deliberately first`);
    const parties = await migrationRepository.parties(batchId);
    return {
      batchId,
      blockers,
      wouldReverse: {
        openingJournalEntryId: batch.openingJournalEntryId,
        invoices: invoices.map((i) => ({ id: i.inv.id, number: i.inv.invoiceNumber, customerId: i.inv.customerId, total: num(i.inv.total) })),
        bills: bills.map((b) => ({ id: b.bill.id, number: b.bill.billNumber, vendorId: b.bill.vendorId, total: num(b.bill.total) })),
        deposits: payments.map((p) => ({ id: p.pay.id, customerId: p.pay.customerId, amount: num(p.pay.amount) })),
        banks: (await migrationRepository.bankAccountsByIds([...new Set((await migrationRepository.chartRows(batchId)).filter((r) => r.decision === "map_to_bank").map((r) => r.targetBankAccountId!))])).map((b) => ({ id: b.id, name: b.name, openingBalance: num(b.openingBalance) })),
        periodLock: ownLock ? { id: lockNow!.id, period } : null,
        keeps: { customers: parties.filter((p) => p.partyType === "customer" && p.resolvedCustomerId != null).length, vendors: parties.filter((p) => p.partyType === "vendor" && p.resolvedVendorId != null).length, accountsCreated: (await migrationRepository.chartRows(batchId)).filter((r) => r.decision === "create").length },
      },
    };
  },

  async reverse(batchId: number, body: { reason?: string | null }, userId: number | null) {
    const [batch] = await migrationRepository.findBatchForUpdate(batchId);
    if (!batch) throw new NotFoundError("Migration batch not found");
    if (batch.status === "reversed") return migrationService.getBatch(batchId);
    if (batch.status !== "committed") refuse(409, { code: "migration_not_committed", error: `Migration batch ${batchId} is ${batch.status}; only a committed migration is reversed.` });
    const reason = body.reason?.trim();
    if (!reason || reason.length < 10) throw new BadRequestError("reason is required (at least 10 characters) — it is the audit record of why the opening position was withdrawn.");
    const preview = await this.reversalPreview(batchId);
    if (preview.blockers.length > 0) {
      refuse(422, { code: "migration_reversal_blocked", error: `The migration cannot be reversed while: ${preview.blockers.join("; ")}. Unwind those first, or post dated correction journals instead.` });
    }
    const [opening] = await migrationRepository.journalEntry(batch.openingJournalEntryId!);
    const lines = await migrationRepository.journalLines(opening!.id);
    const now = new Date();

    // 1. The migration's own lock comes off.
    if (preview.wouldReverse.periodLock) {
      const [lock] = await migrationRepository.periodLock(preview.wouldReverse.periodLock.id);
      await periodLocksRepository.removeByPeriod(preview.wouldReverse.periodLock.period);
      if (lock) await auditService.deleted("period_lock", lock.id, lock);
    }
    // 2. The mirror, through the seam, dated the opening date.
    const mirror = await postJournalEntry({
      entryNumber: `${opening!.entryNumber}-REV`, date: batch.openingDate, description: `Reversal of ${opening!.description} — ${reason}`, reference: `migration:${batch.id}`,
      source: "opening_reversal", migrationBatchId: batch.id, reversalOf: opening!.id,
      lines: lines.map((l) => ({
        accountId: l.accountId!, accountName: l.accountName, debitAmount: num(l.creditAmount), creditAmount: num(l.debitAmount), description: l.description ?? undefined,
        party: l.customerId != null ? { type: "customer" as const, customerId: l.customerId } : l.vendorId != null ? { type: "vendor" as const, vendorId: l.vendorId } : undefined,
      })),
    });
    await migrationRepository.markJournalReversed(opening!.id);
    // 3. 🔴 Policy C: MARK the opening subledger rows — nothing is deleted, no
    //    staging link is cleared. Invoices/bills take the marker pair (the DB
    //    trigger admits it once, from this batch, on opening rows, then
    //    freezes the row); each deposit gets its superseding reversal record.
    const reversedInvoices = await migrationRepository.markInvoicesReversed(preview.wouldReverse.invoices.map((i) => i.id), batch.id, now);
    const reversedBills = await migrationRepository.markBillsReversed(preview.wouldReverse.bills.map((b) => b.id), batch.id, now);
    const reversedDeposits = await migrationRepository.insertDepositReversals(preview.wouldReverse.deposits.map((d) => ({ paymentId: d.id, batchId: batch.id, reversalJournalEntryId: mirror.id, reason, createdBy: userId })));
    if (reversedInvoices.length !== preview.wouldReverse.invoices.length || reversedBills.length !== preview.wouldReverse.bills.length || reversedDeposits.length !== preview.wouldReverse.deposits.length) {
      // A row the preview listed that the mark did not reach: never a partial reversal — the request rolls back.
      refuse(409, { code: "migration_reversal_incomplete", error: `The reversal marked ${reversedInvoices.length}/${preview.wouldReverse.invoices.length} invoices, ${reversedBills.length}/${preview.wouldReverse.bills.length} bills and ${reversedDeposits.length}/${preview.wouldReverse.deposits.length} deposits. Nothing was reversed.` });
    }
    // 4. Banks: display-only again.
    for (const b of preview.wouldReverse.banks) await migrationRepository.updateBankAccount(b.id, { openingJournalEntryId: null });
    // 5. Reversed.
    const [updated] = await migrationRepository.updateBatch(batch.id, { status: "reversed", reversalJournalEntryId: mirror.id, reversedBy: userId, reversedAt: now, reversalReason: reason, periodLockId: null });
    await auditService.record({
      action: "migration_batch_reverse", entityType: "migration_batch", entityId: batch.id,
      before: { status: "committed", openingJournalEntryId: opening!.id, periodLockId: batch.periodLockId },
      after: { reversalJournalEntryId: mirror.id, reason, reversed: { invoices: preview.wouldReverse.invoices, bills: preview.wouldReverse.bills, deposits: preview.wouldReverse.deposits }, banksUnlinked: preview.wouldReverse.banks.map((b) => b.id), kept: preview.wouldReverse.keeps, by: userId },
    });
    return { ...toBatchOut(updated), reversalJournalEntryId: mirror.id, reversed: { invoices: reversedInvoices.length, bills: reversedBills.length, deposits: reversedDeposits.length } };
  },
};
