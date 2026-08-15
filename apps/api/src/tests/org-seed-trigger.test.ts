/**
 * 🔴 THE STANDING GUARD for `seed_org_chart_of_accounts()` — the trigger that
 * seeds every new organization's chart of accounts from
 * `system_account_templates`.
 *
 * ── Why this file exists: the same trap fired TWICE, in OPPOSITE directions ──
 *
 *   M17.0 (migration 0038)  DROPPED `zakat_relevant` while the trigger body
 *                           still NAMED it. plpgsql resolves column names at
 *                           EXECUTION time, so nothing failed during the
 *                           migration — every future SIGNUP would have errored,
 *                           at a call site nowhere near the change.
 *   M18.1 (migration 0041)  ADDED `liquidity_class` and the trigger did NOT
 *                           name it. Again nothing failed: the next
 *                           organization would simply have been seeded with
 *                           every class NULL, and its owner would have opened
 *                           the Finance Hub to find no account classified and
 *                           no ratio computable.
 *
 * Both were caught by hand. Twice is a pattern, and "remember to check the
 * trigger" is not a countermeasure — it is a hope. This test is the
 * countermeasure, and it is deliberately GENERAL: it does not know about
 * `zakat_relevant` or `liquidity_class`, it compares the column sets. Any
 * future migration that touches either table is covered without being edited.
 *
 * ── The rule it enforces ────────────────────────────────────────────────────
 * Every column present in BOTH `system_account_templates` and `categories`
 * (aliasing `code` → `system_code`) must be carried by the trigger, and every
 * column the trigger names must still exist. `sort_order` is template-only and
 * legitimately not copied — the test derives that rather than hardcoding it.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[org-seed-trigger] no real DATABASE_URL — skipping.");

/** `system_account_templates.code` is the same fact as `categories.system_code`. */
const ALIASES: Record<string, string> = { code: "system_code" };

/** Columns `categories` owns that no template could supply. */
const CATEGORY_OWN = new Set(["id", "organization_id", "created_at", "description"]);

const SLUG = "seed-trigger-guard";

describeMaybe("🔴 the org-seed trigger carries every shared column", () => {
  let templateCols: string[] = [];
  let categoryCols: Set<string>;
  let triggerBody = "";

  beforeAll(async () => {
    const t = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'system_account_templates'`,
    );
    const c = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'categories'`,
    );
    const p = await pool.query<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname = 'seed_org_chart_of_accounts'`,
    );
    templateCols = t.rows.map((r) => r.column_name);
    categoryCols = new Set(c.rows.map((r) => r.column_name));
    triggerBody = p.rows[0]?.prosrc ?? "";
  });

  it("the trigger exists and this guard can read it", () => {
    // If the function is ever renamed or dropped, every assertion below would
    // pass vacuously against an empty string. Fail loudly instead.
    expect(triggerBody).toContain("INSERT INTO categories");
    expect(templateCols.length).toBeGreaterThan(5);
  });

  it("🔴 every column shared by both tables is carried by the trigger (catches an ADDED column)", () => {
    // The M18.1 direction. A shared column the trigger does not copy means the
    // next organization is seeded with a NULL nobody asked for.
    const missing = templateCols
      .map((col) => ALIASES[col] ?? col)
      .filter((target) => categoryCols.has(target) && !CATEGORY_OWN.has(target))
      .filter((target) => !new RegExp(`\\b${target}\\b`).test(triggerBody));

    expect(
      missing,
      `columns exist in BOTH tables but the org-seed trigger does not copy them: ${missing.join(", ")}. ` +
        `Redefine seed_org_chart_of_accounts() in your migration.`,
    ).toEqual([]);
  });

  it("🔴 every column the trigger names still exists (catches a DROPPED column)", () => {
    // The M17.0 direction. plpgsql resolves names at execution time, so a
    // dropped-but-still-named column breaks the next SIGNUP rather than the
    // migration — there is no error to notice at deploy time.
    const insertCols = (triggerBody.match(/INSERT INTO categories\s*\(([^)]*)\)/) ?? [, ""])[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const selectedTemplateCols = [...triggerBody.matchAll(/\bt\.([a-z_]+)/g)].map((m) => m[1]);

    const badTargets = insertCols.filter((c) => !categoryCols.has(c));
    const badSources = selectedTemplateCols.filter((c) => !templateCols.includes(c));

    expect(badTargets, `trigger writes columns that do not exist on categories: ${badTargets}`).toEqual([]);
    expect(badSources, `trigger reads columns that do not exist on the templates: ${badSources}`).toEqual([]);
  });

  it("🔴 …and it actually works: a real org is seeded with the template values", async () => {
    // The behavioural half. Source analysis proves the trigger NAMES the right
    // columns; only running it proves the values arrive. This is the assertion
    // that would have caught M18.1 even if the regex above were fooled.
    await pool.query(`DELETE FROM categories WHERE organization_id IN (SELECT id FROM organizations WHERE slug = '${SLUG}')`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
    const orgId = (
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Seed Guard','${SLUG}') RETURNING id`)
    ).rows[0].id;

    try {
      const { rows } = await pool.query(
        `SELECT t.code,
                t.type            AS t_type,            c.type            AS c_type,
                t.vat_applicable  AS t_vat,             c.vat_applicable  AS c_vat,
                t.is_system       AS t_sys,             c.is_system       AS c_sys,
                t.default_tax_treatment AS t_treat,     c.default_tax_treatment AS c_treat,
                t.treatment_verified    AS t_ver,       c.treatment_verified    AS c_ver,
                t.liquidity_class AS t_liq,             c.liquidity_class AS c_liq
           FROM system_account_templates t
           JOIN categories c
             ON c.system_code = t.code AND c.organization_id = $1`,
        [orgId],
      );

      expect(rows.length, "the trigger seeded nothing at all").toBeGreaterThan(5);
      for (const r of rows) {
        expect(r.c_type, `${r.code}.type`).toBe(r.t_type);
        expect(r.c_vat, `${r.code}.vat_applicable`).toBe(r.t_vat);
        expect(r.c_sys, `${r.code}.is_system`).toBe(r.t_sys);
        expect(r.c_treat, `${r.code}.default_tax_treatment`).toBe(r.t_treat);
        expect(r.c_ver, `${r.code}.treatment_verified`).toBe(r.t_ver);
        expect(r.c_liq, `${r.code}.liquidity_class`).toBe(r.t_liq);
      }
    } finally {
      await pool.query(`DELETE FROM categories WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    }
  });
});

afterAll(async () => {
  if (!REAL_DB) return;
  await pool.query(`DELETE FROM categories WHERE organization_id IN (SELECT id FROM organizations WHERE slug = '${SLUG}')`);
  await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
});
