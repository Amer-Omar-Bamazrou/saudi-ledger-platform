/**
 * D-3 / G3 — THE PER-BANK CASH CUT-OVER, annotation model (2026-09-17).
 *
 * Decision record: docs/product/accounting-architecture-decision-pack.md §D-3;
 * as-built: docs/product/design-per-bank-cash.md.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * Since migration 0073 every bank account has its own GL cash account and
 * "Cash and Bank" (`CASH`) is a non-posting header. Every cash line posted
 * BEFORE that sits on the header and belongs to no bank. This service
 * ANNOTATES that history — one `cash_line_bank_attributions` row per line
 * naming the bank its source evidence establishes — per COMPANY, in two
 * phases:
 *
 *   dry-run  classify every header line that has no attribution yet; write
 *            NOTHING to the books; return the full report with every blocking
 *            record's remediation. (The caller may store the report as a run
 *            record — that is evidence, not accounting state.)
 *   commit   under a company-level transactional lock, re-classify, refuse
 *            unless every unattributed line is DETERMINISTIC, insert the
 *            attributions, assert that not one journal line changed and that
 *            no unattributed line remains, and record the run. Any failure
 *            rolls the whole company back.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * It never rewrites a posted line: `journal_entry_lines` is read, never
 * written (a checksum over id, entry, ACCOUNT, name and money is asserted
 * unchanged across the commit). History keeps its posted account; the bank
 * is carried beside it, and per-bank readers resolve both through the one
 * view `journal_line_bank_identity`.
 *
 * It never guesses. A line is attributed only when its BANK IDENTITY is
 * established by source evidence — an explicit bank on the transaction it
 * came from, a settlement row paired ONE-TO-ONE with the payment record
 * (services/accounting/evidencePairing.ts), the payment record's own bank,
 * or a mirror of a line so established. The accountant rejected "the company
 * had exactly one bank account" as evidence and so does this file: the number
 * of bank accounts is listed for the reviewer and never consulted to decide.
 * Amount, date and description alone establish nothing. No default bank, no
 * "Other Bank", no partial commit.
 *
 * ── Idempotency and concurrency ─────────────────────────────────────────────
 * Per LINE, not per company: `line_id` is unique on the attribution table,
 * the commit only ever considers unattributed lines, and a clean rerun
 * finds nothing to do and says so. A reversal mirror created after a
 * company's cut-over is not stranded: the reversal path copies the
 * original's attribution onto the mirror (journalEntries.service), and if
 * one ever slips through, the next run attributes it by A3. Two concurrent
 * commits serialise on `pg_advisory_xact_lock(company)`; the second sees the
 * first's attributions and has nothing to do.
 */
import { db, categoriesTable, journalEntriesTable, journalEntryLinesTable, transactionsTable, invoicePaymentsTable, billPaymentsTable, invoicesTable, billsTable, bankAccountsTable, cashCutoverRunsTable, cashLineBankAttributionsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { JE_IN_BOOKS } from "../../repositories/reports.repository";
import { auditService } from "../audit.service";
import { round2 } from "../../lib/money";
import { pairOneToOne } from "./evidencePairing";

export type CutoverClassification = "DETERMINISTIC" | "AMBIGUOUS_REQUIRES_REVIEW" | "UNMAPPABLE" | "INCONSISTENT";

/** The rule that established a DETERMINISTIC bank — stored on every attribution. */
export type CutoverRule =
  | "A0_payment_record_bank"   // invoice_payments / bill_payments.bank_account_id (post-0073 payments)
  | "A1_transaction_link"      // transactions.journal_entry_id → the row's bank_account_id
  | "A1_transaction_number"    // entry number TXN-<id>[-P<n>] → the row's bank_account_id
  | "A2_settlement_pairing"    // ONE settlement row paired one-to-one with ONE payment record (evidencePairing.ts)
  | "A3_mirror_of_attributed"; // a reversal mirror of a line attributed (or attributable) by A0–A2

/** One classified header line — every field the reviewer needs, blocking or not. */
export interface ClassifiedLine {
  lineId: number;
  journalEntryId: number;
  entryNumber: string;
  entryStatus: string;
  date: string;
  debit: number;
  credit: number;
  currentAccountId: number;
  currentAccountName: string;
  sourceKind: "transaction" | "invoice_payment" | "bill_payment" | "reversal" | "manual" | "unknown";
  transactionId: number | null;
  paymentId: number | null;
  invoiceId: number | null;
  billId: number | null;
  /** The bank the source names, if any. */
  knownBankAccountId: number | null;
  /** Banks RECORDED on the platform by the line's date — listed for the reviewer, never used to decide. */
  candidateBankAccountIds: number[];
  classification: CutoverClassification;
  rule: CutoverRule | null;
  /** The bank's own GL leaf the line is attributed to (reporting identity). Its posted account never changes. */
  targetGlAccountId: number | null;
  reason: string;
  requiredRemediation: string | null;
}

export interface CutoverReport {
  companyId: string;
  headerAccountId: number;
  /** Header lines ALREADY attributed by an earlier run (or by the reversal path). */
  attributedBefore: number;
  /** The unattributed header lines, classified. */
  lines: ClassifiedLine[];
  counts: Record<CutoverClassification, number>;
  cashBefore: number;
  /** Planned per-bank attribution — provisional while any line blocks. */
  plan: Array<{ bankAccountId: number; glAccountId: number; glAccountName: string; lines: number; net: number }>;
  blocked: boolean;
  blockingCount: number;
}

export interface CutoverCommitResult extends CutoverReport {
  runId: number | null;
  attributed: number;
  cashAfter: number;
  /** `committed` when lines were attributed; `nothing_to_do` when every header line already was. */
  state: "committed" | "nothing_to_do";
}

const TXN_NUMBER = /^TXN-(\d+)(?:-P\d+)?$/;
const INV_PAY_NUMBER = /^GL-(.+)-PAY-(\d+)$/;
const INV_PAY_LEGACY = /^GL-(.+)-PAY$/;
const BILL_PAY_NUMBER = /^BILL-(.+)-PAY-(\d+)$/;
const BILL_PAY_LEGACY = /^BILL-(.+)-PAY$/;

const OVERRIDE_PENDING =
  "No override mechanism exists yet: what an override must cite is an open accountant decision " +
  "(decision pack D-3 §13). This line stays unattributed until that decision is taken.";

type HeaderLine = {
  lineId: number;
  journalEntryId: number;
  entryNumber: string;
  entryStatus: string;
  reversalOf: number | null;
  reference: string | null;
  date: string;
  debit: string;
  credit: string;
  accountId: number;
  accountName: string;
};
type PaymentRecord = { id: number; docId: number; amount: string; paidAt: string; bankAccountId: number | null };
type Attribution = typeof cashLineBankAttributionsTable.$inferSelect;

async function headerAccount(): Promise<{ id: number; name: string }> {
  const [row] = await db
    .select({ id: categoriesTable.id, name: categoriesTable.name })
    .from(categoriesTable)
    .where(eq(categoriesTable.systemCode, "CASH"))
    .limit(1);
  if (!row) throw new Error("This organization has no CASH header account — the system chart is not seeded.");
  return row;
}

/** Every line on the header for the scoped company (RLS confines the company), any entry status. */
async function headerLines(headerId: number): Promise<HeaderLine[]> {
  return db
    .select({
      lineId: journalEntryLinesTable.id,
      journalEntryId: journalEntryLinesTable.journalEntryId,
      entryNumber: journalEntriesTable.entryNumber,
      entryStatus: journalEntriesTable.status,
      reversalOf: journalEntriesTable.reversalOf,
      reference: journalEntriesTable.reference,
      date: journalEntriesTable.date,
      debit: journalEntryLinesTable.debitAmount,
      credit: journalEntryLinesTable.creditAmount,
      accountId: journalEntryLinesTable.accountId,
      accountName: journalEntryLinesTable.accountName,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId))
    .where(eq(journalEntryLinesTable.accountId, headerId))
    .orderBy(journalEntriesTable.date, journalEntryLinesTable.id) as Promise<HeaderLine[]>;
}

async function attributionsFor(lineIds: number[]): Promise<Map<number, Attribution>> {
  if (lineIds.length === 0) return new Map();
  const rows = await db.select().from(cashLineBankAttributionsTable).where(inArray(cashLineBankAttributionsTable.lineId, lineIds));
  return new Map(rows.map((r) => [r.lineId, r]));
}

/** Σ Dr − Cr on cash-classified accounts, in-books entries, for the scoped company. */
async function cashPosition(): Promise<number> {
  const [row] = await db
    .select({ net: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount} - ${journalEntryLinesTable.creditAmount}), 0)::text` })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId))
    .innerJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
    .where(and(inArray(journalEntriesTable.status, JE_IN_BOOKS), eq(categoriesTable.liquidityClass, "cash")));
  return round2(Number(row?.net ?? 0));
}

/**
 * A checksum over EVERY column of every line that could express accounting
 * identity — id, entry, account, label, money. Asserted equal across the
 * commit: the annotation model changes no journal line, and this is the
 * proof rather than the promise.
 */
async function lineChecksum(): Promise<{ count: number; digest: string }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      digest: sql<string>`md5(coalesce(string_agg(${journalEntryLinesTable.id}::text || ':' || ${journalEntryLinesTable.journalEntryId}::text || ':' || coalesce(${journalEntryLinesTable.accountId}::text, '') || ':' || ${journalEntryLinesTable.accountName} || ':' || ${journalEntryLinesTable.debitAmount}::text || ':' || ${journalEntryLinesTable.creditAmount}::text, ',' ORDER BY ${journalEntryLinesTable.id}), ''))`,
    })
    .from(journalEntryLinesTable);
  return { count: row?.count ?? 0, digest: row?.digest ?? "" };
}

/**
 * Classify every UNATTRIBUTED header line of the scoped company. Attributed
 * lines are loaded too — a mirror resolves through its original — but are
 * not reported. Pure read: no write of any kind happens here.
 */
async function classify(headerId: number, headerName: string): Promise<{ lines: ClassifiedLine[]; attributedBefore: number }> {
  const all = await headerLines(headerId);
  if (all.length === 0) return { lines: [], attributedBefore: 0 };
  const attributions = await attributionsFor(all.map((l) => l.lineId));
  const pending = all.filter((l) => !attributions.has(l.lineId));
  if (pending.length === 0) return { lines: [], attributedBefore: attributions.size };

  const banks = await db.select({ id: bankAccountsTable.id, createdAt: bankAccountsTable.createdAt }).from(bankAccountsTable);
  const leaves = await db
    .select({ id: categoriesTable.id, name: categoriesTable.name, bankAccountId: categoriesTable.bankAccountId })
    .from(categoriesTable)
    .where(isNotNull(categoriesTable.bankAccountId));
  const leafByBank = new Map(leaves.map((l) => [l.bankAccountId as number, l]));
  const candidatesOn = (date: string) =>
    banks.filter((b) => b.createdAt.toISOString().slice(0, 10) <= date).map((b) => b.id).sort((a, b) => a - b);

  // ── Source records, fetched once for the pending lines ───────────────────
  const entryIds = [...new Set(pending.map((l) => l.journalEntryId))];
  const txByEntry = new Map<number, typeof transactionsTable.$inferSelect>();
  for (const t of await db.select().from(transactionsTable).where(inArray(transactionsTable.journalEntryId, entryIds))) {
    if (t.journalEntryId != null) txByEntry.set(t.journalEntryId, t);
  }
  const txIdsNamed = pending.map((l) => l.entryNumber.match(TXN_NUMBER)?.[1]).filter((x): x is string => !!x).map(Number);
  const txById = new Map<number, typeof transactionsTable.$inferSelect>();
  if (txIdsNamed.length > 0) {
    for (const t of await db.select().from(transactionsTable).where(inArray(transactionsTable.id, [...new Set(txIdsNamed)]))) txById.set(t.id, t);
  }
  const invPayIds = pending.map((l) => l.entryNumber.match(INV_PAY_NUMBER)?.[2]).filter((x): x is string => !!x).map(Number);
  const invPayById = new Map<number, PaymentRecord>();
  if (invPayIds.length > 0) {
    for (const p of await db.select().from(invoicePaymentsTable).where(inArray(invoicePaymentsTable.id, [...new Set(invPayIds)]))) {
      invPayById.set(p.id, { id: p.id, docId: p.invoiceId, amount: p.amount, paidAt: String(p.paidAt), bankAccountId: p.bankAccountId });
    }
  }
  const billPayIds = pending.map((l) => l.entryNumber.match(BILL_PAY_NUMBER)?.[2]).filter((x): x is string => !!x).map(Number);
  const billPayById = new Map<number, PaymentRecord>();
  if (billPayIds.length > 0) {
    for (const p of await db.select().from(billPaymentsTable).where(inArray(billPaymentsTable.id, [...new Set(billPayIds)]))) {
      billPayById.set(p.id, { id: p.id, docId: p.billId, amount: p.amount, paidAt: String(p.paidAt), bankAccountId: p.bankAccountId });
    }
  }
  // Pre-N3 (legacy) payment entries name the document, not the payment row.
  const legacyInvNumbers = pending.map((l) => l.entryNumber.match(INV_PAY_LEGACY)?.[1]).filter((x): x is string => !!x);
  const legacyBillNumbers = pending.map((l) => l.entryNumber.match(BILL_PAY_LEGACY)?.[1]).filter((x): x is string => !!x);
  const invoiceByNumber = new Map<string, number>();
  if (legacyInvNumbers.length > 0) {
    for (const i of await db.select({ id: invoicesTable.id, n: invoicesTable.invoiceNumber }).from(invoicesTable).where(inArray(invoicesTable.invoiceNumber, [...new Set(legacyInvNumbers)]))) invoiceByNumber.set(i.n, i.id);
  }
  const billByNumber = new Map<string, number>();
  if (legacyBillNumbers.length > 0) {
    for (const b of await db.select({ id: billsTable.id, n: billsTable.billNumber }).from(billsTable).where(inArray(billsTable.billNumber, [...new Set(legacyBillNumbers)]))) {
      if (b.n) billByNumber.set(b.n, b.id);
    }
  }

  // ── Per document: ALL its payment records and ALL its settlement rows ────
  // The pairing considers every payment record of the document — including
  // ones already attributed or posted to a leaf — because a settlement row
  // that stands for one of THOSE must not be free to stand for a header-era
  // record with the same date and amount.
  const docPaymentsCache = new Map<string, PaymentRecord[]>();
  const docSettlementsCache = new Map<string, Array<typeof transactionsTable.$inferSelect>>();
  const paymentsOf = async (isInvoice: boolean, docId: number): Promise<PaymentRecord[]> => {
    const k = `${isInvoice ? "i" : "b"}:${docId}`;
    if (!docPaymentsCache.has(k)) {
      const rows = isInvoice
        ? (await db.select().from(invoicePaymentsTable).where(eq(invoicePaymentsTable.invoiceId, docId))).map((p) => ({ id: p.id, docId: p.invoiceId, amount: p.amount, paidAt: String(p.paidAt), bankAccountId: p.bankAccountId }))
        : (await db.select().from(billPaymentsTable).where(eq(billPaymentsTable.billId, docId))).map((p) => ({ id: p.id, docId: p.billId, amount: p.amount, paidAt: String(p.paidAt), bankAccountId: p.bankAccountId }));
      docPaymentsCache.set(k, rows);
    }
    return docPaymentsCache.get(k)!;
  };
  const settlementsOf = async (isInvoice: boolean, docId: number) => {
    const k = `${isInvoice ? "i" : "b"}:${docId}`;
    if (!docSettlementsCache.has(k)) {
      docSettlementsCache.set(
        k,
        await db
          .select()
          .from(transactionsTable)
          .where(and(eq(transactionsTable.kind, "settlement"), isNotNull(transactionsTable.bankAccountId), isInvoice ? eq(transactionsTable.settlesInvoiceId, docId) : eq(transactionsTable.settlesBillId, docId))),
      );
    }
    return docSettlementsCache.get(k)!;
  };
  /** A2: the one-to-one pairing of a document's payment records with its settlement rows, keyed by date|amount. */
  const pairingOf = async (isInvoice: boolean, docId: number) => {
    const records = await paymentsOf(isInvoice, docId);
    const evidence = await settlementsOf(isInvoice, docId);
    return pairOneToOne(records, evidence, {
      recordId: (p) => p.id,
      recordKey: (p) => `${p.paidAt}|${round2(Number(p.amount)).toFixed(2)}`,
      evidenceKey: (t) => `${t.date}|${round2(Number(t.amount)).toFixed(2)}`,
      describe: (t) => `settlement ${t.id} via bank ${t.bankAccountId}`,
    });
  };

  const byEntryId = new Map<number, HeaderLine[]>();
  for (const l of all) byEntryId.set(l.journalEntryId, [...(byEntryId.get(l.journalEntryId) ?? []), l]);
  const memo = new Map<number, ClassifiedLine>();

  const base = (l: HeaderLine): Omit<ClassifiedLine, "sourceKind" | "classification" | "rule" | "targetGlAccountId" | "reason" | "requiredRemediation"> => ({
    lineId: l.lineId,
    journalEntryId: l.journalEntryId,
    entryNumber: l.entryNumber,
    entryStatus: l.entryStatus,
    date: l.date,
    debit: Number(l.debit),
    credit: Number(l.credit),
    currentAccountId: l.accountId,
    currentAccountName: l.accountName,
    transactionId: null,
    paymentId: null,
    invoiceId: null,
    billId: null,
    knownBankAccountId: null,
    candidateBankAccountIds: candidatesOn(l.date),
  });
  const resolved = (l: HeaderLine, partial: Partial<ClassifiedLine>, bankAccountId: number, rule: CutoverRule, reason: string): ClassifiedLine => {
    const leaf = leafByBank.get(bankAccountId);
    if (!leaf) {
      return {
        ...base(l), sourceKind: partial.sourceKind ?? "unknown", ...partial, knownBankAccountId: bankAccountId,
        classification: "INCONSISTENT", rule: null, targetGlAccountId: null,
        reason: `${reason} — but bank account ${bankAccountId} has no GL account in this organization (it may belong to another tenant or have been deleted).`,
        requiredRemediation: "Restore the bank account's GL account (migration 0073 creates one for every bank account) and re-run the dry-run.",
      };
    }
    return { ...base(l), sourceKind: partial.sourceKind ?? "unknown", ...partial, knownBankAccountId: bankAccountId, classification: "DETERMINISTIC", rule, targetGlAccountId: leaf.id, reason, requiredRemediation: null };
  };
  const blocked = (l: HeaderLine, partial: Partial<ClassifiedLine>, classification: Exclude<CutoverClassification, "DETERMINISTIC">, reason: string, remediation: string): ClassifiedLine => ({
    ...base(l), sourceKind: partial.sourceKind ?? "unknown", ...partial, classification, rule: null, targetGlAccountId: null, reason, requiredRemediation: remediation,
  });
  const amountOf = (l: HeaderLine) => round2(Math.abs(Number(l.debit) - Number(l.credit)));

  async function classifyOne(l: HeaderLine, depth = 0): Promise<ClassifiedLine> {
    const cached = memo.get(l.lineId);
    if (cached) return cached;
    const out = await classifyInner(l, depth);
    memo.set(l.lineId, out);
    return out;
  }

  async function classifyInner(l: HeaderLine, depth: number): Promise<ClassifiedLine> {
    // ── A3: a reversal mirror follows the line it cancels ──────────────────
    if (l.reversalOf != null) {
      const originals = byEntryId.get(l.reversalOf);
      const mirrorOf = originals?.find((o) => round2(Number(o.debit)) === round2(Number(l.credit)) && round2(Number(o.credit)) === round2(Number(l.debit)));
      if (!mirrorOf) {
        const [orig] = await db.select({ id: journalEntriesTable.id }).from(journalEntriesTable).where(eq(journalEntriesTable.id, l.reversalOf)).limit(1);
        return blocked(l, { sourceKind: "reversal" }, "INCONSISTENT",
          orig
            ? `Entry ${l.entryNumber} reverses entry ${l.reversalOf}, but that entry has no matching cash line on ${headerName} to mirror.`
            : `Entry ${l.entryNumber} reverses entry ${l.reversalOf}, which does not exist.`,
          "Investigate the reversal pair; the ledger's evidence for this mirror is broken and no bank can be established.");
      }
      // The original may already carry an attribution (an earlier run, or the
      // reversal path copied one) — that IS its bank identity.
      const attr = attributions.get(mirrorOf.lineId);
      if (attr) {
        return resolved(l, { sourceKind: "reversal" }, attr.bankAccountId, "A3_mirror_of_attributed",
          `Mirror of line ${mirrorOf.lineId} (${mirrorOf.entryNumber}), attributed to bank ${attr.bankAccountId} by ${attr.rule}.`);
      }
      if (depth > 8) {
        return blocked(l, { sourceKind: "reversal" }, "INCONSISTENT", `Entry ${l.entryNumber} sits in a reversal chain deeper than 8 — refusing to follow it.`, "Investigate the reversal chain.");
      }
      const of = await classifyOne(mirrorOf, depth + 1);
      if (of.classification === "DETERMINISTIC" && of.knownBankAccountId != null) {
        return resolved(l, { sourceKind: "reversal", transactionId: of.transactionId, paymentId: of.paymentId, invoiceId: of.invoiceId, billId: of.billId }, of.knownBankAccountId, "A3_mirror_of_attributed",
          `Mirror of line ${of.lineId} (${of.entryNumber}), whose bank is established by ${of.rule}.`);
      }
      return blocked(l, { sourceKind: "reversal", transactionId: of.transactionId, paymentId: of.paymentId, invoiceId: of.invoiceId, billId: of.billId }, of.classification === "DETERMINISTIC" ? "INCONSISTENT" : of.classification,
        `Mirror of line ${of.lineId} (${of.entryNumber}), which is ${of.classification}: ${of.reason}`,
        of.requiredRemediation ?? "Resolve the original line first; the mirror follows it.");
    }

    // ── A1: a transaction — by explicit link, then by entry number ─────────
    const linked = txByEntry.get(l.journalEntryId);
    const named = l.entryNumber.match(TXN_NUMBER);
    const namedId = named ? Number(named[1]) : null;
    if (linked || namedId != null) {
      const tx = linked ?? (namedId != null ? txById.get(namedId) : undefined);
      const via: CutoverRule = linked ? "A1_transaction_link" : "A1_transaction_number";
      if (!tx) {
        if (l.entryStatus === "reversed") {
          return blocked(l, { sourceKind: "transaction", transactionId: namedId }, "UNMAPPABLE",
            `Entry ${l.entryNumber} was posted from transaction ${namedId}, which has since been deleted (the entry is reversed). No source record can name its bank.`,
            OVERRIDE_PENDING);
        }
        return blocked(l, { sourceKind: "transaction", transactionId: namedId }, "INCONSISTENT",
          `Entry ${l.entryNumber} names transaction ${namedId}, which does not exist, yet the entry is still ${l.entryStatus}.`,
          "Investigate: a posted transaction entry with no transaction row. Restore the row or reverse the entry.");
      }
      if (round2(Number(tx.amount)) !== amountOf(l)) {
        return blocked(l, { sourceKind: "transaction", transactionId: tx.id, knownBankAccountId: tx.bankAccountId ?? null }, "INCONSISTENT",
          `Entry ${l.entryNumber} posts ${amountOf(l).toFixed(2)} but transaction ${tx.id} carries ${Number(tx.amount).toFixed(2)}.`,
          "Investigate the amount mismatch between the transaction and its entry before any bank is assigned.");
      }
      if (tx.bankAccountId == null) {
        return blocked(l, { sourceKind: "transaction", transactionId: tx.id }, "AMBIGUOUS_REQUIRES_REVIEW",
          `Transaction ${tx.id} ("${tx.description.slice(0, 60)}") names no bank account. The number of bank accounts the company had on ${l.date} is not evidence of which one this movement went through.`,
          `Set the bank account on transaction ${tx.id} (PATCH /transactions/${tx.id} { bankAccountId }) through the product, then re-run the dry-run.`);
      }
      return resolved(l, { sourceKind: "transaction", transactionId: tx.id }, tx.bankAccountId, via,
        linked ? `Transaction ${tx.id} links to this entry and names bank account ${tx.bankAccountId}.` : `Entry ${l.entryNumber} names transaction ${tx.id}, which names bank account ${tx.bankAccountId}.`);
    }

    // ── A0 / A2: a document payment ─────────────────────────────────────────
    const invPay = l.entryNumber.match(INV_PAY_NUMBER);
    const billPay = l.entryNumber.match(BILL_PAY_NUMBER);
    const invLegacy = l.entryNumber.match(INV_PAY_LEGACY);
    const billLegacy = l.entryNumber.match(BILL_PAY_LEGACY);
    if (invPay || billPay || invLegacy || billLegacy) {
      const isInvoice = !!(invPay || invLegacy);
      const sourceKind = isInvoice ? "invoice_payment" : "bill_payment";
      let payment: PaymentRecord | null = null;
      let docId: number | null = null;
      if (invPay || billPay) {
        const pid = Number((invPay ?? billPay)![2]);
        const p = (isInvoice ? invPayById : billPayById).get(pid);
        if (!p) return blocked(l, { sourceKind, paymentId: pid }, "INCONSISTENT", `Entry ${l.entryNumber} names ${isInvoice ? "invoice" : "bill"} payment ${pid}, which does not exist.`, "Investigate: a payment entry with no payment record. The record is append-only, so its absence is a data fault.");
        payment = p;
        docId = p.docId;
      } else {
        // Legacy (pre-N3): the entry names the DOCUMENT. The payment record it
        // stands for is the one record of the document with this entry's
        // amount — the document is the identity, the amount only partitions
        // that document's own records; two records of the amount → ambiguous.
        const number = (invLegacy ?? billLegacy)![1];
        docId = isInvoice ? (invoiceByNumber.get(number) ?? null) : (billByNumber.get(number) ?? null);
        if (docId == null) return blocked(l, { sourceKind }, "INCONSISTENT", `Entry ${l.entryNumber} names ${isInvoice ? "invoice" : "bill"} ${number}, which does not exist.`, "Investigate: a payment entry for a document that no longer exists.");
        const rows = await paymentsOf(isInvoice, docId);
        const matching = rows.filter((r) => round2(Number(r.amount)) === amountOf(l));
        if (matching.length !== 1) {
          return blocked(l, { sourceKind, invoiceId: isInvoice ? docId : null, billId: isInvoice ? null : docId }, "AMBIGUOUS_REQUIRES_REVIEW",
            `Entry ${l.entryNumber} predates per-payment numbering; ${matching.length} payment record(s) of ${amountOf(l).toFixed(2)} exist for the document, so the entry cannot be tied to one payment.`,
            OVERRIDE_PENDING);
        }
        payment = matching[0]!;
      }
      const partial: Partial<ClassifiedLine> = { sourceKind, paymentId: payment.id, invoiceId: isInvoice ? docId : null, billId: isInvoice ? null : docId };
      if (round2(Number(payment.amount)) !== amountOf(l)) {
        return blocked(l, partial, "INCONSISTENT", `Entry ${l.entryNumber} posts ${amountOf(l).toFixed(2)} but payment ${payment.id} records ${Number(payment.amount).toFixed(2)}.`, "Investigate the amount mismatch between the payment record and its entry.");
      }
      // A0: the payment record names its bank (every payment since 0073 does).
      if (payment.bankAccountId != null) {
        return resolved(l, partial, payment.bankAccountId, "A0_payment_record_bank", `Payment ${payment.id} records bank account ${payment.bankAccountId}.`);
      }
      // A2: ONE settlement row paired one-to-one with THIS payment record.
      const pairing = await pairingOf(isInvoice, docId!);
      const settlement = pairing.paired.get(payment.id);
      if (settlement) {
        return resolved(l, { ...partial, transactionId: settlement.id }, settlement.bankAccountId!, "A2_settlement_pairing",
          `Settlement transaction ${settlement.id} names ${isInvoice ? "invoice" : "bill"} ${docId} and bank account ${settlement.bankAccountId}, and is the only settlement row for this payment's date and amount (${settlement.date}, ${Number(settlement.amount).toFixed(2)}).`);
      }
      const why = pairing.ambiguous.get(payment.id);
      if (why) {
        return blocked(l, partial, "AMBIGUOUS_REQUIRES_REVIEW", `Payment ${payment.id}: ${why}.`, OVERRIDE_PENDING);
      }
      const others = await settlementsOf(isInvoice, docId!);
      return blocked(l, partial, "AMBIGUOUS_REQUIRES_REVIEW",
        `Payment ${payment.id} was recorded without a bank (Mark Paid) and no settlement row names ${isInvoice ? "invoice" : "bill"} ${docId} with this payment's date and amount${others.length > 0 ? ` (${others.length} settlement row(s) exist for the document but disagree on date or amount)` : ""}. The number of bank accounts the company had on ${l.date} is not evidence.`,
        OVERRIDE_PENDING);
    }

    // ── Anything else: a manual entry, or a shape this migration does not know ─
    const manual = /^JE-/i.test(l.entryNumber) || /^E2E-/i.test(l.entryNumber);
    return blocked(l, { sourceKind: manual ? "manual" : "unknown" }, "AMBIGUOUS_REQUIRES_REVIEW",
      manual
        ? `Entry ${l.entryNumber} is a manual journal entry; its cash line names no bank account.`
        : `Entry ${l.entryNumber} (reference ${l.reference ?? "—"}) has no recognisable source: no transaction links to it and its number matches no posting path's shape.`,
      OVERRIDE_PENDING);
  }

  const out: ClassifiedLine[] = [];
  for (const l of pending) out.push(await classifyOne(l));
  return { lines: out, attributedBefore: attributions.size };
}

function summarise(companyId: string, headerId: number, attributedBefore: number, lines: ClassifiedLine[], cashBefore: number, leafNames: Map<number, { id: number; name: string }>): CutoverReport {
  const counts: Record<CutoverClassification, number> = { DETERMINISTIC: 0, AMBIGUOUS_REQUIRES_REVIEW: 0, UNMAPPABLE: 0, INCONSISTENT: 0 };
  const planByBank = new Map<number, { bankAccountId: number; glAccountId: number; glAccountName: string; lines: number; net: number }>();
  for (const l of lines) {
    counts[l.classification]++;
    if (l.classification === "DETERMINISTIC" && l.knownBankAccountId != null && l.targetGlAccountId != null) {
      const leaf = leafNames.get(l.knownBankAccountId);
      const cur = planByBank.get(l.knownBankAccountId) ?? { bankAccountId: l.knownBankAccountId, glAccountId: l.targetGlAccountId, glAccountName: leaf?.name ?? "", lines: 0, net: 0 };
      cur.lines++;
      cur.net = round2(cur.net + l.debit - l.credit);
      planByBank.set(l.knownBankAccountId, cur);
    }
  }
  const blockingCount = lines.length - counts.DETERMINISTIC;
  return { companyId, headerAccountId: headerId, attributedBefore, lines, counts, cashBefore, plan: [...planByBank.values()].sort((a, b) => a.bankAccountId - b.bankAccountId), blocked: blockingCount > 0, blockingCount };
}

async function leafNames(): Promise<Map<number, { id: number; name: string }>> {
  const rows = await db
    .select({ id: categoriesTable.id, name: categoriesTable.name, bankAccountId: categoriesTable.bankAccountId })
    .from(categoriesTable)
    .where(isNotNull(categoriesTable.bankAccountId));
  return new Map(rows.map((r) => [r.bankAccountId as number, { id: r.id, name: r.name }]));
}

function currentCompanyId(): Promise<string> {
  return db.execute<{ c: string }>(sql`SELECT current_setting('app.current_company_id', true) AS c`).then((r) => {
    const c = ((r as unknown as { rows: { c: string }[] }).rows ?? [])[0]?.c ?? "";
    if (!c) throw new Error("The cash cut-over runs per COMPANY: open the tenant connection with a companyId.");
    return c;
  });
}

export class CashCutoverBlockedError extends Error {
  readonly statusCode = 409;
  constructor(public readonly report: CutoverReport) {
    super(
      `Cash cut-over refused: ${report.blockingCount} of ${report.lines.length} unattributed cash line(s) cannot be attributed to a bank ` +
        `(AMBIGUOUS_REQUIRES_REVIEW ${report.counts.AMBIGUOUS_REQUIRES_REVIEW}, UNMAPPABLE ${report.counts.UNMAPPABLE}, INCONSISTENT ${report.counts.INCONSISTENT}). ` +
        "Nothing was changed. Remediate the listed records and run the dry-run again.",
    );
    this.name = "CashCutoverBlockedError";
  }
}

export const cashCutoverService = {
  /**
   * Phase 1 — classify the unattributed header lines, write nothing to the
   * books. `record` stores the report as a `cash_cutover_runs` row (evidence
   * of the run); the accounting tables are never touched either way.
   */
  async dryRun(opts: { record?: boolean; userId?: number | null } = {}): Promise<CutoverReport> {
    const companyId = await currentCompanyId();
    const header = await headerAccount();
    const { lines, attributedBefore } = await classify(header.id, header.name);
    const cashBefore = await cashPosition();
    const report = summarise(companyId, header.id, attributedBefore, lines, cashBefore, await leafNames());
    if (opts.record) {
      await db.insert(cashCutoverRunsTable).values({
        mode: "dry_run",
        state: lines.length === 0 ? "nothing_to_do" : report.blocked ? "blocked" : "clean",
        counts: report.counts,
        report: { attributedBefore, lines: report.lines, plan: report.plan },
        cashBefore: cashBefore.toFixed(2),
        cashAfter: cashBefore.toFixed(2),
        createdBy: opts.userId ?? null,
      });
    }
    return report;
  },

  /**
   * Phase 2 — the attribution. Runs inside the caller's tenant transaction;
   * every refusal throws BEFORE any write, every invariant failure throws
   * AFTER the writes, and the caller's rollback undoes them.
   */
  async commit(opts: { userId?: number | null } = {}): Promise<CutoverCommitResult> {
    const companyId = await currentCompanyId();
    // Serialise cut-overs of one company: a second concurrent commit waits,
    // then finds the first's attributions and has nothing to do. The lock is
    // transaction-scoped, so a rollback releases it with everything else.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"cash-cutover:" + companyId}))`);
    const header = await headerAccount();

    const { lines, attributedBefore } = await classify(header.id, header.name);
    const cashBefore = await cashPosition();
    const checksumBefore = await lineChecksum();
    const leaves = await leafNames();
    const report = summarise(companyId, header.id, attributedBefore, lines, cashBefore, leaves);
    if (lines.length === 0) {
      return { ...report, runId: null, attributed: 0, cashAfter: cashBefore, state: "nothing_to_do" };
    }
    if (report.blocked) throw new CashCutoverBlockedError(report);

    // ── Evidence first: the run, then one attribution per line ──────────────
    const [run] = await db
      .insert(cashCutoverRunsTable)
      .values({
        mode: "commit",
        state: "committed",
        counts: report.counts,
        report: { attributedBefore, lines: report.lines, plan: report.plan },
        cashBefore: cashBefore.toFixed(2),
        cashAfter: cashBefore.toFixed(2),
        createdBy: opts.userId ?? null,
      })
      .returning({ id: cashCutoverRunsTable.id });
    const inserted = await db
      .insert(cashLineBankAttributionsTable)
      .values(
        lines.map((l) => ({
          runId: run.id,
          lineId: l.lineId,
          journalEntryId: l.journalEntryId,
          accountId: l.currentAccountId,
          accountName: l.currentAccountName,
          bankAccountId: l.knownBankAccountId!,
          glAccountId: l.targetGlAccountId!,
          classification: l.classification,
          rule: l.rule!,
        })),
      )
      .returning({ id: cashLineBankAttributionsTable.id });
    if (inserted.length !== lines.length) throw new Error(`Attributed ${inserted.length} of ${lines.length} lines — a line changed under the run. Rolled back.`);

    // ── Invariants, asserted on the data as it now stands ──────────────────
    const checksumAfter = await lineChecksum();
    if (checksumAfter.count !== checksumBefore.count || checksumAfter.digest !== checksumBefore.digest) {
      throw new Error("A journal line changed during the cut-over — the annotation model never writes journal_entry_lines. Rolled back.");
    }
    const cashAfter = await cashPosition();
    if (cashAfter !== cashBefore) throw new Error(`Cash conservation violated: ${cashBefore.toFixed(2)} before, ${cashAfter.toFixed(2)} after. Rolled back.`);
    const [{ left }] = await db
      .select({ left: sql<number>`count(*)::int` })
      .from(journalEntryLinesTable)
      .leftJoin(cashLineBankAttributionsTable, eq(cashLineBankAttributionsTable.lineId, journalEntryLinesTable.id))
      .where(and(eq(journalEntryLinesTable.accountId, header.id), sql`${cashLineBankAttributionsTable.id} IS NULL`));
    if (left !== 0) throw new Error(`${left} header line(s) remain unattributed after the run. Rolled back.`);

    await auditService.record({
      action: "cash_cutover",
      entityType: "company",
      entityId: companyId,
      after: { runId: run.id, attributed: inserted.length, attributedBefore, cashBefore, cashAfter, plan: report.plan, counts: report.counts },
    });

    return { ...report, runId: run.id, attributed: inserted.length, cashAfter, state: "committed" };
  },
};
