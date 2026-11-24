/**
 * 🔴 19B S1 (v4 §6, D10) — THE FIELD-CLASS GRANTS IN THE ONE MATRIX.
 *
 *  - The (resource, class) pairs PERMISSION_MATRIX grants are EXACTLY the pairs the class tables use — both ways, so a
 *    protected field never lacks the grants that decide it, and no grant decides nothing.
 *  - Each pair carries every level its class has (`last4` for an IBAN only).
 *  - 🔴 S1: EVERY ROLE HOLDS EVERY ONE OF THEM — except EXACTLY the removals an S2 step makes (S2a: S2A_REMOVALS, the
 *    owner's approved set; restated for S2a, 2026-11-23). Each step's removals are listed, dry-run per environment and
 *    applied to a database only with the owner's approval string for it (D10).
 */
import { describe, expect, it } from "vitest";
import { FIELD_CLASS_LEVELS, PERMISSION_MATRIX, PROTECTED_FIELD_CLASSES, S2A_REMOVALS, S2B_REMOVALS, S2C_REMOVALS, fieldGrantAction, removalSetHash, type ProtectedFieldClass } from "@workspace/db";
import { FIELD_CLASS_TABLE, indexTable } from "../lib/fieldClasses/classTable";
import { OUTSIDE_CONTRACT_ROUTES } from "../lib/fieldClasses/outsideContract";

const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const WRITERS = ["admin", "accountant", "bookkeeper"] as const;
const FIELD_ACTION = /^field\.([a-z_]+)\.(read|write|last4)$/;

function pairsUsedByTables(): Set<string> {
  const used = new Set<string>();
  for (const table of [FIELD_CLASS_TABLE, OUTSIDE_CONTRACT_ROUTES]) {
    for (const byField of indexTable(table).values()) {
      for (const s of byField.values()) {
        if (s.cls !== "standard" && s.cls !== "by_entity") used.add(`${s.resource}:${s.cls}`);
        for (const c of s.writeAlsoNeeds) used.add(`${s.resource}:${c}`);
      }
    }
  }
  return used;
}

describe("field-class grants in PERMISSION_MATRIX (19B S1)", () => {
  const fieldRows = PERMISSION_MATRIX.filter((r) => r.action.startsWith("field."));

  it("every field action is a known class and level", () => {
    const bad = fieldRows.filter((r) => {
      const m = FIELD_ACTION.exec(r.action);
      return !m || !(PROTECTED_FIELD_CLASSES as readonly string[]).includes(m[1]!) || !FIELD_CLASS_LEVELS[m[1] as ProtectedFieldClass].includes(m[2] as never);
    });
    expect(bad).toEqual([]);
  });

  it("🔴 the granted (resource, class) pairs are exactly the pairs the tables use — both ways", () => {
    const granted = new Set(fieldRows.map((r) => `${r.resource}:${FIELD_ACTION.exec(r.action)![1]}`));
    const used = pairsUsedByTables();
    expect([...used].filter((p) => !granted.has(p)).sort(), "a protected field with no grant to decide it").toEqual([]);
    expect([...granted].filter((p) => !used.has(p)).sort(), "a grant that decides no field").toEqual([]);
  });

  // 🔴 Restated for S2a (O2, D2; owner 2026-11-23): S1 asserted "nothing lacking"; what lacks is now EXACTLY S2a's field removals.
  it("🔴 EVERY ROLE READS EVERY USED CLASS, AND EVERY ROLE THAT WRITES WRITES IT — except exactly S2a's field removals", () => {
    const held = new Set(fieldRows.map((r) => `${r.role}:${r.resource}:${r.action}`));
    const lacking: string[] = [];
    for (const pair of pairsUsedByTables()) {
      const [resource, cls] = pair.split(":") as [string, ProtectedFieldClass];
      for (const level of FIELD_CLASS_LEVELS[cls]) {
        // A viewer writes nothing, anywhere (its route grants are read only), so it holds no write level.
        for (const role of level === "write" ? WRITERS : ROLES) if (!held.has(`${role}:${resource}:${fieldGrantAction(cls, level)}`)) lacking.push(`${role}:${resource}:${fieldGrantAction(cls, level)}`);
      }
    }
    const s2aFieldRemovals = S2A_REMOVALS.filter((r) => r.action.startsWith("field.")).map((r) => `${r.role}:${r.resource}:${r.action}`);
    expect(s2aFieldRemovals).toHaveLength(11);
    // restated for S2b's removal: S2a's eleven field removals and S2b's seven, and nothing else
    const s2bRemovals = S2B_REMOVALS.map((r) => `${r.role}:${r.resource}:${r.action}`);
    expect(s2bRemovals).toHaveLength(7);
    // restated for S2c's removal: and S2c's nine
    const s2cRemovals = S2C_REMOVALS.map((r) => `${r.role}:${r.resource}:${r.action}`);
    expect(s2cRemovals).toHaveLength(9);
    expect(lacking.sort(), "a narrowing is an S2 removal the owner approves — S2a's, S2b's and S2c's, and nothing else").toEqual([...s2aFieldRemovals, ...s2bRemovals, ...s2cRemovals].sort());
  });

  it("🔴 a viewer holds no field WRITE level (presence: it holds the read levels)", () => {
    expect(fieldRows.filter((r) => r.role === "viewer" && r.action.endsWith(".write")).map((r) => `${r.resource}:${r.action}`)).toEqual([]);
    expect(fieldRows.some((r) => r.role === "viewer" && r.action.endsWith(".read"))).toBe(true);
  });
});

/**
 * 🔴 19B S2a: the removals that switch withholding on for employees and payroll are REMOVED FROM THE MATRIX by this
 * commit (restated 2026-11-23: until now this pinned them as still granted). A database's table loses them only with the
 * owner's approval string for that environment and THIS set, whose hash the approval names: b92b750c…63d7.
 */
describe("S2a's removals (removed from the matrix; each environment only with the owner's approval)", () => {
  const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
  it("🔴 the set is exactly these twelve", () => {
    expect(S2A_REMOVALS.map(key).sort()).toEqual([
      "bookkeeper:employees:field.bank_account.read", "bookkeeper:employees:field.compensation.read", "bookkeeper:employees:field.compensation.write",
      "bookkeeper:employees:field.identity.read", "bookkeeper:payroll:create", "bookkeeper:payroll:field.compensation.read",
      "bookkeeper:payroll:field.compensation.write", "viewer:employees:field.bank_account.last4", "viewer:employees:field.bank_account.read",
      "viewer:employees:field.compensation.read", "viewer:employees:field.identity.read", "viewer:payroll:field.compensation.read",
    ]);
  });
  it("🔴 APPLIED in the matrix: none of the twelve is granted, and the set's hash is the one the owner reviewed", () => {
    const granted = new Set(PERMISSION_MATRIX.map(key));
    expect(S2A_REMOVALS.filter((r) => granted.has(key(r))).map(key)).toEqual([]);
    expect(removalSetHash(S2A_REMOVALS)).toBe("b92b750c39bfea56d800ea7adea8eb037855cdc2bfc6f174f6326674ef0963d7");
    // presence: the accountant and the admin still hold every one of the twelve actions
    for (const r of S2A_REMOVALS) for (const role of ["admin", "accountant"]) expect(granted.has(key({ ...r, role })), `${role}:${r.resource}:${r.action}`).toBe(true);
  });
  it("the bookkeeper keeps writing the national ID and the IBAN (held from S3), and reads the IBAN's last four", () => {
    const removed = new Set(S2A_REMOVALS.map(key));
    const granted = new Set(PERMISSION_MATRIX.map(key));
    for (const a of ["field.identity.write", "field.bank_account.write", "field.bank_account.last4"]) {
      expect(removed.has(`bookkeeper:employees:${a}`), a).toBe(false);
      expect(granted.has(`bookkeeper:employees:${a}`), a).toBe(true);
    }
  });
});

/**
 * 🔴 19B S2b: its seven removals are DECLARED and STILL GRANTED (owner, 2026-11-24: "build the code, merge it with every
 * grant still in place, and stop before any removal with the dry-run list, its hash and the pre-removal review"). The
 * removal commit restates this block, as S2a's was; a database loses them only with the owner's approval string for it
 * and THIS set, whose hash the approval names.
 */
describe("S2b's removals (removed from the matrix; each environment only with the owner's approval)", () => {
  const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
  it("🔴 the set is exactly these seven (v4 §6.1)", () => {
    expect(S2B_REMOVALS.map(key).sort()).toEqual([
      "bookkeeper:customers:field.identity.read", "bookkeeper:vendors:field.bank_account.read",
      "viewer:customers:field.contact.read", "viewer:customers:field.identity.read",
      "viewer:vendors:field.bank_account.last4", "viewer:vendors:field.bank_account.read", "viewer:vendors:field.contact.read",
    ]);
    expect(removalSetHash(S2B_REMOVALS)).toBe("42693c06f2bf74be1b217115eb85c7f553cdc7c6ba6a3ca0dfcb9dfbc97c088f");
  });
  // restated for the removal (until now: every one still granted)
  it("🔴 APPLIED in the matrix: none of the seven is granted, none overlaps S2a's, and the accountant and admin keep each", () => {
    const granted = new Set(PERMISSION_MATRIX.map(key));
    expect(S2B_REMOVALS.filter((r) => granted.has(key(r))).map(key)).toEqual([]);
    for (const r of S2B_REMOVALS) for (const role of ["admin", "accountant"]) expect(granted.has(key({ ...r, role })), `${role}:${r.resource}:${r.action}`).toBe(true);
    const s2a = new Set(S2A_REMOVALS.map(key));
    expect(S2B_REMOVALS.filter((r) => s2a.has(key(r))).map(key)).toEqual([]);
  });
  it("after them the bookkeeper keeps customer and supplier contact, the national ID's write, and an IBAN's last four and write", () => {
    const pending = new Set(S2B_REMOVALS.map(key));
    for (const k of ["bookkeeper:customers:field.contact.read", "bookkeeper:customers:field.contact.write", "bookkeeper:customers:field.identity.write",
      "bookkeeper:vendors:field.contact.read", "bookkeeper:vendors:field.bank_account.last4", "bookkeeper:vendors:field.bank_account.write"]) {
      expect([k, pending.has(k), new Set(PERMISSION_MATRIX.map(key)).has(k)]).toEqual([k, false, true]);
    }
  });
});

/**
 * 🔴 19B S2c: its nine removals are DECLARED and STILL GRANTED (owner, 2026-11-24: S2c "the same way as S2a"). The removal
 * commit restates this block; a database loses them only with the owner's approval string for it and THIS set.
 */
describe("S2c's removals (removed from the matrix; each environment only with the owner's approval)", () => {
  const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
  it("🔴 the set is exactly these nine (v4 §6.1: bank text, member security, migration contact)", () => {
    expect(S2C_REMOVALS.map(key).sort()).toEqual([
      "accountant:audit_logs:field.member_security.read", "accountant:users:field.member_security.read",
      "bookkeeper:audit_logs:field.member_security.read", "bookkeeper:users:field.member_security.read",
      "viewer:audit_logs:field.member_security.read", "viewer:journal_entries:field.bank_narrative.read",
      "viewer:migration:field.contact.read", "viewer:transactions:field.bank_narrative.read", "viewer:users:field.member_security.read",
    ]);
    expect(removalSetHash(S2C_REMOVALS)).toBe("2c11c0503ac92fb002aeeed5d98ef4aa1f3dc8d392479151879a2be813bce65e");
  });
  // restated for the removal (until now: every one still granted)
  it("🔴 APPLIED in the matrix: none of the nine is granted, none overlaps S2a's or S2b's, and the admin keeps each", () => {
    const granted = new Set(PERMISSION_MATRIX.map(key));
    expect(S2C_REMOVALS.filter((r) => granted.has(key(r))).map(key)).toEqual([]);
    for (const r of S2C_REMOVALS) expect(granted.has(key({ ...r, role: "admin" })), `admin:${r.resource}:${r.action}`).toBe(true);
    const earlier = new Set([...S2A_REMOVALS, ...S2B_REMOVALS].map(key));
    expect(S2C_REMOVALS.filter((r) => earlier.has(key(r))).map(key)).toEqual([]);
  });
  it("after them the admin alone reads member security, the bookkeeper keeps the bank's text, and no write level changes", () => {
    const pending = new Set(S2C_REMOVALS.map(key));
    const granted = new Set(PERMISSION_MATRIX.map(key));
    for (const k of ["admin:users:field.member_security.read", "admin:audit_logs:field.member_security.read", "bookkeeper:transactions:field.bank_narrative.read", "bookkeeper:journal_entries:field.bank_narrative.read", "bookkeeper:migration:field.contact.read"]) {
      expect([k, pending.has(k), granted.has(k)]).toEqual([k, false, true]); // restated: still true after the removal
    }
    expect(S2C_REMOVALS.filter((r) => !r.action.endsWith(".read")).map(key)).toEqual([]);
  });
});
