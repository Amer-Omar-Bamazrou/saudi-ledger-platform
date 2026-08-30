/** Invoices repository — tenant-scoped via RLS. */
import {
  db,
  invoicesTable,
  invoiceItemsTable,
  customersTable,
  einvoiceDocumentsTable,
  invoiceNumberCountersTable,
} from "@workspace/db";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";

export interface InvoiceListFilter {
  status?: string;
  customerId?: number;
  limit?: number;
  offset?: number;
}

/** The default page. Stated once so the API, the UI and the tests agree. */
export const DEFAULT_PAGE = 50;

/** One predicate for the rows AND the totals — so they cannot describe different sets. */
function invoiceListConditions(filter: InvoiceListFilter) {
  const conditions = [];
  if (filter.status) conditions.push(eq(invoicesTable.status, filter.status));
  if (filter.customerId) conditions.push(eq(invoicesTable.customerId, filter.customerId));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const invoicesRepository = {
  /**
   * 🔴 PAGINATED, and the page is a page — not a silent cap.
   *
   * This list was UNBOUNDED, which is the other half of B-6's disease: capped
   * where it should be unbounded and unbounded where it should be capped is one
   * illness pointing both ways. An unbounded ledger list is merely slow at ten
   * rows and fatal at ten thousand, and the page then `reduce`d its money
   * totals over whatever it happened to fetch.
   *
   * OFFSET pagination, deliberately. Cursor pagination is better in principle —
   * stable under concurrent inserts, no deep-page cost — and nothing in this
   * market justifies it: twenty pages of fifty is not a problem anyone here
   * has. 🔴 Recorded as the upgrade path if volume ever arrives, so the choice
   * reads as a decision rather than an oversight.
   */
  list(filter: InvoiceListFilter) {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(invoiceListConditions(filter))
      .orderBy(desc(invoicesTable.date), desc(invoicesTable.id))
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /**
   * 🔴 The totals, computed in SQL over the WHOLE filtered set — never over the
   * page. "Total on this page" is a number nobody asked for, and the honest
   * alternative to a page-scoped total is not a smaller number but a
   * confidently wrong one (B-6). The count comes from the same predicate as the
   * rows, so the two can never disagree.
   */
  async listMeta(filter: InvoiceListFilter) {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        outstanding: sql<number>`COALESCE(SUM(
          CASE WHEN ${invoicesTable.status} NOT IN ('paid','cancelled')
               THEN ${invoicesTable.total} - ${invoicesTable.paidAmount} ELSE 0 END), 0)::float8`,
        collected: sql<number>`COALESCE(SUM(
          CASE WHEN ${invoicesTable.status} = 'paid' THEN ${invoicesTable.total} ELSE 0 END), 0)::float8`,
        overdue: sql<number>`COUNT(*) FILTER (WHERE ${invoicesTable.status} = 'overdue')::int`,
      })
      .from(invoicesTable)
      .where(invoiceListConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      outstanding: Number(row?.outstanding ?? 0),
      collected: Number(row?.collected ?? 0),
      overdue: Number(row?.overdue ?? 0),
    };
  },

  findWithCustomer(id: number) {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(eq(invoicesTable.id, id))
      .limit(1);
  },

  /**
   * Allocate the next invoice number for the current company (C12).
   *
   * ── The rule, from the PRIMARY TEXT ──────────────────────────────────────
   * VAT Implementing Regulations **Art. 53(5)(b)**: "a sequential number which
   * uniquely identifies the Tax Invoice". The E-Invoicing Resolution's Annex
   * (2) field 2.1 delegates to that article rather than restating it. Full
   * citations: `docs/tax/invoice-numbering-verification.md`.
   *
   * 🔴 **Sequential and unique — NOT gapless.** Neither document contains
   * "unbroken", "gapless" or "without gap" for the invoice number. ZATCA DID
   * write an explicitly gapless, non-resettable rule for the tamper-resistant
   * COUNTER (Resolution §7) — a different field. So this needs no advisory
   * lock and no reservation discipline; `lockCompanySequence` exists for the
   * ICV chain and must not acquire a second, unrelated caller.
   *
   * 🔴 **Monotonic, never reset — including at year end.** The year is a
   * display prefix only. M21.2's allocator restarted each January, which
   * nothing in either document authorises and which is the one arrangement
   * that sits awkwardly against both "sequential" and Resolution §2's ban on
   * more than one sequence per unit.
   *
   * Concurrency: one atomic UPSERT. Two concurrent callers for the same
   * company serialise on the row lock and receive different values; callers
   * for different companies never contend. The `UNIQUE (company_id,
   * invoice_number)` index is the backstop if anything ever bypasses this.
   */
  async allocateInvoiceNumber(date?: string): Promise<string> {
    const year = (date ?? new Date().toISOString().slice(0, 10)).slice(0, 4);
    const res = await db.execute<{ last_value: number }>(sql`
      INSERT INTO invoice_number_counters (organization_id, company_id, last_value)
      VALUES (DEFAULT, DEFAULT, 1)
      ON CONFLICT (company_id)
      DO UPDATE SET last_value = invoice_number_counters.last_value + 1
      RETURNING last_value
    `);
    const next = Number(res.rows[0]?.last_value ?? 1);
    return `INV-${year}-${String(next).padStart(6, "0")}`;
  },

  findById(id: number) {
    return db.select().from(invoicesTable).where(eq(invoicesTable.id, id)).limit(1);
  },

  itemsByInvoice(id: number) {
    return db.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, id));
  },

  /**
   * The most recent issued invoice's hash for ONE COMPANY — the tail of that
   * company's chain.
   *
   * ── M12.1a bug fix ────────────────────────────────────────────────────────
   * This used to live in `services/accounting/zatca.ts` as
   * `getPreviousInvoiceHash(db, invoicesTable)`, taking `any` params and
   * filtering ONLY on `invoice_hash IS NOT NULL`. RLS confined it to the active
   * organization, but NOT to a company — so an org with two companies
   * INTERLEAVED their chains into one, which is invalid: ZATCA's chain (and the
   * ICV counter) are per EGS unit, i.e. per company. Harmless while every org
   * had one company; a correctness bug the moment one had two.
   *
   * It also belongs here on layering grounds — repositories own Drizzle access.
   * That it lived in the accounting layer behind `any` types is precisely why
   * the missing filter was invisible.
   *
   * Drafts are excluded by the `invoice_hash IS NOT NULL` predicate (M10.4), so
   * a draft still consumes no sequence number.
   */
  async previousInvoiceHash(companyId: string): Promise<string | null> {
    const [row] = await db
      .select({ hash: invoicesTable.invoiceHash })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.companyId, companyId), isNotNull(invoicesTable.invoiceHash)))
      // 🔴 ORDER BY ICV, NOT BY ROW ID (M12.1b bug fix).
      //
      // `id` is assigned at CREATE; the chain position is assigned at APPROVAL.
      // Those orders differ whenever documents are approved out of the order they
      // were created — which happens under concurrency AND in the ordinary case
      // of an approver working a queue out of order.
      //
      // Ordering by `id` picked "the highest-numbered row that happens to be
      // hashed", so several approvals could read the SAME head and FORK THE
      // CHAIN — three documents sharing one predecessor, reproduced with 8
      // parallel approvals in `invoice-icv-concurrency.test.ts`. The ICVs were
      // dense and unique the whole time (the advisory lock was working); only
      // this ordering was wrong.
      //
      // `NULLS LAST` keeps pre-M12.1b rows (hashed but with no ICV) behind
      // ICV-bearing ones, so a company with legacy invoices continues its chain
      // instead of starting a second genesis root.
      .orderBy(sql`${invoicesTable.icv} DESC NULLS LAST`, desc(invoicesTable.id))
      .limit(1);
    return row?.hash ?? null;
  },

  /**
   * Serialise sequence consumption for one company (M12.1b).
   *
   * 🔴 Both the ICV and the hash chain are read-then-write: each reads the
   * current head and writes the next position. Under two concurrent approvals
   * for the same company, READ COMMITTED lets both read the SAME head — which
   * would mint a duplicate ICV and, worse, FORK THE HASH CHAIN (two documents
   * claiming the same predecessor). A forked chain is not repairable after the
   * fact and is exactly what ZATCA's chain exists to detect.
   *
   * The `unique(company_id, icv)` index is a backstop that turns the duplicate
   * into an error, but it cannot fix the fork and it cannot tell the loser to
   * retry cleanly. So allocation is serialised properly, and the index remains
   * the backstop rather than the mechanism.
   *
   * A TRANSACTION-scoped advisory lock is used (not a counter table, not
   * `SELECT FOR UPDATE`) because:
   *   - it covers the ICV **and** the hash-chain read in one critical section,
   *     which a counter table would not;
   *   - it needs no new table and no lock-ordering discipline;
   *   - it releases automatically on commit OR rollback, so a failed approval
   *     cannot strand the lock.
   *
   * Scoped per company: two different companies onboard and issue in parallel
   * without contending, which matters because the chain is per EGS unit.
   */
  async lockCompanySequence(companyId: string): Promise<void> {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${companyId}::text, 0))`);
  },

  /**
   * The next ICV for a company — call only while holding
   * {@link lockCompanySequence}.
   *
   * ICV counts ISSUED documents, so it keys off `icv IS NOT NULL`: a draft (and
   * a rejected draft) consumes no sequence number, exactly like the hash chain.
   * Notes share the sequence with invoices — ZATCA's counter is per EGS unit and
   * covers every document type.
   */
  async nextIcv(companyId: string): Promise<number> {
    const [row] = await db
      .select({ maxIcv: sql<number | null>`max(${invoicesTable.icv})` })
      .from(invoicesTable)
      .where(eq(invoicesTable.companyId, companyId));
    return (row?.maxIcv ?? 0) + 1;
  },

  /**
   * The ZATCA PIH for the document preceding `invoiceId` in this company's
   * chain — read from `einvoice_documents`, NEVER from `invoices.previous_hash`.
   *
   * 🔴 Those are two different chains. `invoices.previous_hash` is the homegrown
   * hex chain with the literal genesis `"GENESIS"`; ZATCA's is the base64
   * SHA-256 of the canonical XML. See the landmine note in CLAUDE.md.
   *
   * 🔴 CALL ONLY WHILE HOLDING {@link lockCompanySequence}, and only from the
   * issuance path. Both halves matter — see below.
   *
   * ── M12.8 bug fix: THE FORK WAS STILL LIVE HERE ───────────────────────────
   * M12.1b found that ordering a chain head by row id forks the chain, fixed it
   * in {@link previousInvoiceHash}, and left this function ordering by
   * `einvoice_documents.invoice_id DESC` — the SAME defect, in the SAME file,
   * applied to the chain ZATCA actually validates. It survived review because
   * nothing enqueued a document, so the table was always empty and this always
   * returned `null` → genesis. The disconnection was masking it.
   *
   * `invoice_id` is assigned at CREATE; the chain position is assigned at
   * ISSUANCE. They diverge whenever documents are approved out of creation
   * order — which is NOT merely a race: an approver working a queue out of
   * order forks the chain one sequential request at a time. So the ordering
   * follows the SEQUENCE (`icv`), exactly as the homegrown chain now does.
   *
   * And ordering alone is not sufficient. Reading the head and writing the next
   * document's hash is read-then-write, so the read must sit in the same
   * critical section as the ICV allocation — hence the lock requirement above.
   * M12.1b needed BOTH mechanisms; this path had NEITHER.
   *
   * `NULLS LAST` keeps any document whose invoice predates ICV assignment
   * behind ICV-bearing ones, so a chain continues rather than restarting.
   *
   * Returns `null` when no ZATCA document has been recorded yet, so the
   * assembler substitutes ZATCA's defined genesis constant.
   */
  async zatcaPreviousInvoiceHash(companyId: string, invoiceId: number): Promise<string | null> {
    const [row] = await db
      .select({ hash: einvoiceDocumentsTable.invoiceHash })
      .from(einvoiceDocumentsTable)
      .innerJoin(invoicesTable, eq(einvoiceDocumentsTable.invoiceId, invoicesTable.id))
      .where(
        and(
          eq(einvoiceDocumentsTable.companyId, companyId),
          isNotNull(einvoiceDocumentsTable.invoiceHash),
          ne(einvoiceDocumentsTable.invoiceId, invoiceId),
        ),
      )
      // 🔴 ORDER BY ICV, NOT BY ROW ID. See the note above.
      .orderBy(sql`${invoicesTable.icv} DESC NULLS LAST`, desc(invoicesTable.id))
      .limit(1);
    return row?.hash ?? null;
  },

  /**
   * Approved credit-note totals grouped by original invoice (audit Tier 3,
   * finding 6). The RECEIVABLE side must be credit-aware everywhere: an
   * invoice's true outstanding is `total − paid − credited`, and computing it
   * as `total − paid` in some places (pay, matching) while credit notes lived
   * as separate rows in others (aging) is the two-independent-computations
   * hazard again — a credited invoice could never reach `paid`, and matching
   * quoted an outstanding the customer would never pay.
   */
  async creditedTotalsByOriginal(): Promise<Map<number, number>> {
    const rows = await db
      .select({
        originalId: invoicesTable.originalInvoiceId,
        credited: sql<string>`sum(${invoicesTable.total}::numeric)`,
      })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.documentType, "credit_note"),
          isNotNull(invoicesTable.invoiceHash),
          isNotNull(invoicesTable.originalInvoiceId),
        ),
      )
      .groupBy(invoicesTable.originalInvoiceId);
    return new Map(rows.filter((r) => r.originalId != null).map((r) => [r.originalId!, Number(r.credited)]));
  },

  /** Every note already issued against one original — the over-crediting guard. */
  async notesAgainst(originalInvoiceId: number, documentType: string) {
    return db
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.originalInvoiceId, originalInvoiceId),
          eq(invoicesTable.documentType, documentType),
          isNotNull(invoicesTable.invoiceHash),
        ),
      );
  },

  /**
   * Open invoices a bank credit could settle (M16.3 reconciliation).
   *
   * "Open" mirrors AR aging's per-document definition: issued (approved —
   * `invoice_hash IS NOT NULL`, so drafts/submitted are structurally excluded),
   * not fully paid, with `total - paid_amount >= 0.01`. Restricted to
   * `document_type = 'invoice'`: a credit/debit NOTE is a correction document,
   * not a receivable a bank credit settles (v1 scope, design §3).
   */
  openForSettlement() {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(
        and(
          isNotNull(invoicesTable.invoiceHash),
          eq(invoicesTable.documentType, "invoice"),
          sql`${invoicesTable.status} NOT IN ('draft','submitted','paid','cancelled')`,
          sql`(${invoicesTable.total}::numeric - COALESCE(${invoicesTable.paidAmount}::numeric, 0)) >= 0.01`,
        ),
      )
      .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));
  },

  insert(values: typeof invoicesTable.$inferInsert) {
    return db.insert(invoicesTable).values(values).returning();
  },

  insertItems(values: (typeof invoiceItemsTable.$inferInsert)[]) {
    return db.insert(invoiceItemsTable).values(values);
  },

  update(id: number, values: Partial<typeof invoicesTable.$inferInsert>) {
    return db.update(invoicesTable).set(values).where(eq(invoicesTable.id, id)).returning();
  },

  remove(id: number) {
    return db.delete(invoicesTable).where(eq(invoicesTable.id, id));
  },
};
