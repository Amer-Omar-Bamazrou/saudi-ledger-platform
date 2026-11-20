/**
 * 🔴 Phase 19A (19.1–19.3; owner approval of the proposal and the MFA policy, 2026-11-17) — the second factor.
 *
 *   password ──► session owes a step ──► code (TOTP, or a recovery code) ──► whole session (id rotated by the route)
 *
 * - WHO MUST: a platform operator and an active admin of any organization (when `MFA_ENFORCEMENT` is `required`, the
 *   default and the only value production accepts). Anyone who HAS an active factor owes its code at every sign-in,
 *   whatever the setting.
 * - THE SECRET is sealed as a ZATCA private key is (per-row data key, wrapped by the KMS master key —
 *   `einvoice/signing/keyWrapper`). It is returned ONCE, by `beginEnrolment`, and is in memory otherwise only while a
 *   code is checked. Production depends on the KMS (queue C3): a row wrapped by the development wrapper is refused there.
 * - A CODE is accepted once: the step it belongs to must be later than the last step the factor accepted.
 * - RECOVERY CODES are single-use, stored only as hashes made by the password seam, shown once at activation.
 * - A RESET (owner, 2026-11-20) is an org ADMIN's act on another member of their own organization — never on their own
 *   factor, and never on an account that also belongs to an organization they do not administer (F1 confinement). A
 *   platform security operator resets only as the break-glass: when NO admin can, after stating that the person's
 *   identity was verified and on what basis. Either way it removes the factor and the recovery codes, ends every
 *   session of the account, is recorded (and feeds A1 for 30 days), and the person is told. A reset needs an active
 *   factor to remove. No recovery by email exists.
 * Every act writes one security event (19.8).
 */
import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import { loadEnv } from "@workspace/config";
import { mfaRepository } from "../repositories/mfa.repository";
import { operatorsRepository } from "../repositories/operators.repository";
import { userAdminRepository } from "../repositories/userAdmin.repository";
import { membersRepository } from "../repositories/members.repository";
import { sessionRecordsRepository } from "../repositories/sessionRecords.repository";
import { securitySettingsRepository } from "../repositories/securitySettings.repository";
import { generateDataKey, getKeyWrapper, openWithDataKey, sealWithDataKey } from "./einvoice/signing/keyWrapper";
import { base32Encode, generateTotpSecret, matchTotp, otpauthUri } from "../lib/totp";
import { hashPassword, verifyPassword } from "../lib/password";
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { assertAccountConfinedTo } from "../lib/accountScope";
import { hasNul } from "../lib/inputGuards";
import { mailer } from "../lib/mailer";
import { logger } from "../lib/logger";
import { securityAuditService } from "./securityAudit.service";

export type MfaStep = "code" | "enrol";
export const MFA_ISSUER = "KSA Ledger";
export const RECOVERY_CODE_COUNT = 10;

export interface MfaActor {
  userId: number;
  email?: string | null;
  ipAddress?: string | null;
  activeOrgId?: string | null;
}

export const MFA_REFUSALS = {
  codeRequired: {
    status: 403, code: "mfa_code_required",
    error: "Enter the code from your authenticator app to continue.",
    errorAr: "أدخل الرمز من تطبيق المصادقة للمتابعة.",
  },
  enrolmentRequired: {
    status: 403, code: "mfa_enrolment_required",
    error: "Your role requires two-step verification. Set it up to continue.",
    errorAr: "دورك يتطلب التحقق بخطوتين. أكمل إعداده للمتابعة.",
  },
  codeInvalid: {
    status: 422, code: "mfa_code_invalid",
    error: "That code is not valid. Enter the current six-digit code from your authenticator app; a code works once.",
    errorAr: "الرمز غير صحيح. أدخل الرمز الحالي المكوّن من ستة أرقام من تطبيق المصادقة؛ يُقبل الرمز مرة واحدة.",
  },
  recoveryInvalid: {
    status: 422, code: "mfa_recovery_code_invalid",
    error: "That recovery code is not valid, or it has been used. Each recovery code works once.",
    errorAr: "رمز الاسترداد غير صحيح أو سبق استخدامه. يُقبل كل رمز استرداد مرة واحدة.",
  },
  alreadyActive: {
    status: 409, code: "mfa_already_active",
    error: "Two-step verification is already on for this account. Replacing it is a reset, done by the platform after verifying your identity.",
    errorAr: "التحقق بخطوتين مفعَّل لهذا الحساب. استبداله إعادة تعيين تجريها المنصة بعد التحقق من هويتك.",
  },
  notEnrolling: {
    status: 409, code: "mfa_not_enrolling",
    error: "There is no set-up in progress. Start the set-up again to get a new key.",
    errorAr: "لا يوجد إعداد قيد التنفيذ. ابدأ الإعداد من جديد للحصول على مفتاح جديد.",
  },
  identityUnverified: {
    status: 422, code: "mfa_reset_identity_unverified",
    error: "A reset needs the person's identity verified first: confirm that it was, and state on what basis.",
    errorAr: "تتطلب إعادة التعيين التحقق من هوية الشخص أولاً: أكّد ذلك واذكر أساس التحقق.",
  },
  resetOwn: {
    status: 409, code: "mfa_reset_own_refused",
    error: "You cannot reset your own two-step verification. Another platform security operator does it.",
    errorAr: "لا يمكنك إعادة تعيين التحقق بخطوتين لحسابك. يجريها مشغّل أمن آخر في المنصة.",
  },
  resetOwnAdmin: {
    status: 409, code: "mfa_reset_own_refused",
    error: "You cannot reset your own two-step verification. Ask another admin of your organization, or the platform when there is no other admin.",
    errorAr: "لا يمكنك إعادة تعيين التحقق بخطوتين لحسابك. اطلب ذلك من مسؤول آخر في منشأتك، أو من المنصة إن لم يوجد مسؤول آخر.",
  },
  adminOnly: {
    status: 403, code: "mfa_reset_admin_only",
    error: "Only an admin of a verified organization can reset a member's two-step verification.",
    errorAr: "لا يعيد تعيين التحقق بخطوتين لعضو إلا مسؤول في منشأة موثّقة.",
  },
  accountShared: {
    status: 409, code: "mfa_reset_account_shared",
    error: "This person's account also belongs to another organization, so its two-step verification cannot be reset from here. The platform resets it, after verifying the person's identity.",
    errorAr: "ينتمي حساب هذا الشخص إلى منشأة أخرى أيضاً، لذا لا يمكن إعادة تعيين التحقق بخطوتين له من هنا. تعيد المنصة تعيينه بعد التحقق من هويته.",
  },
  adminAvailable: {
    status: 409, code: "mfa_reset_admin_available",
    error: "An admin of this person's organization can reset their two-step verification from the Users page. The platform resets it only when no admin of the organization can.",
    errorAr: "يستطيع مسؤول في منشأة هذا الشخص إعادة تعيين التحقق بخطوتين له من صفحة المستخدمين. لا تعيد المنصة تعيينه إلا إذا لم يستطع ذلك أي مسؤول في المنشأة.",
  },
  notSetUp: {
    status: 409, code: "mfa_not_set_up",
    error: "This person has not set up two-step verification, so there is nothing to reset.",
    errorAr: "لم يُعِدّ هذا الشخص التحقق بخطوتين، فلا يوجد ما يُعاد تعيينه.",
  },
  userNotFound: { status: 404, code: "user_not_found", error: "No user with that email.", errorAr: "لا يوجد مستخدم بهذا البريد." },
  /** The admin path names a user by id: one answer for "no such account" and "not yours to see" (no existence leak). */
  memberNotFound: { status: 404, code: "user_not_found", error: "User not found.", errorAr: "لم يُعثر على المستخدم." },
  kmsRefused: {
    status: 503, code: "mfa_key_unavailable",
    error: "Two-step verification is not available right now: its key service could not be reached. Try again shortly, or contact the platform.",
    errorAr: "التحقق بخطوتين غير متاح الآن: تعذّر الوصول إلى خدمة المفاتيح. حاول بعد قليل أو تواصل مع المنصة.",
  },
} as const;

function refuse(r: (typeof MFA_REFUSALS)[keyof typeof MFA_REFUSALS]): never {
  throw new BusinessRuleError(r.status, { code: r.code, error: r.error, errorAr: r.errorAr });
}

/** The organization an act on one's own account is recorded in: the active one, else the only one, else none. */
async function ownOrgOf(actor: MfaActor): Promise<string | null> {
  if (actor.activeOrgId) return actor.activeOrgId;
  const orgs = await membersRepository.activeOrgIds(actor.userId);
  return orgs.length === 1 ? orgs[0]! : null;
}

async function record(action: string, actor: MfaActor, metadata: Record<string, unknown> | null = null): Promise<void> {
  await securityAuditService.record({
    action, actorUserId: actor.userId, actorEmail: actor.email ?? null, targetUserId: actor.userId,
    organizationId: await ownOrgOf(actor), ipAddress: actor.ipAddress ?? null, metadata,
  });
}

/**
 * The configured key wrapper — or the NAMED refusal when it cannot be built (no key configured). Found by CI's browser
 * job: a missing development key surfaced as a bare 500; a person setting up a factor is owed a sentence instead.
 */
function keyWrapperOrRefuse() {
  try {
    return getKeyWrapper();
  } catch (err) {
    logger.error({ err }, "mfa: the key wrapper is not available — secrets cannot be sealed or opened");
    return refuse(MFA_REFUSALS.kmsRefused);
  }
}

/** Unseal a factor's secret — in memory only, for the length of one check. */
async function secretOf(factor: NonNullable<Awaited<ReturnType<typeof mfaRepository.factorOf>>>): Promise<Buffer> {
  const wrapper = keyWrapperOrRefuse();
  // the vault's own rule (signing.service): a development-wrapped row is never trusted in production, and a row
  // wrapped by another provider is not unwrapped by this one
  if ((loadEnv().NODE_ENV === "production" && factor.kmsProvider === "local-dev") || factor.kmsProvider !== wrapper.provider) refuse(MFA_REFUSALS.kmsRefused);
  const dataKey = await wrapper.unwrap(factor.wrappedDataKey);
  try {
    return openWithDataKey({ ciphertext: factor.encryptedSecret, iv: factor.secretIv, authTag: factor.secretAuthTag }, dataKey);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * 🔴 THE ONE DEFINITION of "this admin may reset this account's factor" — the admin path acts on it, and the operator
 * path refuses while it holds for ANY usable admin, so the two can never disagree into a person nobody may reset.
 * Returns the organizations the admin administers; throws the named refusal otherwise.
 */
async function adminResetScope(adminUserId: number, targetUserId: number, actor?: MfaActor): Promise<string[]> {
  if (targetUserId === adminUserId) refuse(MFA_REFUSALS.resetOwnAdmin);
  const orgIds = await userAdminRepository.administeredOrgIds(adminUserId);
  if (orgIds.length === 0) refuse(MFA_REFUSALS.adminOnly);
  if (!(await userAdminRepository.isMemberOfAny(targetUserId, orgIds))) refuse(MFA_REFUSALS.memberNotFound);
  try {
    // F1: a factor is account-wide, so its reset is the account-wide act confinement governs
    await assertAccountConfinedTo(targetUserId, orgIds, "explain", actor && {
      actorUserId: actor.userId, actorEmail: actor.email, ipAddress: actor.ipAddress, attempted: "mfa.reset",
    });
  } catch (err) {
    if (err instanceof ConflictError) refuse(MFA_REFUSALS.accountShared);
    if (err instanceof NotFoundError) refuse(MFA_REFUSALS.memberNotFound);
    throw err;
  }
  return orgIds;
}

/** Can any usable admin reset this account's factor? (Any other failure propagates: the operator path fails closed.) */
async function anAdminCanReset(targetUserId: number): Promise<boolean> {
  for (const adminUserId of await membersRepository.usableAdminIdsAround(targetUserId)) {
    try {
      await adminResetScope(adminUserId, targetUserId);
      return true;
    } catch (err) {
      if (!(err instanceof BusinessRuleError)) throw err;
    }
  }
  return false;
}

/** The reset's effects, whoever resets: the factor and every recovery code go, and every session of the account ends. */
async function removeFactorAndEndSessions(targetUserId: number, endedBy: "ended_by_admin" | "ended_by_operator", actorUserId: number) {
  const removed = await mfaRepository.removeAll(targetUserId);
  // every session of the account ends: its records (the guarantee, at the next request) and its rows (hygiene)
  const ended = await sessionRecordsRepository.end((await sessionRecordsRepository.activeForUser(targetUserId)).map((r) => r.id), endedBy, actorUserId);
  await userAdminRepository.revokeSessions(targetUserId);
  return { hadFactor: removed.hadFactor, sessionsEnded: ended.length, recoveryCodesInvalidated: removed.recoveryCodesInvalidated };
}

/** The person is told: by email when a provider is configured, and always in the app at their next sign-in. */
async function tellThePerson(email: string, by: "admin" | "platform"): Promise<"email_and_next_sign_in" | "next_sign_in"> {
  const [who, whoAr] = by === "admin"
    ? ["An admin of your organization reset the two-step verification on your account.", "أعاد مسؤول في منشأتك تعيين التحقق بخطوتين لحسابك."]
    : ["The platform reset the two-step verification on your account after verifying your identity.", "أعادت المنصة تعيين التحقق بخطوتين لحسابك بعد التحقق من هويتك."];
  const mail = await mailer.send({
    to: email,
    subject: "Your two-step verification was reset | أُعيد تعيين التحقق بخطوتين لحسابك",
    text:
      `${who} Every session was signed out and your recovery codes no longer work. ` +
      "Set it up again from the Security menu; if your role requires it, you will be asked at your next sign-in. If you did not ask for this, contact the platform immediately.\n\n" +
      `${whoAr} أُنهيت جميع الجلسات ولم تعد رموز الاسترداد صالحة. ` +
      "أعِدّه من جديد من قائمة الأمان؛ وإن كان دورك يتطلبه فسيُطلب منك عند دخولك التالي. إن لم تطلب ذلك فتواصل مع المنصة فوراً.",
  });
  return mail.delivered ? "email_and_next_sign_in" : "next_sign_in";
}

function newRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const part = () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${part()}-${part()}`;
}

export const mfaService = {
  /** Must this account hold a second factor? Operators and active org admins, when enforcement is `required`. */
  async isRequiredFor(userId: number): Promise<boolean> {
    // 🔴 Phase 19A (19.7): an organization that requires two-step verification for EVERYONE has said so itself — that
    // binds its members under either enforcement value (the setting below relaxes only the platform's role mandate).
    if (await securitySettingsRepository.mfaRequiredForAllOf(userId)) return true;
    if (loadEnv().MFA_ENFORCEMENT !== "required") return false;
    return (await operatorsRepository.isOperator(userId)) || (await mfaRepository.isAdminAnywhere(userId));
  },

  /** 🔴 What a session just opened by a PASSWORD (or a break-glass password) still owes — asked at every sign-in. */
  async stepAfterPassword(userId: number): Promise<MfaStep | null> {
    if (await mfaRepository.hasActiveFactor(userId)) return "code";
    return (await this.isRequiredFor(userId)) ? "enrol" : null;
  },

  async status(actor: MfaActor, step: MfaStep | null) {
    const factor = await mfaRepository.factorOf(actor.userId);
    const lastReset = await mfaRepository.lastReset(actor.userId);
    return {
      required: await this.isRequiredFor(actor.userId),
      state: (factor?.state ?? "none") as "none" | "pending" | "active",
      step,
      recoveryCodesLeft: factor?.state === "active" ? (await mfaRepository.unusedRecoveryCodes(actor.userId)).length : 0,
      activatedAt: factor?.activatedAt?.toISOString() ?? null,
      lastResetAt: lastReset?.at.toISOString() ?? null,
      lastResetBy: lastReset?.by ?? null,
    };
  },

  /** Start (or restart) enrolment: a new sealed secret, returned ONCE with its QR. Never over an active factor. */
  async beginEnrolment(actor: MfaActor) {
    if (await mfaRepository.hasActiveFactor(actor.userId)) refuse(MFA_REFUSALS.alreadyActive);
    const wrapper = keyWrapperOrRefuse();
    const secret = generateTotpSecret();
    const dataKey = generateDataKey();
    try {
      const sealed = sealWithDataKey(secret, dataKey);
      await mfaRepository.putPending(actor.userId, {
        kmsProvider: wrapper.provider, kmsKeyId: wrapper.keyId, wrappedDataKey: await wrapper.wrap(dataKey),
        encryptedSecret: sealed.ciphertext, secretIv: sealed.iv, secretAuthTag: sealed.authTag,
      });
    } finally {
      dataKey.fill(0);
    }
    const uri = otpauthUri({ issuer: MFA_ISSUER, account: actor.email ?? `user-${actor.userId}`, secret });
    const out = { secret: base32Encode(secret), otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: "svg", margin: 1 }) };
    secret.fill(0);
    await record("mfa.enrolled", actor);
    return out;
  },

  /** Activate the pending factor with ONE correct code; issue the recovery codes, shown once. */
  async activate(actor: MfaActor, code: unknown) {
    const factor = await mfaRepository.factorOf(actor.userId);
    if (!factor) refuse(MFA_REFUSALS.notEnrolling);
    if (factor.state === "active") refuse(MFA_REFUSALS.alreadyActive);
    const secret = await secretOf(factor);
    const step = matchTotp(secret, code);
    secret.fill(0);
    if (step === null || !(await mfaRepository.takeStep(actor.userId, step, true))) {
      await record("mfa.failed", actor, { at: "activation" });
      refuse(MFA_REFUSALS.codeInvalid);
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await mfaRepository.replaceRecoveryCodes(actor.userId, await Promise.all(codes.map((c) => hashPassword(c, "recoveryCode"))));
    await record("mfa.activated", actor);
    return { recoveryCodes: codes };
  },

  /** The code step of a sign-in. Throws the named refusal on a wrong or used code. */
  async verify(actor: MfaActor, code: unknown): Promise<void> {
    const factor = await mfaRepository.factorOf(actor.userId);
    if (!factor || factor.state !== "active") refuse(MFA_REFUSALS.codeInvalid);
    const secret = await secretOf(factor);
    const step = matchTotp(secret, code);
    secret.fill(0);
    if (step === null || !(await mfaRepository.takeStep(actor.userId, step, false))) {
      await record("mfa.failed", actor, { at: "sign_in" });
      refuse(MFA_REFUSALS.codeInvalid);
    }
    await record("mfa.verified", actor);
  },

  /** A recovery code in place of the code: consumed by the call that accepts it. */
  async useRecoveryCode(actor: MfaActor, code: unknown): Promise<{ recoveryCodesLeft: number }> {
    const given = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(given) || !(await mfaRepository.hasActiveFactor(actor.userId))) {
      await record("mfa.failed", actor, { at: "recovery" });
      refuse(MFA_REFUSALS.recoveryInvalid);
    }
    const unused = await mfaRepository.unusedRecoveryCodes(actor.userId);
    let taken = false;
    for (const row of unused) {
      if (await verifyPassword(given, row.codeHash)) { taken = await mfaRepository.useRecoveryCode(row.id); break; }
    }
    if (!taken) {
      await record("mfa.failed", actor, { at: "recovery" });
      refuse(MFA_REFUSALS.recoveryInvalid);
    }
    const left = unused.length - 1;
    await record("mfa.recovery_code_used", actor, { recoveryCodesLeft: left });
    return { recoveryCodesLeft: left };
  },

  /**
   * 🔴 THE ADMIN'S RESET (owner, 2026-11-20) — POST /auth/users/:id/mfa-reset: an admin of a verified organization resets
   * another member's factor. Out of scope reads as no such user; an account that also belongs elsewhere is refused by
   * name (the platform resets it). Recorded once in each of the member's organizations, the admin named.
   */
  async adminReset(admin: MfaActor, targetUserId: number) {
    const orgIds = await adminResetScope(admin.userId, targetUserId, admin);
    if (!(await mfaRepository.hasActiveFactor(targetUserId))) refuse(MFA_REFUSALS.notSetUp);
    const target = await userAdminRepository.findById(targetUserId);
    if (!target) refuse(MFA_REFUSALS.memberNotFound);
    const effects = await removeFactorAndEndSessions(targetUserId, "ended_by_admin", admin.userId);
    const shared = (await membersRepository.activeOrgIds(targetUserId)).filter((o) => orgIds.includes(o)).sort();
    for (const organizationId of shared.length > 0 ? shared : [null]) {
      await securityAuditService.record({
        action: "mfa.reset", actorUserId: admin.userId, actorEmail: admin.email ?? null, targetUserId, organizationId,
        ipAddress: admin.ipAddress ?? null, metadata: { by: "admin", ...effects },
      });
    }
    return {
      sessionsEnded: effects.sessionsEnded,
      recoveryCodesInvalidated: effects.recoveryCodesInvalidated,
      notified: await tellThePerson(target.email, "admin"),
    };
  },

  /**
   * 🔴 THE PLATFORM'S RESET — the break-glass of a second factor, on the operator surface: only when NO admin can reset
   * it (a sole admin, an account that also belongs elsewhere, an organization not yet verified). The operator states
   * that the person's identity was verified and on what basis; both are recorded.
   */
  async operatorReset(operator: MfaActor, input: { email?: unknown; identityVerified?: unknown; basis?: unknown }) {
    const email = String(input.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@") || email.length > 320 || hasNul(email)) throw new BadRequestError("A user email is required.");
    const basis = typeof input.basis === "string" ? input.basis.trim() : "";
    if (input.identityVerified !== true || basis.length < 10 || basis.length > 500 || hasNul(basis)) refuse(MFA_REFUSALS.identityUnverified);
    const target = await userAdminRepository.findByEmail(email);
    if (!target) refuse(MFA_REFUSALS.userNotFound);
    if (target.id === operator.userId) refuse(MFA_REFUSALS.resetOwn);
    if (await anAdminCanReset(target.id)) refuse(MFA_REFUSALS.adminAvailable);
    if (!(await mfaRepository.hasActiveFactor(target.id))) refuse(MFA_REFUSALS.notSetUp);

    const effects = await removeFactorAndEndSessions(target.id, "ended_by_operator", operator.userId);
    const metadata = { by: "platform_operator", identityVerified: true, basis, ...effects };
    // the operator-identified record carries no organization (operators belong to none) …
    await securityAuditService.record({
      action: "mfa.reset", actorUserId: operator.userId, actorEmail: operator.email ?? null, targetUserId: target.id,
      ipAddress: operator.ipAddress ?? null, metadata,
    });
    // … and each organization the account is an active member of sees that it happened, the operator redacted
    // (the break-glass reset's pattern, DR-27/G51)
    for (const organizationId of await membersRepository.activeOrgIds(target.id)) {
      await securityAuditService.record({
        action: "mfa.reset", actorUserId: null, actorEmail: null, targetUserId: target.id, organizationId,
        metadata: { by: "platform_operator", sessionsEnded: effects.sessionsEnded },
      });
    }
    return {
      sessionsEnded: effects.sessionsEnded,
      recoveryCodesInvalidated: effects.recoveryCodesInvalidated,
      // the truth about the notice: by email when a provider is configured; always in the app at the next sign-in
      notified: await tellThePerson(target.email, "platform"),
    };
  },
};
