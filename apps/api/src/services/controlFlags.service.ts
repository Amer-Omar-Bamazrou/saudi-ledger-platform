/**
 * 🔴 Phase 18 R-11a — DR-14 (owner, 2026-11-01): "flags only (self-approval; pairs first). A flag never blocks an
 * act. No new approval framework." Register §11.111.
 *
 * `flagIfSamePerson` is the ONE place a flag is decided: the act that completes a pair (or an approval) names who
 * did the first half and who is doing this one; when they are the same person, a flag is recorded beside the act,
 * in its transaction. It never throws a refusal and never changes the act — a flag describes, it does not decide.
 * Every caller passes the person of the FIRST act as the record holds it (never a request value).
 */
import type { ControlFlagKind } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { controlFlagsRepository, type ControlFlagRow } from "../repositories/controlFlags.repository";
import { membersRepository } from "../repositories/members.repository";

export type ControlFlagOut = {
  id: number;
  kind: ControlFlagKind;
  actorUserId: number;
  actorName: string | null;
  entityType: string;
  entityId: string;
  reference: string | null;
  firstAct: string;
  secondAct: string;
  createdAt: string;
};

export const controlFlagsService = {
  /**
   * Record a flag when `firstActor` — the person the record names for the first act — is `secondActor`, the person
   * doing this one. Nothing is recorded when either is unknown (a job, a record from before the act stored it).
   *
   * 🔴 Register §11.114 — A FLAG NEVER BLOCKS ITS ACT. The store names the connection's DECLARED actor (T1b) and
   * refuses any other, and the flag is written inside the act's transaction, so a refused flag would take the act
   * with it. It is therefore written only when this act's person IS the declared actor — as in every request; where
   * the connection declares none (a script) or another, no flag is written and the act goes through.
   */
  async flagIfSamePerson(
    firstActor: number | null | undefined,
    secondActor: number | null | undefined,
    flag: { kind: ControlFlagKind; entityType: string; entityId: string | number; reference: string | null; firstAct: string; secondAct: string },
  ): Promise<boolean> {
    if (firstActor == null || secondActor == null || firstActor !== secondActor) return false;
    if ((await controlFlagsRepository.declaredActor()) !== secondActor) return false;
    await controlFlagsRepository.record(flag);
    return true;
  },

  /** A page of the active company's flags, newest first, each with the person's name (resolved in the identity layer). */
  async list(page: { limit: number; offset: number }): Promise<{ items: ControlFlagOut[]; total: number }> {
    const [rows, total] = await Promise.all([controlFlagsRepository.list(page.limit, page.offset), controlFlagsRepository.count()]);
    return { items: await toOut(rows), total };
  },
};

async function toOut(rows: ControlFlagRow[]): Promise<ControlFlagOut[]> {
  if (rows.length === 0) return [];
  const orgId = auditContext.get()?.organizationId;
  const names = orgId ? await membersRepository.memberNamesByIds(orgId, [...new Set(rows.map((r) => r.actorUserId))]) : new Map<number, string>();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorUserId: r.actorUserId,
    actorName: names.get(r.actorUserId) ?? null,
    entityType: r.entityType,
    entityId: r.entityId,
    reference: r.reference,
    firstAct: r.firstAct,
    secondAct: r.secondAct,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}
