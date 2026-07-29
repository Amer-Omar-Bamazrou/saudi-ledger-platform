/**
 * approvalService — the generic draft→approval state machine (M10.2).
 *
 * This is the single, entity-agnostic engine that drives the universal workflow
 * for every financial record. It knows nothing about journal entries, invoices,
 * or bills; each entity supplies an {@link Approvable} adapter and this service
 * runs the transitions, enforces the guards, and writes the audit trail. Later
 * milestones (M10.3–M10.5) add entities by writing an adapter — never by editing
 * this file.
 *
 * Transitions (spec §4):
 *   - `approve` (`pending → approved`): fires the entity's on-approve action
 *     (its existing activation path) and records an `approve` audit entry.
 *   - `reject`  (`pending → ∅`): hard-deletes the draft — no archive (spec §4) —
 *     and records a `reject` audit entry.
 *
 * Every transition runs inside the request's tenant transaction, so the audit
 * row commits atomically with the effect (per M7): a rolled-back approval leaves
 * no audit trace, and there is no effect without its audit entry.
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
   * Approve a pending draft: fire the entity's activation action and record it.
   * Fail-closed on state — a record that is already approved cannot be
   * re-approved (idempotency guard).
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

    if (adapter.status(entity) === "approved") {
      throw new ConflictError(`This ${humanize(adapter.entityType)} is already approved.`);
    }

    const before = await adapter.snapshot(entity);
    const after = await adapter.onApprove(entity, actor);

    await auditService.record({
      action: "approve",
      entityType: adapter.entityType,
      entityId: id,
      before,
      after,
    });

    return after;
  },

  /**
   * Reject a pending draft by hard-deleting it (spec §4 — no archive). Only a
   * `pending` record can be rejected; an already-approved record must be
   * reversed through its own accounting path, not rejected.
   */
  async reject<TEntity, TSnapshot>(
    adapter: Approvable<TEntity, TSnapshot>,
    id: number,
    _actor: ApprovalActor,
  ): Promise<void> {
    const entity = await adapter.load(id);
    if (!entity) throw new NotFoundError("Not found");

    if (adapter.status(entity) !== "pending") {
      throw new ConflictError(
        `Only a pending ${humanize(adapter.entityType)} can be rejected.`,
      );
    }

    const before = await adapter.snapshot(entity);
    await adapter.hardDelete(entity);

    await auditService.record({
      action: "reject",
      entityType: adapter.entityType,
      entityId: id,
      before,
    });
  },
};
