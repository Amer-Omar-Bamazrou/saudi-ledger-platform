/**
 * Centralized error-handling middleware (M6).
 *
 * Registered last in the Express chain. Controllers/services throw (Express 5
 * forwards rejected async handlers here automatically); this translates the
 * error to an HTTP response. The translation is intentionally identical to the
 * pre-M6 `handleRouteError` helper so API responses do not change:
 *   - an error carrying a numeric `statusCode` in [400, 600) → that status +
 *     the error's message (covers AppError and the legacy `{ statusCode }` tag);
 *   - anything else → logged and returned as a generic 500.
 */
import type { Request, Response, NextFunction } from "express";

/** Phase 15 — the 0112 trigger refusals, by the constraint name each raises (422: the request names something it may not; 409: a lifecycle state). */
const BUDGET_TRIGGER_STATUS: Record<string, 409 | 422> = {
  budget_header_frozen: 409,
  budget_header_tenant: 422,
  budget_version_superseded_alone: 409,
  budget_version_tenant: 422,
  budget_version_born_draft: 409,
  budget_version_sequence: 409,
  budget_version_revision_base: 409,
  budget_version_immutable: 409,
  budget_version_identity: 409,
  budget_version_transition: 409,
  budget_line_tenant: 422,
  budget_line_locked: 409,
  budget_line_identity: 409,
  budget_line_account: 422,
  budget_line_mode: 422,
  budget_no_truncate: 409,
};
/** The 0112 unique indexes a concurrent request can collide on. */
const BUDGET_UNIQUE_MESSAGE: Record<string, string> = {
  budgets_company_year_scenario_name_unq: "A budget with this name and scenario already exists for that fiscal year.",
  budget_versions_one_open_unq: "Another version of this budget is already open — finish or reject it first.",
  budget_versions_one_approved_unq: "This budget already has an approved version.",
  budget_versions_no_unq: "Another version of this budget was created at the same moment — reload and try again.",
};

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If a response was already partially sent, defer to Express' default handler.
  if (res.headersSent) {
    next(err);
    return;
  }

  const code = (err as { statusCode?: unknown })?.statusCode;
  if (typeof code === "number" && code >= 400 && code < 600) {
    // Preserve rich, structured error bodies (e.g. { error, code, detail }).
    const payload = (err as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      res.status(code).json(payload);
      return;
    }
    res.status(code).json({ error: (err as Error).message });
    return;
  }

  // ── Class-level Postgres mappings (audit 2026-08-20, LOW / M-4 family) ────
  // 22001 (value too long for varchar) is PREDICTABLE user input hitting a
  // column bound — a 400, not a 500. Mapped HERE, at the one boundary every
  // path shares, rather than per-field guards in seven services: present and
  // future varchar columns inherit it (the write-boundary rule applied to an
  // error translation). The driver does not reliably name the column, so the
  // message stays generic; the log line carries the full error.
  if ((err as { code?: string })?.code === "22001") {
    req.log.warn({ err }, "varchar overflow mapped to 400");
    res.status(400).json({ error: "A field exceeds its maximum allowed length." });
    return;
  }

  // Phase 12C/12D: the banking triggers refuse from EVERY posting path (a
  // payment, a journal, an import, a reversal) — so they are translated here,
  // once, into a 409 carrying the database's own sentence and a stable code
  // the UI keys on. Drizzle may wrap the driver error in `cause`.
  const pg = (err as { code?: string; message?: string; cause?: { code?: string; message?: string } });
  const pgCode = pg?.code && /^[0-9A-Z]{5}$/.test(pg.code) ? pg.code : pg?.cause?.code;
  const pgMessage = pg?.cause?.message ?? pg?.message ?? "";
  if (pgCode === "23514" && /is reconciled through/.test(pgMessage)) {
    res.status(409).json({ code: "bank_reconciled_through", error: pgMessage });
    return;
  }
  if (pgCode === "23514" && /is reconciled to a bank statement line/.test(pgMessage)) {
    res.status(409).json({ code: "entry_reconciled", error: pgMessage });
    return;
  }

  // Phase 15: the budget triggers (0112) lock the lifecycle and the tenancy of
  // every row at the database, so they refuse from EVERY path — translated here
  // once. The constraint name is the stable code; the database's sentence is
  // the message. A wrong account / mixed mode / foreign row is a 422 (the
  // request names something it may not); a lifecycle step is a 409 (state).
  // An EXACT allow-list — a plain CHECK or a primary-key fault on these tables
  // is a bug, not a refusal, and stays a logged 500.
  const pgConstraint = (err as { constraint?: string })?.constraint ?? (pg?.cause as { constraint?: string } | undefined)?.constraint;
  const budgetRefusal = pgCode === "23514" && pgConstraint ? BUDGET_TRIGGER_STATUS[pgConstraint] : undefined;
  if (budgetRefusal) {
    req.log.warn({ code: pgConstraint }, "budget refusal from the database");
    res.status(budgetRefusal).json({ code: pgConstraint, error: pgMessage });
    return;
  }
  const budgetConflict = pgCode === "23505" && pgConstraint ? BUDGET_UNIQUE_MESSAGE[pgConstraint] : undefined;
  if (budgetConflict) {
    req.log.warn({ constraint: pgConstraint }, "budget conflict from the database");
    res.status(409).json({ code: "budget_conflict", constraint: pgConstraint, error: budgetConflict });
    return;
  }

  req.log.error({ err });
  res.status(500).json({ error: "Internal server error" });
}
