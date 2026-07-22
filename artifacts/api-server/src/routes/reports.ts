import { Router } from "express";
import { db } from "@workspace/db";
import {
  transactionsTable, categoriesTable, invoicesTable, billsTable,
  journalEntriesTable, journalEntryLinesTable, customersTable, vendorsTable,
} from "@workspace/db";
import { eq, and, gte, lte, ne, sql, asc, desc, or, ilike } from "drizzle-orm";

const router = Router();
const toNum = (v: unknown) => v != null ? Number(v) : 0;
const fmt2  = (n: number)  => parseFloat(n.toFixed(2));

// ── helpers ──────────────────────────────────────────────────────────────────
function jeConditions(date_from?: string, date_to?: string, statusFilter = true) {
  const conds: any[] = [];
  if (statusFilter) conds.push(eq(journalEntriesTable.status, "posted"));
  if (date_from)    conds.push(gte(journalEntriesTable.date, date_from));
  if (date_to)      conds.push(lte(journalEntriesTable.date, date_to));
  return conds;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIAL BALANCE   GET /reports/trial-balance?date_from=&date_to=
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trial-balance", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conds = jeConditions(date_from, date_to);

    const lines = await db
      .select({
        accountName: journalEntryLinesTable.accountName,
        accountId:   journalEntryLinesTable.accountId,
        debit:       journalEntryLinesTable.debitAmount,
        credit:      journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds));

    // Roll up by account; join category for type
    const cats = await db.select().from(categoriesTable);
    const catMap = new Map(cats.map(c => [c.id, c]));

    const accounts = new Map<string, { name: string; nameAr: string; accountId: number | null; type: string; debit: number; credit: number }>();
    for (const l of lines) {
      const key = l.accountId != null ? String(l.accountId) : l.accountName;
      if (!accounts.has(key)) {
        const cat = l.accountId ? catMap.get(l.accountId) : undefined;
        accounts.set(key, { name: l.accountName, nameAr: cat?.nameAr ?? "", accountId: l.accountId, type: cat?.type ?? "other", debit: 0, credit: 0 });
      }
      const acc = accounts.get(key)!;
      acc.debit  += toNum(l.debit);
      acc.credit += toNum(l.credit);
    }

    const rows = Array.from(accounts.values())
      .map(a => ({ name: a.name, nameAr: a.nameAr, accountId: a.accountId, type: a.type, debit: fmt2(a.debit), credit: fmt2(a.credit), balance: fmt2(a.debit - a.credit) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totalDebit  = fmt2(rows.reduce((s, r) => s + r.debit,  0));
    const totalCredit = fmt2(rows.reduce((s, r) => s + r.credit, 0));
    res.json({ accounts: rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INCOME STATEMENT   GET /reports/income-statement?date_from=&date_to=
// Derived from posted journal_entry_lines; falls back to transactions if no JEs.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/income-statement", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conds = jeConditions(date_from, date_to);

    const lines = await db
      .select({
        accountName: journalEntryLinesTable.accountName,
        accountId:   journalEntryLinesTable.accountId,
        debit:       journalEntryLinesTable.debitAmount,
        credit:      journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds));

    const cats = await db.select().from(categoriesTable);
    const catMap = new Map(cats.map(c => [c.id, c]));

    const revenue: Record<string, { name: string; nameAr: string; amount: number }> = {};
    const expenses: Record<string, { name: string; nameAr: string; amount: number }> = {};

    for (const l of lines) {
      const cat = l.accountId ? catMap.get(l.accountId) : undefined;
      const type = cat?.type ?? "expense";
      const name = l.accountName;
      const nameAr = cat?.nameAr ?? "";
      const key = l.accountId != null ? String(l.accountId) : name;

      if (type === "income" || type === "revenue") {
        // Revenue: credit increases income (credit - debit)
        if (!revenue[key]) revenue[key] = { name, nameAr, amount: 0 };
        revenue[key].amount += toNum(l.credit) - toNum(l.debit);
      } else if (type === "expense") {
        // Expenses: debit increases expense (debit - credit)
        if (!expenses[key]) expenses[key] = { name, nameAr, amount: 0 };
        expenses[key].amount += toNum(l.debit) - toNum(l.credit);
      }
    }

    // Fallback: if no JEs, use transactions table
    if (lines.length === 0) {
      const txConds: any[] = [];
      if (date_from) txConds.push(gte(transactionsTable.date, date_from));
      if (date_to)   txConds.push(lte(transactionsTable.date, date_to));
      const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
        .from(transactionsTable)
        .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
        .where(txConds.length > 0 ? and(...txConds) : undefined);
      for (const { tx, cat } of txs) {
        const amount = toNum(tx.amount);
        const catType = cat?.type ?? "expense";
        const key = String(tx.categoryId ?? "uncategorized");
        const name = cat?.name ?? "Uncategorized";
        const nameAr = cat?.nameAr ?? "غير مصنف";
        if (tx.type === "credit" || catType === "income") {
          if (!revenue[key]) revenue[key] = { name, nameAr, amount: 0 };
          revenue[key].amount += amount;
        } else {
          if (!expenses[key]) expenses[key] = { name, nameAr, amount: 0 };
          expenses[key].amount += amount;
        }
      }
    }

    const revenueItems  = Object.values(revenue).map(r => ({ ...r, amount: fmt2(r.amount) })).sort((a, b) => b.amount - a.amount);
    const expenseItems  = Object.values(expenses).map(e => ({ ...e, amount: fmt2(e.amount) })).sort((a, b) => b.amount - a.amount);
    const totalRevenue  = fmt2(revenueItems.reduce((s, r) => s + r.amount, 0));
    const totalExpenses = fmt2(expenseItems.reduce((s, e) => s + e.amount, 0));
    const netIncome     = fmt2(totalRevenue - totalExpenses);

    res.json({
      revenue: revenueItems, expenses: expenseItems,
      totalRevenue, totalExpenses, grossProfit: totalRevenue, netIncome,
      netIncomeMargin: totalRevenue > 0 ? fmt2((netIncome / totalRevenue) * 100) : 0,
      source: lines.length > 0 ? "journal_entries" : "transactions",
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE SHEET   GET /reports/balance-sheet?as_of=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
router.get("/balance-sheet", async (req, res) => {
  try {
    const { as_of } = req.query as Record<string, string>;
    const conds: any[] = [eq(journalEntriesTable.status, "posted")];
    if (as_of) conds.push(lte(journalEntriesTable.date, as_of));

    const lines = await db
      .select({
        accountId:   journalEntryLinesTable.accountId,
        accountName: journalEntryLinesTable.accountName,
        debit:       journalEntryLinesTable.debitAmount,
        credit:      journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds));

    const cats = await db.select().from(categoriesTable);
    const catMap = new Map(cats.map(c => [c.id, c]));

    const assets: Record<string, { name: string; nameAr: string; amount: number }> = {};
    const liabilities: Record<string, { name: string; nameAr: string; amount: number }> = {};
    const equityAccounts: Record<string, { name: string; nameAr: string; amount: number }> = {};
    let retainedEarnings = 0;

    for (const l of lines) {
      const cat = l.accountId ? catMap.get(l.accountId) : undefined;
      const type = cat?.type ?? "";
      const key = l.accountId != null ? String(l.accountId) : l.accountName;
      const name = l.accountName;
      const nameAr = cat?.nameAr ?? "";
      const net = toNum(l.debit) - toNum(l.credit); // debit-normal for assets

      if (type === "asset") {
        if (!assets[key]) assets[key] = { name, nameAr, amount: 0 };
        assets[key].amount += net;
      } else if (type === "liability") {
        if (!liabilities[key]) liabilities[key] = { name, nameAr, amount: 0 };
        liabilities[key].amount += -net; // credit-normal
      } else if (type === "equity") {
        if (!equityAccounts[key]) equityAccounts[key] = { name, nameAr, amount: 0 };
        equityAccounts[key].amount += -net;
      } else if (type === "income" || type === "revenue") {
        retainedEarnings += toNum(l.credit) - toNum(l.debit);
      } else if (type === "expense") {
        retainedEarnings -= toNum(l.debit) - toNum(l.credit);
      }
    }

    // Fallback: supplement with AR/AP from invoice/bill tables
    const invRows  = await db.select().from(invoicesTable);
    const arBalance = fmt2(invRows.reduce((s, i) => s + toNum(i.total) - toNum(i.paidAmount), 0));
    const billRows  = await db.select().from(billsTable);
    const apBalance = fmt2(billRows.reduce((s, b) => s + toNum(b.total) - toNum(b.paidAmount), 0));

    const assetItems = Object.values(assets).map(a => ({ ...a, amount: fmt2(a.amount) }));
    const liabItems  = Object.values(liabilities).map(l => ({ ...l, amount: fmt2(l.amount) }));
    const eqItems    = Object.values(equityAccounts).map(e => ({ ...e, amount: fmt2(e.amount) }));

    const totalAssets = fmt2(assetItems.reduce((s, a) => s + a.amount, 0) + arBalance);
    const totalLiab   = fmt2(liabItems.reduce((s, l) => s + l.amount, 0) + apBalance);
    const totalEquity = fmt2(eqItems.reduce((s, e) => s + e.amount, 0) + retainedEarnings);
    const totalLiabAndEquity = fmt2(totalLiab + totalEquity);
    const balanced = Math.abs(totalAssets - totalLiabAndEquity) < 0.05;

    res.json({
      asOf: as_of ?? new Date().toISOString().split("T")[0],
      assets:      { items: assetItems.sort((a,b) => b.amount - a.amount), accountsReceivable: arBalance, total: totalAssets },
      liabilities: { items: liabItems, accountsPayable: apBalance, total: totalLiab },
      equity:      { items: eqItems, retainedEarnings: fmt2(retainedEarnings), total: totalEquity },
      totalLiabilitiesAndEquity: totalLiabAndEquity,
      balanced,
      warning: balanced ? null : `Assets (${totalAssets}) ≠ Liabilities + Equity (${totalLiabAndEquity}). Check for unposted entries.`,
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CASH FLOW   GET /reports/cash-flow?date_from=&date_to=
// ─────────────────────────────────────────────────────────────────────────────
router.get("/cash-flow", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const txConds: any[] = [];
    if (date_from) txConds.push(gte(transactionsTable.date, date_from));
    if (date_to)   txConds.push(lte(transactionsTable.date, date_to));
    const txs = await db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable).leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(txConds.length > 0 ? and(...txConds) : undefined);

    let operating = 0, investing = 0, financing = 0;
    const operatingItems: any[] = [], investingItems: any[] = [], financingItems: any[] = [];

    for (const { tx, cat } of txs) {
      const amount = tx.type === "credit" ? toNum(tx.amount) : -toNum(tx.amount);
      const catName = cat?.name ?? "Uncategorized";
      const catType = cat?.type ?? "expense";
      if (catType === "asset" && (cat?.name ?? "").toLowerCase().includes("fixed")) {
        investing += amount; investingItems.push({ name: catName, amount });
      } else if (catType === "liability") {
        financing += amount; financingItems.push({ name: catName, amount });
      } else {
        operating += amount; operatingItems.push({ name: catName, amount });
      }
    }

    res.json({
      operating:  { total: fmt2(operating),  items: operatingItems },
      investing:  { total: fmt2(investing),  items: investingItems },
      financing:  { total: fmt2(financing),  items: financingItems },
      netChange:  fmt2(operating + investing + financing),
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL REPORT   GET /reports/journal-report?date_from=&date_to=
// Full list of posted journal entries with all debit/credit lines under each.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/journal-report", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conds = jeConditions(date_from, date_to);

    const entries = await db
      .select()
      .from(journalEntriesTable)
      .where(and(...conds))
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id));

    const lines = await db
      .select()
      .from(journalEntryLinesTable)
      .where(entries.length > 0 ? sql`${journalEntryLinesTable.journalEntryId} = ANY(ARRAY[${sql.raw(entries.map(e => e.id).join(",") || "NULL")}]::int[])` : eq(journalEntryLinesTable.id, -1));

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map(e => {
      const entryLines = linesByEntry.get(e.id) ?? [];
      const totalDebit  = fmt2(entryLines.reduce((s, l) => s + toNum(l.debitAmount), 0));
      const totalCredit = fmt2(entryLines.reduce((s, l) => s + toNum(l.creditAmount), 0));
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description,
        reference: e.reference, status: e.status,
        lines: entryLines.map(l => ({
          id: l.id, accountName: l.accountName, accountId: l.accountId,
          description: l.description,
          debit: fmt2(toNum(l.debitAmount)), credit: fmt2(toNum(l.creditAmount)),
        })),
        totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01,
      };
    });

    const grandDebit  = fmt2(result.reduce((s, e) => s + e.totalDebit,  0));
    const grandCredit = fmt2(result.reduce((s, e) => s + e.totalCredit, 0));
    res.json({ entries: result, count: result.length, grandDebit, grandCredit, balanced: Math.abs(grandDebit - grandCredit) < 0.01 });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL LEDGER   GET /reports/general-ledger?account_id=&account_name=&date_from=&date_to=
// All movements for one account (or all accounts) with running balance.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/general-ledger", async (req, res) => {
  try {
    const { account_id, account_name, date_from, date_to } = req.query as Record<string, string>;

    // Opening balance: all posted lines for this account BEFORE date_from
    let openingBalance = 0;
    if (date_from && (account_id || account_name)) {
      const preConds: any[] = [eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`];
      if (account_id) preConds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
      else if (account_name) preConds.push(eq(journalEntryLinesTable.accountName, account_name));

      const preLines = await db.select({ debit: journalEntryLinesTable.debitAmount, credit: journalEntryLinesTable.creditAmount })
        .from(journalEntryLinesTable)
        .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
        .where(and(...preConds));
      openingBalance = fmt2(preLines.reduce((s, l) => s + toNum(l.debit) - toNum(l.credit), 0));
    }

    const conds = jeConditions(date_from, date_to);
    if (account_id)   conds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    if (account_name && !account_id) conds.push(eq(journalEntryLinesTable.accountName, account_name));

    const rows = await db
      .select({
        lineId:      journalEntryLinesTable.id,
        jeId:        journalEntriesTable.id,
        entryNumber: journalEntriesTable.entryNumber,
        date:        journalEntriesTable.date,
        description: journalEntriesTable.description,
        reference:   journalEntriesTable.reference,
        lineDesc:    journalEntryLinesTable.description,
        accountName: journalEntryLinesTable.accountName,
        accountId:   journalEntryLinesTable.accountId,
        debit:       journalEntryLinesTable.debitAmount,
        credit:      journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .orderBy(asc(journalEntriesTable.date), asc(journalEntriesTable.id));

    // Compute running balance
    let running = openingBalance;
    const movements = rows.map(r => {
      const d = toNum(r.debit), c = toNum(r.credit);
      running = fmt2(running + d - c);
      return {
        date: r.date, entryNumber: r.entryNumber, jeId: r.jeId,
        description: r.lineDesc ?? r.description, reference: r.reference,
        accountName: r.accountName, accountId: r.accountId,
        debit: fmt2(d), credit: fmt2(c), balance: running,
      };
    });

    // Enrich movements with nameAr from categories (looked up via accountId)
    const cats = await db.select().from(categoriesTable);
    const catMap = new Map(cats.map(c => [c.id, c]));
    const enrichedMovements = movements.map(m => ({
      ...m,
      accountNameAr: (m.accountId ? catMap.get(m.accountId)?.nameAr : undefined) ?? "",
    }));

    const accountsList = Array.from(new Set(rows.map(r => r.accountName)));
    const firstCat = rows[0]?.accountId ? catMap.get(rows[0].accountId) : undefined;

    res.json({
      accountId: account_id ? Number(account_id) : null,
      accountName:   account_name ?? rows[0]?.accountName ?? "All Accounts",
      accountNameAr: firstCat?.nameAr ?? "",
      openingBalance,
      movements: enrichedMovements,
      closingBalance: fmt2(running),
      totalDebit:  fmt2(enrichedMovements.reduce((s, m) => s + m.debit,  0)),
      totalCredit: fmt2(enrichedMovements.reduce((s, m) => s + m.credit, 0)),
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT STATEMENT   GET /reports/account-statement?account_id=&date_from=&date_to=
// Single-account view: opening balance + movements + closing balance.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/account-statement", async (req, res) => {
  try {
    const { account_id, account_name, date_from, date_to } = req.query as Record<string, string>;
    if (!account_id && !account_name) {
      res.status(400).json({ error: "account_id or account_name is required" }); return;
    }
    // Delegate to general-ledger logic — same endpoint behaviour
    const qs = new URLSearchParams();
    if (account_id)   qs.set("account_id",   account_id);
    if (account_name) qs.set("account_name", account_name);
    if (date_from)    qs.set("date_from",    date_from);
    if (date_to)      qs.set("date_to",      date_to);

    // Re-run GL logic inline
    let openingBalance = 0;
    if (date_from) {
      const preConds: any[] = [eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`];
      if (account_id)   preConds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
      else              preConds.push(eq(journalEntryLinesTable.accountName, account_name));
      const pre = await db.select({ d: journalEntryLinesTable.debitAmount, c: journalEntryLinesTable.creditAmount })
        .from(journalEntryLinesTable)
        .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
        .where(and(...preConds));
      openingBalance = fmt2(pre.reduce((s, l) => s + toNum(l.d) - toNum(l.c), 0));
    }

    const conds = jeConditions(date_from, date_to);
    if (account_id)              conds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    else if (account_name)       conds.push(eq(journalEntryLinesTable.accountName, account_name));

    const rows = await db.select({
        date: journalEntriesTable.date, entryNumber: journalEntriesTable.entryNumber,
        reference: journalEntriesTable.reference, description: journalEntriesTable.description,
        lineDesc: journalEntryLinesTable.description,
        debit: journalEntryLinesTable.debitAmount, credit: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .orderBy(asc(journalEntriesTable.date));

    let running = openingBalance;
    const movements = rows.map(r => {
      const d = toNum(r.debit), c = toNum(r.credit);
      running = fmt2(running + d - c);
      return { date: r.date, entryNumber: r.entryNumber, reference: r.reference, description: r.lineDesc ?? r.description, debit: fmt2(d), credit: fmt2(c), balance: running };
    });

    // Fetch account meta
    const cat = account_id ? await db.select().from(categoriesTable).where(eq(categoriesTable.id, Number(account_id))).limit(1) : [];

    res.json({
      account: cat[0] ?? { name: account_name ?? "Unknown", type: "other" },
      openingBalance, movements, closingBalance: running,
      totalDebit:  fmt2(movements.reduce((s, m) => s + m.debit,  0)),
      totalCredit: fmt2(movements.reduce((s, m) => s + m.credit, 0)),
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT SUMMARY   GET /reports/account-summary?date_from=&date_to=
// Every account: opening balance, period movements, closing balance.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/account-summary", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;

    // Opening balances (before date_from)
    const openMap = new Map<string, number>();
    if (date_from) {
      const pre = await db.select({
        accountName: journalEntryLinesTable.accountName,
        accountId:   journalEntryLinesTable.accountId,
        debit:       journalEntryLinesTable.debitAmount,
        credit:      journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`));
      for (const l of pre) {
        const k = l.accountId != null ? String(l.accountId) : l.accountName;
        openMap.set(k, (openMap.get(k) ?? 0) + toNum(l.debit) - toNum(l.credit));
      }
    }

    // Period movements
    const conds = jeConditions(date_from, date_to);
    const period = await db.select({
      accountName: journalEntryLinesTable.accountName,
      accountId:   journalEntryLinesTable.accountId,
      debit:       journalEntryLinesTable.debitAmount,
      credit:      journalEntryLinesTable.creditAmount,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
    .where(and(...conds));

    const cats = await db.select().from(categoriesTable);
    const catMap = new Map(cats.map(c => [c.id, c]));

    const accs = new Map<string, { name: string; type: string; opening: number; debit: number; credit: number }>();
    const allKeys = new Set([...openMap.keys(), ...period.map(l => l.accountId != null ? String(l.accountId) : l.accountName)]);
    for (const k of allKeys) {
      const sampleLine = period.find(l => (l.accountId != null ? String(l.accountId) : l.accountName) === k);
      const cat = sampleLine?.accountId ? catMap.get(sampleLine.accountId) : undefined;
      accs.set(k, { name: sampleLine?.accountName ?? k, type: cat?.type ?? "other", opening: openMap.get(k) ?? 0, debit: 0, credit: 0 });
    }
    for (const l of period) {
      const k = l.accountId != null ? String(l.accountId) : l.accountName;
      if (!accs.has(k)) accs.set(k, { name: l.accountName, type: "other", opening: 0, debit: 0, credit: 0 });
      const a = accs.get(k)!;
      a.debit  += toNum(l.debit);
      a.credit += toNum(l.credit);
    }

    const rows = Array.from(accs.entries()).map(([, a]) => ({
      name: a.name, type: a.type,
      openingBalance: fmt2(a.opening),
      periodDebit:    fmt2(a.debit),
      periodCredit:   fmt2(a.credit),
      closingBalance: fmt2(a.opening + a.debit - a.credit),
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ accounts: rows, count: rows.length });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER LEDGER   GET /reports/customer-ledger?customer_id=&date_from=&date_to=
// Invoices + payments for each customer showing balance owed.
// (Derived from invoices table since journal lines lack entity_id)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/customer-ledger", async (req, res) => {
  try {
    const { customer_id, date_from, date_to } = req.query as Record<string, string>;
    const conds: any[] = [];
    if (customer_id) conds.push(eq(invoicesTable.customerId, Number(customer_id)));
    if (date_from)   conds.push(gte(invoicesTable.date, date_from));
    if (date_to)     conds.push(lte(invoicesTable.date, date_to));

    const rows = await db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(customersTable.name), asc(invoicesTable.date));

    // Group by customer
    const custMap = new Map<number, { customer: any; invoices: any[] }>();
    for (const { inv, cust } of rows) {
      const cid = inv.customerId ?? 0;
      if (!custMap.has(cid)) custMap.set(cid, { customer: cust, invoices: [] });
      custMap.get(cid)!.invoices.push({
        id: inv.id, invoiceNumber: inv.invoiceNumber, date: inv.date, dueDate: inv.dueDate,
        status: inv.status, total: fmt2(toNum(inv.total)), paidAmount: fmt2(toNum(inv.paidAmount)),
        outstanding: fmt2(toNum(inv.total) - toNum(inv.paidAmount)),
        vatAmount: fmt2(toNum(inv.vatAmount)), subtotal: fmt2(toNum(inv.subtotal)),
      });
    }

    const customers = Array.from(custMap.values()).map(({ customer, invoices }) => ({
      customerId: customer?.id, customerName: customer?.name ?? "Unknown",
      taxNumber: customer?.taxNumber,
      invoices,
      totalInvoiced: fmt2(invoices.reduce((s, i) => s + i.total, 0)),
      totalPaid:     fmt2(invoices.reduce((s, i) => s + i.paidAmount, 0)),
      balance:       fmt2(invoices.reduce((s, i) => s + i.outstanding, 0)),
    }));

    res.json({ customers, totalBalance: fmt2(customers.reduce((s, c) => s + c.balance, 0)) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// OWNER EQUITY   GET /reports/owner-equity?date_from=&date_to=
// Opening equity + net income + contributions − withdrawals = closing equity.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/owner-equity", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;

    // Opening equity: all posted equity-type lines before date_from
    let openingEquity = 0;
    if (date_from) {
      const preConds: any[] = [eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`];
      const cats = await db.select().from(categoriesTable).where(eq(categoriesTable.type, "equity"));
      if (cats.length > 0) {
        const catIds = cats.map(c => c.id);
        const pre = await db.select({ d: journalEntryLinesTable.debitAmount, c: journalEntryLinesTable.creditAmount, accountId: journalEntryLinesTable.accountId })
          .from(journalEntryLinesTable)
          .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
          .where(and(...preConds));
        openingEquity = fmt2(pre.filter(l => l.accountId && catIds.includes(l.accountId))
          .reduce((s, l) => s + toNum(l.c) - toNum(l.d), 0));
      }
    }

    // Net income for period (revenue - expenses from posted JEs)
    const incomeConds = jeConditions(date_from, date_to);
    const lines = await db.select({
      accountId: journalEntryLinesTable.accountId,
      debit:     journalEntryLinesTable.debitAmount,
      credit:    journalEntryLinesTable.creditAmount,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
    .where(and(...incomeConds));

    const allCats = await db.select().from(categoriesTable);
    const catMap  = new Map(allCats.map(c => [c.id, c]));

    let revenue = 0, expenses = 0;
    let contributions = 0, withdrawals = 0;
    for (const l of lines) {
      const cat = l.accountId ? catMap.get(l.accountId) : undefined;
      if (!cat) continue;
      if (cat.type === "income" || cat.type === "revenue") revenue  += toNum(l.credit) - toNum(l.debit);
      if (cat.type === "expense")                          expenses += toNum(l.debit)  - toNum(l.credit);
      if (cat.type === "equity") {
        const net = toNum(l.credit) - toNum(l.debit);
        if (net > 0) contributions += net;
        else         withdrawals   += -net;
      }
    }

    const netIncome     = fmt2(revenue - expenses);
    const closingEquity = fmt2(openingEquity + netIncome + contributions - withdrawals);

    res.json({
      period: { from: date_from ?? "all", to: date_to ?? "all" },
      openingEquity, netIncome, contributions: fmt2(contributions), withdrawals: fmt2(withdrawals),
      closingEquity,
      breakdown: [
        { label: "Opening Equity",        amount: openingEquity },
        { label: "Net Income / (Loss)",   amount: netIncome },
        { label: "Capital Contributions", amount: contributions },
        { label: "Withdrawals / Drawings",amount: -withdrawals },
        { label: "Closing Equity",        amount: closingEquity },
      ],
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AR AGING   GET /reports/ar-aging
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ar-aging", async (req, res) => {
  try {
    const today = new Date();
    const rows = await db.select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id));

    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: any[] = [];
    for (const { inv, cust } of rows) {
      const outstanding = toNum(inv.total) - toNum(inv.paidAmount);
      if (outstanding < 0.01 || inv.status === "paid") continue;
      const due = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.date);
      const daysPast = Math.floor((today.getTime() - due.getTime()) / 86400000);
      items.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, customerName: cust?.name ?? "Unknown", customerNameAr: cust?.nameAr ?? "", dueDate: inv.dueDate, outstanding: fmt2(outstanding), daysPastDue: Math.max(0, daysPast) });
      if (daysPast <= 0)       buckets.current     += outstanding;
      else if (daysPast <= 30) buckets.days_1_30   += outstanding;
      else if (daysPast <= 60) buckets.days_31_60  += outstanding;
      else if (daysPast <= 90) buckets.days_61_90  += outstanding;
      else                     buckets.over_90     += outstanding;
    }
    const fmtBuckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt2(v)]));
    res.json({ buckets: fmtBuckets, total: fmt2(Object.values(buckets).reduce((s, v) => s + v, 0)), items: items.sort((a, b) => b.daysPastDue - a.daysPastDue) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AP AGING   GET /reports/ap-aging
// ─────────────────────────────────────────────────────────────────────────────
router.get("/ap-aging", async (req, res) => {
  try {
    const today = new Date();
    const rows = await db.select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id));

    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: any[] = [];
    for (const { bill, vendor } of rows) {
      const outstanding = toNum(bill.total) - toNum(bill.paidAmount);
      if (outstanding < 0.01 || bill.status === "paid") continue;
      const due = bill.dueDate ? new Date(bill.dueDate) : new Date(bill.date);
      const daysPast = Math.floor((today.getTime() - due.getTime()) / 86400000);
      items.push({ id: bill.id, billNumber: bill.billNumber, vendorName: vendor?.name ?? "Unknown", vendorNameAr: vendor?.nameAr ?? "", dueDate: bill.dueDate, outstanding: fmt2(outstanding), daysPastDue: Math.max(0, daysPast) });
      if (daysPast <= 0)       buckets.current    += outstanding;
      else if (daysPast <= 30) buckets.days_1_30  += outstanding;
      else if (daysPast <= 60) buckets.days_31_60 += outstanding;
      else if (daysPast <= 90) buckets.days_61_90 += outstanding;
      else                     buckets.over_90    += outstanding;
    }
    const fmtBuckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt2(v)]));
    res.json({ buckets: fmtBuckets, total: fmt2(Object.values(buckets).reduce((s, v) => s + v, 0)), items: items.sort((a, b) => b.daysPastDue - a.daysPastDue) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// TAX JOURNAL ENTRIES   GET /reports/tax-journal-entries?date_from=&date_to=
// JEs that touch any account with "VAT", "Tax", or "ضريبة" in the name.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tax-journal-entries", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conds = jeConditions(date_from, date_to);

    // Find all lines whose account name contains VAT/Tax keywords
    const taxLines = await db.select({ journalEntryId: journalEntryLinesTable.journalEntryId })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(
        ...conds,
        or(
          ilike(journalEntryLinesTable.accountName, "%vat%"),
          ilike(journalEntryLinesTable.accountName, "%tax%"),
          ilike(journalEntryLinesTable.accountName, "%ضريبة%"),
          ilike(journalEntryLinesTable.accountName, "%زكاة%"),
        )
      ));

    const taxJeIds = [...new Set(taxLines.map(l => l.journalEntryId))];
    if (taxJeIds.length === 0) { res.json({ entries: [], count: 0 }); return; }

    const entries = await db.select().from(journalEntriesTable)
      .where(sql`${journalEntriesTable.id} = ANY(ARRAY[${sql.raw(taxJeIds.join(","))}]::int[])`)
      .orderBy(desc(journalEntriesTable.date));

    const lines = await db.select().from(journalEntryLinesTable)
      .where(sql`${journalEntryLinesTable.journalEntryId} = ANY(ARRAY[${sql.raw(taxJeIds.join(","))}]::int[])`);

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map(e => {
      const entryLines = linesByEntry.get(e.id) ?? [];
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description, reference: e.reference,
        lines: entryLines.map(l => ({ accountName: l.accountName, debit: fmt2(toNum(l.debitAmount)), credit: fmt2(toNum(l.creditAmount)), isTaxLine: /vat|tax|ضريبة|زكاة/i.test(l.accountName) })),
        totalVatDebit:  fmt2(entryLines.filter(l => /vat|tax|ضريبة/i.test(l.accountName)).reduce((s, l) => s + toNum(l.debitAmount), 0)),
        totalVatCredit: fmt2(entryLines.filter(l => /vat|tax|ضريبة/i.test(l.accountName)).reduce((s, l) => s + toNum(l.creditAmount), 0)),
      };
    });

    res.json({ entries: result, count: result.length });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY   GET /reports/activity?date_from=&date_to=
// Recent journal entries as an activity feed.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/activity", async (req, res) => {
  try {
    const { date_from, date_to } = req.query as Record<string, string>;
    const conds: any[] = [];
    if (date_from) conds.push(gte(journalEntriesTable.date, date_from));
    if (date_to)   conds.push(lte(journalEntriesTable.date, date_to));

    const entries = await db.select().from(journalEntriesTable)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id))
      .limit(500);

    const lines = entries.length > 0
      ? await db.select().from(journalEntryLinesTable)
          .where(sql`${journalEntryLinesTable.journalEntryId} = ANY(ARRAY[${sql.raw(entries.map(e => e.id).join(","))}]::int[])`)
      : [];

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map(e => {
      const el = linesByEntry.get(e.id) ?? [];
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description,
        reference: e.reference, status: e.status,
        lineCount: el.length,
        totalDebit: fmt2(el.reduce((s, l) => s + toNum(l.debitAmount), 0)),
        accounts: [...new Set(el.map(l => l.accountName))].slice(0, 3),
      };
    });

    res.json({ activities: result, count: result.length, hasPosted: result.filter(r => r.status === "posted").length, hasDraft: result.filter(r => r.status === "draft").length });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// VAT RETURN   GET /reports/vat-return?period_from=YYYY-MM&period_to=YYYY-MM
// ZATCA Form 001 — output VAT from invoices, input VAT from bills.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/vat-return", async (req, res) => {
  try {
    const { period_from, period_to } = req.query as Record<string, string>;
    const dateFrom = period_from ? `${period_from}-01` : "1900-01-01";
    const dateTo   = period_to   ? `${period_to}-31`   : "2099-12-31";

    const [invoiceRows, billRows] = await Promise.all([
      db.select().from(invoicesTable).where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo))),
      db.select().from(billsTable).where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo))),
    ]);

    let standardRatedSales = 0, outputVat = 0, zeroRatedSales = 0;
    for (const inv of invoiceRows) {
      const vatRate = toNum(inv.vatAmount) > 0 ? (toNum(inv.vatAmount) / toNum(inv.subtotal)) * 100 : 0;
      if (vatRate >= 14.9) { standardRatedSales += toNum(inv.subtotal); outputVat += toNum(inv.vatAmount); }
      else if (vatRate === 0) zeroRatedSales += toNum(inv.subtotal);
    }

    let standardRatedPurchases = 0, inputVat = 0, zeroRatedPurchases = 0;
    for (const bill of billRows) {
      const vatRate = toNum(bill.vatAmount) > 0 ? (toNum(bill.vatAmount) / toNum(bill.subtotal)) * 100 : 0;
      if (vatRate >= 14.9) { standardRatedPurchases += toNum(bill.subtotal); inputVat += toNum(bill.vatAmount); }
      else if (vatRate === 0) zeroRatedPurchases += toNum(bill.subtotal);
    }

    const netVatDue = outputVat - inputVat;
    res.json({
      period: { from: dateFrom, to: dateTo },
      salesSection: {
        box1_standardRatedDomesticSales: fmt2(standardRatedSales),
        box2_zeroRatedDomesticSales:     fmt2(zeroRatedSales),
        box3_exemptSales:                0,
        box4_exportSales:                0,
        box5_totalSales:                 fmt2(standardRatedSales + zeroRatedSales),
        box6_vatOnStandardRatedSales:    fmt2(outputVat),
        box7_vatAdjustments:             0,
        box8_totalOutputVat:             fmt2(outputVat),
      },
      purchasesSection: {
        box9_standardRatedPurchases:  fmt2(standardRatedPurchases),
        box10_zeroRatedPurchases:     fmt2(zeroRatedPurchases),
        box11_exemptPurchases:        0,
        box12_totalPurchases:         fmt2(standardRatedPurchases + zeroRatedPurchases),
        box13_recoverableInputVat:    fmt2(inputVat),
        box14_inputVatAdjustments:    0,
        box15_totalInputVat:          fmt2(inputVat),
      },
      netVatDue:    fmt2(netVatDue),
      vatPayable:   netVatDue > 0 ? fmt2(netVatDue) : 0,
      vatRefund:    netVatDue < 0 ? fmt2(-netVatDue) : 0,
      invoiceCount: invoiceRows.length,
      billCount:    billRows.length,
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: String(err) }); }
});

export default router;
