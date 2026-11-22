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
import { FIELD_CLASS_LEVELS, PERMISSION_MATRIX, PROTECTED_FIELD_CLASSES, fieldGrantAction, type ProtectedFieldClass } from "@workspace/db";
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
