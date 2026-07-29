/**
 * Journal-entry presenter — the single place a JE (+ its lines) is shaped into
 * the API/audit response object. Extracted from the service so both the service
 * and the approval adapter share one shape without a circular import.
 */
import type { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";

type JournalEntry = typeof journalEntriesTable.$inferSelect;
type JournalEntryLine = typeof journalEntryLinesTable.$inferSelect;

const toNum = (v: unknown) => (v != null ? Number(v) : 0);

export function buildJEOut(je: JournalEntry, lines?: JournalEntryLine[]) {
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

export type JournalEntryOut = ReturnType<typeof buildJEOut>;
