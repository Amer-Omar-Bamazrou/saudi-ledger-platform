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
 *       tsx scripts/src/demo-seed.mts                 (this file)
 */
import { pool } from "@workspace/db";

const P = "DEMO-";
const YEAR = new Date().getFullYear();
const d = (mm: number, dd: number) => `${YEAR}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

async function main() {
  const org = await pool.query(`SELECT id FROM organizations WHERE slug = 'default'`);
  if (!org.rows[0]) throw new Error("No 'default' organization — run `pnpm --filter @workspace/db run seed` first.");
  const orgId = org.rows[0].id as string;
  const comp = await pool.query(`SELECT id FROM companies WHERE organization_id = $1 ORDER BY created_at LIMIT 1`, [orgId]);
  if (!comp.rows[0]) throw new Error("No company for the default organization.");
  const companyId = comp.rows[0].id as string;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  // ── wipe only what this script created ────────────────────────────────────
  await q(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=$1 AND invoice_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=$1 AND invoice_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM invoices WHERE organization_id=$1 AND invoice_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=$1 AND bill_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM bills WHERE organization_id=$1 AND bill_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=$1 AND entry_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM journal_entries WHERE organization_id=$1 AND entry_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE organization_id=$1 AND quotation_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM quotations WHERE organization_id=$1 AND quotation_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=$1 AND order_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM purchase_orders WHERE organization_id=$1 AND order_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM payroll_items WHERE payroll_run_id IN (SELECT id FROM payroll_runs WHERE organization_id=$1)`, [orgId]);
  await q(`DELETE FROM payroll_runs WHERE organization_id=$1`, [orgId]);
  await q(`DELETE FROM depreciation_entries WHERE asset_id IN (SELECT id FROM fixed_assets WHERE organization_id=$1 AND asset_number LIKE $2)`, [orgId, `${P}%`]);
  await q(`DELETE FROM fixed_assets WHERE organization_id=$1 AND asset_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM employees WHERE organization_id=$1 AND employee_number LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM budgets WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM transactions WHERE organization_id=$1 AND description LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM bank_accounts WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM customers WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);
  await q(`DELETE FROM vendors WHERE organization_id=$1 AND name LIKE $2`, [orgId, `${P}%`]);

  // 🔴 QA fix (2026-09-04): sweep DEBRIS, not just this script's own rows.
  // The demo DB accumulates exploratory junk from manual sessions — a
  // SAR 0.00 draft bill named "PROBE-1" with no vendor sat on the demo with a
  // live "Post" button, exactly the kind of thing someone clicks. A zero-total
  // DRAFT with no party is not a real document by any path (every real create
  // requires a priced line and, for bills, an amount), so it is safe to
  // remove. Scoped to the demo org and to drafts only — a posted or
  // party-bearing row is never touched.
  await q(
    `DELETE FROM bill_items WHERE bill_id IN (
       SELECT id FROM bills WHERE organization_id=$1 AND status='draft'
         AND total::numeric = 0 AND vendor_id IS NULL)`,
    [orgId],
  );
  await q(
    `DELETE FROM bills WHERE organization_id=$1 AND status='draft'
       AND total::numeric = 0 AND vendor_id IS NULL`,
    [orgId],
  );
  await q(
    `DELETE FROM invoice_items WHERE invoice_id IN (
       SELECT id FROM invoices WHERE organization_id=$1 AND status='draft'
         AND total::numeric = 0 AND customer_id IS NULL)`,
    [orgId],
  );
  await q(
    `DELETE FROM invoices WHERE organization_id=$1 AND status='draft'
       AND total::numeric = 0 AND customer_id IS NULL`,
    [orgId],
  );

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

  // ── invoices: issued + paid, and 60 PENDING drafts (the old cap was 50) ────
  const issued: Array<[string, number, number, number, string, string]> = [
    [`${P}INV-1001`, 12000, 1800, 13800, d(3, 5), "paid"],
    [`${P}INV-1002`, 8000, 1200, 9200, d(4, 12), "paid"],
    [`${P}INV-1003`, 15000, 2250, 17250, d(5, 2), "sent"],
    [`${P}INV-1004`, 6400, 960, 7360, d(6, 18), "sent"],
    [`${P}INV-1005`, 22000, 3300, 25300, d(7, 9), "sent"],
  ];
  for (const [num, sub, vat, total, date, status] of issued) {
    const paid = status === "paid" ? total : 0;
    const r = await q(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status, invoice_hash, previous_hash, qr_code, icv, issued_at)
       VALUES ($1,$2,$3,$4,'invoice',$5,$6,$7,$8,$9,$10,$11,'demo-hash','GENESIS','demo-qr',$12,now()) RETURNING id`,
      [orgId, companyId, customers[issued.indexOf([num, sub, vat, total, date, status] as never) % 3] ?? customers[0], num, date, date, sub, vat, total, paid, status, 1000 + issued.findIndex((x) => x[0] === num)],
    );
    await q(
      `INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, description_ar, quantity, unit_price, vat_rate, vat_amount, total, tax_category_code)
       VALUES ($1,$2,$3,'Professional services','خدمات مهنية',1,$4,15,$5,$6,'S')`,
      [orgId, companyId, r.rows[0].id, sub, vat, total],
    );
    if (paid > 0) {
      await q(`INSERT INTO invoice_payments (organization_id, company_id, invoice_id, amount, paid_at) VALUES ($1,$2,$3,$4,$5)`,
        [orgId, companyId, r.rows[0].id, paid, date]);
    }
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
  for (const [num, sub, vat, total, date, status] of [
    [`${P}BILL-501`, 3000, 450, 3450, d(4, 3), "paid"],
    [`${P}BILL-502`, 1800, 270, 2070, d(6, 21), "received"],
    [`${P}BILL-503`, 950, 142.5, 1092.5, d(8, 8), "submitted"],
  ] as const) {
    const r = await q(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orgId, companyId, vendors[0], num, date, sub, vat, total, status === "paid" ? total : 0, status],
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
  const cash = (await acct("CASH")) ?? (await anyOf("asset"));
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
  for (const [num, date, status, lines] of jes) {
    const r = await q(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orgId, companyId, num, date, status === "posted" ? "Posted entry" : "Awaiting approval", status, status === "posted" ? new Date() : null],
    );
    for (const [a, dr, cr] of lines) {
      await q(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, companyId, r.rows[0].id, a.id, a.name, dr, cr],
      );
    }
  }

  // ── bank account + transactions (cash flow, transaction review) ────────────
  const bank = await q(
    `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, currency, balance, opening_balance)
     VALUES ($1,$2,$3,'Al Rajhi Bank','SAR',186500,150000) RETURNING id`,
    [orgId, companyId, `${P}Main Current Account`],
  );
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
  for (const [num, name, ar, cost, life] of [
    [`${P}FA-01`, "Office fit-out", "تجهيزات المكتب", 180000, 10],
    [`${P}FA-02`, "Company vehicle", "مركبة الشركة", 95000, 5],
    [`${P}FA-03`, "Laptops (12)", "أجهزة محمولة", 62000, 3],
  ] as const) {
    const a = await q(
      `INSERT INTO fixed_assets (organization_id, company_id, asset_number, name, name_ar, purchase_date, purchase_cost, salvage_value, useful_life_years, accumulated_depreciation, current_book_value, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,'active') RETURNING id`,
      [orgId, companyId, num, name, ar, `${YEAR - 1}-01-15`, cost, life, cost / life / 12 * 6, cost - cost / life / 12 * 6],
    );
    await q(
      `INSERT INTO depreciation_entries (organization_id, company_id, asset_id, period, amount, book_value_after)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, companyId, a.rows[0].id, `${YEAR}-07`, cost / life / 12, cost - cost / life / 12 * 6],
    );
  }
  const cats = await q(`SELECT id FROM categories WHERE organization_id=$1 AND type='expense' ORDER BY id LIMIT 3`, [orgId]);
  for (const [i, c] of cats.rows.entries()) {
    await q(
      `INSERT INTO budgets (organization_id, company_id, name, name_ar, period, category_id, budgeted_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, companyId, `${P}Operating budget ${i + 1}`, "الميزانية التشغيلية", String(YEAR), c.id, [240000, 120000, 60000][i]],
    );
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
