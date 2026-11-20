/**
 * 🔴 Phase 19A (19.7, owner approval 2026-11-17) — an organization's security settings: two-step verification for
 * everyone, the session lifetime, the idle timeout. IDENTITY LAYER: the caller must be an active admin of THIS
 * organization (no ambient tenant context), like the security trail beside it.
 *
 *   - A value stays inside the platform's bounds (refused here naming the bound; the database CHECKs it too).
 *   - A STRENGTHENING change applies at once.
 *   - A WEAKENING change (two-step verification for everyone turned off, a longer lifetime, a longer idle timeout) in
 *     an organization with two or more usable admins is recorded as a REQUEST and waits for a second admin — the
 *     requester cannot approve it. The database refuses the weakening itself without that approval (0167), so this
 *     service is not the only thing standing between one admin and a weaker organization. An internal control of the
 *     platform (the DR-23 dual-control pattern), not a regulatory requirement.
 *   - Every act writes one `security_settings.changed` event: stage `applied`, `requested`, `approved` or `rejected`.
 */
import { membersRepository } from "../repositories/members.repository";
import {
  SECURITY_BOUNDS, securitySettingsRepository, type SecuritySettings,
} from "../repositories/securitySettings.repository";
import { BusinessRuleError } from "../lib/errors";
import { securityAuditService } from "./securityAudit.service";

export interface SettingsActor {
  userId: number;
  email?: string | null;
  ipAddress?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SECURITY_SETTINGS_REFUSALS = {
  adminOnly: {
    status: 403, code: "security_settings_admin_only",
    error: "Only an admin of this organization sees or changes its security settings.",
    errorAr: "لا يطّلع على إعدادات أمان هذه المنشأة أو يغيّرها إلا مسؤول فيها.",
  },
  pending: {
    status: 409, code: "security_settings_change_pending",
    error: "A change to the security settings is already waiting for a second admin. It is approved or rejected before another is asked for.",
    errorAr: "يوجد تغيير في إعدادات الأمان بانتظار مسؤول ثانٍ. يُعتمد أو يُرفض قبل طلب تغيير آخر.",
  },
  secondAdmin: {
    status: 409, code: "security_settings_second_admin_required",
    error: "You asked for this change, so you cannot approve it: a weaker security setting is approved by a second admin of this organization. (An internal control of this platform.)",
    errorAr: "أنت من طلب هذا التغيير فلا يمكنك اعتماده: يعتمد إعدادَ الأمان الأضعف مسؤول ثانٍ في هذه المنشأة. (ضابط رقابة داخلية في المنصة.)",
  },
  notFound: {
    status: 404, code: "security_settings_change_not_found",
    error: "That request is not waiting for a decision. It may have been decided already.",
    errorAr: "هذا الطلب ليس بانتظار قرار. ربما تم البت فيه.",
  },
  stale: {
    status: 409, code: "security_settings_change_stale",
    error: "The settings changed after this request was made, so it can no longer be approved. Reject it and ask again.",
    errorAr: "تغيّرت الإعدادات بعد تقديم هذا الطلب فلم يعد اعتماده ممكناً. ارفضه واطلب التغيير من جديد.",
  },
  decisionInvalid: { status: 422, code: "security_settings_decision_invalid", error: "The decision is 'approve' or 'reject'.", errorAr: "القرار إما اعتماد أو رفض." },
} as const;

function refuse(r: { status: number; code: string; error: string; errorAr: string }, extra: Record<string, unknown> = {}): never {
  throw new BusinessRuleError(r.status, { code: r.code, error: r.error, errorAr: r.errorAr, ...extra });
}

async function requireAdminOf(actor: SettingsActor, orgId: string): Promise<void> {
  if (!UUID.test(orgId) || (await membersRepository.activeRole(actor.userId, orgId)) !== "admin") refuse(SECURITY_SETTINGS_REFUSALS.adminOnly);
}

/** The body as settings inside the platform's bounds — or a refusal naming the field and the bound. */
function parse(body: unknown): SecuritySettings {
  const b = (body ?? {}) as Record<string, unknown>;
  const outOfBounds = (field: string, en: string, ar: string): never =>
    refuse({ status: 422, code: "security_setting_out_of_bounds", error: en, errorAr: ar }, { field });
  if (typeof b.mfaRequiredForAll !== "boolean") {
    outOfBounds("mfaRequiredForAll", "Two-step verification for everyone is either on or off.", "التحقق بخطوتين للجميع إما مفعَّل أو غير مفعَّل.");
  }
  const whole = (field: "sessionLifetimeHours" | "idleTimeoutMinutes", en: string, ar: string): number => {
    const v = b[field];
    const { min, max } = SECURITY_BOUNDS[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) outOfBounds(field, en, ar);
    return v as number;
  };
  return {
    mfaRequiredForAll: b.mfaRequiredForAll as boolean,
    sessionLifetimeHours: whole("sessionLifetimeHours",
      "The session lifetime is a whole number of hours from 1 to 12. Twelve hours is the platform's limit; an organization can only be stricter.",
      "مدة الجلسة عدد صحيح من الساعات من 1 إلى 12. اثنتا عشرة ساعة حدّ المنصة، ولا تكون المنشأة إلا أكثر تشدداً."),
    idleTimeoutMinutes: whole("idleTimeoutMinutes",
      "The idle timeout is a whole number of minutes from 15 to 480. Eight hours is the platform's limit; an organization can only be stricter.",
      "مهلة الخمول عدد صحيح من الدقائق من 15 إلى 480. ثماني ساعات حدّ المنصة، ولا تكون المنشأة إلا أكثر تشدداً."),
  };
}

const same = (a: SecuritySettings, b: SecuritySettings) =>
  a.mfaRequiredForAll === b.mfaRequiredForAll && a.sessionLifetimeHours === b.sessionLifetimeHours && a.idleTimeoutMinutes === b.idleTimeoutMinutes;
/** Does `after` loosen anything `before` held? */
export const weakens = (before: SecuritySettings, after: SecuritySettings) =>
  (before.mfaRequiredForAll && !after.mfaRequiredForAll) || after.sessionLifetimeHours > before.sessionLifetimeHours || after.idleTimeoutMinutes > before.idleTimeoutMinutes;

async function record(actor: SettingsActor, orgId: string, metadata: Record<string, unknown>): Promise<void> {
  await securityAuditService.record({
    action: "security_settings.changed", actorUserId: actor.userId, actorEmail: actor.email ?? null, organizationId: orgId,
    ipAddress: actor.ipAddress ?? null, metadata,
  });
}

async function view(orgId: string) {
  return {
    settings: await securitySettingsRepository.get(orgId),
    bounds: SECURITY_BOUNDS,
    pendingChange: await securitySettingsRepository.pending(orgId),
    usableAdmins: await membersRepository.usableAdminCount(orgId),
  };
}

export const securitySettingsService = {
  async get(actor: SettingsActor, orgId: string) {
    await requireAdminOf(actor, orgId);
    return view(orgId);
  },

  /** Change the settings: applied at once, or — a weakening with a second admin to ask — held as a request. */
  async change(actor: SettingsActor, orgId: string, body: unknown): Promise<{ status: 200 | 202; body: Record<string, unknown> }> {
    await requireAdminOf(actor, orgId);
    const after = parse(body);
    const before = await securitySettingsRepository.get(orgId);
    if (same(before, after)) return { status: 200, body: { applied: false, held: false, ...(await view(orgId)) } };
    if (await securitySettingsRepository.pending(orgId)) refuse(SECURITY_SETTINGS_REFUSALS.pending);

    if (weakens(before, after) && (await membersRepository.usableAdminCount(orgId)) >= 2) {
      try {
        await securitySettingsRepository.request(orgId, before, after, actor.userId);
      } catch (err) {
        if ((err as { code?: string; cause?: { code?: string } }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") refuse(SECURITY_SETTINGS_REFUSALS.pending);
        throw err;
      }
      await record(actor, orgId, { stage: "requested", before, after });
      return { status: 202, body: { applied: false, held: true, ...(await view(orgId)) } };
    }
    await securitySettingsRepository.apply(orgId, after, actor.userId);
    await record(actor, orgId, { stage: "applied", before, after });
    return { status: 200, body: { applied: true, held: false, ...(await view(orgId)) } };
  },

  /** A second admin approves a held change (it is written in the same transaction), or it is rejected. */
  async decide(actor: SettingsActor, orgId: string, changeId: string, decision: unknown) {
    await requireAdminOf(actor, orgId);
    if (decision !== "approve" && decision !== "reject") refuse(SECURITY_SETTINGS_REFUSALS.decisionInvalid);
    const pending = await securitySettingsRepository.pending(orgId);
    if (!UUID.test(changeId) || !pending || pending.id !== changeId) refuse(SECURITY_SETTINGS_REFUSALS.notFound);
    if (decision === "approve") {
      if (pending.requestedBy.id === actor.userId) refuse(SECURITY_SETTINGS_REFUSALS.secondAdmin);
      if (!same(await securitySettingsRepository.get(orgId), pending.before)) refuse(SECURITY_SETTINGS_REFUSALS.stale);
    }
    const done = await securitySettingsRepository.decide(orgId, changeId, decision === "approve" ? "approved" : "rejected", decision === "approve" ? pending.after : null, actor.userId);
    if (!done) refuse(SECURITY_SETTINGS_REFUSALS.notFound);
    await record(actor, orgId, { stage: decision === "approve" ? "approved" : "rejected", before: pending.before, after: pending.after, requestedBy: pending.requestedBy.id });
    return { applied: decision === "approve", ...(await view(orgId)) };
  },
};
