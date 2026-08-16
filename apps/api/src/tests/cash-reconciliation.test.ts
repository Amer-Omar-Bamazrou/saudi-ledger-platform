/**
 * M19.7 — bank movement vs ledger cash, and the gap accounted for line by line.
 *
 * 🔴 THE PROPERTY THIS FILE EXISTS FOR IS `unexplained === 0`.
 *
 * Two stores answer "what happened to cash" and disagree. That is tolerable
 * only under the M16 Q0 discipline — each figure says which question it
 * answers, and the difference is ITEMISED. A gap merely displayed is a
 * discrepancy the reader has to take on trust; a gap itemised is a
 * reconciliation. `unexplained` is the difference between the two, and the
 * moment it is non-zero the page is showing a reconciliation that does not
 * reconcile.
 *
 * So these tests construct each cause deliberately — a transfer, a settlement,
 * a document payment with no transaction — and assert that after every one the
 * remainder is still zero. Asserting the FIGURES would pass vacuously the day
 * someone adds a fifth cause; asserting the remainder fails loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { cashService } from "../services/cash.service";
import { monthsBetween } from "../services/analytics.service";
import { invoicesService } from "../services/invoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[cash-reconciliation] no real DATABASE_URL — skipping.");

const SLUG = "m19-cash";
const EMAIL = "m19-cash@test.local";
const FROM = "2026-01";
const TO = "2026-03";

describeMaybe("M19.7 — the cash gap is itemised, not merely shown", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let seq = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId: orgId,
      companyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of [
      "transactions",
      "journal_entry_lines",
      "journal_entries",
      "invoice_items",
      "invoices",
      "customers",
      "categories",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(
      `DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`,
    );
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('Cash Org','${SLUG}') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number)
         VALUES ($1,'Cash Co','1010101013','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active)
         VALUES ('${EMAIL}','CA',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status)
       VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name) VALUES ($1,'Cash Customer') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** A raw accepted transaction — the shape the bank side is built from. */
  const tx = (opts: {
    date: string;
    amount: number;
    type: "credit" | "debit";
    kind: string;
    posted?: boolean;
  }) =>
    pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind,
          review_status, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',NULL)`,
      [
        orgId,
        companyId,
        opts.date,
        `${opts.kind} ${++seq}`,
        opts.amount.toFixed(2),
        opts.type,
        opts.kind,
      ],
    );

  const recon = () =>
    inTenant(() => cashService.reconciliation(FROM, TO, monthsBetween(FROM, TO)));

  it("agrees exactly when nothing has happened", async () => {
    const { summary } = await recon();
    expect(summary.bankMovement).toBe(0);
    expect(summary.ledgerCash).toBe(0);
    expect(summary.gap).toBe(0);
    expect(summary.unexplained).toBe(0);
  });

  it("🔴 an UNDECLARED transfer is reported as undeclared — not assumed either way", async () => {
    // 🔴 B5's whole point. A transfer with no declared direction must NOT be
    // silently treated as internal (which would say the ledger is fine) or as
    // external (which would say the ledger is wrong). Both are assertions
    // nobody made. It gets its own line, and its own number on the summary.
    await tx({ date: "2026-01-10", amount: 5_000, type: "debit", kind: "transfer" });

    const { summary } = await recon();
    expect(summary.bankMovement).toBe(-5_000);
    expect(summary.ledgerCash).toBe(0);
    expect(summary.gap).toBe(-5_000);
    expect(summary.items.find((i) => i.code === "transfers_undeclared")?.amount).toBe(-5_000);
    expect(summary.items.find((i) => i.code === "transfers_own_account")).toBeUndefined();
    expect(summary.items.find((i) => i.code === "transfers_external")).toBeUndefined();
    expect(summary.undeclaredTransfers, "surfaced so the page can ASK").toBe(-5_000);
    expect(summary.unexplained, "the gap is fully attributed").toBe(0);
  });

  it("🔴 declaring OWN ACCOUNT says the ledger was right all along", async () => {
    // Money between the business's own pockets: business cash did not change,
    // so the ledger's silence is correct and the gap has an innocent cause.
    await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind,
          review_status, transfer_direction)
       VALUES ($1,$2,'2026-01-15','own move','2000.00','debit','transfer','accepted','own_account')`,
      [orgId, companyId],
    );
    const { summary } = await recon();
    expect(summary.items.find((i) => i.code === "transfers_own_account")?.amount).toBe(-2_000);
    expect(summary.undeclaredTransfers, "unchanged — this one was declared").toBe(-5_000);
    expect(summary.unexplained).toBe(0);
  });

  it("🔴 declaring EXTERNAL says the ledger is genuinely understating cash", async () => {
    // Owner drawings, cash withdrawn and kept: business cash really fell, and
    // the ledger has no entry for it. Same arithmetic as own_account, opposite
    // meaning — which is exactly why they cannot share a line.
    await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind,
          review_status, transfer_direction)
       VALUES ($1,$2,'2026-01-20','drawings','1000.00','debit','transfer','accepted','external')`,
      [orgId, companyId],
    );
    const { summary } = await recon();
    expect(summary.items.find((i) => i.code === "transfers_external")?.amount).toBe(-1_000);
    expect(summary.unexplained).toBe(0);
  });

  it("🔴 a SETTLEMENT does the same, under its own name", async () => {
    // Its ledger effect was posted by the pay path, possibly in another period.
    // Lumping it with transfers would hide that they are excluded for different
    // reasons and would need different fixes.
    // A settlement must NAME the document it settles (DB CHECK
    // `transactions_settlement_names_document`, migration 0034) — a real
    // write-boundary invariant, so the fixture supplies a real invoice.
    const settled = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: `CASH-SET-${++seq}`,
          date: "2026-02-01",
          customerId,
          items: [{ description: "Settled work", quantity: 1, unitPrice: 3_000, vatRate: 0, taxCategoryCode: "O" }],
        },
        userId,
        { autoApprove: true },
      ),
    );
    await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind,
          review_status, settles_invoice_id)
       VALUES ($1,$2,'2026-02-05','settlement',$3,'credit','settlement','accepted',$4)`,
      [orgId, companyId, "3000.00", settled.id],
    );

    const { summary } = await recon();
    expect(summary.items.find((i) => i.code === "settlements")?.amount).toBe(3_000);
    expect(summary.unexplained).toBe(0);
  });

  it("🔴 a DOCUMENT PAYMENT moves the ledger and not the bank — the opposite direction", async () => {
    // `invoicesService.pay` posts Dr Cash / Cr AR and writes NO transaction, so
    // this is the one cause that pushes ledger cash ABOVE bank movement. The
    // sign matters: attributing it the wrong way round would still sum to the
    // gap while describing the reverse of what happened.
    const inv = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: `CASH-${++seq}`,
          date: "2026-03-02",
          customerId,
          items: [{ description: "Service", quantity: 1, unitPrice: 1_000, vatRate: 15 }],
        },
        userId,
        { autoApprove: true },
      ),
    );
    await inTenant(() =>
      invoicesService.pay(inv.id, { amount: 1_150, paidAt: "2026-03-20" }, userId),
    );

    const { summary } = await recon();
    expect(summary.ledgerCash).toBe(1_150);
    const ledgerOnly = summary.items.find((i) => i.code === "ledger_only");
    expect(ledgerOnly?.amount, "ledger-only cash REDUCES bank minus ledger").toBe(-1_150);
    expect(summary.unexplained).toBe(0);
  });

  it("🔴 with every cause present at once, the remainder is STILL zero", async () => {
    // The assertion that would catch a fifth cause appearing: each individual
    // figure could be right while their sum silently failed to close the gap.
    const { summary } = await recon();
    const summed = summary.items.reduce((s, i) => s + i.amount, 0);
    expect(Math.abs(summed - summary.gap), "items must sum to the gap").toBeLessThan(0.005);
    expect(summary.unexplained).toBe(0);
  });

  it("per-month points carry their own gap, and it reconciles per month too", async () => {
    const { points } = await recon();
    for (const p of points) {
      expect(
        Math.abs(p.bankMovement - p.ledgerCash - p.gap),
        `${p.period}: ${p.bankMovement} − ${p.ledgerCash} ≠ ${p.gap}`,
      ).toBeLessThan(0.005);
    }
    expect(points.map((p) => p.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("🔴 a PENDING row contributes to neither figure", async () => {
    // M15's rule: an un-reviewed bank line is evidence, not a fact. Including
    // it in "bank movement" would make the headline figure change as somebody
    // works through the review queue.
    await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind, review_status)
       VALUES ($1,$2,'2026-02-11','pending row','999.00','debit','operating','pending_review')`,
      [orgId, companyId],
    );
    const { summary } = await recon();
    // −5,000 undeclared − 2,000 own-account − 1,000 external + 3,000 settlement
    expect(summary.bankMovement).toBe(-5_000);
    expect(summary.unexplained).toBe(0);
  });
});
