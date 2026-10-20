/**
 * approvalService — the generic draft→approval state machine (M10.2, generalized
 * in M10.3).
 *
 * This is the single, entity-agnostic engine that drives the universal workflow
 * for every financial record. It knows nothing about journal entries, bills, or
 * invoices; each entity supplies an {@link Approvable} adapter and this service
 * runs the transitions, enforces the guards, and writes the audit trail. Later
 * milestones add entities by writing an adapter — never by editing this file.
 *
 * Transitions (spec §4):
 *   - `submit`   (`draft → submitted`): move an editable draft into the approval
 *     queue. Requires the adapter to implement `onSubmit`.
 *   - `sendBack` (`submitted → draft`): return a queued record for correction,
 *     with an optional reviewer note. Requires `onSendBack`.
 *   - `approve`  (`draft|submitted → approved`): fire the entity's on-approve
 *     action (its existing activation path). Approvers may approve straight from
 *     `draft` (self-approve on create) or from the queue.
 *   - `reject`   (non-approved → ∅): hard-delete the record — no archive (§4).
 *
 * Every transition runs inside the request's tenant transaction, so the audit
 * row commits atomically with the effect (per M7): a rolled-back transition
 * leaves no audit trace, and there is no effect without its audit entry.
 *
 * 🔴 G08 residuals (PR A) — COMPARE-AND-SET. The state check below runs on a
 * record loaded before any lock, so on its own it is check-then-act: a second
 * request could act on the record between this check and the adapter's write
 * (B-G08R-P reproduced it on every adapter — an issued invoice set back to
 * draft and edited, posted bills, journal entries and payroll runs deleted).
 * The engine therefore passes the state it checked to the adapter, and an
 * adapter on compare-and-set (`compareAndSet: true`) writes only while the
 * record is still in that state, throwing `TransitionNotApplied` when its write
 * matched nothing. The engine answers that with a 409 decided from the record
 * as it is NOW (`lostRace`), so the loser of a race gets the refusal it would
 * get if it came second sequentially, and its whole transaction rolls back.
 * Sequential behaviour is unchanged: a conditional write misses only when
 * another request changed the record after this one loaded it. No lock is taken
 * here; the adapters keep their own lock order.
 */
import { ConflictError, NotFoundError } from "../../lib/errors";
import { auditService } from "../audit.service";
import { TransitionNotApplied, type Approvable, type ApprovalActor } from "./approvable";

/** "journal_entry" → "journal entry" for human-readable conflict messages. */
function humanize(entityType: string): string {
  return entityType.replace(/_/g, " ");
}

/** The refusal each act gets from a state it cannot start from — sequentially, and for the loser of a race. */
const REFUSAL = {
  submit: (what: string) => `Only a draft ${what} can be submitted.`,
  sendBack: (what: string) => `Only a submitted ${what} can be sent back.`,
  approve: (what: string) => `This ${what} is already approved.`,
  reject: (what: string) => `An approved ${what} cannot be rejected — reverse it instead.`,
} as const;
type Act = keyof typeof REFUSAL;
const DOING: Record<Act, string> = { submit: "submitted", sendBack: "sent back", approve: "approved", reject: "rejected" };

/**
 * 🔴 G08 residuals (PR A) — the 409 for a compare-and-set write that did not
 * apply, decided from the record as it is NOW:
 *  1. gone — another act removed it first;
 *  2. in a state this act is refused from sequentially — that same refusal;
 *  3. otherwise (approve and reject can start from two states) — it changed.
 * Anything that is not a {@link TransitionNotApplied} is returned unchanged.
 */
async function lostRace<TEntity, TSnapshot>(adapter: Approvable<TEntity, TSnapshot>, id: number, act: Act, err: unknown): Promise<unknown> {
  if (!(err instanceof TransitionNotApplied)) return err;
  const what = humanize(adapter.entityType);
  const now = await adapter.load(id);
  if (!now) {
    return new ConflictError(
      act === "approve"
        ? `This ${what} was rejected or deleted while it was being approved — nothing was ${adapter.approvalEffect ?? "posted"}.`
        : `This ${what} was already rejected or deleted by another action.`,
    );
  }
  const state = adapter.state(now);
  const refused = act === "submit" ? state !== "draft" : act === "sendBack" ? state !== "submitted" : state === "approved";
  if (refused) return new ConflictError(REFUSAL[act](what));
  return new ConflictError(`This ${what} changed while it was being ${DOING[act]}. Nothing was changed — reload and try again.`);
}

export const approvalService = {
  /**
   * Submit an editable draft into the approval queue (`draft → submitted`).
   * Only a `draft` may be submitted; a submitted/approved record is a 409.
   */
  async submit<TEntity, TSnapshot>(
    adapter: Approvable<TEntity, TSnapshot>,
    id: number,
    actor: ApprovalActor,
  ): Promise<TSnapshot> {
    if (!adapter.onSubmit) {
      throw new ConflictError(`A ${humanize(adapter.entityType)} cannot be submitted.`);
    }
    const entity = await adapter.load(id);
    if (!entity) throw new NotFoundError("Not found");
    if (adapter.state(entity) !== "draft") {
      throw new ConflictError(REFUSAL.submit(humanize(adapter.entityType)));
    }

    const before = await adapter.snapshot(entity);
    let after: TSnapshot;
    try {
      after = await adapter.onSubmit(entity, actor);
    } catch (err) {
      throw await lostRace(adapter, id, "submit", err);
    }
    await auditService.record({ action: "submit", entityType: adapter.entityType, entityId: id, before, after });
    return after;
  },

  /**
   * Send a queued record back to the enterer for correction (`submitted →
   * draft`), with an optional reviewer note. Only a `submitted` record can be
   * sent back.
   */
  async sendBack<TEntity, TSnapshot>(
    adapter: Approvable<TEntity, TSnapshot>,
    id: number,
    actor: ApprovalActor,
    note?: string,
  ): Promise<TSnapshot> {
    if (!adapter.onSendBack) {
      throw new ConflictError(`A ${humanize(adapter.entityType)} cannot be sent back.`);
    }
    const entity = await adapter.load(id);
    if (!entity) throw new NotFoundError("Not found");
    if (adapter.state(entity) !== "submitted") {
      throw new ConflictError(REFUSAL.sendBack(humanize(adapter.entityType)));
    }

    const before = await adapter.snapshot(entity);
    let after: TSnapshot;
    try {
      after = await adapter.onSendBack(entity, actor, note);
    } catch (err) {
      throw await lostRace(adapter, id, "sendBack", err);
    }
    await auditService.record({ action: "send_back", entityType: adapter.entityType, entityId: id, before, after });
    return after;
  },

  /**
   * Approve a record: fire the entity's on-approve action and record it. May run
   * from `draft` (self-approve on create) or `submitted` (from the queue).
   * Fail-closed on state — an already-approved record cannot be re-approved.
   *
   * @returns the post-approval snapshot produced by the adapter.
   */
  async approve<TEntity, TSnapshot>(
    adapter: Approvable<TEntity, TSnapshot>,
    id: number,
    actor: ApprovalActor,
  ): Promise<TSnapshot> {
    const entity = await adapter.load(id);
    if (!entity) throw new NotFoundError("Not found");

    const from = adapter.state(entity);
    if (from === "approved") {
      throw new ConflictError(REFUSAL.approve(humanize(adapter.entityType)));
    }

    const before = await adapter.snapshot(entity);
    let after: TSnapshot;
    try {
      after = await adapter.onApprove(entity, actor, from);
    } catch (err) {
      throw await lostRace(adapter, id, "approve", err);
    }
    await auditService.record({ action: "approve", entityType: adapter.entityType, entityId: id, before, after });
    return after;
  },

  /**
   * Reject a non-approved record by hard-deleting it (spec §4 — no archive). An
   * already-approved record must be reversed through its own accounting path,
   * not rejected.
   */
  async reject<TEntity, TSnapshot>(
    adapter: Approvable<TEntity, TSnapshot>,
    id: number,
    _actor: ApprovalActor,
  ): Promise<void> {
    const entity = await adapter.load(id);
    if (!entity) throw new NotFoundError("Not found");

    const from = adapter.state(entity);
    if (from === "approved") {
      throw new ConflictError(REFUSAL.reject(humanize(adapter.entityType)));
    }

    const before = await adapter.snapshot(entity);
    try {
      await adapter.hardDelete(entity, from);
    } catch (err) {
      throw await lostRace(adapter, id, "reject", err);
    }
    await auditService.record({ action: "reject", entityType: adapter.entityType, entityId: id, before });
  },
};
