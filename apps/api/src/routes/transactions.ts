import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, categoriesTable } from "@workspace/db";
import { eq, and, ilike, desc, sql, inArray } from "drizzle-orm";
import {
  ListTransactionsQueryParams,
  ListTransactionsResponse,
  CreateTransactionBody,
  CreateTransactionResponse,
  GetTransactionParams,
  GetTransactionResponse,
  UpdateTransactionParams,
  UpdateTransactionBody,
  UpdateTransactionResponse,
  DeleteTransactionParams,
  UploadTransactionsBody,
  UploadTransactionsResponse,
} from "@workspace/api-zod";
import { categorizeTransaction } from "../lib/categorizer.js";

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

async function buildTransactionRow(tx: typeof transactionsTable.$inferSelect, cat?: typeof categoriesTable.$inferSelect | null) {
  return {
    id: tx.id,
    date: tx.date,
    description: tx.description,
    descriptionAr: tx.descriptionAr ?? null,
    amount: Number(tx.amount),
    currency: tx.currency,
    type: tx.type as "debit" | "credit",
    categoryId: tx.categoryId ?? null,
    categoryName: cat?.name ?? null,
    categoryNameAr: cat?.nameAr ?? null,
    vatAmount: tx.vatAmount != null ? Number(tx.vatAmount) : null,
    vatRate: tx.vatRate != null ? Number(tx.vatRate) : null,
    isZakatRelevant: tx.isZakatRelevant,
    confidenceScore: tx.confidenceScore != null ? Number(tx.confidenceScore) : null,
    isManuallyOverridden: tx.isManuallyOverridden,
    source: tx.source ?? null,
    notes: tx.notes ?? null,
    createdAt: tx.createdAt.toISOString(),
  };
}

async function fetchWithCategory(txId: number) {
  const rows = await db
    .select({
      tx: transactionsTable,
      cat: categoriesTable,
    })
    .from(transactionsTable)
    .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
    .where(eq(transactionsTable.id, txId))
    .limit(1);
  return rows[0] ?? null;
}

// ── GET /transactions ─────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const params = ListTransactionsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const {
      category_id,
      is_zakat_relevant,
      is_manually_overridden,
      type,
      search,
      limit = 50,
      offset = 0,
    } = params.data;

    const conditions = [];
    if (category_id != null) conditions.push(eq(transactionsTable.categoryId, category_id));
    if (is_zakat_relevant != null) conditions.push(eq(transactionsTable.isZakatRelevant, is_zakat_relevant));
    if (is_manually_overridden != null) conditions.push(eq(transactionsTable.isManuallyOverridden, is_manually_overridden));
    if (type != null) conditions.push(eq(transactionsTable.type, type));
    if (search) conditions.push(ilike(transactionsTable.description, `%${search}%`));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select({ tx: transactionsTable, cat: categoriesTable })
        .from(transactionsTable)
        .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
        .where(whereClause)
        .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
        .limit(limit ?? 50)
        .offset(offset ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count ?? 0;
    const transactions = await Promise.all(
      rows.map((r) => buildTransactionRow(r.tx, r.cat))
    );

    const parsed = ListTransactionsResponse.parse({
      transactions,
      total,
      offset: offset ?? 0,
      limit: limit ?? 50,
    });

    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "listTransactions failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /transactions/upload ─────────────────────────────────────────────────

router.post("/upload", async (req, res) => {
  const body = UploadTransactionsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { rows, autoCategrize } = body.data;
  const errors: string[] = [];
  let inserted = 0;
  let categorized = 0;

  for (const row of rows) {
    try {
      let catId: number | null = row.categoryId ?? null;
      let vatAmount: string | null = row.vatAmount != null ? String(row.vatAmount) : null;
      let vatRate: string | null = row.vatRate != null ? String(row.vatRate) : null;
      let isZakatRelevant = row.isZakatRelevant ?? false;
      let confidenceScore: string | null = null;

      if (autoCategrize) {
        const match = categorizeTransaction(
          row.description,
          Number(row.amount),
          row.type as "debit" | "credit",
          row.descriptionAr
        );
        if (match && catId == null) {
          catId = match.categoryId;
          confidenceScore = String(match.confidence);
          isZakatRelevant = match.isZakatRelevant;
          if (match.vatApplicable && match.suggestedVatRate != null && vatAmount == null) {
            const vatRate15 = match.suggestedVatRate;
            if (vatRate15 > 0) {
              vatAmount = String((Number(row.amount) * vatRate15) / 100);
              vatRate = String(vatRate15);
            }
          }
          categorized++;
        }
      }

      await db.insert(transactionsTable).values({
        date: row.date,
        description: row.description,
        descriptionAr: row.descriptionAr ?? null,
        amount: String(row.amount),
        currency: row.currency ?? "SAR",
        type: row.type,
        categoryId: catId,
        vatAmount,
        vatRate,
        isZakatRelevant,
        confidenceScore,
        isManuallyOverridden: false,
        source: row.source ?? "upload",
        notes: row.notes ?? null,
      });
      inserted++;
    } catch (err) {
      errors.push(`Row "${row.description}" — ${String(err)}`);
    }
  }

  const parsed = UploadTransactionsResponse.parse({ inserted, categorized, errors });
  res.json(parsed);
});

// ── POST /transactions ────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  const body = CreateTransactionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  try {
    const d = body.data;
    const [tx] = await db
      .insert(transactionsTable)
      .values({
        date: d.date,
        description: d.description,
        descriptionAr: d.descriptionAr ?? null,
        amount: String(d.amount),
        currency: d.currency ?? "SAR",
        type: d.type,
        categoryId: d.categoryId ?? null,
        vatAmount: d.vatAmount != null ? String(d.vatAmount) : null,
        vatRate: d.vatRate != null ? String(d.vatRate) : null,
        isZakatRelevant: d.isZakatRelevant ?? false,
        confidenceScore: null,
        isManuallyOverridden: false,
        source: d.source ?? "manual",
        notes: d.notes ?? null,
      })
      .returning();

    const row = await fetchWithCategory(tx.id);
    if (!row) { res.status(500).json({ error: "Insert failed" }); return; }

    const parsed = CreateTransactionResponse.parse(
      await buildTransactionRow(row.tx, row.cat)
    );
    res.status(201).json(parsed);
  } catch (err) {
    req.log.error({ err }, "createTransaction failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /transactions/:id ─────────────────────────────────────────────────────

router.get("/:id", async (req, res) => {
  const params = GetTransactionParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const row = await fetchWithCategory(params.data.id);
    if (!row) { res.status(404).json({ error: "Transaction not found" }); return; }
    const parsed = GetTransactionResponse.parse(await buildTransactionRow(row.tx, row.cat));
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "getTransaction failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PATCH /transactions/:id ────────────────────────────────────────────────────

router.patch("/:id", async (req, res) => {
  const idParsed = UpdateTransactionParams.safeParse({ id: Number(req.params.id) });
  if (!idParsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = UpdateTransactionBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  try {
    const existing = await fetchWithCategory(idParsed.data.id);
    if (!existing) { res.status(404).json({ error: "Transaction not found" }); return; }

    const updates: Partial<typeof transactionsTable.$inferInsert> = {
      isManuallyOverridden: true,
    };
    if (body.data.categoryId !== undefined) updates.categoryId = body.data.categoryId ?? null;
    if (body.data.isZakatRelevant !== undefined) updates.isZakatRelevant = body.data.isZakatRelevant ?? false;
    if (body.data.vatAmount !== undefined) updates.vatAmount = body.data.vatAmount != null ? String(body.data.vatAmount) : null;
    if (body.data.vatRate !== undefined) updates.vatRate = body.data.vatRate != null ? String(body.data.vatRate) : null;
    if (body.data.notes !== undefined) updates.notes = body.data.notes ?? null;
    if (body.data.descriptionAr !== undefined) updates.descriptionAr = body.data.descriptionAr ?? null;

    await db
      .update(transactionsTable)
      .set(updates)
      .where(eq(transactionsTable.id, idParsed.data.id));

    const row = await fetchWithCategory(idParsed.data.id);
    if (!row) { res.status(500).json({ error: "Update failed" }); return; }

    const parsed = UpdateTransactionResponse.parse(await buildTransactionRow(row.tx, row.cat));
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "updateTransaction failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── DELETE /transactions/:id ──────────────────────────────────────────────────

router.delete("/:id", async (req, res) => {
  const params = DeleteTransactionParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    await db.delete(transactionsTable).where(eq(transactionsTable.id, params.data.id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteTransaction failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
