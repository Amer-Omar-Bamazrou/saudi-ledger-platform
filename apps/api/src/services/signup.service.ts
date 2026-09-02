/**
 * Signup service (M11.5) — public self-service organization registration.
 *
 * Creates the whole tenant in one atomic transaction (org + company + admin user
 * + admin membership) with the organization in `pending_review`, so the new
 * account can log in and see its status page but — per the M11.2 gate — cannot
 * touch any business route until a platform operator approves it.
 *
 * Identity layer: runs before `resolveTenant` on the base connection, and is the
 * only PUBLIC (unauthenticated) write in the platform, so it is rate-limited at
 * the route and validated strictly here.
 */
import { assertFitsColumn, assertPasswordAcceptable, hashPassword, MAX_VARCHAR } from "../lib/password";
import { BadRequestError, ConflictError } from "../lib/errors";
import { signupRepository } from "../repositories/signup.repository";
import { securityAuditService } from "./securityAudit.service";


// Saudi VAT registration: 15 digits, starts and ends with 3. CR: 10 digits.
const VAT_RE = /^3\d{13}3$/;
const CR_RE = /^\d{10}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export interface SignupInput {
  email?: unknown;
  name?: unknown;
  password?: unknown;
  organizationName?: unknown;
  companyName?: unknown;
  crNumber?: unknown;
  vatNumber?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export const signupService = {
  /**
   * Validate + create the tenant. Returns the identity to log in with.
   * Duplicate email → 409; invalid input → 400.
   */
  async signup(input: SignupInput, ctx: { ipAddress?: string | null } = {}) {
    const email = str(input.email).toLowerCase();
    const name = str(input.name);
    const password = typeof input.password === "string" ? input.password : "";
    const organizationName = str(input.organizationName);
    // A single-company signup: default the company name to the organization name.
    const companyName = str(input.companyName) || organizationName;
    const crNumber = str(input.crNumber);
    const vatNumber = str(input.vatNumber);

    if (!email || !EMAIL_RE.test(email)) throw new BadRequestError("A valid email is required.");
    if (!name) throw new BadRequestError("Your full name is required.");
    assertPasswordAcceptable(password);
    /**
     * 🔴 These three land in `varchar(255)` columns (`organizations.name`,
     * `organizations.slug`, `companies.name`). Unvalidated, an over-long value
     * reached Postgres and came back as a 22001 — a 500 for what is plainly a
     * 400 the user can fix. This is M-4's second half, and it is checked on the
     * PUBLIC path where the caller is unauthenticated.
     */
    assertFitsColumn(organizationName, "organizationName", MAX_VARCHAR);
    assertFitsColumn(companyName, "companyName", MAX_VARCHAR);
    assertFitsColumn(name, "name", MAX_VARCHAR);
    if (!organizationName) throw new BadRequestError("Organization name is required.");
    // CR/VAT are collected at signup for the operator to verify. CR is required
    // (it identifies the business); VAT is optional (not every entity is
    // VAT-registered). Both are format-checked when present.
    if (!CR_RE.test(crNumber)) {
      throw new BadRequestError("Commercial Registration (CR) number must be 10 digits.");
    }
    if (vatNumber && !VAT_RE.test(vatNumber)) {
      throw new BadRequestError("VAT registration number must be 15 digits, starting and ending with 3.");
    }

    if (await signupRepository.emailExists(email)) {
      throw new ConflictError("An account with this email already exists.");
    }

    const passwordHash = await hashPassword(password);
    let created;
    try {
      created = await signupRepository.createTenant({
        email,
        name,
        passwordHash,
        organizationName,
        companyName,
        crNumber,
        vatNumber: vatNumber || null,
      });
    } catch (err) {
      // M-3 (audit, closed 2026-08-24): the emailExists pre-check above has a
      // RACE — two concurrent signups both pass it and the loser hits the
      // unique index as a raw 23505 500. The unique index is the real
      // arbiter; its verdict maps to the same 409 the pre-check gives.
      // Keyed on the CONSTRAINT, not the code alone: createTenant also
      // inserts the organization, whose slug collision must not be
      // mislabeled as a duplicate email. Drizzle WRAPS the driver error
      // ("Failed query: …") with the pg error as `cause`, so unwrap first.
      const unwrap = (e: unknown): { code?: string; constraint?: string } => {
        let cur = e as { code?: string; constraint?: string; cause?: unknown };
        for (let i = 0; i < 4 && cur && cur.code === undefined && cur.cause; i++) {
          cur = cur.cause as typeof cur;
        }
        return cur ?? {};
      };
      const pg = unwrap(err);
      if (pg?.code === "23505" && pg.constraint === "users_email_unique") {
        throw new ConflictError("An account with this email already exists.");
      }
      if (pg?.code === "23505" && pg.constraint === "organizations_slug_unique") {
        throw new ConflictError("An organization with this name already exists — choose a different organization name.");
      }
      throw err;
    }

    await securityAuditService.record({
      action: "signup.completed",
      actorUserId: created.userId,
      actorEmail: email,
      organizationId: created.organizationId,
      targetUserId: created.userId,
      metadata: { organizationName, companyName, crNumber, vatNumber: vatNumber || null },
      ipAddress: ctx.ipAddress,
    });

    // `role` here is the GLOBAL (vestigial) users.role — non-privileged by
    // design (see signup.repository). The new user's admin authority lives in
    // their organization membership, not this value.
    return { ...created, email, name, role: "viewer" as const };
  },
};
