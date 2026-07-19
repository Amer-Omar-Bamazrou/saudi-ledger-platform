import { Router } from "express";
import { db } from "@workspace/db";
import {
  transactionsTable, categoriesTable, invoicesTable, billsTable,
  journalEntriesTable, journalEntryLinesTable, customersTable
} from "@workspace/db";
import { eq, and, gte, lte, isNotNull, desc } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

// ─────────────────────────────────────────────────────────────────────────────
// GET /reports/trial-balance?date_from=&date_to=
// Reads from posted journal_entry_lines — the authoritative double-entry ledger.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trial-balance", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;

    const jeConditions: any[] = [eq(journalEntriesTable.status, "posted")];
    if (date_from) jeConditions.push(gte(journalEntriesTable.date, date_from));
    if (date_to)   jeConditions.push(lte(journalEntriesTable.date, date_to));

    const lines = await db
      .select({
        accountName: journalEntryLinesTable.accountName,
        accountId: journalEntryLinesTable.accountId,
        debitAmount: journalEntryLinesTable.debitAmount,
        creditAmount: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...jeConditions));

    const accounts = new Map<string, { name: string; accountId: number | null; debit: number; credit: number }>();
    for (const l of lines) {
      if (!accounts.has(l.accountName)) accounts.set(l.accountName, { name: l.accountName, accountId: l.accountId, debit: 0, credit: 0 });
      const acc = accounts.get(l.accountName)!;
      acc.debit  += toNum(l.debitAmount);
      acc.credit += toNum(l.creditAmount);
    }

    const rows = Array.from(accounts.values())
      .map(a => ({ name: a.name, accountId: a.accountId, debit: parseFloat(a.debit.toFixed(2)), credit: parseFloat(a.credit.toFixed(2)), balance: parseFloat((a.debit - a.credit).toFixed(2)) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totalDebit  = parseFloat(rows.reduce((s, r) => s + r.debit,  0).toFixed(2));
    const totalCredit = parseFloat(rows.reduce((s, r) => s + r.credit, 0).toFixed(2));

    res.json({ accounts: rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01, note: "Trial balance is derived from posted journal entries only." });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/income-statement?date_from=&date_to=
router.get("/income-statement", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));

    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const revenue: Record<string, { name: string; nameAr: string; amount: number }> = {};
    const expenses: Record<string, { name: string; nameAr: string; amount: number }> = {};

    for (const { tx, cat } of txs) {
      const amount = toNum(tx.amount);
      const catType = cat?.type ?? "expense";
      const catName = cat?.name ?? "Uncategorized";
      const catNameAr = cat?.nameAr ?? "غير مصنف";
      const key = String(tx.categoryId ?? "uncategorized");
      if (tx.type === "credit" || catType === "income") {
        if (!revenue[key]) revenue[key] = { name: catName, nameAr: catNameAr, amount: 0 };
        revenue[key].amount += amount;
      } else {
        if (!expenses[key]) expenses[key] = { name: catName, nameAr: catNameAr, amount: 0 };
        expenses[key].amount += amount;
      }
    }

    const revenueItems = Object.values(revenue).map(r => ({ ...r, amount: parseFloat(r.amount.toFixed(2)) }));
    const expenseItems = Object.values(expenses).map(e => ({ ...e, amount: parseFloat(e.amount.toFixed(2)) }));
    const totalRevenue = revenueItems.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenseItems.reduce((s, e) => s + e.amount, 0);
    const netIncome = totalRevenue - totalExpenses;
    res.json({ revenue: revenueItems.sort((a, b) => b.amount - a.amount), expenses: expenseItems.sort((a, b) => b.amount - a.amount), totalRevenue: parseFloat(totalRevenue.toFixed(2)), totalExpenses: parseFloat(totalExpenses.toFixed(2)), grossProfit: parseFloat(totalRevenue.toFixed(2)), netIncome: parseFloat(netIncome.toFixed(2)), netIncomeMargin: totalRevenue > 0 ? parseFloat(((netIncome / totalRevenue) * 100).toFixed(2)) : 0 });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/balance-sheet
router.get("/balance-sheet", async (req, res) => {
  try {
    const { as_of } = req.query as Record<string, string>;
    const conditions: any[] = as_of ? [lte(transactionsTable.date, as_of)] : [];
    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable).leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const assets: Record<string, { name: string; nameAr: string; amount: number }> = {};
    const liabilities: Record<string, { name: string; nameAr: string; amount: number }> = {};
    let equity = 0;

    for (const { tx, cat } of txs) {
      const amount = toNum(tx.amount);
      const catType = cat?.type ?? "expense";
      const key = String(tx.categoryId ?? "uncategorized");
      const catName = cat?.name ?? "Uncategorized";
      const catNameAr = cat?.nameAr ?? "غير مصنف";
      if (catType === "asset") {
        if (!assets[key]) assets[key] = { name: catName, nameAr: catNameAr, amount: 0 };
        assets[key].amount += tx.type === "credit" ? amount : -amount;
      } else if (catType === "liability") {
        if (!liabilities[key]) liabilities[key] = { name: catName, nameAr: catNameAr, amount: 0 };
        liabilities[key].amount += tx.type === "credit" ? amount : -amount;
      } else if (catType === "income") { equity += amount;
      } else if (catType === "expense") { equity -= amount; }
    }

    const invRows = await db.select().from(invoicesTable);
    const arBalance = invRows.reduce((s, i) => s + toNum(i.total) - toNum(i.paidAmount), 0);
    const apRows = await db.select().from(billsTable);
    const apBalance = apRows.reduce((s, b) => s + toNum(b.total) - toNum(b.paidAmount), 0);
    const totalAssets = Object.values(assets).reduce((s, a) => s + a.amount, 0) + arBalance;
    const totalLiabilities = Object.values(liabilities).reduce((s, l) => s + l.amount, 0) + apBalance;

    res.json({
      assets: { items: Object.values(assets).map(a => ({ ...a, amount: parseFloat(a.amount.toFixed(2)) })).sort((a, b) => b.amount - a.amount), accountsReceivable: parseFloat(arBalance.toFixed(2)), total: parseFloat(totalAssets.toFixed(2)) },
      liabilities: { items: Object.values(liabilities).map(l => ({ ...l, amount: parseFloat(l.amount.toFixed(2)) })), accountsPayable: parseFloat(apBalance.toFixed(2)), total: parseFloat(totalLiabilities.toFixed(2)) },
      equity: { retainedEarnings: parseFloat(equity.toFixed(2)), total: parseFloat(equity.toFixed(2)) },
      totalLiabilitiesAndEquity: parseFloat((totalLiabilities + equity).toFixed(2)),
      asOf: as_of ?? new Date().toISOString().split("T")[0],
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/cash-flow?date_from=&date_to=
router.get("/cash-flow", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));
    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable).leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    let operating = 0, investing = 0, financing = 0;
    const operatingItems: any[] = [], investingItems: any[] = [], financingItems: any[] = [];

    for (const { tx, cat } of txs) {
      const amount = tx.type === "credit" ? toNum(tx.amount) : -toNum(tx.amount);
      const catType = cat?.type ?? "expense";
      const catName = cat?.name ?? "Uncategorized";
      if (catType === "asset" && ["Fixed Assets"].includes(cat?.name ?? "")) { investing += amount; investingItems.push({ name: catName, amount });
      } else if (catType === "liability") { financing += amount; financingItems.push({ name: catName, amount });
      } else { operating += amount; operatingItems.push({ name: catName, amount }); }
    }
    res.json({ operating: { total: parseFloat(operating.toFixed(2)), items: operatingItems }, investing: { total: parseFloat(investing.toFixed(2)), items: investingItems }, financing: { total: parseFloat(financing.toFixed(2)), items: financingItems }, netChange: parseFloat((operating + investing + financing).toFixed(2)) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/ar-aging
router.get("/ar-aging", async (req, res) => {
  try {
    const today = new Date();
    const invoices = await db.select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable).leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(and(eq(invoicesTable.status, "sent")));
    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: any[] = [];
    for (const { inv, cust } of invoices) {
      const outstanding = toNum(inv.total) - toNum(inv.paidAmount);
      if (outstanding <= 0) continue;
      const due = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.date);
      const daysPast = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
      items.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, customerName: cust?.name ?? "Unknown", dueDate: inv.dueDate, outstanding: parseFloat(outstanding.toFixed(2)), daysPastDue: Math.max(0, daysPast) });
      if (daysPast <= 0) buckets.current += outstanding;
      else if (daysPast <= 30) buckets.days_1_30 += outstanding;
      else if (daysPast <= 60) buckets.days_31_60 += outstanding;
      else if (daysPast <= 90) buckets.days_61_90 += outstanding;
      else buckets.over_90 += outstanding;
    }
    res.json({ buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, parseFloat(v.toFixed(2))])), total: parseFloat(Object.values(buckets).reduce((s, v) => s + v, 0).toFixed(2)), items: items.sort((a, b) => b.daysPastDue - a.daysPastDue) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /reports/vat-return?period_from=YYYY-MM&period_to=YYYY-MM
//
// ZATCA VAT Return — Form 001 structure (box by box)
// Standard rate = 15%, zero-rated = 0%, exempt = no VAT
// ─────────────────────────────────────────────────────────────────────────────
router.get("/vat-return", async (req, res) => {
  try {
    const { period_from, period_to } = req.query as Record<string, string>;
    const dateFrom = period_from ? `${period_from}-01` : "1900-01-01";
    const dateTo   = period_to   ? `${period_to}-31`   : "2099-12-31";

    // Output VAT: from customer invoices in the period
    const invoiceRows = await db.select().from(invoicesTable)
      .where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo)));

    let standardRatedSales = 0, outputVat = 0, zeroRatedSales = 0, exemptSales = 0, exportSales = 0;
    for (const inv of invoiceRows) {
      const vatRate = toNum(inv.vatAmount) > 0 ? (toNum(inv.vatAmount) / toNum(inv.subtotal)) * 100 : 0;
      if (vatRate >= 14.9) {
        standardRatedSales += toNum(inv.subtotal);
        outputVat += toNum(inv.vatAmount);
      } else if (vatRate === 0) {
        zeroRatedSales += toNum(inv.subtotal);
      }
    }

    // Input VAT: from vendor bills in the period
    const billRows = await db.select().from(billsTable)
      .where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo)));

    let standardRatedPurchases = 0, inputVat = 0, zeroRatedPurchases = 0;
    for (const bill of billRows) {
      const vatRate = toNum(bill.vatAmount) > 0 ? (toNum(bill.vatAmount) / toNum(bill.subtotal)) * 100 : 0;
      if (vatRate >= 14.9) {
        standardRatedPurchases += toNum(bill.subtotal);
        inputVat += toNum(bill.vatAmount);
      } else if (vatRate === 0) {
        zeroRatedPurchases += toNum(bill.subtotal);
      }
    }

    const totalSales = standardRatedSales + zeroRatedSales + exemptSales + exportSales;
    const totalPurchases = standardRatedPurchases + zeroRatedPurchases;
    const netVatDue = outputVat - inputVat;

    const fmt2 = (n: number) => parseFloat(n.toFixed(2));

    res.json({
      period: { from: dateFrom, to: dateTo },
      // ZATCA Form 001 — Sales Section
      salesSection: {
        box1_standardRatedDomesticSales:  fmt2(standardRatedSales),
        box2_zeroRatedDomesticSales:      fmt2(zeroRatedSales),
        box3_exemptSales:                 fmt2(exemptSales),
        box4_exportSales:                 fmt2(exportSales),
        box5_totalSales:                  fmt2(totalSales),
        box6_vatOnStandardRatedSales:     fmt2(outputVat),
        box7_vatAdjustments:              0,
        box8_totalOutputVat:              fmt2(outputVat),
      },
      // ZATCA Form 001 — Purchases Section
      purchasesSection: {
        box9_standardRatedPurchases:      fmt2(standardRatedPurchases),
        box10_zeroRatedPurchases:         fmt2(zeroRatedPurchases),
        box11_exemptPurchases:            0,
        box12_totalPurchases:             fmt2(totalPurchases),
        box13_recoverableInputVat:        fmt2(inputVat),
        box14_inputVatAdjustments:        0,
        box15_totalInputVat:              fmt2(inputVat),
      },
      // Net position
      netVatDue:   fmt2(netVatDue),
      vatPayable:  netVatDue > 0 ? fmt2(netVatDue) : 0,
      vatRefund:   netVatDue < 0 ? fmt2(-netVatDue) : 0,
      invoiceCount: invoiceRows.length,
      billCount:    billRows.length,
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
