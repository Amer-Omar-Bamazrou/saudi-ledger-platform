/**
 * Journal entries service — draft creation (balanced), posting, reversal, delete.
 * Balancing, period-lock enforcement, and immutability guards preserved exactly
 * from the pre-M6 route. Posting/reversal go through the ledger's status model.
 */
import { ConflictError, NotFoundError } from "../lib/errors";
import { BadRequestError } from "../lib/errors";
import { checkPeriodOpen } from "./accounting/periodLock";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import type { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";

type JournalEntry = typeof journalEntriesTable.$inferSelect;
type JournalEntryLine = typeof journalEntryLinesTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

function buildJEOut(je: JournalEntry, lines?: JournalEntryLine[]) {
  return {
    id: je.id,
    entryNumber: je.entryNumber,
    date: je.date,
    description: je.description,
    reference: je.reference,
    status: je.status,
    reversalOf: je.reversalOf,
    notes: je.notes,
    postedAt: je.postedAt?.toISOString() ?? null,
    createdAt: je.createdAt.toISOString(),
    totalDebit: (lines ?? []).reduce((s, l) => s + toNum(l.debitAmount), 0),
    totalCredit: (lines ?? []).reduce((s, l) => s + toNum(l.creditAmount), 0),
    lines: (lines ?? []).map((l) => ({
      id: l.id,
      journalEntryId: l.journalEntryId,
      accountId: l.accountId,
      accountName: l.accountName,
      description: l.description,
      debitAmount: toNum(l.debitAmount),
      creditAmount: toNum(l.creditAmount),
    })),
  };
}

export const journalEntriesService = {
  async list(status?: string) {
    const rows = await journalEntriesRepository.list(status);
    return rows.map((r) => buildJEOut(r));
  },

  async getById(id: number) {
    const [je] = await journalEntriesRepository.findById(id);
    if (!je) throw new NotFoundError("Not found");
    const lines = await journalEntriesRepository.linesByEntry(id);
    return buildJEOut(je, lines);
  },

  async create(body: Record<string, unknown>, userId: number | null) {
    const { lines = [], ...jeData } = body as { lines?: unknown[] } & Record<string, unknown>;
    const totalDebit = (lines as any[]).reduce((s, l) => s + Number(l.debitAmount ?? 0), 0);
    const totalCredit = (lines as any[]).reduce((s, l) => s + Number(l.creditAmount ?? 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestError("Journal entry must balance: debits must equal credits");
    }
    if (jeData.date) await checkPeriodOpen(jeData.date as string);

    const [je] = await journalEntriesRepository.insertEntry({
      ...(jeData as typeof journalEntriesTable.$inferInsert),
      createdBy: userId ?? null,
    });
    const savedLines =
      (lines as any[]).length > 0
        ? await journalEntriesRepository.insertLines(
            (lines as any[]).map((l) => ({
              ...l,
              journalEntryId: je.id,
              debitAmount: String(l.debitAmount ?? 0),
              creditAmount: String(l.creditAmount ?? 0),
            })),
          )
        : [];
    return buildJEOut(je, savedLines);
  },

  async post(id: number) {
    const [existing] = await journalEntriesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status === "posted") throw new ConflictError("Entry is already posted.");
    if (existing.status === "reversed") {
      throw new ConflictError("Entry has already been reversed and cannot be re-posted.");
    }
    const [je] = await journalEntriesRepository.updateEntry(id, { status: "posted", postedAt: new Date() });
    const lines = await journalEntriesRepository.linesByEntry(id);
    return buildJEOut(je, lines);
  },

  async reverse(id: number) {
    const [original] = await journalEntriesRepository.findById(id);
    if (!original) throw new NotFoundError("Not found");
    if (original.status !== "posted") throw new ConflictError("Only posted entries can be reversed.");

    const lines = await journalEntriesRepository.linesByEntry(id);
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();
    const [reversal] = await journalEntriesRepository.insertEntry({
      entryNumber: `${original.entryNumber}-REV`,
      date: today,
      description: `Reversal of ${original.description}`,
      reference: original.reference,
      status: "posted",
      postedAt: now,
      reversalOf: id,
    });
    await journalEntriesRepository.insertLines(
      lines.map((l) => ({
        journalEntryId: reversal.id,
        accountId: l.accountId,
        accountName: l.accountName,
        description: l.description,
        // swap debit ↔ credit
        debitAmount: l.creditAmount,
        creditAmount: l.debitAmount,
      })),
    );
    await journalEntriesRepository.updateEntry(id, { status: "reversed" });
    const reversalLines = await journalEntriesRepository.linesByEntry(reversal.id);
    return { message: "Reversed", reversalId: reversal.id, reversal: buildJEOut(reversal, reversalLines) };
  },

  async remove(id: number) {
    const [existing] = await journalEntriesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError(`Cannot delete a ${existing.status} journal entry. Post a reversing entry instead.`);
    }
    await journalEntriesRepository.remove(id);
  },
};
