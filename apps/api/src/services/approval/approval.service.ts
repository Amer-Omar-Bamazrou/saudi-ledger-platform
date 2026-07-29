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
 */
import { ConflictError, NotFoundError } from "../../lib/errors";
import { auditService } from "../audit.service";
import type { Approvable, ApprovalActor } from "./approvable";

/** "journal_entry" → "journal entry" for human-readable conflict messages. */
function humanize(entityType: string): string {
  return entityType.replace(/_/g, " ");
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
      throw new ConflictError(`Only a draft ${humanize(adapter.entityType)} can be submitted.`);
    }

    const before = await adapter.snapshot(entity);
    const after = await adapter.onSubmit(entity, actor);
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
      throw new ConflictError(`Only a submitted ${humanize(adapter.entityType)} can be sent back.`);
    }

    const before = await adapter.snapshot(entity);
    const after = await adapter.onSendBack(entity, actor, note);
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

    if (adapter.state(entity) === "approved") {
      throw new ConflictError(`This ${humanize(adapter.entityType)} is already approved.`);
    }

    const before = await adapter.snapshot(entity);
    const after = await adapter.onApprove(entity, actor);
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

    if (adapter.state(entity) === "approved") {
      throw new ConflictError(
        `An approved ${humanize(adapter.entityType)} cannot be rejected — reverse it instead.`,
      );
    }

    const before = await adapter.snapshot(entity);
    await adapter.hardDelete(entity);
    await auditService.record({ action: "reject", entityType: adapter.entityType, entityId: id, before });
  },
};
