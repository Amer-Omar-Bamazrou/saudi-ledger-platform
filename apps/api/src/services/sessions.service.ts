/**
 * 🔴 Phase 19A (19.4/19.5/19.8, owner approval 2026-11-17) — a person's sessions, seen and ended. IDENTITY LAYER:
 * every act authorizes explicitly before it reads or ends anything —
 *   - one's OWN sessions: the session's own user;
 *   - a MEMBER's sessions: an admin of a verified organization, and only for an account CONFINED to the organizations
 *     they administer (a session is account-wide, so ending one is the account-wide act `assertAccountConfinedTo`
 *     governs — the F1 lesson; out of scope is concealed as 404, a shared account is explained as 409);
 *   - ANY session: a platform operator, on the operator surface (operators are members of no organization).
 * Each act writes EXACTLY ONE security event (19.8) — `session.revoked` for one session, `session.revoked_all` for
 * several — with actor, target, organization and the request id. A refused act writes none.
 *
 * Ending is immediate: the record ends and `endEndedSessions` refuses the session on its next request (deleting the
 * session row is hygiene, not the guarantee).
 */
import { sessionRecordsRepository, type MemberSessionRow, type SessionRow } from "../repositories/sessionRecords.repository";
import { userAdminRepository } from "../repositories/userAdmin.repository";
import { membersRepository } from "../repositories/members.repository";
import { assertAccountConfinedTo } from "../lib/accountScope";
import { BadRequestError, BusinessRuleError } from "../lib/errors";
import { hasNul } from "../lib/inputGuards";
import { securityAuditService } from "./securityAudit.service";

export interface SessionActor {
  userId: number;
  email?: string | null;
  ipAddress?: string | null;
  /** The record of the session making the request. */
  currentRecordId?: string | null;
  activeOrgId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SESSION_REFUSALS = {
  notFound: { status: 404, code: "session_not_found", error: "Session not found. It may have ended already.", errorAr: "لم يُعثر على الجلسة. ربما انتهت بالفعل." },
  isCurrent: {
    status: 409, code: "session_is_current",
    error: "This is the session you are using. To end it, sign out.",
    errorAr: "هذه هي الجلسة التي تستخدمها الآن. لإنهائها، سجّل الخروج.",
  },
  notAdmin: {
    status: 403, code: "sessions_admin_only",
    error: "Only an admin of a verified organization can see or end its members' sessions.",
    errorAr: "لا يطّلع على جلسات الأعضاء أو ينهيها إلا مسؤول في منشأة موثّقة.",
  },
  userNotFound: { status: 404, code: "user_not_found", error: "User not found.", errorAr: "لم يُعثر على المستخدم." },
} as const;

function refuse(r: (typeof SESSION_REFUSALS)[keyof typeof SESSION_REFUSALS]): never {
  throw new BusinessRuleError(r.status, { code: r.code, error: r.error, errorAr: r.errorAr });
}

function out(r: SessionRow, currentRecordId?: string | null) {
  return {
    id: r.id, current: r.id === currentRecordId, kind: r.kind,
    createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(),
    client: r.client, ipAddress: r.ipAddress,
  };
}
function memberOut(r: MemberSessionRow, currentRecordId?: string | null) {
  return { ...out(r, currentRecordId), user: { id: r.userId, name: r.userName, email: r.userEmail } };
}

/** The organization a self-act is recorded in: the active one, else the account's only one, else none. */
async function ownOrgOf(actor: SessionActor): Promise<string | null> {
  if (actor.activeOrgId) return actor.activeOrgId;
  const orgs = await membersRepository.activeOrgIds(actor.userId);
  return orgs.length === 1 ? orgs[0]! : null;
}

async function record(action: "session.revoked" | "session.revoked_all", actor: SessionActor, targetUserId: number,
  organizationId: string | null, metadata: Record<string, unknown>): Promise<void> {
  await securityAuditService.record({
    action, actorUserId: actor.userId, actorEmail: actor.email ?? null, targetUserId, organizationId,
    ipAddress: actor.ipAddress ?? null, metadata,
  });
}

async function adminScope(actor: SessionActor): Promise<string[]> {
  const orgIds = await userAdminRepository.administeredOrgIds(actor.userId);
  if (orgIds.length === 0) refuse(SESSION_REFUSALS.notAdmin);
  return orgIds;
}

export const sessionsService = {
  async listMine(actor: SessionActor) {
    return { sessions: (await sessionRecordsRepository.activeForUser(actor.userId)).map((r) => out(r, actor.currentRecordId)) };
  },

  /** End ONE of one's own sessions — never the one asking (that is Sign out), never someone else's (concealed). */
  async endMine(actor: SessionActor, recordId: string) {
    if (!UUID.test(recordId)) refuse(SESSION_REFUSALS.notFound);
    const row = await sessionRecordsRepository.activeById(recordId);
    if (!row || row.userId !== actor.userId) refuse(SESSION_REFUSALS.notFound);
    if (recordId === actor.currentRecordId) refuse(SESSION_REFUSALS.isCurrent);
    const ended = await sessionRecordsRepository.end([recordId], "ended_by_self", actor.userId);
    await record("session.revoked", actor, actor.userId, await ownOrgOf(actor), { sessionIds: ended, by: "self" });
    return { ended: ended.length };
  },

  /** End every one of one's own sessions except the one asking. */
  async endMyOthers(actor: SessionActor) {
    const others = (await sessionRecordsRepository.activeForUser(actor.userId)).filter((r) => r.id !== actor.currentRecordId).map((r) => r.id);
    const ended = await sessionRecordsRepository.end(others, "ended_by_self", actor.userId);
    await record("session.revoked_all", actor, actor.userId, await ownOrgOf(actor), { sessionIds: ended, count: ended.length, by: "self", scope: "others" });
    return { ended: ended.length };
  },

  /** The active sessions of the accounts this admin administers (confined to their organizations). */
  async listMembers(actor: SessionActor) {
    const orgIds = await adminScope(actor);
    const userIds = await sessionRecordsRepository.confinedMemberIds(orgIds);
    return { sessions: (await sessionRecordsRepository.activeForUsers(userIds)).map((r) => memberOut(r, actor.currentRecordId)) };
  },

  /** An admin ends every session of a member: in scope, and confined to the admin's organizations. */
  async endMember(actor: SessionActor, targetUserId: number) {
    const orgIds = await adminScope(actor);
    if (!(await userAdminRepository.isMemberOfAny(targetUserId, orgIds))) refuse(SESSION_REFUSALS.userNotFound);
    await assertAccountConfinedTo(targetUserId, orgIds, "explain", {
      actorUserId: actor.userId, actorEmail: actor.email, ipAddress: actor.ipAddress, attempted: "session.revoked_all",
    });
    const ids = (await sessionRecordsRepository.activeForUser(targetUserId)).map((r) => r.id);
    const ended = await sessionRecordsRepository.end(ids, "ended_by_admin", actor.userId);
    const shared = (await membersRepository.activeOrgIds(targetUserId)).filter((o) => orgIds.includes(o)).sort();
    await record("session.revoked_all", actor, targetUserId, shared[0] ?? null, { sessionIds: ended, count: ended.length, by: "admin", scope: "all" });
    return { ended: ended.length };
  },

  /** The operator surface: platform operators' own active sessions. */
  async listOperators(actor: SessionActor) {
    return { sessions: (await sessionRecordsRepository.activeForOperators()).map((r) => memberOut(r, actor.currentRecordId)) };
  },

  /** An operator ends any ONE session (audited; org-less — operators belong to no organization). */
  async operatorEndOne(actor: SessionActor, recordId: string) {
    if (!UUID.test(recordId)) refuse(SESSION_REFUSALS.notFound);
    const row = await sessionRecordsRepository.activeById(recordId);
    if (!row) refuse(SESSION_REFUSALS.notFound);
    if (recordId === actor.currentRecordId) refuse(SESSION_REFUSALS.isCurrent);
    const ended = await sessionRecordsRepository.end([recordId], "ended_by_operator", actor.userId);
    await record("session.revoked", actor, row.userId, null, { sessionIds: ended, by: "operator" });
    return { ended: ended.length };
  },

  /** An operator ends every session of the account with this email (audited). */
  async operatorEndUser(actor: SessionActor, email: unknown) {
    const cleaned = String(email ?? "").trim().toLowerCase();
    if (!cleaned || !cleaned.includes("@") || cleaned.length > 320 || hasNul(cleaned)) throw new BadRequestError("A user email is required.");
    const target = await userAdminRepository.findByEmail(cleaned);
    if (!target) refuse(SESSION_REFUSALS.userNotFound);
    const ids = (await sessionRecordsRepository.activeForUser(target.id)).filter((r) => r.id !== actor.currentRecordId).map((r) => r.id);
    const ended = await sessionRecordsRepository.end(ids, "ended_by_operator", actor.userId);
    await record("session.revoked_all", actor, target.id, null, { sessionIds: ended, count: ended.length, by: "operator", scope: "all" });
    return { ended: ended.length };
  },
};
