import { Router } from "express";
import { db } from "@workspace/db";
import { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { checkPeriodOpen } from "../lib/periodLock";
import { handleRouteError } from "../lib/routeError";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

async function buildJEOut(je: typeof journalEntriesTable.$inferSelect, lines?: typeof journalEntryLinesTable.$inferSelect[]) {
  return {
    id: je.id, entryNumber: je.entryNumber, date: je.date, description: je.description,
    reference: je.reference, status: je.status, reversalOf: je.reversalOf, notes: je.notes,
    postedAt: je.postedAt?.toISOString() ?? null,
    createdAt: je.createdAt.toISOString(),
    totalDebit: (lines ?? []).reduce((s, l) => s + toNum(l.debitAmount), 0),
    totalCredit: (lines ?? []).reduce((s, l) => s + toNum(l.creditAmount), 0),
    lines: (lines ?? []).map(l => ({
      id: l.id, journalEntryId: l.journalEntryId, accountId: l.accountId,
      accountName: l.accountName, description: l.description,
      debitAmount: toNum(l.debitAmount), creditAmount: toNum(l.creditAmount),
    })),
  };
}

router.get("/", async (req, res) => {
  try {
    const { status } = req.query as Record<string, string>;
    const rows = await db.select().from(journalEntriesTable)
      .where(status ? eq(journalEntriesTable.status, status) : undefined)
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id));
    res.json(await Promise.all(rows.map(r => buildJEOut(r))));
  } catch (err) { handleRouteError(err, req, res); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [je] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
    if (!je) { res.status(404).json({ error: "Not found" }); return; }
    const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
    res.json(await buildJEOut(je, lines));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /journal-entries — create a draft entry (debit must equal credit)
router.post("/", async (req, res) => {
  try {
    const { lines = [], ...jeData } = req.body;
    const totalDebit = lines.reduce((s: number, l: any) => s + Number(l.debitAmount ?? 0), 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + Number(l.creditAmount ?? 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(400).json({ error: "Journal entry must balance: debits must equal credits" }); return;
    }
    // Enforce period lock on the entry's date
    if (jeData.date) await checkPeriodOpen(jeData.date);
    const [je] = await db.insert(journalEntriesTable).values({ ...jeData, createdBy: req.session?.userId ?? null }).returning();
    const savedLines = lines.length > 0
      ? await db.insert(journalEntryLinesTable).values(
          lines.map((l: any) => ({ ...l, journalEntryId: je.id, debitAmount: String(l.debitAmount ?? 0), creditAmount: String(l.creditAmount ?? 0) }))
        ).returning()
      : [];
    res.status(201).json(await buildJEOut(je, savedLines));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /journal-entries/:id/post — stamps postedAt; entry becomes immutable
router.post("/:id/post", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status === "posted") {
      res.status(409).json({ error: "Entry is already posted." }); return;
    }
    if (existing.status === "reversed") {
      res.status(409).json({ error: "Entry has already been reversed and cannot be re-posted." }); return;
    }
    const [je] = await db.update(journalEntriesTable)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(journalEntriesTable.id, id))
      .returning();
    const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
    res.json(await buildJEOut(je, lines));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /journal-entries/:id/reverse — only posted entries can be reversed
router.post("/:id/reverse", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [original] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
    if (!original) { res.status(404).json({ error: "Not found" }); return; }
    if (original.status !== "posted") {
      res.status(409).json({ error: "Only posted entries can be reversed." }); return;
    }
    const lines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();
    const [reversal] = await db.insert(journalEntriesTable).values({
      entryNumber: `${original.entryNumber}-REV`,
      date: today,
      description: `Reversal of ${original.description}`,
      reference: original.reference,
      status: "posted",
      postedAt: now,
      reversalOf: id,
    }).returning();
    await db.insert(journalEntryLinesTable).values(lines.map(l => ({
      journalEntryId: reversal.id, accountId: l.accountId, accountName: l.accountName,
      description: l.description,
      // swap debit ↔ credit
      debitAmount: l.creditAmount, creditAmount: l.debitAmount,
    })));
    await db.update(journalEntriesTable).set({ status: "reversed" }).where(eq(journalEntriesTable.id, id));
    const reversalLines = await db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, reversal.id));
    res.json({ message: "Reversed", reversalId: reversal.id, reversal: await buildJEOut(reversal, reversalLines) });
  } catch (err) { handleRouteError(err, req, res); }
});

// DELETE — only draft entries can be deleted; posted entries are immutable
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: `Cannot delete a ${existing.status} journal entry. Post a reversing entry instead.` });
      return;
    }
    await db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, id));
    res.status(204).send();
  } catch (err) { handleRouteError(err, req, res); }
});

export default router;
