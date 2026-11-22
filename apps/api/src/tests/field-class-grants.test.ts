/**
 * 🔴 19B S1 (v4 §6, D10) — THE FIELD-CLASS GRANTS IN THE ONE MATRIX.
 *
 *  - The (resource, class) pairs PERMISSION_MATRIX grants are EXACTLY the pairs the class tables use — both ways, so a
 *    protected field never lacks the grants that decide it, and no grant decides nothing.
 *  - Each pair carries every level its class has (`last4` for an IBAN only).
 *  - 🔴 S1: EVERY ROLE HOLDS EVERY ONE OF THEM. This is the assertion that keeps S1 invisible. S2 changes it on purpose:
 *    each step's removals are listed, dry-run per environment and approved by the owner before they apply (D10).
 */
import { describe, expect, it } from "vitest";
import { FIELD_CLASS_LEVELS, PERMISSION_MATRIX, PROTECTED_FIELD_CLASSES, S2A_PENDING_REMOVALS, fieldGrantAction, type ProtectedFieldClass } from "@workspace/db";
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

  it("🔴 S1: EVERY ROLE READS EVERY USED CLASS, AND EVERY ROLE THAT WRITES WRITES IT — nothing withheld, no write refused", () => {
    const held = new Set(fieldRows.map((r) => `${r.role}:${r.resource}:${r.action}`));
    const lacking: string[] = [];
    for (const pair of pairsUsedByTables()) {
      const [resource, cls] = pair.split(":") as [string, ProtectedFieldClass];
      for (const level of FIELD_CLASS_LEVELS[cls]) {
        // A viewer writes nothing, anywhere (its route grants are read only), so it holds no write level.
        for (const role of level === "write" ? WRITERS : ROLES) if (!held.has(`${role}:${resource}:${fieldGrantAction(cls, level)}`)) lacking.push(`${role}:${resource}:${fieldGrantAction(cls, level)}`);
      }
    }
    expect(lacking, "S1 changes nothing anyone sees; a narrowing is an S2 removal the owner approves").toEqual([]);
  });

  it("🔴 a viewer holds no field WRITE level (presence: it holds the read levels)", () => {
    expect(fieldRows.filter((r) => r.role === "viewer" && r.action.endsWith(".write")).map((r) => `${r.resource}:${r.action}`)).toEqual([]);
    expect(fieldRows.some((r) => r.role === "viewer" && r.action.endsWith(".read"))).toBe(true);
  });
});

/**
 * 🔴 19B S2a (owner, 2026-11-22): the removals that switch withholding on for employees and payroll are DECLARED and
 * NOT APPLIED until the owner approves each environment after the pre-removal review. This pins both halves: the set is
 * exactly these twelve grants, and every one is still in the matrix. The step that removes them changes this test.
 */
describe("S2a's pending removals (declared, not applied)", () => {
  const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
  it("🔴 the set is exactly these twelve", () => {
    expect(S2A_PENDING_REMOVALS.map(key).sort()).toEqual([
      "bookkeeper:employees:field.bank_account.read", "bookkeeper:employees:field.compensation.read", "bookkeeper:employees:field.compensation.write",
      "bookkeeper:employees:field.identity.read", "bookkeeper:payroll:create", "bookkeeper:payroll:field.compensation.read",
      "bookkeeper:payroll:field.compensation.write", "viewer:employees:field.bank_account.last4", "viewer:employees:field.bank_account.read",
      "viewer:employees:field.compensation.read", "viewer:employees:field.identity.read", "viewer:payroll:field.compensation.read",
    ]);
  });
  it("🔴 NOT APPLIED: every one is still granted by PERMISSION_MATRIX", () => {
    const granted = new Set(PERMISSION_MATRIX.map(key));
    expect(S2A_PENDING_REMOVALS.filter((r) => !granted.has(key(r))).map(key)).toEqual([]);
  });
  it("the bookkeeper keeps writing the national ID and the IBAN (held from S3), and reads the IBAN's last four", () => {
    const pending = new Set(S2A_PENDING_REMOVALS.map(key));
    for (const a of ["field.identity.write", "field.bank_account.write", "field.bank_account.last4"]) expect(pending.has(`bookkeeper:employees:${a}`), a).toBe(false);
  });
});
