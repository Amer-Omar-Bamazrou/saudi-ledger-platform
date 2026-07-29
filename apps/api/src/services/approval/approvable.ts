/**
 * The `Approvable` contract — the entity-agnostic seam of the universal
 * draft/approval workflow (M10.2).
 *
 * Every in-scope financial record (journal entries, invoices, bills, payments,
 * payroll — added across M10.3–M10.5) plugs into the SAME {@link approvalService}
 * state machine by supplying an `Approvable` adapter. The adapter describes only
 * the entity-specifics; the service owns the transitions, the guards, and the
 * audit trail. This is what keeps the workflow uniform across entities.
 *
 * ── The core principle it encodes (spec §3, §7) ──────────────────────────────
 * A record is created as a DRAFT (`pending`) that has NO effect on the books. It
 * only touches the ledger when it becomes `approved`, at which point the adapter's
 * {@link Approvable.onApprove} fires the entity's existing activation path
 * (JE → post to GL; invoice → AR + ZATCA; …). The workflow gates *when* the
 * accounting core fires — it never reimplements it.
 *
 * ── Status vocabulary (spec §10) ─────────────────────────────────────────────
 * The abstract status is binary: `pending | approved`. Entities keep their own
 * native status column and map it here — e.g. a journal entry's richer
 * `draft | posted | reversed` maps `draft → pending`, `posted`/`reversed →
 * approved`. The adapter is the single place that translation lives.
 */

/** The two abstract states every approvable record collapses to. */
export type ApprovalStatus = "pending" | "approved";

/** Who is performing the transition (the resolved request actor). */
export interface ApprovalActor {
  /** The acting user's id, or null for system/pre-auth contexts. */
  userId: number | null;
}

/**
 * The adapter a financial entity implements to join the approval workflow.
 *
 * @typeParam TEntity   the loaded domain row (opaque to the service)
 * @typeParam TSnapshot the shape used for audit before/after AND the response
 */
export interface Approvable<TEntity, TSnapshot = unknown> {
  /**
   * Audit `entity_type` for this record (e.g. `"journal_entry"`). Also used to
   * phrase the service's generic conflict messages.
   */
  readonly entityType: string;

  /** Load the record by id, tenant-scoped. Returns null when not found. */
  load(id: number): Promise<TEntity | null>;

  /** Map the record's native state to the abstract approval status. */
  status(entity: TEntity): ApprovalStatus;

  /**
   * Fire the entity's activation path — the existing, trusted accounting action
   * that makes the record affect the books (period-lock checks included). Called
   * by the service ONLY on a `pending → approved` transition. Returns the
   * post-approval snapshot (used as the audit `after` state and the response).
   */
  onApprove(entity: TEntity, actor: ApprovalActor): Promise<TSnapshot>;

  /**
   * Build a snapshot of the record in its current state — the audit `before`
   * state for a transition, and the response body for a plain read.
   */
  snapshot(entity: TEntity): Promise<TSnapshot> | TSnapshot;

  /**
   * Hard-delete the draft (reject path). Per spec §4 there is NO archive of
   * rejected drafts — a rejected record is removed. The service only ever calls
   * this on a `pending` record.
   */
  hardDelete(entity: TEntity): Promise<void>;
}
