/**
 * 🔴 OBS-S1-1 (G60 batch, 2026-10-15): WHAT A RUN TELLS THE CLIENT ABOUT AN
 * ITEM THAT DID NOT POST.
 *
 * The month-end runs report every item they did not post, with a reason. The
 * reason used to be the thrown error's message, and for a database error that
 * message is drizzle's "Failed query: insert into …" — the full SQL text and
 * its parameters, sent to the client. (The statement import closed the same
 * leak in its own `reasonFor`.)
 *
 * - A refusal WE wrote (an `AppError`: a business rule, a missing reference,
 *   a closed month) already is a sentence for the user. Its code and sentence
 *   pass through unchanged — the G55 "another company" refusal among them.
 * - Anything else is described, never quoted: the one database error a run
 *   can meet in normal use — its entry number already taken by another entry,
 *   typically a draft (user-chosen numbers are not reserved, contract SG-11) —
 *   is named with that number; any other error gets a fixed sentence. The
 *   error itself goes to the server log, where a developer can read it.
 */
import { AppError } from "./errors";
import { logger } from "./logger";

export interface RunItemFailure {
  code: string;
  reason: string;
}

/** The driver's SQLSTATE and constraint, whether drizzle wrapped the error (`cause`) or not. */
function driverError(err: unknown): { code: string; constraint?: string } | null {
  const read = (e: unknown) => {
    const x = e as { code?: unknown; constraint?: unknown } | null | undefined;
    return typeof x?.code === "string" && /^[0-9A-Z]{5}$/.test(x.code)
      ? { code: x.code, constraint: typeof x.constraint === "string" ? x.constraint : undefined }
      : null;
  };
  return read(err) ?? read((err as { cause?: unknown } | null | undefined)?.cause);
}

/**
 * @param item `label` names the item in a sentence ("asset FA-00002");
 *             `entryNumber` is the number its entry would have carried;
 *             `log` is context for the server log only.
 */
export function runItemFailure(
  err: unknown,
  item: { label: string; entryNumber: string; log: Record<string, unknown> },
): RunItemFailure {
  if (err instanceof AppError) {
    const code = typeof err.payload?.code === "string" ? err.payload.code : "unknown";
    const reason = typeof err.payload?.error === "string" ? err.payload.error : err.message;
    return { code, reason };
  }
  logger.error({ err, ...item.log }, "a run item failed; its savepoint was rolled back and it was reported as not posted");
  const pg = driverError(err);
  if (pg?.code === "23505" && pg.constraint === "journal_entries_company_number_unq") {
    return {
      code: "entry_number_taken",
      reason: `Entry number “${item.entryNumber}” is already used by another journal entry in this company, so nothing was posted for ${item.label}.`,
    };
  }
  if (pg) {
    return { code: "database_error", reason: `The database refused the entry for ${item.label}, so nothing was posted for it. The details are in the server log.` };
  }
  return { code: "unknown", reason: `An unexpected error stopped ${item.label}, so nothing was posted for it. The details are in the server log.` };
}
