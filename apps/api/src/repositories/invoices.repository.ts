/** Invoices repository — tenant-scoped via RLS. */
import { db, invoicesTable, invoiceItemsTable, customersTable, einvoiceDocumentsTable } from "@workspace/db";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";

export interface InvoiceListFilter {
  status?: string;
  customerId?: number;
}

export const invoicesRepository = {
  list(filter: InvoiceListFilter) {
    const conditions = [];
    if (filter.status) conditions.push(eq(invoicesTable.status, filter.status));
    if (filter.customerId) conditions.push(eq(invoicesTable.customerId, filter.customerId));
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));
  },

  findWithCustomer(id: number) {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(eq(invoicesTable.id, id))
      .limit(1);
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
