/**
 * GL Posting helper — creates a balanced, immediately-posted journal entry.
 * Called by invoices, bills, and payroll routes to keep AR/AP wired to the GL.
 */
import { db } from "@workspace/db";
import { journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { checkPeriodOpen } from "./periodLock";

export interface GLLine {
  accountName: string;
  accountId?: number | null;
  description?: string;
  debitAmount: number;
  creditAmount: number;
}

export async function postJournalEntry(opts: {
  entryNumber: string;
  date: string;
  description: string;
  reference?: string;
  lines: GLLine[];
}): Promise<typeof journalEntriesTable.$inferSelect> {
  const totalDebit = opts.lines.reduce((s, l) => s + l.debitAmount, 0);
  const totalCredit = opts.lines.reduce((s, l) => s + l.creditAmount, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(
      `GL entry does not balance: Dr ${totalDebit.toFixed(2)} vs Cr ${totalCredit.toFixed(2)}`
    );
  }

  // Enforce period lock — block posting into closed periods
  await checkPeriodOpen(opts.date);

  const now = new Date();
  const [je] = await db
    .insert(journalEntriesTable)
    .values({
      entryNumber: opts.entryNumber,
      date: opts.date,
      description: opts.description,
      reference: opts.reference ?? null,
      status: "posted",
      postedAt: now,
    })
    .returning();

  await db.insert(journalEntryLinesTable).values(
    opts.lines.map((l) => ({
      journalEntryId: je.id,
      accountName: l.accountName,
      accountId: l.accountId ?? null,
      description: l.description ?? null,
      debitAmount: String(l.debitAmount.toFixed(2)),
      creditAmount: String(l.creditAmount.toFixed(2)),
    }))
  );

  return je;
}
