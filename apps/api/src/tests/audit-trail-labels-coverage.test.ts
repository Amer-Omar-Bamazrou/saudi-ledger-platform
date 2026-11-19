/**
 * 🔴 Walk L3 (2026-11-16; the work package's included walk items): the audit trail printed its actions and record
 * types raw, in English — and its filters offered 21 of about 75 record types, because the list was written once from
 * the callers of the day and nothing kept it current. Two definitions with no forcing function diverge invisibly.
 *
 * So: every record type and action the API writes (the same search shape as the sweep that built the map —
 * `auditService.<verb>("…"`, `entityType: "…"`, `action: "…"` across apps/api/src, tests excluded) must have a label in
 * the web's one map (`apps/web/src/lib/walkLabels.ts`). A new one fails here until it is named in both languages.
 * No database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..", "..");
const apiSrc = join(root, "apps", "api", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "tests" ? [] : sources(p);
    return /\.ts$/.test(f) ? [readFileSync(p, "utf8")] : [];
  });
}

function written(): { entities: Set<string>; actions: Set<string> } {
  const entities = new Set<string>();
  const actions = new Set<string>();
  for (const src of sources(apiSrc)) {
    for (const m of src.matchAll(/auditService\.(?:created|updated|deleted|submitted|approved|rejected|sentBack|exported)\(\s*"([a-z_]+)"/g)) entities.add(m[1]);
    for (const m of src.matchAll(/entityType: "([a-z_]+)"/g)) entities.add(m[1]);
    for (const m of src.matchAll(/\baction: "([a-z_]+)"/g)) actions.add(m[1]);
  }
  return { entities, actions };
}

/** The keys of one `const NAME: Record<string, [string, string]> = { … };` block in the web's label map. */
function mapKeys(name: string): Set<string> {
  const text = readFileSync(join(root, "apps", "web", "src", "lib", "walkLabels.ts"), "utf8");
  const start = text.indexOf(`const ${name}:`);
  expect(start, `${name} exists`).toBeGreaterThan(0);
  const body = text.slice(start, text.indexOf("\n};", start));
  return new Set([...body.matchAll(/^\s+([a-z_]+): \[/gm)].map((m) => m[1]));
}

describe("walk L3 — every audit record type and action the API writes has a label, in English and Arabic", () => {
  it("🔴 the sweep sees what it must (a probe that finds nothing proves nothing)", () => {
    const { entities, actions } = written();
    for (const known of ["invoice", "journal_entry", "treasury_settings", "bank_detail_change_request"]) expect(entities, known).toContain(known);
    for (const known of ["create", "approve", "reverse"]) expect(actions, known).toContain(known);
  });

  it("🔴 no record type the API writes is left unlabelled", () => {
    const labelled = mapKeys("AUDIT_ENTITIES");
    expect([...written().entities].filter((e) => !labelled.has(e)).sort()).toEqual([]);
  });

  it("🔴 no action the API writes is left unlabelled", () => {
    const labelled = mapKeys("AUDIT_ACTIONS");
    expect([...written().actions].filter((a) => !labelled.has(a)).sort()).toEqual([]);
  });
});
