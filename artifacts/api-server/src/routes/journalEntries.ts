import { Router } from "express";
import { db } from "@workspace/db";
import { journalEntriesTable, journalEntryLinesTable, categoriesTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

async function buildJEOut(je: typeof journalEntriesTable.$inferSelect, lines?: typeof journalEntryLinesTable.$inferSelect[]) {
  return {
    id: je.id, entryNumber: je.entryNumber, date: je.date, description: je.description,
    reference: je.reference, status: je.status, reversalOf: je.reversalOf, notes: je.notes,
    createdAt: je.createdAt.toISOString(),
    totalDebit: (lines ?? []).reduce((s, l) => s + toNum(l.debitAmount), 0),
    totalCredit: (lines ?? []).reduce((s, l) => s + toNum(l.creditAmount), 0),
    lines: (lines ?? []).map(l => ({ id: l.id, journalEntryId: l.journalEntryId, accountId: l.accountId, accountName: l.accountName, description: l.description, debitAmount: toNum(l.debitAmount), creditAmount: toNum(l.creditAmount) })),
  };
}

router.get("/", async (req, res) => {
  try {
    const { status } = req.query as Record<string, string>;
    const rows = await db.select().from(journalEntriesTable)
      .where(status ? eq(journalEntriesTable.status, status) : undefined)
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id));
    res.json(await Promise.all(rows.map(r => buildJEOut(r))));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [je] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
    if (!je) { res.status(404).json({ error: "Not found" }); return; }
    const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
    res.json(await buildJEOut(je, lines));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const { lines = [], ...jeData } = req.body;
    const totalDebit = lines.reduce((s: number, l: any) => s + Number(l.debitAmount ?? 0), 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + Number(l.creditAmount ?? 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(400).json({ error: "Journal entry must balance: debits must equal credits" }); return;
    }
    const [je] = await db.insert(journalEntriesTable).values(jeData).returning();
    const savedLines = lines.length > 0
      ? await db.insert(journalEntryLinesTable).values(lines.map((l: any) => ({ ...l, journalEntryId: je.id, debitAmount: String(l.debitAmount ?? 0), creditAmount: String(l.creditAmount ?? 0) }))).returning()
      : [];
    res.status(201).json(await buildJEOut(je, savedLines));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /journal-entries/:id/post
router.post("/:id/post", async (req, res) => {
  try {
    const [je] = await db.update(journalEntriesTable).set({ status: "posted" }).where(eq(journalEntriesTable.id, Number(req.params.id))).returning();
    if (!je) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await buildJEOut(je));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /journal-entries/:id/reverse
router.post("/:id/reverse", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [original] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
    if (!original) { res.status(404).json({ error: "Not found" }); return; }
    const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
    const today = new Date().toISOString().split("T")[0];
    const [reversal] = await db.insert(journalEntriesTable).values({
      entryNumber: `${original.entryNumber}-REV`,
      date: today, description: `Reversal of ${original.description}`,
      reference: original.reference, status: "posted", reversalOf: id,
    }).returning();
    await db.insert(journalEntryLinesTable).values(lines.map(l => ({
      journalEntryId: reversal.id, accountId: l.accountId, accountName: l.accountName,
      description: l.description, debitAmount: l.creditAmount, creditAmount: l.debitAmount,
    })));
    await db.update(journalEntriesTable).set({ status: "reversed" }).where(eq(journalEntriesTable.id, id));
    res.json({ message: "Reversed", reversalId: reversal.id });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
