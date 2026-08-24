/**
 * The audit's LOW close-out (2026-08-24) — the small findings, each pinned:
 *   - a CSID-bearing ZATCA response body is SANITIZED before it can reach a
 *     log line (secret-shaped keys redacted, the diagnosis kept);
 *   - Postgres 22001 (varchar overflow) maps to a 400 at the ONE boundary
 *     every path shares — the class fix, not seven per-service guards;
 *   - M-3: the signup email race maps the unique-index verdict to the same
 *     409 the pre-check gives, keyed on the CONSTRAINT so an organization
 *     slug collision is not mislabeled as a duplicate email.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { sanitizeBody } from "../services/einvoice/onboarding/zatcaOnboardingClient";
import { errorHandler } from "../middleware/errorHandler";
import { signupService } from "../services/signup.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[audit-low-closeout] no real DATABASE_URL — skipping DB half.");

describe("sanitizeBody — a secret never reaches a loggable error", () => {
  it("redacts secret-shaped keys at any depth and keeps the diagnosis", () => {
    const body = {
      requestID: "12345",
      dispositionMessage: "ISSUED",
      secret: "s3cr3t-value",
      binarySecurityToken: "dG9rZW4=",
      nested: { errors: [{ message: "bad CSR" }], authorization: "Basic abc" },
    };
    const clean = sanitizeBody(body) as Record<string, any>;
    expect(clean.secret).toBe("[REDACTED]");
    expect(clean.binarySecurityToken).toBe("[REDACTED]");
    expect(clean.nested.authorization).toBe("[REDACTED]");
    // The parts an operator diagnoses from survive untouched.
    expect(clean.dispositionMessage).toBe("ISSUED");
    expect(clean.nested.errors[0].message).toBe("bad CSR");
    expect(JSON.stringify(clean)).not.toContain("s3cr3t-value");
  });

  it("passes primitives and null through", () => {
    expect(sanitizeBody("plain text")).toBe("plain text");
    expect(sanitizeBody(null)).toBeNull();
  });
});

describe("errorHandler — 22001 is a 400, not a raw 500 (the class fix)", () => {
  const run = (err: unknown) => {
    let status = 0;
    let body: unknown;
    const res = {
      headersSent: false,
      status(s: number) {
        status = s;
        return this;
      },
      json(b: unknown) {
        body = b;
      },
    };
    const req = { log: { error() {}, warn() {} } };
    errorHandler(err, req as never, res as never, (() => {}) as never);
    return { status, body };
  };

  it("maps varchar overflow to a named 400", () => {
    const { status, body } = run(Object.assign(new Error("value too long"), { code: "22001" }));
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringContaining("maximum allowed length") });
  });

  it("an unknown error still becomes the generic 500 wall — the mapping narrows nothing else", () => {
    const { status } = run(new Error("boom"));
    expect(status).toBe(500);
  });
});

const EMAIL = "m3-race@test.local";
const SLUGBASE = "M3 Race Org";

describeMaybe("M-3 — the signup email race resolves to 409, decided by the unique index", () => {
  const cleanup = async () => {
    await pool.query(
      `DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`,
    );
    await pool.query(
      `DELETE FROM security_audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')
        OR target_user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`,
    );
    const orgs = `(SELECT id FROM organizations WHERE name LIKE '${SLUGBASE}%')`;
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${orgs}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${orgs}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM organizations WHERE name LIKE '${SLUGBASE}%'`);
  };

  beforeAll(cleanup);
  afterAll(cleanup);

  it("🔴 two concurrent signups with one email: exactly one account, the loser gets 409 — never a raw 500", async () => {
    const attempt = (n: number) =>
      signupService.signup(
        {
          email: EMAIL,
          name: "Racer",
          password: "correct-horse-battery-staple-9!",
          organizationName: `${SLUGBASE} ${n}`,
          companyName: "Race Co",
          crNumber: "1010101099",
          vatNumber: "",
        } as never,
        { ipAddress: null } as never,
      );
    const results = await Promise.allSettled([attempt(1), attempt(2)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 🔴 The verdict that matters: a 409 with the same message as the
    // pre-check — not a 500, and not a slug-collision mislabel.
    expect((rejected[0].reason as { statusCode?: number }).statusCode).toBe(409);
    expect(String(rejected[0].reason)).toContain("email already exists");

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE email = '${EMAIL}'`);
    expect(rows[0].n).toBe(1);
  });
});
