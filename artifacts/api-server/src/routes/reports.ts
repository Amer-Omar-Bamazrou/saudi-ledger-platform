import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, categoriesTable, invoicesTable, billsTable } from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

// GET /reports/trial-balance?date_from=&date_to=
router.get("/trial-balance", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conditions = [];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));

    const txs = await db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    // Group by category/account
    const accounts = new Map<number | null, { id: number | null; name: string; nameAr: string; type: string; debit: number; credit: number }>();

    for (const { tx, cat } of txs) {
      const key = tx.categoryId ?? null;
      const amount = toNum(tx.amount);
      if (!accounts.has(key)) {
        accounts.set(key, { id: key, name: cat?.name ?? "Uncategorized", nameAr: cat?.nameAr ?? "غير مصنف", type: cat?.type ?? "expense", debit: 0, credit: 0 });
      }
      const acc = accounts.get(key)!;
      if (tx.type === "debit") acc.debit += amount;
      else acc.credit += amount;
    }

    const rows = Array.from(accounts.values()).map(a => ({
      ...a, debit: parseFloat(a.debit.toFixed(2)), credit: parseFloat(a.credit.toFixed(2)), balance: parseFloat((a.debit - a.credit).toFixed(2)),
    })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

    const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.credit, 0);

    res.json({ accounts: rows, totalDebit: parseFloat(totalDebit.toFixed(2)), totalCredit: parseFloat(totalCredit.toFixed(2)), balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/income-statement?date_from=&date_to=
router.get("/income-statement", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conditions = [];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));

    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    // Separate income vs expense categories
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

    res.json({
      revenue: revenueItems.sort((a, b) => b.amount - a.amount),
      expenses: expenseItems.sort((a, b) => b.amount - a.amount),
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalExpenses: parseFloat(totalExpenses.toFixed(2)),
      grossProfit: parseFloat(totalRevenue.toFixed(2)),
      netIncome: parseFloat(netIncome.toFixed(2)),
      netIncomeMargin: totalRevenue > 0 ? parseFloat(((netIncome / totalRevenue) * 100).toFixed(2)) : 0,
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/balance-sheet
router.get("/balance-sheet", async (req, res) => {
  try {
    const { as_of } = req.query as Record<string, string>;
    const conditions = as_of ? [lte(transactionsTable.date, as_of)] : [];

    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
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
      } else if (catType === "income") {
        equity += amount;
      } else if (catType === "expense") {
        equity -= amount;
      }
    }

    // AR from invoices
    const invRows = await db.select().from(invoicesTable);
    const arBalance = invRows.reduce((s, i) => s + toNum(i.total) - toNum(i.paidAmount), 0);
    const apRows = await db.select().from(billsTable);
    const apBalance = apRows.reduce((s, b) => s + toNum(b.total) - toNum(b.paidAmount), 0);

    const totalAssets = Object.values(assets).reduce((s, a) => s + a.amount, 0) + arBalance;
    const totalLiabilities = Object.values(liabilities).reduce((s, l) => s + l.amount, 0) + apBalance;
    const retainedEarnings = equity;

    res.json({
      assets: { items: Object.values(assets).map(a => ({ ...a, amount: parseFloat(a.amount.toFixed(2)) })).sort((a, b) => b.amount - a.amount), accountsReceivable: parseFloat(arBalance.toFixed(2)), total: parseFloat(totalAssets.toFixed(2)) },
      liabilities: { items: Object.values(liabilities).map(l => ({ ...l, amount: parseFloat(l.amount.toFixed(2)) })), accountsPayable: parseFloat(apBalance.toFixed(2)), total: parseFloat(totalLiabilities.toFixed(2)) },
      equity: { retainedEarnings: parseFloat(retainedEarnings.toFixed(2)), total: parseFloat(retainedEarnings.toFixed(2)) },
      totalLiabilitiesAndEquity: parseFloat((totalLiabilities + retainedEarnings).toFixed(2)),
      asOf: as_of ?? new Date().toISOString().split("T")[0],
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/cash-flow?date_from=&date_to=
router.get("/cash-flow", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conditions = [];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));

    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    let operating = 0, investing = 0, financing = 0;
    const operatingItems: { name: string; amount: number }[] = [];
    const investingItems: { name: string; amount: number }[] = [];
    const financingItems: { name: string; amount: number }[] = [];

    for (const { tx, cat } of txs) {
      const amount = tx.type === "credit" ? toNum(tx.amount) : -toNum(tx.amount);
      const catType = cat?.type ?? "expense";
      const catName = cat?.name ?? "Uncategorized";

      if (catType === "asset" && ["Fixed Assets"].includes(cat?.name ?? "")) {
        investing += amount;
        investingItems.push({ name: catName, amount });
      } else if (catType === "liability") {
        financing += amount;
        financingItems.push({ name: catName, amount });
      } else {
        operating += amount;
        operatingItems.push({ name: catName, amount });
      }
    }

    res.json({
      operating: { total: parseFloat(operating.toFixed(2)), items: operatingItems },
      investing: { total: parseFloat(investing.toFixed(2)), items: investingItems },
      financing: { total: parseFloat(financing.toFixed(2)), items: financingItems },
      netChange: parseFloat((operating + investing + financing).toFixed(2)),
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /reports/ar-aging  
router.get("/ar-aging", async (req, res) => {
  try {
    const today = new Date();
    const invoices = await db.select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
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

    res.json({
      buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, parseFloat(v.toFixed(2))])),
      total: parseFloat(Object.values(buckets).reduce((s, v) => s + v, 0).toFixed(2)),
      items: items.sort((a, b) => b.daysPastDue - a.daysPastDue),
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
