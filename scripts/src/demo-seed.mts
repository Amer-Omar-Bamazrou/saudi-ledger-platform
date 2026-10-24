/**
 * DEMO SEED — enough data that every page renders ROWS, not empty states, and
 * enough pending invoices that the approvals queue would have hit the old
 * 50-row cap (contract batch 5).
 *
 * Idempotent: it deletes anything it previously created for the demo company
 * (rows whose document number starts with the demo prefix) and re-inserts.
 * It never touches rows it did not create.
 *
 * Run:  pnpm --filter @workspace/db run seed          (creates org/company/admin)
 *       DEMO_MODE=1 tsx scripts/src/demo-seed.mts     (this file)
 *
 * G71 (Phase 18; owner decision 2026-10-21): it REFUSES to run unless
 * `DEMO_MODE=1` is set (checked before any query), and its payroll wipe is
 * limited to the payroll it created itself: DRAFT runs of the `default`
 * organization whose every item belongs to one of its `DEMO-` employees. It
 * used to delete EVERY payroll run of that organization, outside demo mode too.
 */
import { pool } from "@workspace/db";

const P = "DEMO-";
const YEAR = new Date().getFullYear();
const d = (mm: number, dd: number) => `${YEAR}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

/** G71: the refusal comes before the first query; nothing is read or written outside demo mode. */
function refuseOutsideDemoMode(): void {
  if (process.env.DEMO_MODE !== "1") {
    throw new Error(
      "demo-seed refuses to run: DEMO_MODE=1 is not set. It deletes and re-creates demo rows in the 'default' organization, so it runs only on a demo database.",
    );
  }
}

async function main() {
  refuseOutsideDemoMode();
  const org = await pool.query(`SELECT id FROM organizations WHERE slug = 'default'`);
  if (!org.rows[0]) throw new Error("No 'default' organization — run `pnpm --filter @workspace/db run seed` first.");
  const orgId = org.rows[0].id as string;
  const comp = await pool.query(`SELECT id FROM companies WHERE organization_id = $1 ORDER BY created_at LIMIT 1`, [orgId]);
  if (!comp.rows[0]) throw new Error("No company for the default organization.");
  const companyId = comp.rows[0].id as string;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  // ── wipe only what this script created ────────────────────────────────────
  // 🔴 G16 (Phase 18; owner decision 6, 2026-10-22): the wipe is ONE transaction
  // on one connection, so it lands whole or not at all (a failure exits the
  // process, and the dropped connection rolls it back). The journal rows go in
  // replica mode — the only bypass of the posted-journal freeze, owner-only —
  // and ONLY them: everything else is deleted with its triggers and cascades on.
  const wipeClient = await pool.connect();
  const w = (sql: string, params: unknown[] = []) => wipeClient.query(sql, params);
  await w("BEGIN");
  await w(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=$1 AND invoice_number LIKE $2)`, [orgId, `${P}%`]);
  await w(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=$1 AND invoice_number LIKE $2)`, [orgId, `${P}%`]);
  await w(`DELETE FROM invoices WHERE organization_id=$1 AND invoice_number LIKE $2`, [orgId, `${P}%`]);
  await w(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=$1 AND bill_number LIKE $2)`, [orgId, `${P}%`]);
  await w(`DELETE FROM bills WHERE organization_id=$1 AND bill_number LIKE $2`, [orgId, `${P}%`]);
  await w("SET LOCAL session_replication_role = replica");
  await w(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=$1 AND entry_number LIKE $2)`, [orgId, `${P}%`]);
  await w(`DELETE FROM journal_entries WHERE organization_id=$1 AND entry_number LIKE $2`, [orgId, `${P}%`]);
  await w("SET LOCAL session_replication_role = origin");
  await w(`DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE organization_id=$1 AND quotation_number LIKE $2)`, [orgId, `${P}%`]);
  await w(`DELETE FROM quotations WHERE organization_id=$1 AND quotation_number LIKE $2`, [orgId, `${P}%`]);
  await w(`DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=$1 AND order_number LIKE $2)`, [orgId, `${P}%`]);
  await w(`DELETE FROM purchase_orders WHERE organization_id=$1 AND order_number LIKE $2`, [orgId, `${P}%`]);
  // G71: only the payroll THIS script created: a DRAFT run (it inserts its run as draft) with at least one
  // item, every item an employee it created (`DEMO-`). A run anyone approved or paid, or one naming any
  // other employee, is never touched. The ids are read first, so the items can go before their run.
  const demoRuns = (await w(
    `SELECT r.id FROM payroll_runs r
      WHERE r.organization_id=$1 AND r.status='draft'
        AND EXISTS (SELECT 1 FROM payroll_items i WHERE i.payroll_run_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM payroll_items i JOIN employees e ON e.id=i.employee_id
                         WHERE i.payroll_run_id=r.id AND e.employee_number NOT LIKE $2)`,
    [orgId, `${P}%`],
  )).rows.map((r) => r.id as number);
  await w(`DELETE FROM payroll_items WHERE payroll_run_id = ANY($1::int[])`, [demoRuns]);
  await w(`DELETE FROM payroll_runs WHERE id = ANY($1::int[])`, [demoRuns]);
  // Only the DRAFT assets this script created: one someone capitalised (and its schedule and events) is never
  // touched, and the insert below skips its number. (`depreciation_entries` went with migration 0087.)
  await w(`DELETE FROM fixed_assets WHERE organization_id=$1 AND asset_number LIKE $2 AND status = 'draft'`, [orgId, `${P}%`]);
  await w(`DELETE FROM employees WHERE organization_id=$1 AND employee_number LIKE $2`, [orgId, `${P}%`]);
  // Only budgets whose every version is still a DRAFT: a submitted or approved budget is a record the
  // database keeps (0112), and the insert below skips it.
  await w(
    `DELETE FROM budgets WHERE organization_id=$1 AND name LIKE $2
        AND NOT EXISTS (SELECT 1 FROM budget_versions v WHERE v.budget_id = budgets.id AND v.status <> 'draft')`,
    [orgId, `${P}%`],
  );
  await w(`DELETE FROM transactions WHERE organization_id=$1 AND description LIKE $2`, [orgId, `${P}%`]);
  await w(`DELETE FROM bank_accounts WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);
  await w(`DELETE FROM customers WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);
  await w(`DELETE FROM vendors WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);

  // 🔴 QA fix (2026-09-04): sweep DEBRIS, not just this script's own rows.
  // The demo DB accumulates exploratory junk from manual sessions — a
  // SAR 0.00 draft bill named "PROBE-1" with no vendor sat on the demo with a
  // live "Post" button, exactly the kind of thing someone clicks. A zero-total
  // DRAFT with no party is not a real document by any path (every real create
  // requires a priced line and, for bills, an amount), so it is safe to
  // remove. Scoped to the demo org and to drafts only — a posted or
  // party-bearing row is never touched.
  await w(
    `DELETE FROM bill_items WHERE bill_id IN (
       SELECT id FROM bills WHERE organization_id=$1 AND status='draft'
         AND total::numeric = 0 AND vendor_id IS NULL)`,
    [orgId],
  );
  await w(
    `DELETE FROM bills WHERE organization_id=$1 AND status='draft'
       AND total::numeric = 0 AND vendor_id IS NULL`,
    [orgId],
  );
  await w(
    `DELETE FROM invoice_items WHERE invoice_id IN (
       SELECT id FROM invoices WHERE organization_id=$1 AND status='draft'
         AND total::numeric = 0 AND customer_id IS NULL)`,
    [orgId],
  );
  await w(
    `DELETE FROM invoices WHERE organization_id=$1 AND status='draft'
       AND total::numeric = 0 AND customer_id IS NULL`,
    [orgId],
  );
  await w("COMMIT");
  wipeClient.release();

  // ── parties ───────────────────────────────────────────────────────────────
  const customers: number[] = [];
  for (const [i, [name, ar, vat]] of ([
    ["Al-Faisal Trading Co.", "شركة الفيصل التجارية", "310111111100003"],
    ["Riyadh Tech Solutions", "حلول الرياض التقنية", "310222222200003"],
    ["Jeddah Logistics Ltd", "جدة للخدمات اللوجستية", "310333333300003"],
  ] as const).entries()) {
    const r = await q(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, city, phone, email, payment_terms_days, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'30',$9) RETURNING id`,
      [orgId, `${P}${name}`, ar, vat, `10100000${i}1`, ["Riyadh", "Riyadh", "Jeddah"][i], "+96650000000" + i, `ap${i}@example.sa`, i === 0 ? "250000.00" : null],
    );
    customers.push(Number(r.rows[0].id));
  }
  const vendors: number[] = [];
  for (const [i, [name, ar]] of ([
    ["Gulf Office Supplies", "الخليج للأدوات المكتبية"],
    ["Najd Facilities Services", "نجد للخدمات"],
  ] as const).entries()) {
    const r = await q(
      `INSERT INTO vendors (organization_id, name, name_ar, tax_number, city, iban, payment_terms_days)
       VALUES ($1,$2,$3,$4,$5,$6,'30') RETURNING id`,
      [orgId, `${P}${name}`, ar, `31099999${i}00003`, "Riyadh", "SA0380000000608010167519"],
    );
    vendors.push(Number(r.rows[0].id));
  }

  // ── invoices: 5 awaiting approval, and 60 PENDING drafts (the old cap was 50) ────
  // 🔴 NEVER INSERTED ISSUED (PR C, migration 0125): an invoice is issued only by
  // its approval — the issuing write assigns its place in the chain, its ICV,
  // hash, QR and seller, and posts its entry — and the database refuses a row
  // inserted already issued (`invoice_inserted_issued`). This script writes raw
  // rows and cannot issue; approve these through the product (the Approvals
  // queue, or `invoicesService.approve` — `services/demo/demoSeed` does exactly
  // that) to get issued and paid invoices with their entries.
  const awaiting: Array<[string, number, number, number, string]> = [
    [`${P}INV-1001`, 12000, 1800, 13800, d(3, 5)],
    [`${P}INV-1002`, 8000, 1200, 9200, d(4, 12)],
    [`${P}INV-1003`, 15000, 2250, 17250, d(5, 2)],
    [`${P}INV-1004`, 6400, 960, 7360, d(6, 18)],
    [`${P}INV-1005`, 22000, 3300, 25300, d(7, 9)],
  ];
  for (const [num, sub, vat, total, date] of awaiting) {
    const r = await q(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,$8,$9,0,'submitted') RETURNING id`,
      [orgId, companyId, customers[0], num, date, date, sub, vat, total],
    );
    await q(
      `INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, description_ar, quantity, unit_price, vat_rate, vat_amount, total, tax_category_code)
       VALUES ($1,$2,$3,'Professional services','خدمات مهنية',1,$4,15,$5,$6,'S')`,
      [orgId, companyId, r.rows[0].id, sub, vat, total],
    );
  }
  // 🔴 60 pending drafts — the approvals queue used to show at most 50.
  for (let i = 1; i <= 60; i++) {
    const r = await q(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,$4,'invoice',$5,$5,$6,$7,$8,0,'draft') RETURNING id`,
      [orgId, companyId, customers[i % 3], `${P}INV-2${String(i).padStart(3, "0")}`, d(8, ((i - 1) % 28) + 1), 1000 + i * 10, (1000 + i * 10) * 0.15, (1000 + i * 10) * 1.15],
    );
    await q(
      `INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, description_ar, quantity, unit_price, vat_rate, vat_amount, total, tax_category_code)
       VALUES ($1,$2,$3,'Monthly retainer','أتعاب شهرية',1,$4,15,$5,$6,'S')`,
      [orgId, companyId, r.rows[0].id, 1000 + i * 10, (1000 + i * 10) * 0.15, (1000 + i * 10) * 1.15],
    );
  }

  // ── bills (one submitted → it appears in the queue) ────────────────────────
  // 🔴 NEVER INSERTED POSTED (Phase 13B-3, migration 0109): a posted bill's
  // input VAT is recorded as events by the APPROVAL, in the same transaction
  // as its GL entry, and the database refuses at commit a posted bill whose
  // VAT has neither (`bills_input_vat_cache_consistency`). This script writes
  // raw rows and cannot post; approve these through the product (the
  // Approvals queue, or `billsService.approve` — `services/demo/demoSeed`
  // does exactly that) to get posted bills with their entries and events.
  for (const [num, sub, vat, total, date, status] of [
    [`${P}BILL-501`, 3000, 450, 3450, d(4, 3), "draft"],
    [`${P}BILL-502`, 1800, 270, 2070, d(6, 21), "draft"],
    [`${P}BILL-503`, 950, 142.5, 1092.5, d(8, 8), "submitted"],
  ] as const) {
    const r = await q(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,0,$9) RETURNING id`,
      [orgId, companyId, vendors[0], num, date, sub, vat, total, status],
    );
    await q(
      `INSERT INTO bill_items (organization_id, company_id, bill_id, description, quantity, unit_price, vat_rate, vat_amount, total)
       VALUES ($1,$2,$3,'Office supplies',1,$4,15,$5,$6)`,
      [orgId, companyId, r.rows[0].id, sub, vat, total],
    );
  }

  // ── journal entries: posted (so reports have rows) + 2 drafts for the queue ─
  const acct = async (code: string) => {
    const r = await q(`SELECT id, name FROM categories WHERE organization_id=$1 AND system_code=$2`, [orgId, code]);
    return r.rows[0] ? { id: Number(r.rows[0].id), name: r.rows[0].name as string } : null;
  };
  const anyOf = async (type: string) => {
    const r = await q(`SELECT id, name FROM categories WHERE organization_id=$1 AND type=$2 ORDER BY id LIMIT 1`, [orgId, type]);
    return { id: Number(r.rows[0].id), name: r.rows[0].name as string };
  };
  // D-3: cash lines sit on a bank's own GL account, so the bank comes first.
  const bank = await q(
    `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, currency, balance, opening_balance)
     VALUES ($1,$2,$3,'Al Rajhi Bank','SAR',186500,150000) RETURNING id`,
    [orgId, companyId, `${P}Main Current Account`],
  );
  const cashLeaf = await q(`SELECT id, name FROM categories WHERE organization_id=$1 AND bank_account_id=$2`, [orgId, bank.rows[0].id]);
  const cash = { id: Number(cashLeaf.rows[0].id), name: cashLeaf.rows[0].name as string };
  const equity = await anyOf("equity");
  const sales = (await acct("SALES")) ?? (await anyOf("income"));
  const expense = (await acct("PURCHASES")) ?? (await anyOf("expense"));

  const jes: Array<[string, string, string, Array<[{ id: number; name: string }, number, number]>]> = [
    [`${P}JE-001`, d(1, 5), "posted", [[cash, 250000, 0], [equity, 0, 250000]]],
    [`${P}JE-002`, d(2, 20), "posted", [[expense, 18000, 0], [cash, 0, 18000]]],
    [`${P}JE-003`, d(5, 15), "posted", [[cash, 42000, 0], [sales, 0, 42000]]],
    [`${P}JE-004`, d(8, 11), "draft", [[expense, 7500, 0], [cash, 0, 7500]]],
    [`${P}JE-005`, d(8, 19), "draft", [[cash, 3200, 0], [sales, 0, 3200]]],
  ];
  // 🔴 G16: each entry is written as a draft, then its lines, then (if it is to
  // be posted) flipped — the order the database requires — in one transaction.
  for (const [num, date, status, lines] of jes) {
    const je = await pool.connect();
    try {
      await je.query("BEGIN");
      const r = await je.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, posted_at)
         VALUES ($1,$2,$3,$4,$5,'draft',NULL) RETURNING id`,
        [orgId, companyId, num, date, status === "posted" ? "Posted entry" : "Awaiting approval"],
      );
      for (const [a, dr, cr] of lines) {
        await je.query(
          `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orgId, companyId, r.rows[0].id, a.id, a.name, dr, cr],
        );
      }
      if (status === "posted") {
        await je.query(`UPDATE journal_entries SET status = 'posted', posted_at = $2 WHERE id = $1 AND status = 'draft'`, [r.rows[0].id, new Date()]);
      }
      await je.query("COMMIT");
    } catch (e) {
      await je.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      je.release();
    }
  }

  // ── transactions (cash flow, transaction review) on the bank account above ─
  for (const [date, desc, amount, type] of [
    [d(3, 6), `${P}Customer payment — Al-Faisal`, 13800, "credit"],
    [d(4, 13), `${P}Customer payment — Riyadh Tech`, 9200, "credit"],
    [d(4, 4), `${P}Supplier payment — Gulf Office`, 3450, "debit"],
    [d(6, 1), `${P}Office rent`, 12000, "debit"],
    [d(7, 2), `${P}Utilities`, 1450, "debit"],
  ] as const) {
    await q(
      `INSERT INTO transactions (organization_id, company_id, bank_account_id, date, description, amount, type, currency, review_status, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'SAR','accepted','operating')`,
      [orgId, companyId, bank.rows[0].id, date, desc, amount, type],
    );
  }

  // ── quotations & purchase orders ──────────────────────────────────────────
  const quo = await q(
    `INSERT INTO quotations (organization_id, company_id, customer_id, quotation_number, date, valid_until, subtotal, vat_amount, total, status)
     VALUES ($1,$2,$3,$4,$5,$6,20000,3000,23000,'approved') RETURNING id`,
    [orgId, companyId, customers[0], `${P}QUO-301`, d(7, 20), `${YEAR + 1}-01-31`],
  );
  await q(
    `INSERT INTO quotation_items (organization_id, company_id, quotation_id, description, quantity, unit_price, vat_rate, vat_amount, total)
     VALUES ($1,$2,$3,'Implementation project',1,20000,15,3000,23000)`,
    [orgId, companyId, quo.rows[0].id],
  );
  const po = await q(
    `INSERT INTO purchase_orders (organization_id, company_id, vendor_id, order_number, date, subtotal, vat_amount, total, status)
     VALUES ($1,$2,$3,$4,$5,9000,1350,10350,'approved') RETURNING id`,
    [orgId, companyId, vendors[1], `${P}PO-401`, d(7, 25)],
  );
  await q(
    `INSERT INTO purchase_order_items (organization_id, company_id, purchase_order_id, description, quantity, unit_price, vat_rate, vat_amount, total)
     VALUES ($1,$2,$3,'Facilities contract',1,9000,15,1350,10350)`,
    [orgId, companyId, po.rows[0].id],
  );

  // ── employees, payroll, assets, budgets ───────────────────────────────────
  for (const [i, [num, name, ar, nat, basic, housing]] of ([
    [`${P}EMP-01`, "Faisal Al-Harbi", "فيصل الحربي", "SA", 14000, 3500],
    [`${P}EMP-02`, "Noura Al-Qahtani", "نورة القحطاني", "SA", 11000, 2750],
    [`${P}EMP-03`, "Ravi Menon", "رافي مينون", "IN", 8000, 2000],
  ] as const).entries()) {
    await q(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, name_ar, nationality, job_title, department, basic_salary, housing_allowance, transport_allowance, joining_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,500,$11,'active')`,
      [orgId, companyId, num, name, ar, nat, ["Finance Manager", "Accountant", "Analyst"][i], "Finance", basic, housing, `${YEAR - 2}-02-01`],
    );
  }
  const run = await q(
    `INSERT INTO payroll_runs (organization_id, company_id, period, status, total_basic_salary, total_allowances, total_gosi_employee, total_gosi_employer, total_deductions, total_net_pay)
     VALUES ($1,$2,$3,'draft',33000,9750,2437.50,2937.50,0,40312.50) RETURNING id`,
    [orgId, companyId, `${YEAR}-08`],
  );
  const emps = await q(`SELECT id, basic_salary, housing_allowance FROM employees WHERE organization_id=$1 AND employee_number LIKE $2 ORDER BY id`, [orgId, `${P}%`]);
  for (const e of emps.rows) {
    const basic = Number(e.basic_salary), housing = Number(e.housing_allowance);
    const gross = basic + housing + 500;
    await q(
      `INSERT INTO payroll_items (organization_id, company_id, payroll_run_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances, gross_salary, gosi_employee, gosi_employer, additions, deductions, net_pay)
       VALUES ($1,$2,$3,$4,$5,$6,500,0,$7,$8,$9,0,0,$10)`,
      [orgId, companyId, run.rows[0].id, e.id, basic, housing, gross, basic * 0.0975, basic * 0.1175, gross - basic * 0.0975],
    );
  }
  // ── fixed assets (the FA-A register, migration 0088) ───────────────────────
  // One demo category on the account triple the product defaults to (FIXED_ASSETS / ACCUMULATED_DEPRECIATION /
  // DEPRECIATION_EXPENSE), and three DRAFT assets. A draft moves no ledger and needs no capitalisation entry
  // (`fixed_assets_state_chk`); capitalising is the product's own act, never this script's. A category is never
  // deleted (retention), so it is reused across runs. Income Tax Law Art. 17(b) group 3 (vehicles, hardware,
  // equipment) and VAT class `movable` fit all three.
  const sysAccount = async (code: string) =>
    (await q(`SELECT id FROM categories WHERE organization_id=$1 AND system_code=$2`, [orgId, code])).rows[0]?.id as number | undefined;
  const [costAccount, accumulatedAccount, expenseAccount] = [await sysAccount("FIXED_ASSETS"), await sysAccount("ACCUMULATED_DEPRECIATION"), await sysAccount("DEPRECIATION_EXPENSE")];
  if (costAccount && accumulatedAccount && expenseAccount) {
    const categoryName = `${P}Vehicles and IT equipment`;
    let categoryId = (await q(`SELECT id FROM asset_categories WHERE organization_id=$1 AND company_id=$2 AND name=$3`, [orgId, companyId, categoryName])).rows[0]?.id as number | undefined;
    if (!categoryId) {
      categoryId = (await q(
        `INSERT INTO asset_categories (organization_id, company_id, name, name_ar, cost_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, default_useful_life_months, income_tax_group, vat_capital_asset_class)
         VALUES ($1,$2,$3,'المركبات ومعدات تقنية المعلومات',$4,$5,$6,60,3,'movable') RETURNING id`,
        [orgId, companyId, categoryName, costAccount, accumulatedAccount, expenseAccount],
      )).rows[0].id as number;
    }
    for (const [num, name, ar, cost, lifeMonths] of [
      [`${P}FA-01`, "Network and printing equipment", "معدات الشبكة والطباعة", 48000, 60],
      [`${P}FA-02`, "Company vehicle", "مركبة الشركة", 95000, 60],
      [`${P}FA-03`, "Laptops (12)", "أجهزة محمولة", 62000, 36],
    ] as const) {
      await q(
        `INSERT INTO fixed_assets (organization_id, company_id, asset_number, name, name_ar, category_id, acquisition_date, cost, useful_life_months, vat_capital_asset_class, income_tax_group, status)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'movable',3,'draft'
          WHERE NOT EXISTS (SELECT 1 FROM fixed_assets WHERE organization_id=$1 AND company_id=$2 AND asset_number=$3)`,
        [orgId, companyId, num, name, ar, categoryId, `${YEAR - 1}-01-15`, cost, lifeMonths],
      );
    }
  } else {
    console.warn("demo-seed: no fixed assets — the chart has no FIXED_ASSETS / ACCUMULATED_DEPRECIATION / DEPRECIATION_EXPENSE account for a category to default to.");
  }

  // ── budgets (Phase 15, migration 0112: a budget, its versions, their lines) ─
  // One demo budget for this fiscal year: version 1 as a DRAFT, with annual lines on three expense posting
  // accounts. Like the product (budgets.service), it needs the company's DECLARED fiscal year — an undeclared
  // year is never assumed to be the calendar year — and a Hijri year is left to the product's own calendar code.
  const company = (await q(`SELECT fiscal_year_start, fiscal_calendar FROM companies WHERE id=$1`, [companyId])).rows[0];
  const budgetName = `${P}Operating budget`;
  if (company.fiscal_year_start == null || (company.fiscal_calendar ?? "gregorian") !== "gregorian") {
    console.warn(`demo-seed: no budget — ${company.fiscal_year_start == null ? "the company's fiscal year is not declared" : "the company keeps a Hijri fiscal year"}. Declare a Gregorian fiscal year in Company Settings to seed one.`);
  } else {
    const startMonth = Number(company.fiscal_year_start);
    // The label is the year the fiscal year STARTS in; it ends the day before the next one starts (lib/fiscalYear.ts).
    const kept = await q(
      `SELECT 1 FROM budgets WHERE organization_id=$1 AND company_id=$2 AND name=$3 AND scenario='base' AND fiscal_year_start = make_date($4, $5, 1)::text`,
      [orgId, companyId, budgetName, YEAR, startMonth],
    );
    if (kept.rows.length === 0) {
      const budget = await q(
        `INSERT INTO budgets (organization_id, company_id, name, name_ar, scenario, fiscal_calendar, fiscal_start_month, fiscal_label, fiscal_year_start, fiscal_year_end)
         VALUES ($1,$2,$3,'الميزانية التشغيلية','base','gregorian',$5::int,$4::int, make_date($4::int, $5::int, 1)::text, (make_date($4::int + 1, $5::int, 1) - 1)::text) RETURNING id`,
        [orgId, companyId, budgetName, YEAR, startMonth],
      );
      const version = await q(
        `INSERT INTO budget_versions (organization_id, company_id, budget_id, version_no, status) VALUES ($1,$2,$3,1,'draft') RETURNING id`,
        [orgId, companyId, budget.rows[0].id],
      );
      const accounts = await q(`SELECT id FROM categories WHERE organization_id=$1 AND type='expense' AND is_posting ORDER BY id LIMIT 3`, [orgId]);
      for (const [i, a] of accounts.rows.entries()) {
        await q(
          `INSERT INTO budget_lines (organization_id, company_id, version_id, account_id, period_no, amount) VALUES ($1,$2,$3,$4,NULL,$5)`,
          [orgId, companyId, version.rows[0].id, a.id, [240000, 120000, 60000][i]],
        );
      }
    }
  }

  const counts = await q(
    `SELECT
       (SELECT count(*) FROM invoices WHERE organization_id=$1 AND status='draft') AS pending_invoices,
       (SELECT count(*) FROM invoices WHERE organization_id=$1) AS invoices,
       (SELECT count(*) FROM bills WHERE organization_id=$1) AS bills,
       (SELECT count(*) FROM journal_entries WHERE organization_id=$1) AS jes,
       (SELECT count(*) FROM employees WHERE organization_id=$1) AS employees,
       (SELECT count(*) FROM fixed_assets WHERE organization_id=$1) AS assets`,
    [orgId],
  );
  console.log("demo seed complete:", counts.rows[0]);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
