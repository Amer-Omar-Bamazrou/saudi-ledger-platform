/**
 * Sample data for a local evaluation copy (`pnpm seed:sample`).
 *
 * 🔴 EVERY LEDGER EFFECT GOES THROUGH THE PRODUCT'S OWN WRITE PATHS —
 * `invoicesService`, `billsService`, `transactionsService`,
 * `quotationsService`, `purchaseOrdersService`. Nothing is INSERTed into the
 * GL directly. That is the §4 rule (one writer per effect), and for a
 * demonstration it matters twice over: figures produced by a second path would
 * be figures the product cannot actually produce, so the reports would be
 * showing something the software does not do.
 *
 * It also makes this an instance of standing rule 2 — the reports are
 * validated from real ledger rows, because the rows come from the write path.
 *
 * ── Difference from `demoSeed.service.ts` ──────────────────────────────────
 * That one builds its OWN tenant (`slug: "demo"`) for the hosted demo, with a
 * weekly reset and DEMO_MODE's capability removals around it. This one
 * populates the org the local admin ALREADY belongs to, so a reviewer logs in
 * with their own seeded account and sees the data — no second login, no demo
 * gating. It also covers quotations and purchase orders, which postdate the
 * demo seed.
 *
 * IDEMPOTENT: keyed on a marker customer. Re-running is a no-op rather than a
 * second set of invoices, so a reviewer who runs it twice does not silently
 * double every figure in the reports.
 *
 * 🔴 ON PARTIAL FAILURE, IT SELF-HEALS OR TELLS YOU HOW TO RESET.
 *
 * Two designs were tried. A single transaction around the whole seed is the
 * obvious "all or nothing" answer and it does NOT work here: the tenant role
 * carries `statement_timeout=8s` and the connection is killed by an
 * idle-in-transaction timeout long before a multi-step seed commits. Those
 * guardrails exist for good reasons and a seed should not be the thing that
 * argues with them.
 *
 * So: per-step commits (what `demoSeed.service.ts` also does), counterparties
 * are GET-OR-CREATE so the common partial case heals on re-run, and any
 * failure prints the exact reset command rather than leaving a reviewer to
 * work it out. "It failed and now you cannot re-run it" is the one outcome
 * that must not be possible for a script whose whole job is to produce an
 * evaluation copy.
 */
// Load apps/api/.env exactly as the API itself does (index.ts does the same
// import). Without this, running via `pnpm --filter ... run seed:sample`
// finds no DATABASE_URL and dies at @workspace/db import time — the doc
// promises "it reads apps/api/.env", and this line is what makes that true.
import "dotenv/config";
import { pool, sessionPool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { customersService } from "../services/customers.service";
import { vendorsService } from "../services/vendors.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { transactionsService } from "../services/transactions.service";
import { quotationsService } from "../services/quotations.service";
import { purchaseOrdersService } from "../services/purchaseOrders.service";
import { companiesService } from "../services/companies.service";

/** The marker that makes a re-run a no-op. */
const MARKER_CUSTOMER = "Najd Contracting Co.";

/** Dates spread over three months so the trend charts have more than one point. */
const M1 = "2026-06";
const M2 = "2026-07";
const M3 = "2026-08";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  if (!email) {
    throw new Error(
      "SEED_ADMIN_EMAIL is required — it names the admin whose organization gets the sample data. Use the same value you passed to `pnpm --filter @workspace/db run seed`.",
    );
  }

  // Resolve the tenant from the admin's ACTIVE membership. The identity tables
  // are outside RLS and this is a script on the owner connection, which is the
  // sanctioned consumer (CLAUDE.md §4) — the business layer must never do this.
  const { rows } = await pool.query(
    `SELECT m.organization_id, m.user_id, c.id AS company_id, o.name AS org_name, c.name AS company_name
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       JOIN companies c ON c.organization_id = o.id
      WHERE u.email = $1 AND m.status = 'active'
      ORDER BY c.created_at ASC
      LIMIT 1`,
    [email],
  );
  if (rows.length === 0) {
    throw new Error(
      `No active membership found for ${email}. Run the base seed first:\n` +
        `  SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... pnpm --filter @workspace/db run seed`,
    );
  }
  const { organization_id: organizationId, company_id: companyId, user_id: userId, org_name, company_name } = rows[0];
  console.log(`[sample] tenant: ${org_name} / ${company_name}`);

  // Per-step commits — see the header. A single wrapping transaction was tried
  // and is structurally impossible here: `beginTenantConnection` sets an
  // idle_in_transaction_session_timeout on the tenant connection (a guardrail
  // worth keeping), and a multi-step seed idles past it between statements —
  // the final COMMIT then dies and EVERYTHING rolls back, after the summary
  // has already printed. That exact failure happened, and it is the
  // "no-op reporting success" shape: a seed that says done and wrote nothing.
  const inTenant = async <T>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };

  await seedAll(inTenant, userId);

  // 🔴 VERIFY FROM OUTSIDE THE WRITE PATH before claiming success. The summary
  // below is printed from returned objects, which exist even inside a doomed
  // transaction — so the claim "done" is only made after an independent read
  // on the owner pool confirms rows are actually visible post-commit.
  const { rows: verify } = await pool.query(
    `SELECT (SELECT count(*)::int FROM invoices    WHERE organization_id=$1) AS invoices,
            (SELECT count(*)::int FROM quotations  WHERE organization_id=$1) AS quotations,
            (SELECT count(*)::int FROM purchase_orders WHERE organization_id=$1) AS pos`,
    [organizationId],
  );
  if (verify[0].invoices === 0 || verify[0].quotations === 0 || verify[0].pos === 0) {
    throw new Error(
      `post-commit verification failed: invoices=${verify[0].invoices} quotations=${verify[0].quotations} purchase_orders=${verify[0].pos} — the seed reported steps but the rows are not visible from a separate connection.`,
    );
  }
  console.log(`[sample] verified from a separate connection: invoices=${verify[0].invoices}, quotations=${verify[0].quotations}, purchase_orders=${verify[0].pos}`);
  // Close BOTH pools. `@workspace/db` opens a second, dedicated pool for the
  // session store; leaving it open kept the process alive and surfaced as an
  // unhandled pg 'error' event AFTER the seed had already succeeded — which
  // reads like a failed seed and is not one.
  await pool.end();
  await sessionPool.end();
}

type InTenant = <T>(fn: () => Promise<T>) => Promise<T>;

async function seedAll(inTenant: InTenant, userId: number) {

  // 🔴 The guard keys on the LAST thing created (a purchase order), not the
  // first. Keying on the first would make a half-finished run report "already
  // seeded" over an incomplete org — which is how the first draft failed.
  const priorPos = await inTenant(() => purchaseOrdersService.list({} as never));
  if (priorPos.length > 0) {
    console.log("[sample] already seeded — nothing to do (re-running is a no-op by design).");
    return;
  }

  // ── The company's ZATCA identity ─────────────────────────────────────────
  // 🔴 Without this, NOTHING can be issued. The base seed creates a company
  // with no VAT number, and M11.6 made issuance FAIL CLOSED on that — "Your
  // company's VAT registration number is required to issue an invoice." That
  // is correct product behaviour (a placeholder VAT on a real invoice was a
  // production blocker), but it means an evaluation copy cannot show a single
  // issued document until the field is set.
  //
  // These are deliberately obvious test values in the valid ZATCA format
  // (15 digits, first and last '3'). They are safe here because nothing is
  // transmitted from a local copy — and they must NEVER become a default in
  // the product itself, which is exactly the blocker M11.6 removed.
  await inTenant(() =>
    companiesService.updateCurrent({
      vatNumber: "399999999999993",
      crNumber: "1010101010",
    } as never),
  );

  // ── Counterparties and a bank account ────────────────────────────────────
  // GET-OR-CREATE: a re-run after a partial failure reuses what is already
  // there instead of producing a second "Najd Contracting Co.".
  // A page, asked for explicitly: these lookups scan the seeded set, which is
  // far smaller than the ceiling, and an implicit default would be a silent cap.
  const customers = (await inTenant(() => customersService.list({ limit: 200 } as never))).items;
  const vendors = (await inTenant(() => vendorsService.list({ limit: 200 } as never))).items;
  const findC = (name: string) => customers.find((c: { name: string }) => c.name === name);
  const findV = (name: string) => vendors.find((v: { name: string }) => v.name === name);

  const custA = findC(MARKER_CUSTOMER) ?? (await inTenant(() => customersService.create({ name: MARKER_CUSTOMER, nameAr: "شركة نجد للمقاولات", email: "ap@najd.example.sa", taxNumber: "310000000000003" } as never)));
  const custB = findC("Rawabi Logistics") ?? (await inTenant(() => customersService.create({ name: "Rawabi Logistics", nameAr: "روابي للخدمات اللوجستية", email: "finance@rawabi.example.sa", taxNumber: "311111111111113" } as never)));
  const vendA = findV("Gulf Office Supplies") ?? (await inTenant(() => vendorsService.create({ name: "Gulf Office Supplies", nameAr: "الخليج للقرطاسية", taxNumber: "300000000000003" } as never)));
  const vendB = findV("Tamimi Facilities") ?? (await inTenant(() => vendorsService.create({ name: "Tamimi Facilities", nameAr: "التميمي للمرافق", taxNumber: "301111111111113" } as never)));

  const bank = await inTenant(() =>
    bankAccountsService.create({
      name: "Main Operating Account",
      bankName: "Al Rajhi Bank",
      accountNumber: "608010167519",
      iban: "SA0380000000608010167519",
      openingBalance: 50000,
      currency: "SAR",
    } as never),
  );

  // ── Invoices: issued (so they post) across three months ──────────────────
  // These are ISSUED invoices — created as drafts, then approved explicitly, which
  // is what makes revenue, AR and output VAT appear in the reports.
  const invoiceSpecs = [
    { date: `${M1}-08`, customerId: custA.id, items: [{ description: "Site survey — phase 1", quantity: 1, unitPrice: 18000, vatRate: 15 }] },
    { date: `${M1}-22`, customerId: custB.id, items: [{ description: "Fleet haulage — June", quantity: 12, unitPrice: 850, vatRate: 15 }] },
    { date: `${M2}-06`, customerId: custA.id, items: [{ description: "Site survey — phase 2", quantity: 1, unitPrice: 22500, vatRate: 15 }, { description: "Drone imagery", quantity: 3, unitPrice: 1200, vatRate: 15 }] },
    { date: `${M2}-27`, customerId: custB.id, items: [{ description: "Fleet haulage — July", quantity: 14, unitPrice: 850, vatRate: 15 }] },
    { date: `${M3}-11`, customerId: custA.id, items: [{ description: "Consulting retainer", quantity: 1, unitPrice: 15000, vatRate: 15 }] },
  ];
  const invoices: { id: number; total: number }[] = [];
  for (const spec of invoiceSpecs) {
    // 🔴 Two acts, not one: auto-approve was removed from the product
    // (2026-08-28), so a seed that wants an ISSUED invoice issues it explicitly.
    invoices.push(
      await inTenant(async () => {
        const draft = await invoicesService.create(spec as never, userId);
        return invoicesService.approve((draft as { id: number }).id, userId);
      }),
    );
  }

  // One invoice PAID in full and one PARTIALLY paid, so AR aging, the
  // receivables bridge and the dated payment history (B4) all have something
  // to show rather than a single undifferentiated balance.
  await inTenant(() => invoicesService.pay(invoices[0].id, { amount: invoices[0].total, paidAt: `${M1}-30` }, userId));
  await inTenant(() => invoicesService.pay(invoices[2].id, { amount: 10000, paidAt: `${M2}-20` }, userId));

  // ── Bills: approved, so AP and input VAT appear ──────────────────────────
  const billSpecs = [
    { billNumber: "GOS-4471", date: `${M1}-12`, vendorId: vendA.id, items: [{ description: "Office consumables", quantity: 1, unitPrice: 2400, vatRate: 15 }] },
    { billNumber: "TAM-2210", date: `${M2}-03`, vendorId: vendB.id, items: [{ description: "Facilities management — July", quantity: 1, unitPrice: 9500, vatRate: 15 }] },
    { billNumber: "GOS-4620", date: `${M3}-05`, vendorId: vendA.id, items: [{ description: "Printer toner", quantity: 6, unitPrice: 310, vatRate: 15 }] },
  ];
  const bills: { id: number }[] = [];
  for (const spec of billSpecs) {
    const bill = await inTenant(() => billsService.create(spec as never, userId));
    bills.push(await inTenant(() => billsService.approve(bill.id, {}, userId)));
  }
  await inTenant(() => billsService.pay(bills[0].id, { amount: 2760, paidAt: `${M1}-28` }, userId));

  // ── Bank transactions ────────────────────────────────────────────────────
  // Left UNCATEGORISED on purpose. An accepted uncategorised row posts to
  // SUSPENSE, which is visible in the reports and is exactly the behaviour a
  // reviewer should see — the platform showing what it does not know rather
  // than guessing a category. Categorising them from /review is the demo.
  const txSpecs = [
    { date: `${M3}-02`, description: "POS SETTLEMENT MADA", amount: 4820.5, type: "credit" },
    { date: `${M3}-04`, description: "STC PAYMENT", amount: 640, type: "debit" },
    { date: `${M3}-09`, description: "SALARY TRANSFER", amount: 28000, type: "debit" },
    { date: `${M3}-14`, description: "BANK CHARGES", amount: 75, type: "debit" },
    { date: `${M3}-18`, description: "CUSTOMER DEPOSIT — NAJD", amount: 12000, type: "credit" },
  ];
  for (const t of txSpecs) {
    await inTenant(() =>
      transactionsService.create({ ...t, currency: "SAR", bankAccountId: bank.id } as never),
    );
  }

  // ── A quotation (M21.1/M21.2) — approved, partially converted ────────────
  // Partially converted so the reviewer sees the state that only exists
  // because partial conversion is supported: approved AND partly invoiced.
  const quotation = await inTenant(() =>
    quotationsService.create(
      {
        date: `${M3}-03`,
        validUntil: `${M3}-31`,
        customerId: custB.id,
        items: [
          { description: "Warehouse fit-out — racking", quantity: 40, unitPrice: 650, vatRate: 15 },
          { description: "Installation labour", quantity: 10, unitPrice: 900, vatRate: 15 },
        ],
      } as never,
      userId,
    ),
  );
  await inTenant(() => quotationsService.approve((quotation as { id: number }).id, userId));

  // ── A purchase order (M21.3) — approved, partially billed ────────────────
  const po = await inTenant(() =>
    purchaseOrdersService.create(
      {
        date: `${M3}-06`,
        vendorId: vendA.id,
        items: [
          { description: "Steel racking units", quantity: 40, unitPrice: 410, vatRate: 15 },
          { description: "Safety signage", quantity: 25, unitPrice: 60, vatRate: 15 },
        ],
      } as never,
      userId,
    ),
  );
  await inTenant(() => purchaseOrdersService.approve((po as { id: number }).id, userId));

  console.log(
    [
      "[sample] done:",
      `  customers        2  (${MARKER_CUSTOMER}, Rawabi Logistics)`,
      "  vendors          2",
      "  bank account     1",
      `  invoices         ${invoices.length} issued — 1 paid in full, 1 part-paid`,
      `  bills            ${bills.length} approved — 1 paid`,
      `  transactions     ${txSpecs.length} uncategorised (post to SUSPENSE until reviewed)`,
      `  quotation        1 approved (${quotation.quotationNumber})`,
      `  purchase order   1 approved (${po.orderNumber})`,
      "",
      "  Convert the quotation from /quotations and record a supplier bill",
      "  against the PO from /purchase-orders to see partial conversion.",
      "  Categorise the bank rows from /review to clear SUSPENSE.",
    ].join("\n"),
  );

}

main().catch(async (err) => {
  console.error("[sample] FAILED:", err instanceof Error ? err.message : err);
  console.error(
    [
      "",
      "  Counterparties are get-or-create, so re-running is usually safe and will",
      "  carry on from where it stopped:",
      "    pnpm --filter @workspace/api-server run seed:sample",
      "",
      "  If the data looks half-written and you would rather start clean:",
      "    supabase db reset",
      "    pnpm --filter @workspace/db run migrate",
      "    SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... pnpm --filter @workspace/db run seed",
      "    pnpm --filter @workspace/api-server run seed:sample",
    ].join(String.fromCharCode(10)),
  );
  await pool.end().catch(() => {});
  await sessionPool.end().catch(() => {});
  process.exit(1);
});
