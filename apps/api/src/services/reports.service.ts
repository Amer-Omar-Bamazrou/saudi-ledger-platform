/**
 * Reports service — financial-statement and ledger computations. Every rollup,
 * balance rule, aging bucket, and VAT-return box is copied VERBATIM from the
 * pre-M6 route handlers; only the DB access now goes through reportsRepository.
 */
import { BadRequestError } from "../lib/errors";
import { reportsRepository, documentSign } from "../repositories/reports.repository";

const toNum = (v: unknown) => (v != null ? Number(v) : 0);
const fmt2 = (n: number) => parseFloat(n.toFixed(2));

export const reportsService = {
  async trialBalance(date_from?: string, date_to?: string) {
    const lines = await reportsRepository.jeLines(date_from, date_to);
    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));

    const accounts = new Map<string, { name: string; nameAr: string; accountId: number | null; type: string; debit: number; credit: number }>();
    for (const l of lines) {
      const key = l.accountId != null ? String(l.accountId) : l.accountName;
      if (!accounts.has(key)) {
        const cat = l.accountId ? catMap.get(l.accountId) : undefined;
        accounts.set(key, { name: l.accountName, nameAr: cat?.nameAr ?? "", accountId: l.accountId, type: cat?.type ?? "other", debit: 0, credit: 0 });
      }
      const acc = accounts.get(key)!;
      acc.debit += toNum(l.debit);
      acc.credit += toNum(l.credit);
    }

    const rows = Array.from(accounts.values())
      .map((a) => ({ name: a.name, nameAr: a.nameAr, accountId: a.accountId, type: a.type, debit: fmt2(a.debit), credit: fmt2(a.credit), balance: fmt2(a.debit - a.credit) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totalDebit = fmt2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredit = fmt2(rows.reduce((s, r) => s + r.credit, 0));
    return { accounts: rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
  },

  async incomeStatement(date_from?: string, date_to?: string) {
    const lines = await reportsRepository.jeLines(date_from, date_to);
    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));

    // `key` travels to the RESPONSE (F7-cmp): the prior-period comparison
    // merges lines across two windows, and joining on the display name breaks
    // silently the day someone renames an account — the kind of defect nobody
    // would trace back. The key is the account id where one exists.
    const revenue: Record<string, { key: string; name: string; nameAr: string; amount: number }> = {};
    const expenses: Record<string, { key: string; name: string; nameAr: string; amount: number }> = {};

    for (const l of lines) {
      const cat = l.accountId ? catMap.get(l.accountId) : undefined;
      const type = cat?.type ?? "expense";
      const name = l.accountName;
      const nameAr = cat?.nameAr ?? "";
      const key = l.accountId != null ? String(l.accountId) : name;
      if (type === "income" || type === "revenue") {
        if (!revenue[key]) revenue[key] = { key, name, nameAr, amount: 0 };
        revenue[key].amount += toNum(l.credit) - toNum(l.debit);
      } else if (type === "expense") {
        if (!expenses[key]) expenses[key] = { key, name, nameAr, amount: 0 };
        expenses[key].amount += toNum(l.debit) - toNum(l.credit);
      }
    }

    if (lines.length === 0) {
      const txs = await reportsRepository.txWithCategory(date_from, date_to);
      for (const { tx, cat } of txs) {
        const amount = toNum(tx.amount);
        const catType = cat?.type ?? "expense";
        const key = String(tx.categoryId ?? "uncategorized");
        const name = cat?.name ?? "Uncategorized";
        const nameAr = cat?.nameAr ?? "غير مصنف";
        if (tx.type === "credit" || catType === "income") {
          if (!revenue[key]) revenue[key] = { key, name, nameAr, amount: 0 };
          revenue[key].amount += amount;
        } else {
          if (!expenses[key]) expenses[key] = { key, name, nameAr, amount: 0 };
          expenses[key].amount += amount;
        }
      }
    }

    const revenueItems = Object.values(revenue).map((r) => ({ ...r, amount: fmt2(r.amount) })).sort((a, b) => b.amount - a.amount);
    const expenseItems = Object.values(expenses).map((e) => ({ ...e, amount: fmt2(e.amount) })).sort((a, b) => b.amount - a.amount);
    const totalRevenue = fmt2(revenueItems.reduce((s, r) => s + r.amount, 0));
    const totalExpenses = fmt2(expenseItems.reduce((s, e) => s + e.amount, 0));
    const netIncome = fmt2(totalRevenue - totalExpenses);

    return {
      revenue: revenueItems,
      expenses: expenseItems,
      totalRevenue,
      totalExpenses,
      grossProfit: totalRevenue,
      netIncome,
      netIncomeMargin: totalRevenue > 0 ? fmt2((netIncome / totalRevenue) * 100) : 0,
      source: lines.length > 0 ? "journal_entries" : "transactions",
    };
  },

  async balanceSheet(as_of?: string) {
    const lines = await reportsRepository.bsLines(as_of);
    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));

    /**
     * M18.2 — every balance-sheet item now carries its liquidity class, so the
     * current / non-current breakout is a GROUPING of the same numbers rather
     * than a second computation of them. That is what makes the reconciling
     * assertion below meaningful: the sections cannot drift from the total,
     * because they are partitions of it.
     */
    // `key` travels to the response for the same reason as the income
    // statement's (F7-cmp): the comparison merges lines across two as-of
    // dates, and a name join breaks silently on a rename.
    type BsItem = { key: string; name: string; nameAr: string; amount: number; liquidityClass: string | null };
    const assets: Record<string, BsItem> = {};
    const liabilities: Record<string, BsItem> = {};
    const equityAccounts: Record<string, { key: string; name: string; nameAr: string; amount: number }> = {};
    let retainedEarnings = 0;

    for (const l of lines) {
      const cat = l.accountId ? catMap.get(l.accountId) : undefined;
      const type = cat?.type ?? "";
      const key = l.accountId != null ? String(l.accountId) : l.accountName;
      const name = l.accountName;
      const nameAr = cat?.nameAr ?? "";
      // NULL here is UNCLASSIFIED and stays null all the way to the response —
      // never coerced to "current", which would hide it inside a figure the
      // Finance Hub presents as a plain-language claim.
      const liquidityClass = cat?.liquidityClass ?? null;
      const net = toNum(l.debit) - toNum(l.credit);
      if (type === "asset") {
        if (!assets[key]) assets[key] = { key, name, nameAr, amount: 0, liquidityClass };
        assets[key].amount += net;
      } else if (type === "liability") {
        if (!liabilities[key]) liabilities[key] = { key, name, nameAr, amount: 0, liquidityClass };
        liabilities[key].amount += -net;
      } else if (type === "equity") {
        if (!equityAccounts[key]) equityAccounts[key] = { key, name, nameAr, amount: 0 };
        equityAccounts[key].amount += -net;
      } else if (type === "income" || type === "revenue") {
        retainedEarnings += toNum(l.credit) - toNum(l.debit);
      } else if (type === "expense") {
        retainedEarnings -= toNum(l.debit) - toNum(l.credit);
      }
    }

    // ── M13: AR and AP now come from the GENERAL LEDGER ─────────────────────
    //
    // 🔴 This is not a preference, it is forced. Before M13 every GL line had
    // `account_id = NULL`, so its type was "" and it matched NO branch above —
    // invoice lines contributed NOTHING to the balance sheet. AR was then bolted
    // on from the `invoices` table and added straight into total assets, and the
    // sheet balanced only because of that accident.
    //
    // The moment an AR line resolves to an `asset` it lands in `assets` above.
    // Adding the bolt-on as well would DOUBLE-COUNT the entire receivable and
    // break `balanced`. So the bolt-on is gone and the totals come from the one
    // place that is now correct.
    //
    // Deliberately NOT moved to the GL: AR/AP **aging**, customer statements and
    // customer balances. Those need a per-customer dimension that journal entry
    // lines do not carry. They remain invoice/bill-derived. Only the
    // balance-sheet TOTAL moves — and a permanent test asserts the two
    // computations agree, because a divergence means something posted to AR that
    // no invoice explains, or an invoice that never posted.
    const systemIdByCode = new Map<string, number>();
    for (const c of cats) if (c.systemCode) systemIdByCode.set(c.systemCode, c.id);
    const arKey = systemIdByCode.has("AR") ? String(systemIdByCode.get("AR")) : null;
    const apKey = systemIdByCode.has("AP") ? String(systemIdByCode.get("AP")) : null;
    const arBalance = fmt2(arKey && assets[arKey] ? assets[arKey].amount : 0);
    const apBalance = fmt2(apKey && liabilities[apKey] ? liabilities[apKey].amount : 0);
    /**
     * M18.3 — the SUSPENSE balance, by system code like AR/AP above.
     *
     * Since flaw #1, an accepted-but-uncategorised bank line posts here. The
     * Finance Hub needs the figure not as an asset but as a DATA-QUALITY
     * signal: money the platform could not identify is not money you can pay
     * with, and a non-zero balance blocks the hub's plain-language liquidity
     * claim entirely (design §5.1, owner decision).
     */
    const suspenseKey = systemIdByCode.has("SUSPENSE") ? String(systemIdByCode.get("SUSPENSE")) : null;
    const suspenseBalance = fmt2(suspenseKey && assets[suspenseKey] ? assets[suspenseKey].amount : 0);
    /**
     * A — GL owns cash: undeclared transfers post here. Same rationale as
     * SUSPENSE, same consequence: cash the platform cannot classify blocks
     * the Finance Hub's liquidity claim (owner decision, 2026-08-17).
     */
    const transferSuspenseKey = systemIdByCode.has("TRANSFER_SUSPENSE") ? String(systemIdByCode.get("TRANSFER_SUSPENSE")) : null;
    const transferSuspenseBalance = fmt2(transferSuspenseKey && assets[transferSuspenseKey] ? assets[transferSuspenseKey].amount : 0);

    const assetItems = Object.values(assets).map((a) => ({ ...a, amount: fmt2(a.amount) }));
    const liabItems = Object.values(liabilities).map((l) => ({ ...l, amount: fmt2(l.amount) }));
    const eqItems = Object.values(equityAccounts).map((e) => ({ ...e, amount: fmt2(e.amount) }));

    // AR/AP are ALREADY inside assetItems/liabItems — they are ordinary GL
    // accounts now. Adding them again is the double count described above.
    const totalAssets = fmt2(assetItems.reduce((s, a) => s + a.amount, 0));
    const totalLiab = fmt2(liabItems.reduce((s, l) => s + l.amount, 0));
    const totalEquity = fmt2(eqItems.reduce((s, e) => s + e.amount, 0) + retainedEarnings);
    const totalLiabAndEquity = fmt2(totalLiab + totalEquity);
    const balanced = Math.abs(totalAssets - totalLiabAndEquity) < 0.05;

    /**
     * ── M18.2: the current / non-current breakout ──────────────────────────
     *
     * 🔴 THREE buckets, not two. `unclassified` holds every balance-sheet
     * account whose `liquidity_class` is NULL, and it is returned even when
     * empty. An account that fits no bucket is exactly what a control surface
     * exists to report, and the alternative — quietly folding it into
     * `current` — would inflate the liquidity ratios by an amount nothing
     * discloses.
     *
     * 🔴 The partition is the guarantee. `current + nonCurrent + unclassified`
     * is arithmetically the same set as `items`, so
     *
     *     current.total + nonCurrent.total + unclassified.total === total
     *
     * holds by construction, and `balanced` keeps reconciling against the same
     * totals it always did. A test asserts both — the M13 AR-agreement pattern:
     * when one figure can be derived two ways, pin that they agree.
     */
    const bucket = (items: (typeof assetItems)[number][], pred: (c: string | null) => boolean) => {
      const picked = items.filter((i) => pred(i.liquidityClass));
      return { items: picked, total: fmt2(picked.reduce((s, i) => s + i.amount, 0)) };
    };
    const isCurrent = (c: string | null) => c === "cash" || c === "quick" || c === "current";
    const isNonCurrent = (c: string | null) => c === "non_current";
    const isUnclassified = (c: string | null) => c == null;

    /** Cash + quick — the acid-test numerator the Finance Hub needs (M18.3). */
    const quickTotal = fmt2(
      assetItems
        .filter((i) => i.liquidityClass === "cash" || i.liquidityClass === "quick")
        .reduce((s, i) => s + i.amount, 0),
    );

    return {
      asOf: as_of ?? new Date().toISOString().split("T")[0],
      assets: {
        items: assetItems.sort((a, b) => b.amount - a.amount),
        accountsReceivable: arBalance,
        total: totalAssets,
        current: bucket(assetItems, isCurrent),
        nonCurrent: bucket(assetItems, isNonCurrent),
        unclassified: bucket(assetItems, isUnclassified),
        quickTotal,
        suspenseBalance,
        transferSuspenseBalance,
      },
      liabilities: {
        items: liabItems,
        accountsPayable: apBalance,
        total: totalLiab,
        current: bucket(liabItems, isCurrent),
        nonCurrent: bucket(liabItems, isNonCurrent),
        unclassified: bucket(liabItems, isUnclassified),
      },
      equity: { items: eqItems, retainedEarnings: fmt2(retainedEarnings), total: totalEquity },
      totalLiabilitiesAndEquity: totalLiabAndEquity,
      balanced,
      warning: balanced ? null : `Assets (${totalAssets}) ≠ Liabilities + Equity (${totalLiabAndEquity}). Check for unposted entries.`,
    };
  },

  async cashFlow(date_from?: string, date_to?: string) {
    // M16.2 — cash flow is the one reader that keeps transfers: an ATM
    // withdrawal or own-account move genuinely changed the bank balance, even
    // though no P&L or tax figure may see it.
    const txs = await reportsRepository.txWithCategory(date_from, date_to, { includeNonOperating: true });
    let operating = 0, investing = 0, financing = 0, internal = 0;
    const operatingItems: any[] = [], investingItems: any[] = [], financingItems: any[] = [], internalItems: any[] = [];
    for (const { tx, cat } of txs) {
      const amount = tx.type === "credit" ? toNum(tx.amount) : -toNum(tx.amount);
      // ── Audit Tier 3 (finding 8): bucket by KIND before category. A transfer
      // carries no category BY DESIGN (the kind is the classification), so the
      // category-type default used to file every ATM withdrawal under
      // OPERATING as "Uncategorized" — and an internal move between two
      // tracked accounts inflated operating inflows and outflows
      // symmetrically. netChange was right; the sections were not. Transfers
      // and settlements get their own section; settlements are the cash side
      // of documents already in operating via their invoices/bills.
      if (tx.kind !== "operating") {
        internal += amount;
        internalItems.push({ name: tx.kind === "transfer" ? "Transfer between own accounts" : "Invoice/bill settlement", amount });
        continue;
      }
      const catName = cat?.name ?? "Uncategorized";
      const catType = cat?.type ?? "expense";
      // 🔴 M18.1 — INVESTING is decided by the account's liquidity class, not by
      // sniffing its NAME.
      //
      // This branch used to read:
      //     catType === "asset" && cat.name.toLowerCase().includes("fixed")
      // which is the bug class M13 removed from the posting path: resolve by
      // CODE, never by a label the tenant owns. A tenant who renamed "Fixed
      // Assets" to "Equipment" — or who runs the product in Arabic, where the
      // English literal never appears — silently moved every fixed-asset
      // purchase into OPERATING cash flow, and nothing reported it.
      //
      // `non_current` is the honest test: investing activity is the acquisition
      // and disposal of non-current assets. An UNCLASSIFIED asset account
      // (liquidity_class NULL) deliberately does NOT land here — it falls
      // through to operating exactly as before, and the Finance Hub reports it
      // as an unclassified account rather than this report guessing.
      if (catType === "asset" && cat?.liquidityClass === "non_current") {
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
    return {
      operating: { total: fmt2(operating), items: operatingItems },
      investing: { total: fmt2(investing), items: investingItems },
      financing: { total: fmt2(financing), items: financingItems },
      /** Transfers + settlements — the bank moved; no P&L activity occurred. */
      internal: { total: fmt2(internal), items: internalItems },
      netChange: fmt2(operating + investing + financing + internal),
    };
  },

  async journalReport(date_from?: string, date_to?: string) {
    const entries = await reportsRepository.postedEntries(date_from, date_to);
    const lines = entries.length > 0 ? await reportsRepository.jeLinesByEntryIds(entries.map((e) => e.id)) : [];

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map((e) => {
      const entryLines = linesByEntry.get(e.id) ?? [];
      const totalDebit = fmt2(entryLines.reduce((s, l) => s + toNum(l.debitAmount), 0));
      const totalCredit = fmt2(entryLines.reduce((s, l) => s + toNum(l.creditAmount), 0));
      return {
        id: e.id,
        entryNumber: e.entryNumber,
        date: e.date,
        description: e.description,
        reference: e.reference,
        status: e.status,
        lines: entryLines.map((l) => ({ id: l.id, accountName: l.accountName, accountId: l.accountId, description: l.description, debit: fmt2(toNum(l.debitAmount)), credit: fmt2(toNum(l.creditAmount)) })),
        totalDebit,
        totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) < 0.01,
      };
    });

    const grandDebit = fmt2(result.reduce((s, e) => s + e.totalDebit, 0));
    const grandCredit = fmt2(result.reduce((s, e) => s + e.totalCredit, 0));
    return { entries: result, count: result.length, grandDebit, grandCredit, balanced: Math.abs(grandDebit - grandCredit) < 0.01 };
  },

  async generalLedger(account_id?: string, account_name?: string, date_from?: string, date_to?: string) {
    let openingBalance = 0;
    if (date_from && (account_id || account_name)) {
      const preLines = await reportsRepository.glPreLines(date_from, account_id, account_name);
      openingBalance = fmt2(preLines.reduce((s, l) => s + toNum(l.debit) - toNum(l.credit), 0));
    }

    const rows = await reportsRepository.glRows(date_from, date_to, account_id, account_name);

    let running = openingBalance;
    const movements = rows.map((r) => {
      const d = toNum(r.debit), c = toNum(r.credit);
      running = fmt2(running + d - c);
      return { date: r.date, entryNumber: r.entryNumber, jeId: r.jeId, description: r.lineDesc ?? r.description, reference: r.reference, accountName: r.accountName, accountId: r.accountId, debit: fmt2(d), credit: fmt2(c), balance: running };
    });

    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const enrichedMovements = movements.map((m) => ({ ...m, accountNameAr: (m.accountId ? catMap.get(m.accountId)?.nameAr : undefined) ?? "" }));

    const firstCat = rows[0]?.accountId ? catMap.get(rows[0].accountId) : undefined;
    return {
      accountId: account_id ? Number(account_id) : null,
      accountName: account_name ?? rows[0]?.accountName ?? "All Accounts",
      accountNameAr: firstCat?.nameAr ?? "",
      openingBalance,
      movements: enrichedMovements,
      closingBalance: fmt2(running),
      totalDebit: fmt2(enrichedMovements.reduce((s, m) => s + m.debit, 0)),
      totalCredit: fmt2(enrichedMovements.reduce((s, m) => s + m.credit, 0)),
    };
  },

  async accountStatement(account_id?: string, account_name?: string, date_from?: string, date_to?: string) {
    if (!account_id && !account_name) throw new BadRequestError("account_id or account_name is required");

    let openingBalance = 0;
    if (date_from) {
      const pre = await reportsRepository.acctStmtPre(date_from, account_id, account_name);
      openingBalance = fmt2(pre.reduce((s, l) => s + toNum(l.d) - toNum(l.c), 0));
    }

    const rows = await reportsRepository.acctStmtRows(date_from, date_to, account_id, account_name);
    let running = openingBalance;
    const movements = rows.map((r) => {
      const d = toNum(r.debit), c = toNum(r.credit);
      running = fmt2(running + d - c);
      return { date: r.date, entryNumber: r.entryNumber, reference: r.reference, description: r.lineDesc ?? r.description, debit: fmt2(d), credit: fmt2(c), balance: running };
    });

    const cat = account_id ? await reportsRepository.categoryById(Number(account_id)) : [];
    return {
      account: cat[0] ?? { name: account_name ?? "Unknown", type: "other" },
      openingBalance,
      movements,
      closingBalance: running,
      totalDebit: fmt2(movements.reduce((s, m) => s + m.debit, 0)),
      totalCredit: fmt2(movements.reduce((s, m) => s + m.credit, 0)),
    };
  },

  async accountSummary(date_from?: string, date_to?: string) {
    const openMap = new Map<string, number>();
    if (date_from) {
      const pre = await reportsRepository.acctSummaryPre(date_from);
      for (const l of pre) {
        const k = l.accountId != null ? String(l.accountId) : l.accountName;
        openMap.set(k, (openMap.get(k) ?? 0) + toNum(l.debit) - toNum(l.credit));
      }
    }

    const period = await reportsRepository.acctSummaryPeriod(date_from, date_to);
    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));

    const accs = new Map<string, { name: string; type: string; opening: number; debit: number; credit: number }>();
    const allKeys = new Set([...openMap.keys(), ...period.map((l) => (l.accountId != null ? String(l.accountId) : l.accountName))]);
    for (const k of allKeys) {
      const sampleLine = period.find((l) => (l.accountId != null ? String(l.accountId) : l.accountName) === k);
      const cat = sampleLine?.accountId ? catMap.get(sampleLine.accountId) : undefined;
      accs.set(k, { name: sampleLine?.accountName ?? k, type: cat?.type ?? "other", opening: openMap.get(k) ?? 0, debit: 0, credit: 0 });
    }
    for (const l of period) {
      const k = l.accountId != null ? String(l.accountId) : l.accountName;
      if (!accs.has(k)) accs.set(k, { name: l.accountName, type: "other", opening: 0, debit: 0, credit: 0 });
      const a = accs.get(k)!;
      a.debit += toNum(l.debit);
      a.credit += toNum(l.credit);
    }

    const rows = Array.from(accs.entries()).map(([, a]) => ({
      name: a.name,
      type: a.type,
      openingBalance: fmt2(a.opening),
      periodDebit: fmt2(a.debit),
      periodCredit: fmt2(a.credit),
      closingBalance: fmt2(a.opening + a.debit - a.credit),
    })).sort((a, b) => a.name.localeCompare(b.name));

    return { accounts: rows, count: rows.length };
  },

  async customerLedger(customer_id?: string, date_from?: string, date_to?: string) {
    const rows = await reportsRepository.customerInvoices(customer_id, date_from, date_to);
    const custMap = new Map<number, { customer: any; invoices: any[] }>();
    for (const { inv, cust } of rows) {
      const cid = inv.customerId ?? 0;
      if (!custMap.has(cid)) custMap.set(cid, { customer: cust, invoices: [] });
      // M12.1b: a credit note appears on the ledger as a NEGATIVE line, so the
      // running balance is what the customer actually owes. `documentType` is
      // surfaced so the UI can label the row rather than infer from the sign.
      const sign = documentSign(inv.documentType);
      custMap.get(cid)!.invoices.push({
        id: inv.id, invoiceNumber: inv.invoiceNumber, date: inv.date, dueDate: inv.dueDate,
        documentType: inv.documentType,
        status: inv.status,
        total: fmt2(sign * toNum(inv.total)), paidAmount: fmt2(sign * toNum(inv.paidAmount)),
        outstanding: fmt2(sign * (toNum(inv.total) - toNum(inv.paidAmount))),
        vatAmount: fmt2(sign * toNum(inv.vatAmount)), subtotal: fmt2(sign * toNum(inv.subtotal)),
      });
    }
    const customers = Array.from(custMap.values()).map(({ customer, invoices }) => ({
      customerId: customer?.id, customerName: customer?.name ?? "Unknown", taxNumber: customer?.taxNumber,
      invoices,
      totalInvoiced: fmt2(invoices.reduce((s, i) => s + i.total, 0)),
      totalPaid: fmt2(invoices.reduce((s, i) => s + i.paidAmount, 0)),
      balance: fmt2(invoices.reduce((s, i) => s + i.outstanding, 0)),
    }));
    return { customers, totalBalance: fmt2(customers.reduce((s, c) => s + c.balance, 0)) };
  },

  async ownerEquity(date_from?: string, date_to?: string) {
    let openingEquity = 0;
    if (date_from) {
      const cats = await reportsRepository.categoriesByType("equity");
      if (cats.length > 0) {
        const catIds = cats.map((c) => c.id);
        const pre = await reportsRepository.ownerEquityPre(date_from);
        openingEquity = fmt2(pre.filter((l) => l.accountId && catIds.includes(l.accountId)).reduce((s, l) => s + toNum(l.c) - toNum(l.d), 0));
      }
    }

    const lines = await reportsRepository.ownerEquityIncomeLines(date_from, date_to);
    const allCats = await reportsRepository.allCategories();
    const catMap = new Map(allCats.map((c) => [c.id, c]));

    let revenue = 0, expenses = 0, contributions = 0, withdrawals = 0;
    for (const l of lines) {
      const cat = l.accountId ? catMap.get(l.accountId) : undefined;
      if (!cat) continue;
      if (cat.type === "income" || cat.type === "revenue") revenue += toNum(l.credit) - toNum(l.debit);
      if (cat.type === "expense") expenses += toNum(l.debit) - toNum(l.credit);
      if (cat.type === "equity") {
        const net = toNum(l.credit) - toNum(l.debit);
        if (net > 0) contributions += net;
        else withdrawals += -net;
      }
    }

    const netIncome = fmt2(revenue - expenses);
    const closingEquity = fmt2(openingEquity + netIncome + contributions - withdrawals);
    return {
      period: { from: date_from ?? "all", to: date_to ?? "all" },
      openingEquity, netIncome, contributions: fmt2(contributions), withdrawals: fmt2(withdrawals), closingEquity,
      breakdown: [
        { label: "Opening Equity", amount: openingEquity },
        { label: "Net Income / (Loss)", amount: netIncome },
        { label: "Capital Contributions", amount: contributions },
        { label: "Withdrawals / Drawings", amount: -withdrawals },
        { label: "Closing Equity", amount: closingEquity },
      ],
    };
  },

  async arAging() {
    const today = new Date();
    const rows = await reportsRepository.invoicesWithCustomer();
    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: any[] = [];

    /**
     * ── Audit Tier 3 (finding 6): credit notes are NETTED into their original,
     * not listed as separate aged rows. ──────────────────────────────────────
     *
     * Pre-fix, aging showed the original at `total − paid` and the credit note
     * as its own negative row. The bucket TOTALS netted correctly (the M12.1b
     * sign discipline), but per-document outstanding disagreed with what the
     * customer actually owes — and once `pay` became credit-aware, the two
     * views had to be unified or a paid-off credited invoice would leave its
     * offsetting +X/−X pair in the items list forever.
     *
     * Each document now ages at its TRUE outstanding:
     *   invoice / debit note:  total − paid − Σ(approved credit notes vs it)
     * A negative outstanding is SHOWN (a fully-paid invoice later credited is
     * a refund owed to the customer — hiding it would desync aging from
     * GL-based balance-sheet AR, the exact drift M12.1b warns about). The
     * `status === 'paid'` skip is gone for the same reason: paid-then-credited
     * must surface; an ordinarily-paid invoice nets to 0 and drops out on the
     * magnitude test alone.
     */
    const creditedByOriginal = new Map<number, number>();
    for (const { inv } of rows) {
      if (inv.documentType === "credit_note" && inv.originalInvoiceId != null) {
        creditedByOriginal.set(
          inv.originalInvoiceId,
          (creditedByOriginal.get(inv.originalInvoiceId) ?? 0) + toNum(inv.total),
        );
      }
    }

    for (const { inv, cust } of rows) {
      if (inv.documentType === "credit_note") continue; // folded into its original
      const credited = creditedByOriginal.get(inv.id) ?? 0;
      const outstanding = Math.round((toNum(inv.total) - toNum(inv.paidAmount) - credited) * 100) / 100;
      if (Math.abs(outstanding) < 0.01) continue;
      const due = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.date);
      const daysPast = Math.floor((today.getTime() - due.getTime()) / 86400000);
      items.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, customerName: cust?.name ?? "Unknown", customerNameAr: cust?.nameAr ?? "", dueDate: inv.dueDate, outstanding: fmt2(outstanding), daysPastDue: Math.max(0, daysPast) });
      if (daysPast <= 0) buckets.current += outstanding;
      else if (daysPast <= 30) buckets.days_1_30 += outstanding;
      else if (daysPast <= 60) buckets.days_31_60 += outstanding;
      else if (daysPast <= 90) buckets.days_61_90 += outstanding;
      else buckets.over_90 += outstanding;
    }
    const fmtBuckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt2(v)]));
    return { buckets: fmtBuckets, total: fmt2(Object.values(buckets).reduce((s, v) => s + v, 0)), items: items.sort((a, b) => b.daysPastDue - a.daysPastDue) };
  },

  async apAging() {
    const today = new Date();
    const rows = await reportsRepository.billsWithVendor();
    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: any[] = [];
    for (const { bill, vendor } of rows) {
      const outstanding = toNum(bill.total) - toNum(bill.paidAmount);
      if (outstanding < 0.01 || bill.status === "paid") continue;
      const due = bill.dueDate ? new Date(bill.dueDate) : new Date(bill.date);
      const daysPast = Math.floor((today.getTime() - due.getTime()) / 86400000);
      items.push({ id: bill.id, billNumber: bill.billNumber, vendorName: vendor?.name ?? "Unknown", vendorNameAr: vendor?.nameAr ?? "", dueDate: bill.dueDate, outstanding: fmt2(outstanding), daysPastDue: Math.max(0, daysPast) });
      if (daysPast <= 0) buckets.current += outstanding;
      else if (daysPast <= 30) buckets.days_1_30 += outstanding;
      else if (daysPast <= 60) buckets.days_31_60 += outstanding;
      else if (daysPast <= 90) buckets.days_61_90 += outstanding;
      else buckets.over_90 += outstanding;
    }
    const fmtBuckets = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fmt2(v)]));
    return { buckets: fmtBuckets, total: fmt2(Object.values(buckets).reduce((s, v) => s + v, 0)), items: items.sort((a, b) => b.daysPastDue - a.daysPastDue) };
  },

  async taxJournalEntries(date_from?: string, date_to?: string) {
    const taxLines = await reportsRepository.taxLineEntryIds(date_from, date_to);
    const taxJeIds = [...new Set(taxLines.map((l) => l.journalEntryId))];
    if (taxJeIds.length === 0) return { entries: [], count: 0 };

    const entries = await reportsRepository.entriesByIds(taxJeIds);
    const lines = await reportsRepository.jeLinesByEntryIds(taxJeIds);

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map((e) => {
      const entryLines = linesByEntry.get(e.id) ?? [];
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description, reference: e.reference,
        lines: entryLines.map((l) => ({ accountName: l.accountName, debit: fmt2(toNum(l.debitAmount)), credit: fmt2(toNum(l.creditAmount)), isTaxLine: /vat|tax|ضريبة|زكاة/i.test(l.accountName) })),
        totalVatDebit: fmt2(entryLines.filter((l) => /vat|tax|ضريبة/i.test(l.accountName)).reduce((s, l) => s + toNum(l.debitAmount), 0)),
        totalVatCredit: fmt2(entryLines.filter((l) => /vat|tax|ضريبة/i.test(l.accountName)).reduce((s, l) => s + toNum(l.creditAmount), 0)),
      };
    });

    return { entries: result, count: result.length };
  },

  async activity(date_from?: string, date_to?: string) {
    const entries = await reportsRepository.activityEntries(date_from, date_to);
    const lines = entries.length > 0 ? await reportsRepository.jeLinesByEntryIds(entries.map((e) => e.id)) : [];

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map((e) => {
      const el = linesByEntry.get(e.id) ?? [];
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description, reference: e.reference, status: e.status,
        lineCount: el.length,
        totalDebit: fmt2(el.reduce((s, l) => s + toNum(l.debitAmount), 0)),
        accounts: [...new Set(el.map((l) => l.accountName))].slice(0, 3),
      };
    });

    return { activities: result, count: result.length, hasPosted: result.filter((r) => r.status === "posted").length, hasDraft: result.filter((r) => r.status === "draft").length };
  },

  async vatReturn(period_from?: string, period_to?: string) {
    const dateFrom = period_from ? `${period_from}-01` : "1900-01-01";
    const dateTo = period_to ? `${period_to}-31` : "2099-12-31";

    const [invoiceRows, invoiceLines, billRows, billLines] = await Promise.all([
      reportsRepository.invoicesInRange(dateFrom, dateTo),
      reportsRepository.invoiceLinesInRange(dateFrom, dateTo),
      reportsRepository.billsInRange(dateFrom, dateTo),
      reportsRepository.billLinesInRange(dateFrom, dateTo),
    ]);

    /**
     * 🔴 AUDIT FIX (Tier 1, finding 1): classify per LINE from
     * `tax_category_code`, never by reconstructing a rate from rounded header
     * cents. The old header inference (`vat/subtotal*100`, branches `>= 14.9`
     * / `=== 0`) silently dropped every MIXED-RATE document (S+Z lines ⇒
     * header rate between the branches ⇒ absent from every box, including
     * output VAT the GL had posted), dropped small 15% documents whose rounded
     * rate fell below 14.9%, and filed EXEMPT documents in the zero-rated box.
     * Credit notes against such documents never reduced output VAT.
     *
     * The M12.1b sign discipline is unchanged: amounts are stored positive,
     * `documentSign()` is applied to every contribution, per line.
     *
     * Legacy fallbacks, stated: a line with NULL `tax_category_code` (pre-
     * M12.1a data; 0%-rate lines the migration deliberately left ambiguous)
     * classifies by VAT presence — vat > 0 ⇒ 'S', else 'Z' (preserving the old
     * report's placement for legacy zero-VAT lines). A document with NO line
     * rows at all (bills may be created header-only) classifies its header the
     * same way. 'O' (out of scope) lines are not consideration for a supply
     * and appear in no box. Box 4 (exports) stays 0 — nothing marks a sale as
     * an export yet; an export today is a 'Z' line and lands in box 2.
     */
    const invLinesByDoc = new Map<number, (typeof invoiceLines)[number][]>();
    for (const l of invoiceLines) {
      (invLinesByDoc.get(l.invoiceId) ?? invLinesByDoc.set(l.invoiceId, []).get(l.invoiceId)!).push(l);
    }

    let standardRatedSales = 0, outputVat = 0, zeroRatedSales = 0, exemptSales = 0;
    for (const inv of invoiceRows) {
      const sign = documentSign(inv.documentType);
      const lines = invLinesByDoc.get(inv.id) ?? [];
      if (lines.length === 0) {
        const subtotal = toNum(inv.subtotal);
        const vat = toNum(inv.vatAmount);
        if (vat > 0) { standardRatedSales += sign * subtotal; outputVat += sign * vat; }
        else zeroRatedSales += sign * subtotal;
        continue;
      }
      for (const { line } of lines) {
        const vat = toNum(line.vatAmount);
        const net = toNum(line.total) - vat;
        const code = line.taxCategoryCode ?? (vat > 0 ? "S" : "Z");
        if (code === "S") { standardRatedSales += sign * net; outputVat += sign * vat; }
        else if (code === "Z") zeroRatedSales += sign * net;
        else if (code === "E") exemptSales += sign * net;
        // "O": out of scope — on no box of the return.
      }
    }

    const billLinesByDoc = new Map<number, (typeof billLines)[number][]>();
    for (const l of billLines) {
      (billLinesByDoc.get(l.billId) ?? billLinesByDoc.set(l.billId, []).get(l.billId)!).push(l);
    }

    let standardRatedPurchases = 0, inputVat = 0, zeroRatedPurchases = 0;
    for (const bill of billRows) {
      const lines = billLinesByDoc.get(bill.id) ?? [];
      if (lines.length === 0) {
        if (toNum(bill.vatAmount) > 0) { standardRatedPurchases += toNum(bill.subtotal); inputVat += toNum(bill.vatAmount); }
        else zeroRatedPurchases += toNum(bill.subtotal);
        continue;
      }
      for (const { line } of lines) {
        const vat = toNum(line.vatAmount);
        const net = toNum(line.total) - vat;
        if (vat > 0) { standardRatedPurchases += net; inputVat += vat; }
        else zeroRatedPurchases += net;
      }
    }

    const netVatDue = outputVat - inputVat;
    return {
      period: { from: dateFrom, to: dateTo },
      salesSection: {
        box1_standardRatedDomesticSales: fmt2(standardRatedSales),
        box2_zeroRatedDomesticSales: fmt2(zeroRatedSales),
        box3_exemptSales: fmt2(exemptSales),
        box4_exportSales: 0,
        box5_totalSales: fmt2(standardRatedSales + zeroRatedSales + exemptSales),
        box6_vatOnStandardRatedSales: fmt2(outputVat),
        box7_vatAdjustments: 0,
        box8_totalOutputVat: fmt2(outputVat),
      },
      purchasesSection: {
        box9_standardRatedPurchases: fmt2(standardRatedPurchases),
        box10_zeroRatedPurchases: fmt2(zeroRatedPurchases),
        box11_exemptPurchases: 0,
        box12_totalPurchases: fmt2(standardRatedPurchases + zeroRatedPurchases),
        box13_recoverableInputVat: fmt2(inputVat),
        box14_inputVatAdjustments: 0,
        box15_totalInputVat: fmt2(inputVat),
      },
      netVatDue: fmt2(netVatDue),
      vatPayable: netVatDue > 0 ? fmt2(netVatDue) : 0,
      vatRefund: netVatDue < 0 ? fmt2(-netVatDue) : 0,
      invoiceCount: invoiceRows.length,
      billCount: billRows.length,
    };
  },
};
