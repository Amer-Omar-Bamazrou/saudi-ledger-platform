/**
 * Findings repository (AI-3a) — the deterministic check queries and the
 * finding rows' persistence. All reads are tenant-scoped via RLS like every
 * repository; the checks read only business tables (never the identity
 * tables — actor names resolve in the service through the audit-trail
 * precedent).
 *
 * 🔴 Every check is INTERNAL-CONSISTENCY only (owner Q2, 2026-08-24): each
 * observes a fact about the tenant's own records and asserts no tax or
 * compliance position. The wording rule travels with the data: facts carry
 * numbers and names, never judgments — the UI renders words, and no severity
 * exists anywhere.
 */
import { db, findingsTable, findingRunsTable, findingSchedulesTable, type Finding, type FindingRun } from "@workspace/db";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

export interface DetectedFinding {
  kind: string;
  refKey: string;
  companyId: string | null;
  facts: Record<string, unknown>;
}

/** Thresholds — named so the facts can carry them and the tests can pin them. */
export const STALE_DRAFT_DAYS = 14;

export const findingsRepository = {
  // ── The checks ─────────────────────────────────────────────────────────────

  /** Bills sharing (vendor, date, total) — the double-entry / double-payment shape. */
  async duplicateBills(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{
      vendor_id: number;
      date: string;
      total: string;
      ids: number[];
      numbers: string[];
    }>(sql`
      SELECT vendor_id, date, total,
             array_agg(id ORDER BY id) AS ids,
             array_agg(bill_number ORDER BY id) AS numbers
        FROM bills
       WHERE vendor_id IS NOT NULL
       GROUP BY vendor_id, date, total
      HAVING count(*) > 1
    `);
    return rows.map((r) => ({
      kind: "duplicate_bill",
      refKey: `vendor:${r.vendor_id}|date:${r.date}|total:${r.total}`,
      companyId: null,
      facts: { billIds: r.ids, billNumbers: r.numbers, vendorId: r.vendor_id, date: r.date, total: Number(r.total), count: r.ids.length },
    }));
  },

  /** Accepted operating rows sharing (date, amount, description) — the manual-entry duplicate (ingest dedupes; typing does not). */
  async duplicateTransactions(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ date: string; amount: string; description: string; ids: number[] }>(sql`
      SELECT date, amount, description, array_agg(id ORDER BY id) AS ids
        FROM transactions
       WHERE review_status = 'accepted' AND kind = 'operating'
       GROUP BY date, amount, description
      HAVING count(*) > 1
    `);
    return rows.map((r) => ({
      kind: "duplicate_transaction",
      refKey: `date:${r.date}|amount:${r.amount}|desc:${r.description}`,
      companyId: null,
      facts: { transactionIds: r.ids, date: r.date, amount: Number(r.amount), description: r.description, count: r.ids.length },
    }));
  },

  /**
   * Gaps in the server-allocated invoice-number series, per company — AS
   * OBSERVATIONS. 🔴 C12: sequential + unique is the legal requirement and
   * gaps are LAWFUL (Art. 53(5)(b); the gapless rule is 2.5's, a different
   * field). The finding says "these numbers are absent", never "violation" —
   * its value is being able to ANSWER if anyone ever asks (advisor Block D1).
   * Only counter-shaped numbers (INV-YYYY-NNNNNN) participate; legacy-import
   * numbers are the caller's own series and are not analyzed.
   */
  async invoiceNumberGaps(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ company_id: string; after_number: string; missing_from: number; missing_to: number }>(sql`
      WITH numbered AS (
        SELECT company_id, invoice_number,
               (regexp_match(invoice_number, '^INV-\\d{4}-(\\d+)$'))[1]::bigint AS n
          FROM invoices
         WHERE invoice_number ~ '^INV-\\d{4}-\\d+$' AND company_id IS NOT NULL
      ),
      gaps AS (
        SELECT company_id, invoice_number, n,
               lead(n) OVER (PARTITION BY company_id ORDER BY n) AS next_n
          FROM numbered
      )
      SELECT company_id, invoice_number AS after_number,
             (n + 1)::int AS missing_from, (next_n - 1)::int AS missing_to
        FROM gaps
       WHERE next_n IS NOT NULL AND next_n - n > 1
    `);
    return rows.map((r) => ({
      kind: "invoice_number_gap",
      refKey: `company:${r.company_id}|after:${r.after_number}`,
      companyId: r.company_id,
      facts: {
        afterNumber: r.after_number,
        missingFrom: r.missing_from,
        missingTo: r.missing_to,
        missingCount: r.missing_to - r.missing_from + 1,
      },
    }));
  },

  /**
   * Issued invoices past due with an outstanding balance — CREDIT-AWARE
   * (audit Tier 3, finding 6: outstanding = total − credited − paid; without
   * netting credit notes, a credited invoice reads overdue forever).
   */
  async overdueReceivables(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ id: number; invoice_number: string; due_date: string; outstanding: string; days_overdue: number }>(sql`
      SELECT i.id, i.invoice_number, i.due_date,
             round(i.total - COALESCE(i.paid_amount, 0) - COALESCE(cn.credited, 0), 2) AS outstanding,
             (current_date - i.due_date::date)::int AS days_overdue
        FROM invoices i
        LEFT JOIN (
          SELECT original_invoice_id, sum(total) AS credited
            FROM invoices WHERE document_type = 'credit_note' AND status NOT IN ('draft','submitted')
           GROUP BY original_invoice_id
        ) cn ON cn.original_invoice_id = i.id
       WHERE i.document_type = 'invoice'
         AND i.status NOT IN ('draft','submitted','paid')
         AND i.due_date IS NOT NULL AND i.due_date::date < current_date
         AND i.total - COALESCE(i.paid_amount, 0) - COALESCE(cn.credited, 0) > 0.005
    `);
    return rows.map((r) => ({
      kind: "overdue_receivable",
      refKey: `invoice:${r.id}`,
      companyId: null,
      facts: { invoiceId: r.id, invoiceNumber: r.invoice_number, dueDate: r.due_date, outstanding: Number(r.outstanding), daysOverdue: r.days_overdue },
    }));
  },

  /** Approved bills past due with an unpaid balance (bills carry no credit notes — verified, not mirrored). */
  async overduePayables(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ id: number; bill_number: string; due_date: string; outstanding: string; days_overdue: number }>(sql`
      SELECT id, bill_number, due_date,
             round(total - COALESCE(paid_amount, 0), 2) AS outstanding,
             (current_date - due_date::date)::int AS days_overdue
        FROM bills
       WHERE status NOT IN ('draft','submitted','paid')
         AND due_date IS NOT NULL AND due_date::date < current_date
         AND total - COALESCE(paid_amount, 0) > 0.005
    `);
    return rows.map((r) => ({
      kind: "overdue_payable",
      refKey: `bill:${r.id}`,
      companyId: null,
      facts: { billId: r.id, billNumber: r.bill_number, dueDate: r.due_date, outstanding: Number(r.outstanding), daysOverdue: r.days_overdue },
    }));
  },

  /** Drafts/submitted documents sitting unapproved past the threshold — work someone entered and nobody decided. */
  async staleDrafts(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ entity: string; id: number; number: string | null; status: string; age_days: number }>(sql`
      SELECT 'invoice' AS entity, id, invoice_number AS number, status,
             EXTRACT(DAY FROM now() - created_at)::int AS age_days
        FROM invoices
       WHERE status IN ('draft','submitted') AND created_at < now() - make_interval(days => ${STALE_DRAFT_DAYS})
      UNION ALL
      SELECT 'bill', id, bill_number, status, EXTRACT(DAY FROM now() - created_at)::int
        FROM bills
       WHERE status IN ('draft','submitted') AND created_at < now() - make_interval(days => ${STALE_DRAFT_DAYS})
      UNION ALL
      SELECT 'journal_entry', id, entry_number, status, EXTRACT(DAY FROM now() - created_at)::int
        FROM journal_entries
       WHERE status IN ('draft','submitted') AND created_at < now() - make_interval(days => ${STALE_DRAFT_DAYS})
    `);
    return rows.map((r) => ({
      kind: "stale_draft",
      refKey: `${r.entity}:${r.id}`,
      companyId: null,
      facts: { entity: r.entity, id: r.id, number: r.number, status: r.status, ageDays: r.age_days, thresholdDays: STALE_DRAFT_DAYS },
    }));
  },

  /** Transfers with no declared direction — the platform will not guess, and each one blocks the liquidity claim (B5/A). */
  async undeclaredTransfers(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ id: number; date: string; amount: string; description: string }>(sql`
      SELECT id, date, amount, description FROM transactions
       WHERE kind = 'transfer' AND transfer_direction IS NULL AND review_status = 'accepted'
    `);
    return rows.map((r) => ({
      kind: "undeclared_transfer",
      refKey: `transaction:${r.id}`,
      companyId: null,
      facts: { transactionId: r.id, date: r.date, amount: Number(r.amount), description: r.description },
    }));
  },

  /**
   * Accepted operating rows with no journal entry — flaw #1's guarantee is
   * that acceptance posts, so an accepted-but-unposted row is either a
   * pre-Option-A legacy row (a named state in the cash reconciliation) or a
   * posting failure someone should see.
   */
  async unpostedTransactions(): Promise<DetectedFinding[]> {
    const { rows } = await db.execute<{ id: number; date: string; amount: string; description: string }>(sql`
      SELECT id, date, amount, description FROM transactions
       WHERE review_status = 'accepted' AND kind = 'operating' AND journal_entry_id IS NULL
    `);
    return rows.map((r) => ({
      kind: "unposted_transaction",
      refKey: `transaction:${r.id}`,
      companyId: null,
      facts: { transactionId: r.id, date: r.date, amount: Number(r.amount), description: r.description },
    }));
  },

  // ── Persistence ────────────────────────────────────────────────────────────

  findById(id: number) {
    return db.select().from(findingsTable).where(eq(findingsTable.id, id));
  },

  findByKey(kind: string, refKey: string) {
    return db
      .select()
      .from(findingsTable)
      .where(and(eq(findingsTable.kind, kind), eq(findingsTable.refKey, refKey)));
  },

  insert(values: typeof findingsTable.$inferInsert) {
    return db.insert(findingsTable).values(values).returning();
  },

  /** Refresh a re-detected finding; a resolved one reopens, an acknowledged one stays acknowledged. */
  refresh(id: number, facts: Record<string, unknown>, reopen: boolean) {
    return db
      .update(findingsTable)
      .set({
        facts,
        lastSeenAt: new Date(),
        ...(reopen ? { status: "open", resolvedAt: null } : {}),
      })
      .where(eq(findingsTable.id, id))
      .returning();
  },

  /** Machine-resolve every still-open finding of the scanned kinds whose key was NOT detected this run. */
  async resolveMissing(kinds: string[], detectedKeys: Set<string>): Promise<number> {
    const candidates = await db
      .select({ id: findingsTable.id, kind: findingsTable.kind, refKey: findingsTable.refKey })
      .from(findingsTable)
      .where(and(inArray(findingsTable.kind, kinds), ne(findingsTable.status, "resolved")));
    const vanished = candidates.filter((c) => !detectedKeys.has(`${c.kind}|${c.refKey}`));
    for (const v of vanished) {
      await db
        .update(findingsTable)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(findingsTable.id, v.id));
    }
    return vanished.length;
  },

  list(filter: { status?: string; kind?: string }) {
    const where = [
      filter.status ? eq(findingsTable.status, filter.status) : undefined,
      filter.kind ? eq(findingsTable.kind, filter.kind) : undefined,
    ].filter(Boolean);
    return db
      .select()
      .from(findingsTable)
      .where(where.length ? and(...(where as [ReturnType<typeof eq>])) : undefined)
      .orderBy(desc(findingsTable.lastSeenAt), desc(findingsTable.id));
  },

  async counts(): Promise<{ open: number; acknowledged: number; resolved: number }> {
    const { rows } = await db.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*)::int AS n FROM findings GROUP BY status`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    return { open: by.open ?? 0, acknowledged: by.acknowledged ?? 0, resolved: by.resolved ?? 0 };
  },

  acknowledge(id: number, userId: number | null) {
    return db
      .update(findingsTable)
      .set({ status: "acknowledged", acknowledgedAt: new Date(), acknowledgedBy: userId })
      .where(and(eq(findingsTable.id, id), sql`${findingsTable.status} <> 'resolved'`))
      .returning();
  },

  markDeliveredInApp(ids: number[]) {
    if (ids.length === 0) return Promise.resolve();
    return db
      .update(findingsTable)
      .set({ delivered: sql`delivered || jsonb_build_object('in_app', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))` })
      .where(inArray(findingsTable.id, ids));
  },

  // ── Runs and schedule (AI-5) ───────────────────────────────────────────────

  /** Record an on-demand run (tenant context; the org comes from the GUC default). */
  insertRun(counts: { created: number; reopened: number; refreshed: number; resolved: number; openAfter: number }) {
    return db
      .insert(findingRunsTable)
      .values({ trigger: "on_demand", ...counts })
      .returning();
  },

  /**
   * Owner Q3's fact: viewing IS the event. Called when an admin/accountant
   * lists findings — stamps every unviewed scheduled run for the org. The
   * side effect on a GET is deliberate and honest: the thing recorded is
   * exactly that the GET happened.
   */
  markScheduledRunsViewed(userId: number | null) {
    return db
      .update(findingRunsTable)
      .set({ viewedAt: new Date(), viewedBy: userId })
      .where(and(eq(findingRunsTable.trigger, "scheduled"), isNull(findingRunsTable.viewedAt)))
      .returning({ id: findingRunsTable.id });
  },

  async latestScheduledRun(): Promise<FindingRun | undefined> {
    const rows = await db
      .select()
      .from(findingRunsTable)
      .where(eq(findingRunsTable.trigger, "scheduled"))
      .orderBy(desc(findingRunsTable.ranAt), desc(findingRunsTable.id))
      .limit(1);
    return rows[0];
  },

  async getCadence(): Promise<"quarterly" | "monthly"> {
    const rows = await db.select().from(findingSchedulesTable).limit(1);
    return (rows[0]?.cadence as "quarterly" | "monthly") ?? "quarterly";
  },

  setCadence(cadence: "quarterly" | "monthly", userId: number | null) {
    return db
      .insert(findingSchedulesTable)
      .values({
        // finding_schedules has no GUC default (its PK is the org), so the
        // tenant transaction's GUC is read explicitly here.
        organizationId: sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid` as unknown as string,
        cadence,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: findingSchedulesTable.organizationId,
        set: { cadence, updatedAt: new Date(), updatedBy: userId },
      })
      .returning();
  },

  /** Stamp the email notice onto the findings it announced (the open set at send time). */
  markDeliveredEmailNotice(runId: number) {
    return db
      .update(findingsTable)
      .set({
        delivered: sql`delivered || jsonb_build_object('email_notice_run', ${runId}::int, 'email_notice_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))`,
      })
      .where(eq(findingsTable.status, "open"));
  },
};

export type { Finding };
