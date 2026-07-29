/**
 * The `Approvable` contract — the entity-agnostic seam of the universal
 * draft/approval workflow (M10.2, generalized in M10.3).
 *
 * Every in-scope financial record (journal entries, invoices, bills, payments,
 * payroll) plugs into the SAME {@link approvalService} state machine by supplying
 * an `Approvable` adapter. The adapter describes only the entity-specifics; the
 * service owns the transitions, the guards, and the audit trail. This is what
 * keeps the workflow uniform across entities.
 *
 * ── The core principle it encodes (spec §3, §7) ──────────────────────────────
 * A record is created as a DRAFT that has NO effect on the books. It only touches
 * the ledger when it becomes `approved`, at which point the adapter's
 * {@link Approvable.onApprove} fires the entity's existing activation path
 * (JE → post to GL; bill → AP/expense/VAT; …). The workflow gates *when* the
 * accounting core fires — it never reimplements it.
 *
 * ── State machine (spec §4) ──────────────────────────────────────────────────
 *
 *   draft ──submit──▶ submitted ──approve──▶ approved   (fires on-approve action)
 *     ▲                   │  │
 *     └────send-back──────┘  └────reject────▶ (hard delete — no archive)
 *     (editable)          (locked, in the approver's queue)
 *
 *   - **draft**     — editable by the enterer, NOT in the approval queue, NOT in
 *                     the books. A sent-back record returns here to be corrected.
 *   - **submitted** — awaiting approval; locked to the enterer, sits in the
 *                     approver's queue. Still NOT in the books.
 *   - **approved**  — active; the record now affects the books. Post-approval
 *                     sub-states an entity may have (e.g. a bill's `paid`, a JE's
 *                     `reversed`) all map to `approved` here.
 *
 * Entities with a simpler lifecycle (e.g. journal entries) simply omit the
 * optional {@link Approvable.onSubmit}/{@link Approvable.onSendBack} and are
 * approved straight from `draft`.
 *
 * ── State vocabulary (spec §10) ──────────────────────────────────────────────
 * Entities keep their own native status column and map it here via
 * {@link Approvable.state}. A journal entry's `draft|posted|reversed` maps
 * `draft→draft`, `posted`/`reversed`→`approved`; a bill's
 * `draft|submitted|received|paid` maps `received`/`paid`→`approved`. The adapter
 * is the single place that translation lives.
 */

/** The lifecycle states every approvable record collapses to. */
export type ApprovalState = "draft" | "submitted" | "approved";

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
   * Audit `entity_type` for this record (e.g. `"journal_entry"`, `"bill"`). Also
   * used to phrase the service's generic conflict messages.
   */
  readonly entityType: string;

  /** Load the record by id, tenant-scoped. Returns null when not found. */
  load(id: number): Promise<TEntity | null>;

  /** Map the record's native status to the abstract lifecycle state. */
  state(entity: TEntity): ApprovalState;

  /**
   * Fire the entity's activation path — the existing, trusted accounting action
   * that makes the record affect the books (period-lock checks included). Called
   * by the service ONLY on a transition INTO `approved`. Returns the
   * post-approval snapshot (used as the audit `after` state and the response).
   */
  onApprove(entity: TEntity, actor: ApprovalActor): Promise<TSnapshot>;

  /**
   * Build a snapshot of the record in its current state — the audit `before`
   * state for a transition, and the response body for a plain read.
   */
  snapshot(entity: TEntity): Promise<TSnapshot> | TSnapshot;

  /**
   * Hard-delete the record (reject path). Per spec §4 there is NO archive of
   * rejected drafts — a rejected record is removed. The service only ever calls
   * this on a non-approved record.
   */
  hardDelete(entity: TEntity): Promise<void>;

  /**
   * OPTIONAL — move an editable `draft` into the approval queue (`submitted`).
   * Entities with an editable-draft stage (bills, invoices, payroll) implement
   * this; simpler entities (journal entries) omit it and are approved directly.
   * Returns the post-submit snapshot.
   */
  onSubmit?(entity: TEntity, actor: ApprovalActor): Promise<TSnapshot>;

  /**
   * OPTIONAL — send a `submitted` record back to `draft` for correction, with an
   * optional reviewer note. The enterer edits and resubmits. Returns the
   * post-send-back snapshot.
   */
  onSendBack?(entity: TEntity, actor: ApprovalActor, note?: string): Promise<TSnapshot>;
}
