/**
 * THE SCALE-AND-COLLISION FIXTURE — the two classes every other fixture we own
 * is structurally blind to.
 *
 * ── 🔴 WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * Every fixture, dev org and sample seed in this repository is SMALL and
 * carries UNIQUE values. Two whole families of defect are therefore invisible
 * to all of them, no matter how carefully the code is read:
 *
 *   (a) VOLUME — a count taken from a capped list, an aggregate reduced over a
 *       fetched page, a bulk action whose label counts one page while the
 *       server acts on every row. At fixture size the capped answer and the
 *       true answer are the same number, so nothing can go red.
 *
 *   (b) COLLISION — an identity built from (date, amount, description) or
 *       (customer, amount, date). Every fixture we have gives its rows
 *       distinct amounts, so a key that is not actually unique looks unique
 *       forever. Two invoices to the same customer for the same amount on the
 *       same day is an ORDINARY occurrence, not an edge case; so is a bank
 *       statement listing the same SAR 45.00 charge twice.
 *
 * Both families appear the month a tenant gets busy — the worst possible
 * moment to discover them. B6 caught one instance of (a) and named the timing
 * property; this file generalises it and adds (b).
 *
 * 🔴 **The fixture is deliberately BOTH big and degenerate**: more rows than
 * every cap it touches, and values that repeat on purpose. A test that cannot
 * fail on small data is not testing the property, and until this file every
 * test we had was small.
 *
 * 🔴 **AND A DIAGNOSTIC RULE THAT CAME OUT OF THE SWEEP:** a suspiciously ROUND
 * count — exactly 500, exactly 200, exactly 100 — is the shape of a CAP, not
 * the shape of data. The assertions below name the cap value they must not
 * equal, so a regression reads as "expected 500 to be 537" instead of a
 * plausible number nobody questions.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3129";
process.env.SESSION_SECRET ??= "scale-and-collision-test-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[scale-and-collision] no real DATABASE_URL — skipping.");
}

/** The caps this file must exceed. Named so an assertion can say "not the cap". */
const REVIEW_CAP = 200;
const OUTBOX_PAGE_CAP = 500;

/** Deliberately not round, so a saturated answer is unmistakable. */
const PENDING_ROWS = REVIEW_CAP + 37; // 237
const OVERDUE_DOCS = OUTBOX_PAGE_CAP + 37; // 537

/** The collision fixture: one amount, one date, one customer, many documents. */
const COLLIDING_AMOUNT = 1_150.0;
const COLLIDING_DATE = "2026-03-11";
const COLLIDING_COUNT = 3;

const FIXTURE_SLUG = "scale-collision";

async function withOrg<T>(
  orgId: string,
  companyId: string,
  fn: () => Promise<T>,
  userId?: number,
): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const { auditContext } = await import("../lib/auditContext");
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(() =>
      userId == null ? fn() : auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
    );
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

/**
 * Remove every row this fixture creates, in FK order. Used before the run (so a
 * crashed run cannot block the next one) and after it.
 */
async function wipeFixture() {
  const org = `(SELECT id FROM organizations WHERE slug = '${FIXTURE_SLUG}')`;
  await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
  await pool.query(
    `DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`,
  );
  await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id IN ${org})`);
  await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM bank_accounts WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
  const { rows: members } = await pool.query(
    `SELECT user_id FROM organization_memberships WHERE organization_id IN ${org}`,
  );
  await pool.query(`DELETE FROM organization_memberships WHERE organization_id IN ${org}`);
  for (const m of members) {
    await pool.query(`DELETE FROM users WHERE id = $1`, [m.user_id]);
  }
  await pool.query(`DELETE FROM organizations WHERE slug = '${FIXTURE_SLUG}'`);
}

describeMaybe("scale and collision — the two classes small unique fixtures cannot see", () => {
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let vendorId = 0;
  let bankAccountId = 0;
  let categoryId = 0;
  let userId = 0;

  beforeAll(async () => {
    // Leftovers from an interrupted run would collide on the slug, so the
    // fixture cleans before it builds. (A failed cleanup once left 537 invoices
    // behind — the cost of a fixture this size is that its teardown matters.)
    await wipeFixture();
    const org = await pool.query(
      `INSERT INTO organizations (name, slug, verification_status)
       VALUES ('Scale Collision Org', '${FIXTURE_SLUG}', 'approved') RETURNING id`,
    );
    orgId = org.rows[0].id;
    const co = await pool.query(
      `INSERT INTO companies (organization_id, name) VALUES ($1,'Scale Co') RETURNING id`,
      [orgId],
    );
    companyId = co.rows[0].id;

    const cust = await pool.query(
      `INSERT INTO customers (organization_id, name) VALUES ($1,'Colliding Customer') RETURNING id`,
      [orgId],
    );
    customerId = cust.rows[0].id;
    const vend = await pool.query(
      `INSERT INTO vendors (organization_id, name) VALUES ($1,'Colliding Vendor') RETURNING id`,
      [orgId],
    );
    vendorId = vend.rows[0].id;
    const acct = await pool.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, currency)
       VALUES ($1,$2,'Main','Test Bank','SAR') RETURNING id`,
      [orgId, companyId],
    );
    bankAccountId = acct.rows[0].id;

    // The org-seed trigger copies the system chart into `categories`, so a real
    // expense category exists. The volume fixture needs one: a row with no
    // category is "needs attention", and the bulk button claims to act on the
    // READY ones.
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1,'x','Scale Tester') RETURNING id`,
      [`scale-collision-${Date.now()}@example.test`],
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status)
       VALUES ($1,$2,'admin','active')`,
      [orgId, userId],
    );

    const cat = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 ORDER BY id LIMIT 1`,
      [orgId],
    );
    categoryId = cat.rows[0].id;
  });

  afterAll(wipeFixture);

  // ──────────────────────────────────────────────────────────────────────────
  // (b) COLLISION — receivables
  // ──────────────────────────────────────────────────────────────────────────
  describe("collision — AR aging with identical documents", () => {
    beforeAll(async () => {
      // THREE approved invoices: same customer, same amount, same date, same
      // due date. Only the server-allocated number distinguishes them — which
      // is exactly the situation a (customer, amount, date) identity cannot
      // survive.
      for (let i = 0; i < COLLIDING_COUNT; i++) {
        await pool.query(
          `INSERT INTO invoices
             (organization_id, company_id, customer_id, invoice_number, document_type,
              date, due_date, subtotal, vat_amount, total, paid_amount, status)
           VALUES ($1,$2,$3,$4,'invoice',$5,$5,$6,0,$6,0,'approved')`,
          [orgId, companyId, customerId, `INV-2026-90000${i}`, COLLIDING_DATE, COLLIDING_AMOUNT],
        );
      }
    });

    it("the fixture really does collide (anti-vacuity)", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int n, count(DISTINCT (customer_id, date, total))::int distinct_keys
           FROM invoices WHERE organization_id = $1`,
        [orgId],
      );
      expect(rows[0].n).toBe(COLLIDING_COUNT);
      // 🔴 The whole point: three rows, ONE (customer, date, total) key.
      expect(rows[0].distinct_keys).toBe(1);
    });

    it("🔴 AR aging totals every colliding invoice — it neither doubles nor collapses them", async () => {
      const { reportsService } = await import("../services/reports.service");
      const aging = await withOrg(orgId, companyId, () => reportsService.arAging());

      // The two failure directions this fixture exists to separate:
      //   collapse → total === COLLIDING_AMOUNT (a dedupe on a non-unique key)
      //   double   → total === 2 * the truth (a join multiplying rows)
      expect(aging.total).toBe(COLLIDING_AMOUNT * COLLIDING_COUNT);
      expect(aging.items.length).toBe(COLLIDING_COUNT);
      // Every document is individually reachable — a customer disputing one of
      // three identical invoices must be able to see all three.
      expect(new Set(aging.items.map((i: { id: number }) => i.id)).size).toBe(COLLIDING_COUNT);
    });

    it("🔴 AP aging behaves the same for identical bills", async () => {
      for (let i = 0; i < COLLIDING_COUNT; i++) {
        await pool.query(
          `INSERT INTO bills
             (organization_id, company_id, vendor_id, bill_number, date, due_date,
              subtotal, vat_amount, total, paid_amount, status)
           VALUES ($1,$2,$3,$4,$5,$5,$6,0,$6,0,'approved')`,
          [orgId, companyId, vendorId, `BILL-90000${i}`, COLLIDING_DATE, COLLIDING_AMOUNT],
        );
      }
      const { reportsService } = await import("../services/reports.service");
      const aging = await withOrg(orgId, companyId, () => reportsService.apAging());
      expect(aging.total).toBe(COLLIDING_AMOUNT * COLLIDING_COUNT);
      expect(aging.items.length).toBe(COLLIDING_COUNT);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (b) COLLISION — statement ingest
  // ──────────────────────────────────────────────────────────────────────────
  describe("collision — a statement that genuinely repeats a line", () => {
    /**
     * 🔴 THE DEFECT THIS PINS: duplicate detection keyed on
     * (date, description, amount, type, account) treated a REPEAT as a
     * RE-UPLOAD. A statement listing the same SAR 45.00 charge twice — two
     * taxi rides, two identical fees, two identical transfers — imported ONE
     * of them, and the books understated the expense and its input VAT.
     *
     * The correct discipline is MULTIPLICITY, not existence: import as many
     * copies as the file has MINUS as many as the account already holds.
     * That distinguishes the two events the old code conflated, without asking
     * the user to notice anything.
     */
    const line = (n: number) => ({
      date: "2026-04-02",
      description: "TAXI FARE RIYADH",
      amount: 45,
      type: "debit" as const,
      _n: n,
    });

    it("imports BOTH copies of a genuinely repeated line", async () => {
      const { transactionsService } = await import("../services/transactions.service");
      const res = await withOrg(orgId, companyId, () =>
        transactionsService.upload({
          rows: [line(1), line(2)] as never,
          autoCategrize: false,
          bankAccountId,
        } as never),
        userId,
      );
      expect(res.inserted).toBe(2);
      expect(res.duplicates?.length).toBe(0);
    });

    it("🔴 but a RE-UPLOAD of the same statement imports nothing", async () => {
      const { transactionsService } = await import("../services/transactions.service");
      const res = await withOrg(orgId, companyId, () =>
        transactionsService.upload({
          rows: [line(1), line(2)] as never,
          autoCategrize: false,
          bankAccountId,
        } as never),
        userId,
      );
      expect(res.inserted).toBe(0);
      expect(res.duplicates?.length).toBe(2);
    });

    it("🔴 a statement holding one MORE copy than the account does imports the difference", async () => {
      const { transactionsService } = await import("../services/transactions.service");
      const res = await withOrg(orgId, companyId, () =>
        transactionsService.upload({
          rows: [line(1), line(2), line(3)] as never,
          autoCategrize: false,
          bankAccountId,
        } as never),
        userId,
      );
      // Two are already there; the third is a real third charge.
      expect(res.inserted).toBe(1);
      expect(res.duplicates?.length).toBe(2);
    });

    it("the ledger holds every copy — the books are not understated", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int n, sum(amount)::numeric total
           FROM transactions
          WHERE organization_id = $1 AND description = 'TAXI FARE RIYADH'`,
        [orgId],
      );
      expect(rows[0].n).toBe(3);
      expect(Number(rows[0].total)).toBe(135);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (a) VOLUME — counts and blast radius
  // ──────────────────────────────────────────────────────────────────────────
  describe("volume — counts must describe the set the user thinks they describe", () => {
    beforeAll(async () => {
      // The ingest fixture above left its own pending rows in this org. Mark
      // them reviewed so the counts below have exactly one source — the
      // assertions are about saturation, not about which fixture ran first.
      await pool.query(
        `UPDATE transactions SET review_status = 'accepted'
          WHERE organization_id = $1 AND description = 'TAXI FARE RIYADH'`,
        [orgId],
      );
      const values: string[] = [];
      for (let i = 0; i < PENDING_ROWS; i++) {
        // Confidence high and a category set ⇒ "ready", so the whole fixture
        // is what the bulk button claims to act on.
        values.push(
          `($1, $2, $3, '2026-05-0${(i % 9) + 1}', ${200 + i}, 'Scale row ${i}', 'debit',` +
            ` 'pending_review', 'operating', 0.95, false)`,
        );
      }
      await pool.query(
        `INSERT INTO transactions
           (organization_id, company_id, category_id, date, amount, description, type,
            review_status, kind, confidence_score, is_manually_overridden)
         VALUES ${values.join(",")}`,
        [orgId, companyId, categoryId],
      );
    });

    it("the fixture is LARGER than the review cap (anti-vacuity)", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM transactions
          WHERE organization_id = $1 AND review_status = 'pending_review'`,
        [orgId],
      );
      expect(rows[0].n).toBe(PENDING_ROWS);
      expect(rows[0].n).toBeGreaterThan(REVIEW_CAP);
    });

    it("🔴 the review page's own row list stays capped — that was never the bug", async () => {
      const { transactionsService } = await import("../services/transactions.service");
      const rows = await withOrg(orgId, companyId, () => transactionsService.pendingReview());
      expect(rows.length).toBe(REVIEW_CAP);
    });

    it("🔴 the count backing the BULK ACCEPT button describes every row the server will touch", async () => {
      /**
       * The defect: the button read `Accept ready (N)` with N counted from the
       * 200-row page, then called the bulk endpoint with NO ids — which accepts
       * every safe pending row in the tenant AND POSTS THEM TO THE LEDGER. A
       * tenant with 5,000 rows was shown "183" and one click posted all 5,000.
       * The label understated the blast radius of an accounting act.
       *
       * 🔴 This asserts the CONTROLLER the new label reads, not the repository
       * count underneath it — `pendingReviewCounts` was already correct (B6
       * added it); what did not exist was any way for the page to ask. So the
       * endpoint is the thing that was missing, and the endpoint is what is
       * measured. It fails against the pre-fix tree by not existing.
       *
       * 🔴 HONEST LIMIT, stated rather than implied: nothing here proves the
       * BUTTON renders this number. No test in this suite renders a page — the
       * gap §3 names — so the binding from endpoint to label is verified by
       * reading only.
       */
      const { transactionsController } = await import("../controllers/transactions.controller");
      let body: { total: number; needsAttention: number; ready: number } | null = null;
      const res = { json: (b: unknown) => { body = b as typeof body; } };

      await withOrg(orgId, companyId, async () => {
        await transactionsController.pendingReviewCounts({} as never, res as never);
      });

      expect(body).not.toBeNull();
      expect(body!.total).toBe(PENDING_ROWS);
      // `ready` is what the bulk act will touch, computed server-side so no
      // client can derive it from a page.
      expect(body!.ready).toBe(PENDING_ROWS);
      // The number the broken label showed.
      expect(body!.ready).not.toBe(REVIEW_CAP);
      expect(body!.ready).toBeGreaterThan(REVIEW_CAP);
    });
  });

  describe("volume — the outbox alarm and the operator dashboard", () => {
    beforeAll(async () => {
      // `einvoice_documents` is UNIQUE on invoice_id, so the fixture needs one
      // invoice per document. They are DRAFTS: drafts move nothing in any
      // report, so this bulk cannot disturb the aging assertions above.
      const invValues: string[] = [];
      for (let i = 0; i < OVERDUE_DOCS; i++) {
        invValues.push(
          `($1, $2, $3, 'INV-OUTBOX-${i}', 'invoice', '2026-06-01', '2026-06-30', 100, 15, 115, 0, 'draft')`,
        );
      }
      const inv = await pool.query(
        `INSERT INTO invoices
           (organization_id, company_id, customer_id, invoice_number, document_type,
            date, due_date, subtotal, vat_amount, total, paid_amount, status)
         VALUES ${invValues.join(",")} RETURNING id`,
        [orgId, companyId, customerId],
      );

      const docValues = inv.rows
        .map((r: { id: number }) => `($1, $2, ${r.id}, 'reporting', 'pending', now() - interval '30 hours')`)
        .join(",");
      await pool.query(
        `INSERT INTO einvoice_documents
           (organization_id, company_id, invoice_id, flow, status, created_at)
         VALUES ${docValues}`,
        [orgId, companyId],
      );
    });

    it("the fixture exceeds the outbox page cap (anti-vacuity)", async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM einvoice_documents WHERE organization_id = $1`,
        [orgId],
      );
      expect(rows[0].n).toBe(OVERDUE_DOCS);
      expect(rows[0].n).toBeGreaterThan(OUTBOX_PAGE_CAP);
    });

    it("🔴 the outbox-overdue ALARM pages the true backlog, not the page size", async () => {
      /**
       * This is the alarm that pages a human about ZATCA's 24-hour reporting
       * deadline. It said `${overdue.length} document(s) unsubmitted` off a
       * 500-capped page, so any backlog past 500 paged the words "500
       * document(s)" — forever, however bad it got. 🔴 An alarm that
       * under-reports the condition it exists to detect is quiet neglect (queue
       * B2) wearing the costume of a working alarm.
       *
       * 🔴 It asserts the PAGED PAYLOAD, not the repository count underneath.
       * `countOverdue` was already correct before this fix — a test that called
       * it would have passed against the broken alarm, which is the vacuous
       * green this project keeps catching. What was broken is which of the two
       * numbers the alarm chose, so that is what is measured.
       */
      const { alarmsService } = await import("../services/alerting/alarms.service");
      const { __setAlerterForTests } = await import("../lib/alerter");
      const { ownerDb } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");

      const fired: Array<{ detail: string; context?: Record<string, unknown> }> = [];
      __setAlerterForTests({
        async fire(a) {
          fired.push(a as { detail: string; context?: Record<string, unknown> });
          return { sent: true };
        },
        async resolve() {
          return { sent: true };
        },
      });
      try {
        await ownerDb.execute(sql`DELETE FROM alert_state`);
        await alarmsService.runOnce({ organizationId: orgId });

        expect(fired.length).toBeGreaterThan(0);
        const outbox = fired.find((f) => f.detail.includes("unsubmitted"));
        expect(outbox).toBeDefined();
        expect(outbox!.context?.total).toBe(OVERDUE_DOCS);
        expect(outbox!.detail).toContain(`${OVERDUE_DOCS} document(s) unsubmitted`);
        // 🔴 The number the broken alarm paged. A ROUND count is the shape of a
        // cap, not of data — named so a regression cannot read as plausible.
        expect(outbox!.context?.total).not.toBe(OUTBOX_PAGE_CAP);
        expect(outbox!.detail).not.toContain(`${OUTBOX_PAGE_CAP} document(s) unsubmitted`);
      } finally {
        __setAlerterForTests(null);
        await ownerDb.execute(sql`DELETE FROM alert_state`);
      }
    });

    it("🔴 the operator dashboard's needsReview figure is counted, not measured off a page", async () => {
      /**
       * `operatorZatca.health()` reported `listNeedingReview(500).length`. B6
       * fixed the overdue figure sitting TWO LINES ABOVE it in the same
       * function and left this one — "green fixes the case, not the class",
       * demonstrated inside a single `Promise.all`.
       *
       * 🔴 Asserted through `health()`, not through the repository count it
       * calls: the count was the thing added, but the DEFECT was which number
       * the dashboard chose. `health()` is deliberately unscoped (it is a
       * platform view), so this asserts a LOWER BOUND — other suites may hold
       * needs-review rows of their own, and 537 of them are ours. Under the old
       * code the answer is exactly 500, which is below the bound and therefore
       * red.
       */
      await pool.query(
        `UPDATE einvoice_documents SET status = 'needs_review' WHERE organization_id = $1`,
        [orgId],
      );
      const { operatorZatcaService } = await import("../services/operatorZatca.service");
      const health = await operatorZatcaService.health();

      expect(health.needsReview).toBeGreaterThanOrEqual(OVERDUE_DOCS);
      // 🔴 A ROUND number is the shape of a cap, not of data.
      expect(health.needsReview).not.toBe(OUTBOX_PAGE_CAP);
    });
  });
});
