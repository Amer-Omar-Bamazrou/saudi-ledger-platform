/**
 * Auth middleware — requireAuth and requireRole guards.
 * Also exports session type augmentation so TypeScript knows req.session.userId etc.
 */
import type { Request, Response, NextFunction } from "express";
import { createHmac } from "node:crypto";
import { loadEnv } from "@workspace/config";
import { userAdminRepository } from "../repositories/userAdmin.repository";
import { sessionRecordsRepository } from "../repositories/sessionRecords.repository";
import { describeClient } from "./sessionClient";
import { MFA_REFUSALS, mfaService, type MfaStep } from "../services/mfa.service";

export type UserRole = "admin" | "accountant" | "bookkeeper" | "viewer";

declare module "express-session" {
  interface SessionData {
    userId: number;
    userRole: UserRole;
    userName: string;
    userEmail: string;
    /** The organization the user is currently acting in (set by the org switcher). */
    activeOrgId: string;
    /** G02: when the user signed in (epoch ms) — the absolute lifetime counts from here, whatever the activity. */
    authenticatedAt: number;
    /** G02: the credential this session was issued for — a keyed fingerprint of the stored password hash. */
    credential: string;
    /** 🔴 Phase 19A (19.4/19.5): this session's record — what the person sees and ends. Never the session id itself. */
    sessionRecordId: string;
    /**
     * 🔴 Phase 19A (19.1/19.2): what this session still owes after its password — the code of an enrolled factor, or
     * enrolment where the role requires one. ABSENT on a whole session. Set at every sign-in, cleared only by the
     * step itself (which rotates the session id).
     */
    mfaStep?: MfaStep;
  }
}

/**
 * 🔴 G02 — the ABSOLUTE session lifetime: 12 hours from sign-in (owner decision
 * DR-07(a), Phase 18 authorisation §2.10, 2026-10-20). The cookie's rolling
 * 8-hour max-age (app.ts) stays as the IDLE limit; this one does not roll.
 */
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** A keyed fingerprint of a stored password hash: it changes whenever the password does, and reveals nothing about it. */
export function credentialOf(passwordHash: string): string {
  return createHmac("sha256", loadEnv().SESSION_SECRET).update(passwordHash).digest("base64url");
}

/**
 * G02: what every session is born with — read from the account as stored, so a
 * login that re-hashes the password (M-4) stamps the hash it just wrote. Called
 * at each place a session is created: login, signup, invitation acceptance.
 */
export async function sessionStampFor(
  userId: number,
  opened: { kind: "sign_in" | "signup" | "invitation"; req: Request },
): Promise<{ authenticatedAt: number; credential: string; sessionRecordId: string; mfaStep?: MfaStep }> {
  const account = await userAdminRepository.sessionAccount(userId);
  if (!account) throw new Error(`sessionStampFor: no account ${userId}`);
  // 🔴 Phase 19A (19.4): one record per sign-in — the sign-in IP and a coarse client description, never the user-agent
  const sessionRecordId = await sessionRecordsRepository.create({
    userId, kind: opened.kind, ipAddress: opened.req.ip ?? null, client: describeClient(opened.req.get("user-agent")),
  });
  // 🔴 Phase 19A (19.2): a password — an operator's break-glass password included — satisfies the PASSWORD step only.
  // Asked here, at the one place every session is born, so no way of signing in can leave it out.
  const mfaStep = await mfaService.stepAfterPassword(userId);
  return { authenticatedAt: Date.now(), credential: credentialOf(account.passwordHash), sessionRecordId, ...(mfaStep ? { mfaStep } : {}) };
}

/**
 * 19.4: how often a session's "last seen" is written — at most once in this window, not on every request. One minute,
 * because 19.7's idle timeout is measured from it and the shortest idle timeout an organization may set is 15 minutes.
 */
export const SESSION_LAST_SEEN_RESOLUTION_MS = 60 * 1000;

/**
 * 🔴 G02 — A SESSION ENDS WHEN WHAT IT WAS ISSUED FOR ENDS (owner D-4: sessions
 * end on deactivation, an admin's password reset and a password change; 12-hour
 * absolute lifetime). Mounted once, right after the session middleware, so
 * every guard downstream (`requireAuth`, `resolveTenant`,
 * `requirePlatformOperator`, the routes that read `req.session` themselves)
 * sees a session only while it is still good — one seam instead of one check
 * per guard.
 *
 * The check is made on every request against the account as stored, so it does
 * not depend on the `user_sessions` rows having been deleted (they are, too —
 * userAdmin.service and change-password): an in-flight request that writes its
 * session back after the deletion cannot resurrect it. A session ends when
 *   - it is older than SESSION_ABSOLUTE_LIFETIME_MS, or carries no sign-in time
 *     (a session from before this check: it fails closed, once);
 *   - its account no longer exists or is inactive;
 *   - its credential is not the stored password's (changed or reset since).
 * An ended session is replaced by an empty one (`regenerate`: the old row is
 * destroyed and the id rotated), so the request continues as anonymous and
 * whatever guard it meets answers 401 — the same answer as a logged-out user.
 */
export async function endEndedSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  const s = req.session;
  if (!s?.userId) return next();
  let ended = !s.authenticatedAt || !s.credential || Date.now() - s.authenticatedAt >= SESSION_ABSOLUTE_LIFETIME_MS;
  if (!ended) {
    const account = await userAdminRepository.sessionAccount(s.userId);
    ended = !account || !account.isActive || credentialOf(account.passwordHash) !== s.credential;
    // H-15: read from the row this check already reads — no second query (refuseUntilPasswordChanged)
    res.locals.passwordChangeRequired = account?.passwordChangeRequired === true;
    // R-1 (DR-27, 24 hours): from the same row — whether the break-glass window the session was opened in has passed
    res.locals.breakGlassExpired = !!account?.breakGlassExpiresAt && account.breakGlassExpiresAt.getTime() <= Date.now();
  }
  if (!ended) {
    // 🔴 Phase 19A (19.5): a session whose RECORD has ended (by its owner, an admin or an operator) ends here, on its
    // next request — and one that carries no record (opened before records existed) fails closed, once.
    const recordId = s.sessionRecordId;
    const record = recordId ? await sessionRecordsRepository.openRecord(recordId, s.userId) : undefined;
    ended = !record;
    // 🔴 Phase 19A (19.7): the organization's own figures — never looser than the platform's (the 12-hour check above
    // and the cookie's 8-hour idle limit stay) — end the session here: its lifetime from sign-in, its idle time from
    // the record's last-seen.
    if (record && (Date.now() - s.authenticatedAt! >= record.lifetimeHours * 60 * 60 * 1000
                || Date.now() - record.lastSeenAt.getTime() >= record.idleMinutes * 60 * 1000)) {
      ended = true;
    }
    if (!ended && record && Date.now() - record.lastSeenAt.getTime() >= SESSION_LAST_SEEN_RESOLUTION_MS) {
      sessionRecordsRepository.touch(recordId!).catch((err) => req.log?.warn({ err }, "session last-seen not written"));
    }
  }
  if (!ended) return next();
  s.regenerate((err) => next(err));
}

/** The only routes a session that owes its CODE reaches (19.2). */
const WHILE_THE_CODE_IS_OWED = new Set(["/auth/me", "/auth/logout", "/auth/login", "/auth/mfa", "/auth/mfa/verify", "/auth/mfa/recovery"]);
/** The only routes a session that owes ENROLMENT reaches (19.1). */
const WHILE_ENROLMENT_IS_OWED = new Set(["/auth/me", "/auth/logout", "/auth/login", "/auth/mfa", "/auth/mfa/enrol", "/auth/mfa/activate"]);

/**
 * 🔴 Phase 19A (19.1/19.2) — a session that owes its second factor reaches NOTHING but the step it owes. Mounted
 * before every router but the public ones, and BEFORE the password-change gate: a break-glass password opens a
 * session that owes the code first, then the change. A refusal naming the next step, never a hidden control.
 */
export function refuseUntilSecondFactor(req: Request, res: Response, next: NextFunction): void {
  const step = req.session?.userId ? req.session.mfaStep : undefined;
  if (!step) return next();
  const allowed = step === "code" ? WHILE_THE_CODE_IS_OWED : WHILE_ENROLMENT_IS_OWED;
  if (allowed.has(req.path)) return next();
  const r = step === "code" ? MFA_REFUSALS.codeRequired : MFA_REFUSALS.enrolmentRequired;
  res.status(r.status).json({ code: r.code, error: r.error, errorAr: r.errorAr });
}

/**
 * 🔴 Phase 19A (19.2): the second factor is satisfied — the session id ROTATES (the half-authenticated id is never
 * the whole session's id) and the owed step is gone. Everything else the session carried is kept.
 */
export function completeSecondFactor(req: Request): Promise<void> {
  const { cookie: _cookie, mfaStep: _step, ...kept } = req.session as unknown as Record<string, unknown>;
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenErr) => {
      if (regenErr) return reject(regenErr);
      Object.assign(req.session, kept);
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

/** The only routes a session that owes a change of password reaches (H-15). */
const WHILE_A_CHANGE_IS_OWED = new Set(["/auth/me", "/auth/logout", "/auth/change-password", "/auth/login"]);
/** The only routes a session whose break-glass window has passed reaches (R-1): not the change. */
const WHILE_EXPIRED = new Set(["/auth/me", "/auth/logout", "/auth/login"]);

/**
 * 🔴 Phase 18 H-15 — DR-06 part 1 and DR-27 (register §11.66): a session whose
 * account's password was set by someone else (an admin's create or reset, an
 * operator's break-glass) reaches only the way to change it. Mounted BEFORE
 * `/auth`, so the admin acts on users under it are held too — an admin given a
 * password by a colleague cannot administer anyone with it. A refusal, naming
 * the next step, never a hidden control.
 */
export function refuseUntilPasswordChanged(req: Request, res: Response, next: NextFunction): void {
  // 🔴 R-1 (DR-27, 24 hours; register §11.83): a session opened inside a break-glass window reaches nothing but the
  // way out once it has passed — the change included: an expired temporary password cannot be a change's "current
  // password". Only a new reset from the platform answers it.
  if (req.session?.userId && res.locals.breakGlassExpired === true && !WHILE_EXPIRED.has(req.path)) {
    res.status(403).json({
      code: "break_glass_expired",
      error: "The temporary password has expired (it was usable for 24 hours). Sign out and ask the platform for a new reset.",
      errorAr: "انتهت صلاحية كلمة المرور المؤقتة (كانت صالحة 24 ساعة). سجّل الخروج واطلب من المنصة إعادة تعيين جديدة.",
    });
    return;
  }
  // 🔴 Phase 19A (19.2): a session that still owes its second factor is already confined to that step by
  // refuseUntilSecondFactor, mounted before this — and the step must be reachable: after a break-glass password the
  // order is the CODE first, then the change (found by phase19a-mfa.test.ts: this gate refused the code step itself).
  if (req.session?.mfaStep) return next();
  if (req.session?.userId && res.locals.passwordChangeRequired === true && !WHILE_A_CHANGE_IS_OWED.has(req.path)) {
    res.status(403).json({
      code: "password_change_required",
      error: "Your password was set by someone else. Choose your own password (Change password) before continuing.",
    });
    return;
  }
  next();
}

/** Requires a valid session. Returns 401 if not authenticated. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Authentication required. Please log in." });
    return;
  }
  next();
}

/**
 * REMOVED in M11.5.1 (security hotfix): `requireRole` / `requireAdmin` /
 * `requireAccountantOrAbove`.
 *
 * These authorized off the ambient GLOBAL `req.session.userRole` (derived from
 * the vestigial `users.role` column) with no tenant scoping. They guarded the
 * `/auth` user-administration surface, which meant:
 *   - once the public M11.5 signup made `users.role = "admin"` self-grantable,
 *     ANY anonymous caller could reach those endpoints; and
 *   - even for a legitimate admin the endpoints were cross-tenant (an admin of
 *     org A could enumerate and reset the password of org B's users).
 *
 * They are deleted rather than deprecated so the pattern cannot be reintroduced
 * by autocomplete. Authorize instead with one of:
 *   - `requirePermission(resource)`      — tenant-scoped business routes (M5),
 *                                          reads `req.tenant.role`;
 *   - explicit admin-of-THAT-org checks  — identity layer (M10.6 members,
 *                                          M11.5.1 userAdmin.service);
 *   - `requirePlatformOperator`          — cross-tenant operator surface (M11.3).
 */

/**
 * Like {@link requireRole} but reads the role from the resolved tenant context
 * (the active organization membership) rather than the session. Must run after
 * `resolveTenant`. This is the tenant-scoped authorization seam for business
 * routes; global user-management still uses the session-based guards above.
 */
export function requireTenantRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.tenant?.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${roles.join(" or ")}. Your role: ${role ?? "none"}.`,
      });
      return;
    }
    next();
  };
}
