import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, categoriesTable } from "@workspace/db";
import { eq, sql, and, gte, lte, isNotNull } from "drizzle-orm";
import {
  GetSummaryQueryParams,
  GetSummaryResponse,
  GetVatSummaryQueryParams,
  GetVatSummaryResponse,
  GetZakatSummaryResponse,
  GetSummaryByCategoryQueryParams,
  GetSummaryByCategoryResponse,
} from "@workspace/api-zod";

const router = Router();

// Nisab threshold in SAR (approx. 85g gold at ~230 SAR/g as of 2024)
const NISAB_SAR = 19550;
const ZAKAT_RATE = 0.025; // 2.5%

// ── GET /summary ─────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const params = GetSummaryQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const { date_from, date_to } = params.data;

    const conditions = [];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        type: transactionsTable.type,
        amount: transactionsTable.amount,
        vatAmount: transactionsTable.vatAmount,
        categoryId: transactionsTable.categoryId,
      })
      .from(transactionsTable)
      .where(where);

    let totalIncome = 0;
    let totalExpenses = 0;
    let totalVatCollected = 0;
    let totalVatPaid = 0;
    let uncategorizedCount = 0;

    for (const r of rows) {
      const amt = Number(r.amount);
      const vat = r.vatAmount != null ? Number(r.vatAmount) : 0;

      if (r.categoryId == null) uncategorizedCount++;

      if (r.type === "credit") {
        totalIncome += amt;
        totalVatCollected += vat;
      } else {
        totalExpenses += amt;
        totalVatPaid += vat;
      }
    }

    const parsed = GetSummaryResponse.parse({
      totalIncome,
      totalExpenses,
      netPosition: totalIncome - totalExpenses,
      totalVatCollected,
      totalVatPaid,
      netVat: totalVatCollected - totalVatPaid,
      transactionCount: rows.length,
      uncategorizedCount,
    });
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "getSummary failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /summary/vat ─────────────────────────────────────────────────────────

router.get("/vat", async (req, res) => {
  const params = GetVatSummaryQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const { date_from, date_to } = params.data;

    const conditions = [isNotNull(transactionsTable.vatAmount)];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(and(...conditions))
      .orderBy(transactionsTable.date);

    let vatCollected = 0;
    let vatPaid = 0;

    const transactions = rows.map((r) => {
      const vat = Number(r.vatAmount ?? 0);
      if (r.type === "credit") vatCollected += vat;
      else vatPaid += vat;

      return {
        id: r.id,
        date: r.date,
        description: r.description,
        amount: Number(r.amount),
        vatAmount: vat,
        type: r.type,
      };
    });

    const parsed = GetVatSummaryResponse.parse({
      vatCollected,
      vatPaid,
      netVatPosition: vatCollected - vatPaid,
      vatRate: 15,
      transactions,
    });
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "getVatSummary failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /summary/zakat ────────────────────────────────────────────────────────

router.get("/zakat", async (req, res) => {
  try {
    const rows = await db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.isZakatRelevant, true))
      .orderBy(transactionsTable.date);

    let totalZakatableAssets = 0;
    const eligibleTransactions = rows.map((r) => {
      const amt = Number(r.tx.amount);
      if (r.tx.type === "credit") totalZakatableAssets += amt;
      else totalZakatableAssets -= amt;

      return {
        id: r.tx.id,
        date: r.tx.date,
        description: r.tx.description,
        descriptionAr: r.tx.descriptionAr ?? null,
        amount: amt,
        currency: r.tx.currency,
        type: r.tx.type as "debit" | "credit",
        categoryId: r.tx.categoryId ?? null,
        categoryName: r.cat?.name ?? null,
        categoryNameAr: r.cat?.nameAr ?? null,
        vatAmount: r.tx.vatAmount != null ? Number(r.tx.vatAmount) : null,
        vatRate: r.tx.vatRate != null ? Number(r.tx.vatRate) : null,
        isZakatRelevant: r.tx.isZakatRelevant,
        confidenceScore: r.tx.confidenceScore != null ? Number(r.tx.confidenceScore) : null,
        isManuallyOverridden: r.tx.isManuallyOverridden,
        source: r.tx.source ?? null,
        notes: r.tx.notes ?? null,
        createdAt: r.tx.createdAt.toISOString(),
      };
    });

    const zakatablePositive = Math.max(totalZakatableAssets, 0);
    const zakatDue = zakatablePositive >= NISAB_SAR ? zakatablePositive * ZAKAT_RATE : 0;

    const parsed = GetZakatSummaryResponse.parse({
      totalZakatableAssets: zakatablePositive,
      nisabThresholdSAR: NISAB_SAR,
      zakatDue,
      eligibleTransactions,
    });
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "getZakatSummary failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /summary/by-category ──────────────────────────────────────────────────

router.get("/by-category", async (req, res) => {
  const params = GetSummaryByCategoryQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const { date_from, date_to } = params.data;

    const conditions = [isNotNull(transactionsTable.categoryId)];
    if (date_from) conditions.push(gte(transactionsTable.date, date_from));
    if (date_to) conditions.push(lte(transactionsTable.date, date_to));

    const rows = await db
      .select({
        categoryId: transactionsTable.categoryId,
        categoryName: categoriesTable.name,
        categoryNameAr: categoriesTable.nameAr,
        categoryType: categoriesTable.type,
        total: sql<number>`sum(${transactionsTable.amount}::numeric)`,
        count: sql<number>`count(*)::int`,
        vatTotal: sql<number>`coalesce(sum(${transactionsTable.vatAmount}::numeric), 0)`,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(and(...conditions))
      .groupBy(
        transactionsTable.categoryId,
        categoriesTable.name,
        categoriesTable.nameAr,
        categoriesTable.type
      )
      .orderBy(sql`sum(${transactionsTable.amount}::numeric) desc`);

    const result = rows.map((r) => ({
      categoryId: r.categoryId!,
      categoryName: r.categoryName ?? "Unknown",
      categoryNameAr: r.categoryNameAr ?? "",
      type: r.categoryType ?? "expense",
      total: Number(r.total),
      count: Number(r.count),
      vatTotal: Number(r.vatTotal),
    }));

    const parsed = GetSummaryByCategoryResponse.parse(result);
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "getSummaryByCategory failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
