import type { APIRequestContext } from "@playwright/test";

/**
 * THE BOOKS A TENANT IS SEEDED WITH, THROUGH THE PRODUCT'S OWN WRITE PATH (global-setup.ts explains why it is the
 * product's path and never direct INSERTs). One sequence, two value sets:
 *
 *   - SMOKE_BOOKS: the shared smoke tenant every spec reads — exactly the values it has always had, so no locator moves;
 *   - PHONE_BOOKS (2026-11-21): the phone-fit tenant the 390 px crawl measures, and that NOTHING ELSE writes to. Its
 *     values are the worst a page plausibly meets: the longest names, Arabic and English; unbroken references (an IBAN,
 *     one unbroken document-number token); long descriptions and bank narratives; amounts 100,000 times the smoke tenant's. The
 *     owner, 2026-11-21: the crawl's result must not depend on what other specs left in a shared tenant, nor on a frame
 *     whose rows happened to be short (CI's tenant had rows the local one did not, and #360 went red on them).
 */

export interface BooksValues {
  company: { name: string; nameAr: string; crNumber: string; vatNumber: string };
  customer: Record<string, unknown> & { name: string };
  vendor: Record<string, unknown> & { name: string };
  bank: { name: string; bankName: string };
  equity: { name: string; nameAr: string };
  /** Document-number prefix: every number is `${prefix}-INV-001` and so on. */
  prefix: string;
  text: {
    opening: string;
    sale: string;
    creditReason: string;
    purchase: string;
    bankCredit: string;
    bankDebit: string;
    bankRent: string;
    depositTransfer: string;
    plainTransfer: string;
    product: string;
    productDescription: string;
    employee: string;
    assetCategory: string;
    assetCategoryAr: string;
    asset: string;
    budget: string;
    budgetAr: string;
    quotation: string;
    purchaseOrder: string;
    retainer: string;
    sourceSystem: string;
  };
  /** Every amount is multiplied by this; the books stay consistent (payments equal totals, entries balance). */
  scale: number;
}

export const SMOKE_BOOKS: BooksValues = {
  company: { name: "E2E Smoke Co", nameAr: "شركة الاختبار", crNumber: "1010101010", vatNumber: "300000000000003" },
  // 2026-11-24: a standard tax invoice to a Saudi business buyer needs its national address (buyer_address_incomplete)
  customer: { name: "E2E Customer", taxNumber: "310000000000003", buildingNumber: "4321", street: "Olaya Street", district: "Al Olaya", city: "Riyadh", postalCode: "12211" },
  vendor: { name: "E2E Vendor", taxNumber: "302222222222223" },
  bank: { name: "E2E Current Account", bankName: "Al Rajhi Bank" },
  equity: { name: "Owner Equity", nameAr: "حقوق الملكية" },
  prefix: "E2E",
  text: {
    opening: "Opening balance entry",
    sale: "Consulting services",
    creditReason: "Goods returned",
    purchase: "Office supplies",
    bankCredit: "Customer payment received",
    bankDebit: "Supplier payment",
    bankRent: "Office rent",
    depositTransfer: "Incoming transfer E2E-DEP-800",
    plainTransfer: "Incoming transfer",
    product: "Consulting hour",
    productDescription: "Professional services",
    employee: "E2E Employee",
    assetCategory: "Computers and equipment",
    assetCategoryAr: "حواسيب ومعدات",
    asset: "Office laptop",
    budget: "E2E Operating Budget",
    budgetAr: "ميزانية التشغيل",
    quotation: "Proposed engagement",
    purchaseOrder: "Hardware order",
    retainer: "Retainer",
    sourceSystem: "E2E Previous System",
  },
  scale: 1,
};

const LONG_AR = "مؤسسة عبدالرحمن بن عبدالعزيز بن محمد الحربي للتجارة والمقاولات العامة والصيانة والتشغيل";
const LONG_EN = "Al-Mutlaq International Trading, Contracting & Investment Company (Closed Joint Stock)";
const IBAN = "SA0380000000608010167519";

export const PHONE_BOOKS: BooksValues = {
  company: {
    name: LONG_EN,
    nameAr: "شركة المطلق الدولية للتجارة والمقاولات والاستثمار (شركة مساهمة مقفلة) - المركز الرئيسي",
    crNumber: "1010505050",
    vatNumber: "300000000000053",
  },
  customer: {
    name: LONG_AR,
    nameAr: LONG_AR,
    taxNumber: "310000000000053",
    email: "procurement.department.head@almutlaq-international-trading.com.sa",
    phone: "+966 55 123 4567 / +966 11 456 7890",
    address: "مبنى رقم 7788، طريق الملك فهد الفرعي، حي العليا، الرياض 12214، المملكة العربية السعودية",
    city: "الرياض",
    // the same address, as the national address a standard tax invoice needs (2026-11-24)
    buildingNumber: "7788", street: "طريق الملك فهد الفرعي", district: "حي العليا", postalCode: "12214",
  },
  vendor: {
    name: "Gulf Integrated Office Supplies, Printing & Technical Services Trading Establishment",
    nameAr: "مؤسسة الخليج المتكاملة للأدوات المكتبية والطباعة والخدمات الفنية التجارية",
    taxNumber: "302222222222253",
    email: "accounts.receivable.department@gulf-integrated-office-supplies.com.sa",
    phone: "+966 13 987 6543 / +966 50 000 1111",
    address: "مستودع رقم 12، المنطقة الصناعية الثانية، طريق الدمام الخبر السريع، الدمام 32432",
    iban: IBAN,
  },
  bank: { name: "Main Operating Account — Corporate Banking Payroll & Collections", bankName: "Saudi National Bank (SNB) — Corporate Banking Group" },
  equity: { name: "Owner Equity — Capital Contributions and Retained Profits", nameAr: "حقوق الملكية — رأس المال المدفوع والأرباح المبقاة والاحتياطيات النظامية" },
  // one unbroken token (no hyphen to break at): the document and entry numbers a long-numbered tenant prints
  prefix: "PHONEFIT2026000000000000",
  text: {
    opening: `Opening balance transferred from the previous accounting system, reference ${IBAN}-MIGRATION-2026-07`,
    sale: "تقديم خدمات استشارية مالية وإدارية متكاملة تشمل إعادة هيكلة الحسابات وإعداد القوائم المالية والتقارير الربعية",
    creditReason: "إرجاع بضاعة تالفة بموجب محضر الاستلام رقم 2026/07/000123456 وفق شروط العقد",
    purchase: "توريد أدوات مكتبية وأحبار طابعات وورق تصوير مقاس A4 للمكاتب الرئيسية والفروع الإقليمية",
    bankCredit: "TRANSFER FROM AL-MUTLAQ INTERNATIONAL TRADING CO REF 20260702000000123456789 INVOICE SETTLEMENT",
    bankDebit: "OUTGOING SARIE TRANSFER TO GULF INTEGRATED OFFICE SUPPLIES REF 20260706000000987654321",
    bankRent: "STANDING ORDER OFFICE RENT KING FAHD ROAD BRANCH CONTRACT 2026-RENT-0000456789 AUGUST",
    depositTransfer: "Incoming transfer PHONEFIT-DEP-80000000 from customer advance against contract 2026/0099887766",
    plainTransfer: "INCOMING SARIE TRANSFER REF 20260721000000555666777 NO NARRATIVE PROVIDED BY REMITTER",
    product: "ساعة استشارات مالية وضريبية متخصصة (زكاة، ضريبة القيمة المضافة، ضريبة الاستقطاع)",
    productDescription: "Professional advisory services billed per hour, including VAT, Zakat and withholding tax compliance reviews",
    employee: "عبدالرحمن بن عبدالعزيز بن محمد بن سليمان الحربي",
    assetCategory: "Computers, servers, networking and audio-visual equipment",
    assetCategoryAr: "أجهزة الحاسب والخوادم ومعدات الشبكات والأجهزة السمعية والبصرية",
    asset: "Dell Precision 7780 mobile workstation with docking station and two 32-inch monitors",
    budget: "Consolidated Operating and Capital Expenditure Budget — Head Office and Regional Branches",
    budgetAr: "الميزانية التشغيلية والرأسمالية الموحدة — المركز الرئيسي والفروع الإقليمية",
    quotation: "عرض سعر لمشروع إعادة هيكلة الأنظمة المحاسبية والربط مع منصة فاتورة للمرحلة الثانية",
    purchaseOrder: "Hardware order: 25 laptops, 4 rack servers, 2 core switches and installation services",
    retainer: "اشتراك شهري في خدمات المحاسبة والاستشارات الضريبية حسب العقد الإطاري رقم 2026/0001",
    sourceSystem: "Previous ERP: Oracle E-Business Suite R12.2 (general ledger and payables)",
  },
  // amounts in the hundreds of millions: the widest figures a KPI card, a total or a statement line meets
  scale: 100000,
};

/** One API call; any non-2xx is a seed failure that names the call and the server's answer. */
export async function api<T = any>(ctx: APIRequestContext, method: "GET" | "POST" | "PATCH" | "PUT", path: string, data?: unknown): Promise<T> {
  const res = await ctx.fetch(`/api${path}`, { method, data, headers: { "content-type": "application/json" } });
  if (!res.ok()) throw new Error(`e2e seed: ${method} ${path} → ${res.status()} ${(await res.text()).slice(0, 400)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface SeededBooks {
  customerId: number;
  vendorId: number;
  bankId: number;
  depositPaymentId: number;
  migrationBatchId: number;
  budgetId: number;
  taxComputationId: number;
  invoiceId: number;
  assetId: number;
}

/** The sequence global-setup has always run for the smoke tenant, with its values taken from `v`. */
export async function seedBooks(ctx: APIRequestContext, v: BooksValues): Promise<SeededBooks> {
  const m = (amount: number) => amount * v.scale;
  const P = v.prefix;

  // Issuing an invoice fails closed without the company's VAT number (the
  // walk of 2026-09-15 hit exactly this 400). Set the legal identity first.
  await api(ctx, "PATCH", "/companies/current", {
    ...v.company,
    // R-2 (G23; register §11.85): the fiscal year is declared HERE, before anything is posted — once an entry is in
    // the books the start is fixed, so the seed can no longer declare it later for the budget and withdraw it after.
    // The shared tenant is therefore DECLARED (January, Gregorian) for every spec.
    fiscalYearStart: 1,
    fiscalCalendar: "gregorian",
  });

  const customer = await api(ctx, "POST", "/customers", v.customer);
  // Phase 13A: a tax invoice names its supplier's VAT number (IR Art. 53(5)(c)) — without one, every bill is held for evidence.
  const vendor = await api(ctx, "POST", "/vendors", v.vendor);
  const customerId = customer.id as number;
  const vendorId = vendor.id as number;

  // The chart: the seeded system accounts plus one equity account for the
  // opening entry (the seeded chart's only equity account is the transfers
  // one, which is not where owner capital goes).
  // D-3: cash lives on a bank's OWN GL account, so the bank account comes
  // first; the opening entry's cash line names that account, never the
  // "Cash and Bank" header (which accepts no postings).
  const bank = await api(ctx, "POST", "/bank-accounts", {
    name: v.bank.name,
    bankName: v.bank.bankName,
    currency: "SAR",
    balance: m(25000),
    openingBalance: m(20000),
  });
  const categories: Array<{ id: number; name: string; systemCode: string | null; type: string; bankAccountId: number | null }> = await api(ctx, "GET", "/categories");
  const cash = categories.find((c) => c.bankAccountId === bank.id);
  if (!cash) throw new Error("e2e seed: the bank account has no GL cash account");
  const equity = await api(ctx, "POST", "/categories", {
    name: v.equity.name,
    nameAr: v.equity.nameAr,
    type: "equity",
    vatApplicable: false,
  });

  // Opening entry — real account ids, posted through the JE path.
  const je = await api(ctx, "POST", "/journal-entries", {
    entryNumber: `${P}-JE-001`,
    date: "2026-07-15",
    description: v.text.opening,
    lines: [
      { accountId: cash.id, accountName: cash.name, debitAmount: m(5000), creditAmount: 0 },
      { accountId: equity.id, accountName: equity.name, debitAmount: 0, creditAmount: m(5000) },
    ],
  });
  await api(ctx, "POST", `/journal-entries/${je.id}/post`);

  // Money on both sides, one of each shape a page might get wrong: fully paid,
  // partly paid, unpaid, and a draft that must move nothing. Approved in date
  // order so the ICV chain is the one a tenant would have.
  const line = (description: string, unitPrice: number) => [{ description, quantity: 1, unitPrice: m(unitPrice), vatRate: 15 }];
  const invoice = async (invoiceNumber: string, date: string, dueDate: string, subtotal: number) =>
    api(ctx, "POST", "/invoices", { invoiceNumber, date, dueDate, customerId, items: line(v.text.sale, subtotal) });
  const issue = async (id: number) => {
    await api(ctx, "POST", `/invoices/${id}/submit`);
    await api(ctx, "POST", `/invoices/${id}/approve`);
  };

  const inv1 = await invoice(`${P}-INV-001`, "2026-06-01", "2026-06-30", 1000);
  await issue(inv1.id);
  await api(ctx, "POST", `/invoices/${inv1.id}/pay`, { amount: m(1150), paidAt: "2026-06-28", bankAccountId: bank.id });

  const inv2 = await invoice(`${P}-INV-002`, "2026-07-01", "2026-07-31", 2000);
  await issue(inv2.id);
  await api(ctx, "POST", `/invoices/${inv2.id}/pay`, { amount: m(1000), paidAt: "2026-07-20", bankAccountId: bank.id });

  const inv3 = await invoice(`${P}-INV-003`, "2026-08-01", "2026-08-31", 3000);
  await issue(inv3.id);

  await invoice(`${P}-INV-004`, "2026-08-15", "2026-09-15", 500); // stays a draft

  // A credit note against the PAID invoice — the shape aging must show as a
  // negative receivable (item 7 of the 2026-09-15 walk).
  const cn = await api(ctx, "POST", "/invoices", {
    invoiceNumber: `${P}-CN-001`,
    documentType: "credit_note",
    originalInvoiceId: inv1.id,
    noteReason: v.text.creditReason,
    date: "2026-08-20",
    customerId,
    items: line(v.text.creditReason, 100),
  });
  await issue(cn.id);

  // Bills: posted through the bill path (PURCHASES by default), one paid.
  const bill = async (billNumber: string, date: string, dueDate: string, subtotal: number) =>
    api(ctx, "POST", "/bills", {
      billNumber,
      // Phase 13A: each is the supplier's full tax invoice, with its own number.
      supplierDocumentKind: "tax_invoice",
      vendorReference: `SUP-${billNumber}`,
      date,
      dueDate,
      vendorId,
      subtotal: m(subtotal),
      vatAmount: m(subtotal) * 0.15,
      total: m(subtotal) * 1.15,
      items: line(v.text.purchase, subtotal),
    });
  const bill1 = await bill(`${P}-BILL-001`, "2026-06-05", "2026-07-05", 400);
  await api(ctx, "POST", `/bills/${bill1.id}/post`, {});
  await api(ctx, "POST", `/bills/${bill1.id}/pay`, { amount: m(460), paidAt: "2026-07-06", bankAccountId: bank.id });
  const bill2 = await bill(`${P}-BILL-002`, "2026-07-10", "2026-08-10", 800);
  await api(ctx, "POST", `/bills/${bill2.id}/post`, {});

  // Three imported movements on the bank account created above — the upload
  // path is what lands rows in review, which is the state the review page
  // exists for.
  await api(ctx, "POST", "/transactions/upload", {
    bankAccountId: bank.id,
    rows: [
      { date: "2026-07-02", description: v.text.bankCredit, amount: m(1150), type: "credit", currency: "SAR" },
      { date: "2026-07-06", description: v.text.bankDebit, amount: m(460), type: "debit", currency: "SAR" },
      { date: "2026-08-03", description: v.text.bankRent, amount: m(3000), type: "debit", currency: "SAR" },
    ],
  });

  // Batch 1B Phase F (2026-09-17): a receipt ON ACCOUNT — a customer deposit
  // with no allocation — and statement rows that classify one way each:
  // DETERMINISTIC (the narrative names the receipt's reference; same bank,
  // exact amount, next day) and AMBIGUOUS (agrees with the 1,000 partial
  // payment of INV-002 on bank, amount and date, but nothing in the narrative
  // identifies it — amount and date alone never match). The 1,150 row above
  // is UNMATCHED: its receipt is dated 2026-06-28, outside the ±3-day window.
  const deposit = await api(ctx, "POST", "/payments", {
    customerId,
    amount: m(800),
    bankAccountId: bank.id,
    paidAt: "2026-08-25",
    method: "transfer",
    reference: v.scale === 1 ? "E2E-DEP-800" : "PHONEFIT-DEP-80000000",
    allocations: [],
  });
  await api(ctx, "POST", "/transactions/upload", {
    bankAccountId: bank.id,
    rows: [
      { date: "2026-08-26", description: v.text.depositTransfer, amount: m(800), type: "credit", currency: "SAR" },
      { date: "2026-07-21", description: v.text.plainTransfer, amount: m(1000), type: "credit", currency: "SAR" },
    ],
  });

  await api(ctx, "POST", "/products", {
    name: v.text.product,
    type: "service",
    unit: "unit",
    description: v.text.productDescription,
    unitPrice: m(500),
    vatApplicable: true,
    stockQty: 0,
  });

  // GOSI (Phase 18): a Saudi employee (the default nationality) carries a stated GOSI law, or payroll refuses to run.
  await api(ctx, "POST", "/employees", { employeeNumber: `${P}-EMP-001`, name: v.text.employee, basicSalary: m(8000), status: "active", gosiRegime: "law_1421h" });

  // A payroll run: created from the employees, approved through the workflow
  // (which posts the GL — the old seed's "approved" run had none).
  const run = await api(ctx, "POST", "/payroll", { period: "2026-07" });
  await api(ctx, "POST", `/payroll/${run.id}/submit`);
  await api(ctx, "POST", `/payroll/${run.id}/approve`);

  // FA-A (2026-09-22): a category (the account triple + the Art. 17 group + the
  // Art. 52 class) and a DRAFT asset — nothing posted; capitalisation and the
  // monthly run arrive with FA-B and seed their own rows then.
  const assetCategory = await api(ctx, "POST", "/asset-categories", { name: v.text.assetCategory, nameAr: v.text.assetCategoryAr, defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" });
  const asset = await api(ctx, "POST", "/assets", {
    assetNumber: `${P}-FA-001`,
    name: v.text.asset,
    categoryId: assetCategory.id,
    acquisitionDate: "2026-01-15",
    availableForUseDate: "2026-01-15",
    cost: m(12000),
    residualValue: 0,
    vatInputTaxAmount: m(1800),
  });

  // Phase 15: an APPROVED 2026 base budget — so /budgets lists a row, /budgets/:id is crawlable and the
  // Analytics card has figures. A budget needs a DECLARED fiscal year (D15-15) — declared with the company's
  // identity above (R-2, G23: it cannot be declared or withdrawn once anything is posted). The budget FREEZES its
  // year (D15-01).
  const budget = await api<{ id: number; version: { id: number } }>(ctx, "POST", "/budgets", { name: v.text.budget, nameAr: v.text.budgetAr, fiscalYearLabel: 2026 });
  // Phase 16: a DRAFT Zakat computation for FY 2025 (a computation also freezes its year at creation), so
  // /zakat lists a row and /tax/computations/:id is crawlable. A draft moves nothing in the books.
  const taxComputation = await api<{ id: number }>(ctx, "POST", "/tax/computations", { kind: "zakat", fiscalYearLabel: 2025 });
  const budgetAccounts = await api<Array<{ id: number; name: string }>>(ctx, "GET", "/budgets/accounts");
  const salesAccount = budgetAccounts.find((a) => a.name === "Sales Revenue");
  const purchasesAccount = budgetAccounts.find((a) => a.name === "Purchases");
  if (!salesAccount || !purchasesAccount) throw new Error("e2e seed: the Sales Revenue / Purchases system accounts are missing from /budgets/accounts");
  await api(ctx, "PUT", `/budgets/${budget.id}/versions/${budget.version.id}/lines`, {
    lines: [
      { accountId: salesAccount.id, periods: [1000, 1000, 1000, 1000, 1000, 2000, 3000, 3000, 1000, 1000, 1000, 1000].map(m) },
      { accountId: purchasesAccount.id, annualAmount: m(6000) },
    ],
  });
  await api(ctx, "POST", `/budgets/${budget.id}/versions/${budget.version.id}/approve`);

  const quotation = await api(ctx, "POST", "/quotations", {
    date: "2026-08-01",
    validUntil: "2026-12-31",
    customerId,
    items: line(v.text.quotation, 2000),
  });
  await api(ctx, "POST", `/quotations/${quotation.id}/submit`);

  const po = await api(ctx, "POST", "/purchase-orders", { date: "2026-08-02", vendorId, items: line(v.text.purchaseOrder, 1500) });
  await api(ctx, "POST", `/purchase-orders/${po.id}/submit`);
  await api(ctx, "POST", `/purchase-orders/${po.id}/approve`);

  // A recurring rule. Drafts-only by design, and dated so the scheduler never
  // generates from it — it exists so `/recurring` renders a row.
  await api(ctx, "POST", "/recurring", {
    entity: "invoice",
    template: { customerId, items: line(v.text.retainer, 1000) },
    frequency: "monthly",
    dayOfMonth: 1,
    startsOn: "2099-01-01",
  });

  // A closed month, so `/closed-months` has something to show. Deliberately a
  // period no seeded document falls in, so nothing above becomes unpostable.
  await api(ctx, "POST", "/period-locks", { period: "2025-12" });

  // Batch 1C: a draft batch (zero ledger effect) so the crawl can render `/migration/:id`.
  const migrationBatch = await api(ctx, "POST", "/migration/batches", { sourceSystem: v.text.sourceSystem, cutoverDate: "2025-01-01" });

  return {
    customerId, vendorId, bankId: bank.id, depositPaymentId: deposit.id, migrationBatchId: migrationBatch.id,
    budgetId: budget.id, taxComputationId: taxComputation.id, invoiceId: inv3.id, assetId: asset.id,
  };
}
