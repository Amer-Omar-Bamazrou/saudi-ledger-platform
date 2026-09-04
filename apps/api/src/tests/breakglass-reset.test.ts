/**
 * §5 RANK 1 — THE BREAK-GLASS PASSWORD RESET (owner decision 2026-09-04:
 * operator reset now, self-service email reset when the mail provider lands).
 *
 * The capability under test is the F1-shaped one the 2026-08-30 options
 * record warns about, so the suite asserts the MITIGATIONS, not just the
 * happy path:
 *
 *   - the temporary password VERIFIES through the one seam and the old one
 *     stops verifying — presence AND absence, and the figure moves;
 *   - every live session of the target dies IN THE SAME ACT;
 *   - 🔴 an operator target is REFUSED, and the refusal itself is audited —
 *     a power being probed is a fact the trail must carry;
 *   - the audit rows carry actor + target and NO password material.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { operatorService } from "../services/operator.service";
import { verifyPassword, hashPassword } from "../lib/password";
import { ForbiddenError } from "../lib/errors";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[breakglass-reset] no real DATABASE_URL — skipping.");

const TARGET_EMAIL = "bg-target@test.local";
const OPERATOR_EMAIL = "bg-operator@test.local";
const OLD_PASSWORD = "old-password-123";

describeMaybe("break-glass password reset", () => {
  let targetId = 0;
  let operatorId = 0;

  const cleanup = async () => {
    await pool.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN (SELECT id FROM users WHERE email IN ($1, $2))`, [TARGET_EMAIL, OPERATOR_EMAIL]);
    await pool.query(`DELETE FROM security_audit_logs WHERE actor_email IN ($1, $2) OR target_user_id IN (SELECT id FROM users WHERE email IN ($1, $2))`, [TARGET_EMAIL, OPERATOR_EMAIL]);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN (SELECT id FROM users WHERE email IN ($1, $2))`, [TARGET_EMAIL, OPERATOR_EMAIL]);
    await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [TARGET_EMAIL, OPERATOR_EMAIL]);
  };

  beforeAll(async () => {
    await cleanup();
    const hash = await hashPassword(OLD_PASSWORD);
    targetId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'BG Target',$2,'user',true) RETURNING id`,
        [TARGET_EMAIL, hash],
      )
    ).rows[0].id;
    operatorId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'BG Operator',$2,'user',true) RETURNING id`,
        [OPERATOR_EMAIL, hash],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [operatorId]);
    // Two live sessions for the target — both must die with the reset.
    await pool.query(
      `INSERT INTO user_sessions (sid, sess, expire) VALUES
         ('bg-sess-1', $1::json, now() + interval '1 day'),
         ('bg-sess-2', $1::json, now() + interval '1 day')`,
      [JSON.stringify({ userId: targetId, cookie: {} })],
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it("🔴 resets to a generated password that verifies; the old one stops verifying; sessions die in the same act", async () => {
    const out = await operatorService.resetUserPassword(operatorId, TARGET_EMAIL, {
      actorEmail: OPERATOR_EMAIL,
      ipAddress: "203.0.113.55",
    });

    expect(out.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    expect(out.sessionsRevoked).toBe(2);

    const { rows: [u] } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [targetId]);
    expect(await verifyPassword(out.temporaryPassword, u.password_hash), "the temp password verifies through the seam").toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, u.password_hash), "the old password is dead").toBe(false);

    const { rows: sess } = await pool.query(`SELECT sid FROM user_sessions WHERE (sess ->> 'userId')::int = $1`, [targetId]);
    expect(sess).toHaveLength(0);

    const { rows: audit } = await pool.query(
      `SELECT action, actor_user_id, target_user_id, metadata::text AS m FROM security_audit_logs WHERE target_user_id = $1`,
      [targetId],
    );
    expect(audit.map((a) => a.action)).toContain("user.password_breakglass_reset");
    const row = audit.find((a) => a.action === "user.password_breakglass_reset")!;
    expect(row.actor_user_id).toBe(operatorId);
    // 🔴 No password material anywhere near the trail.
    expect(row.m ?? "").not.toContain(out.temporaryPassword);
  });

  it("🔴 an operator target is REFUSED — and the refusal is audited", async () => {
    await expect(
      operatorService.resetUserPassword(operatorId, OPERATOR_EMAIL, { actorEmail: OPERATOR_EMAIL, ipAddress: "203.0.113.55" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The operator's own hash is untouched — the refusal happened before any write.
    const { rows: [u] } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [operatorId]);
    expect(await verifyPassword(OLD_PASSWORD, u.password_hash)).toBe(true);

    const { rows: audit } = await pool.query(
      `SELECT action FROM security_audit_logs WHERE target_user_id = $1`,
      [operatorId],
    );
    expect(audit.map((a) => a.action)).toContain("user.password_breakglass_refused_operator_target");
  });

  it("an unknown email is a 404, and garbage is a 400 — refusals that say why", async () => {
    await expect(operatorService.resetUserPassword(operatorId, "nobody@test.local", {})).rejects.toThrow(/No user/);
    await expect(operatorService.resetUserPassword(operatorId, "   ", {})).rejects.toThrow(/email is required/);
  });
});
