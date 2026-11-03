/**
 * 🔴 Phase 18 R-14 — AC-1: THE CONTROL REGISTRY'S TWO-WAY TEST (owner, 2026-11-01, memo §3;
 * register §11.121, the scoped D-4 written before this file).
 *
 * "Each entry names the control, its enforcement point (file, function or trigger) and its proving
 * test. A two-way test: every entry has its enforcement point, and every enforcement point has an entry."
 *
 *  - FORWARD (every entry has its point): each trigger and CHECK the registry names is created by the
 *    migrations and exists, enabled, in the live database on its table; each code point's file declares
 *    its symbol; each refusal code appears in the code (the registry itself excluded); each proving test
 *    exists and mentions the control's id.
 *  - REVERSE (every point has an entry): each trigger and named CHECK the Phase 18 migrations (0121
 *    onward) leave in place is named by an entry. Parsed from the migration text, so a new migration's
 *    guard has to enter the registry before this test is green.
 *
 * 🔴 THE FRAME: triggers and named CHECKs. Foreign keys, unique indexes and code-level refusals are
 * outside the reverse direction (registry.ts says why); a code point is checked forward only.
 *
 * The migration parser carries its own known-present cases (a negative result from an unvalidated probe
 * is not evidence): a synthetic script of every statement shape it reads, and, in the real migrations,
 * one point of each shape the Phase 18 migrations use.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { CONTROLS, type EnforcementPoint } from "../controls/registry";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const MIGRATIONS = join(REPO, "packages/db/migrations");
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

type DbPoint = Extract<EnforcementPoint, { kind: "trigger" | "check" }>;
const keyOf = (p: { kind: string; table: string; name: string }) => `${p.kind} ${p.table}.${p.name}`;

/** The DDL a migration states, comments and string literals removed. A DO block runs at once, so its
 *  body's DDL counts; a function body runs only when called, so a CREATE TRIGGER inside one is text.
 *  DDL built as a string (EXECUTE '…') is not seen: no Phase 18 migration states a trigger or CHECK so. */
function ddlStatements(sql: string): string[] {
  const text = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\bDO\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/gi, (_all, _tag, body: string) => `;${body};`)
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
  return text.split(";").map((s) => s.trim()).filter(Boolean);
}

const IDENT = String.raw`(?:"?public"?\.)?"?(\w+)"?`;

/** Replays the trigger and named-CHECK statements of `scripts` in order: what they leave in place. */
export function pointsLeftBy(scripts: readonly string[]): Map<string, DbPoint> {
  const points = new Map<string, DbPoint>();
  const put = (p: DbPoint) => points.set(keyOf(p), p);
  for (const sql of scripts) {
    for (const st of ddlStatements(sql)) {
      // Unanchored: inside a DO block a statement follows BEGIN or IF … THEN.
      let m: RegExpMatchArray | null;
      if ((m = st.match(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?[\s\S]*?\bON\s+${IDENT}`, "i")))) {
        put({ kind: "trigger", name: m[1], table: m[2] });
      } else if ((m = st.match(new RegExp(String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+${IDENT}`, "i")))) {
        points.delete(keyOf({ kind: "trigger", name: m[1], table: m[2] }));
      } else if ((m = st.match(new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, "i")))) {
        for (const [k, p] of points) if (p.table === m[1]) points.delete(k);
      } else if ((m = st.match(new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, "i")))) {
        const table = m[1];
        for (const c of st.matchAll(/CONSTRAINT\s+"?(\w+)"?\s+CHECK\b/gi)) put({ kind: "check", name: c[1], table });
      } else if ((m = st.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}`, "i")))) {
        const table = m[1];
        for (const c of st.matchAll(/ADD\s+CONSTRAINT\s+"?(\w+)"?\s+CHECK\b|DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)) {
          if (c[1]) put({ kind: "check", name: c[1], table });
          else points.delete(keyOf({ kind: "check", name: c[2], table }));
        }
      }
    }
  }
  return points;
}

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
/** Everything the migrations leave in place, and the part the Phase 18 migrations (0121 on) created. */
const allPoints = pointsLeftBy(migrationFiles.map(read));
const phase18Created = new Set(pointsLeftBy(migrationFiles.filter((f) => Number(f.slice(0, 4)) >= 121).map(read)).keys());
const phase18Points = [...allPoints.entries()].filter(([k]) => phase18Created.has(k)).map(([, p]) => p);

const dbPoints = CONTROLS.flatMap((c) => c.points.filter((p): p is DbPoint => p.kind !== "code").map((p) => ({ id: c.id, p })));
const codePoints = CONTROLS.flatMap((c) => c.points.flatMap((p) => (p.kind === "code" ? [{ id: c.id, p }] : [])));

/** The symbol is DECLARED in the file: a function, class or binding; or a method or property. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bindingRe = (s: string) => new RegExp(String.raw`\b(?:function\*?|class|const|let|var)\s+${escape(s)}\b`);
const memberRe = (s: string) =>
  new RegExp(String.raw`^[ \t]*(?:(?:public|private|static|readonly|async)\s+)*${escape(s)}\s*(?:<[^>\n]*>)?\s*(?:\((?![^\n]*\);?\s*$)|:)`, "m");
function declares(text: string, symbol: string): boolean {
  const [head, ...members] = symbol.split(".");
  const first = text.search(bindingRe(head)) >= 0 ? text.search(bindingRe(head)) : text.search(memberRe(head));
  if (first < 0) return false;
  let from = first;
  for (const m of members) {
    const at = text.slice(from).search(memberRe(m));
    if (at < 0) return false;
    from += at;
  }
  return true;
}

/** Non-test source: where a refusal code must appear (the registry itself excluded). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "tests" || f === "generated" || f === "node_modules" || f === "dist" ? [] : sourceFiles(p);
    return /\.(ts|tsx|mts)$/.test(f) ? [p] : [];
  });
}
const REGISTRY = join(REPO, "apps/api/src/controls/registry.ts");
const sourceText = [join(REPO, "apps/api/src"), join(REPO, "packages/shared/src"), join(REPO, "packages/db/src")]
  .flatMap(sourceFiles)
  .filter((p) => p !== REGISTRY)
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

const mentions = (text: string, id: string) => new RegExp(String.raw`(?<![A-Za-z0-9])${escape(id)}(?![A-Za-z0-9])`).test(text);

describe("R-14 (AC-1): the migration parser sees what it must (its own known-present cases)", () => {
  it("a synthetic script of every statement shape: created, re-created and dropped points", () => {
    const left = pointsLeftBy([
      `CREATE TABLE "t1" ("a" int, CONSTRAINT "t1_a_chk" CHECK ("a" > 0));--> statement-breakpoint
       ALTER TABLE "t1" ADD CONSTRAINT "t1_b_chk" CHECK ("a" < 9);
       CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN
         -- CREATE TRIGGER fake_in_comment AFTER INSERT ON t1
         EXECUTE 'CREATE TRIGGER fake_in_string AFTER INSERT ON t1';
         CREATE TRIGGER fake_in_function_body AFTER INSERT ON t1 FOR EACH ROW EXECUTE FUNCTION f();
         RETURN NEW; END $$ LANGUAGE plpgsql;
       CREATE TRIGGER "t1_trg" BEFORE UPDATE OF a ON "t1" FOR EACH ROW EXECUTE FUNCTION f();
       CREATE CONSTRAINT TRIGGER t1_at_commit AFTER INSERT ON public.t1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();
       CREATE TRIGGER t1_gone BEFORE TRUNCATE ON t1 EXECUTE FUNCTION f();
       DO $do$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't1_in_do_chk') THEN
           ALTER TABLE "t1" ADD CONSTRAINT "t1_in_do_chk" CHECK ("a" <> 5);
         END IF;
       END $do$;`,
      `ALTER TABLE "t1" DROP CONSTRAINT "t1_b_chk";
       ALTER TABLE "t1" ADD CONSTRAINT "t1_b_chk" CHECK ("a" < 8);
       ALTER TABLE "t1" DROP CONSTRAINT "t1_a_chk";
       DROP TRIGGER IF EXISTS t1_gone ON "t1";`,
    ]);
    expect([...left.keys()].sort()).toEqual([
      "check t1.t1_b_chk",
      "check t1.t1_in_do_chk",
      "trigger t1.t1_at_commit",
      "trigger t1.t1_trg",
    ]);
  });

  it("in the real migrations, one point of each shape the Phase 18 migrations use", () => {
    const keys = new Set(phase18Points.map(keyOf));
    // CREATE TRIGGER (0126), CREATE CONSTRAINT TRIGGER (0126), ALTER … ADD CONSTRAINT … CHECK (0126),
    // an inline CHECK in CREATE TABLE (0140), a CHECK dropped and re-added by a later migration (0154 → 0155).
    for (const k of [
      "trigger journal_entries.zz_journal_entries_posted_frozen",
      "trigger journal_entry_lines.zz_journal_entry_lines_posted_frozen_at_commit",
      "check journal_entries.journal_entries_status_chk",
      "check wht_refund_claims.wht_refund_claims_reason_chk",
      "check control_flags.control_flags_kind_chk",
    ]) expect(keys, k).toContain(k);
    // A point created BEFORE 0121 is outside the frame (it predates Phase 18), though the migrations have
    // it — 0066's CHECK, added inside a DO block, is one, and the parser reads it.
    expect(allPoints.has("check journal_entry_lines.jel_party_consistency_chk")).toBe(true);
    expect(keys.has("check journal_entry_lines.jel_party_consistency_chk")).toBe(false);
    expect(allPoints.size).toBeGreaterThan(phase18Points.length);
    // The universe measured when this test was written (frame: 0121–0155): 38 triggers, 75 named CHECKs.
    expect(phase18Points.filter((p) => p.kind === "trigger").length).toBeGreaterThanOrEqual(38);
    expect(phase18Points.filter((p) => p.kind === "check").length).toBeGreaterThanOrEqual(75);
  });
});

describe("R-14 (AC-1): FORWARD — every entry has its enforcement point", () => {
  it("ids are unique; every entry names at least one point and one proving test", () => {
    const ids = CONTROLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CONTROLS) {
      expect(c.points.length, c.id).toBeGreaterThan(0);
      expect(c.provingTests.length, c.id).toBeGreaterThan(0);
    }
  });

  it("every trigger and CHECK named is created by the migrations, on its table", () => {
    const missing = dbPoints.filter(({ p }) => !allPoints.has(keyOf(p))).map(({ id, p }) => `${id}: ${keyOf(p)}`);
    expect(missing).toEqual([]);
  });

  it("every code point's file declares its symbol", () => {
    const missing = codePoints
      .filter(({ p }) => !existsSync(join(REPO, p.file)) || !declares(readFileSync(join(REPO, p.file), "utf8"), p.symbol))
      .map(({ id, p }) => `${id}: ${p.file} ${p.symbol}`);
    expect(missing).toEqual([]);
  });

  it("every refusal code appears in the code, outside the registry", () => {
    const missing = CONTROLS.flatMap((c) => c.refusalCodes.filter((r) => !sourceText.includes(`"${r}"`)).map((r) => `${c.id}: ${r}`));
    expect(missing).toEqual([]);
  });

  it("every proving test exists and mentions its control's id", () => {
    const wrong = CONTROLS.flatMap((c) =>
      c.provingTests.flatMap((t) => {
        const p = join(HERE, t);
        if (!existsSync(p)) return [`${c.id}: ${t} does not exist`];
        return mentions(readFileSync(p, "utf8"), c.id) ? [] : [`${c.id}: ${t} does not mention ${c.id}`];
      }),
    );
    expect(wrong).toEqual([]);
  });
});

describeMaybe("R-14 (AC-1): FORWARD — every trigger and CHECK named exists, enabled, in the live database", () => {
  it("each named trigger is on its table and fires (enabled, not replica-only); each named CHECK is on its table", async () => {
    const triggers = await pool.query<{ t: string; enabled: string }>(
      `SELECT c.relname || '.' || t.tgname AS t, t.tgenabled AS enabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
    );
    const checks = await pool.query<{ t: string }>(
      `SELECT c.relname || '.' || k.conname AS t
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND k.contype = 'c'`,
    );
    const enabled = new Map(triggers.rows.map((r) => [r.t, r.enabled]));
    const checkSet = new Set(checks.rows.map((r) => r.t));
    // Known-present: the probe sees a trigger and a CHECK it must see before its absences mean anything.
    expect(enabled.get("journal_entries.zz_journal_entries_posted_frozen")).toBe("O");
    expect(checkSet.has("journal_entries.journal_entries_status_chk")).toBe(true);
    const wrong = dbPoints.flatMap(({ id, p }) => {
      const at = `${p.table}.${p.name}`;
      if (p.kind === "check") return checkSet.has(at) ? [] : [`${id}: CHECK ${at} is not in the database`];
      const e = enabled.get(at);
      if (e == null) return [`${id}: trigger ${at} is not in the database`];
      return e === "O" || e === "A" ? [] : [`${id}: trigger ${at} is ${e === "D" ? "disabled" : "replica-only"}`];
    });
    expect(wrong).toEqual([]);
  });
});

describe("R-14 (AC-1): REVERSE — every enforcement point has an entry", () => {
  it("each trigger and named CHECK the Phase 18 migrations leave in place is named by a registry entry", () => {
    const named = new Set(dbPoints.map(({ p }) => keyOf(p)));
    const unregistered = phase18Points.map(keyOf).filter((k) => !named.has(k)).sort();
    expect(unregistered).toEqual([]);
  });
});
