/**
 * 🔴 Phase 18 audit (2026-11-09), finding A25 — the Phase 18 refusals that reached an Arabic user in English carry an
 * Arabic sentence (`errorAr`).
 *
 * Sweep 3c: of the control registry's refusal codes, nine had no Arabic anywhere — neither an `errorAr` from the API
 * nor a title keyed on the code in the web — and neither had #306's four request-boundary refusals. The close-out
 * report's AC-10 row named three of them as bilingual. Each now carries `errorAr`; the web shows it (refusalOf). The
 * shared protected-account list gains its Arabic phrases, which the protected-account sentences quote.
 *
 * Source check everywhere; two refusals over HTTP on the DB (sl_test / CI).
 */
process.env.PORT ??= "3397";
process.env.SESSION_SECRET ??= "phase18-audit-a25-arabic-refusals-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { PROTECTED_SYSTEM_ACCOUNTS } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA25ArabicRefusalsPw1!";
const ARABIC = /[؀-ۿ]/;

const CODES = [
  "correction_kind_required", "protected_account", "inputs_changed_since_submission", "idempotency_key_reused",
  "recovery_allocation_immutable", "statement_already_imported", "note_over_credit", "commit_rolled_back",
  "break_glass_expired", "nul_in_text", "nul_in_url", "invalid_id_in_path", "malformed_path",
];

/** Every line naming `"code"` in the API source (tests and the registry aside), and whether an Arabic `errorAr` sits within six lines of it. */
function sitesOf(code: string, files: Array<{ path: string; lines: string[] }>) {
  const out: Array<{ at: string; arabic: boolean }> = [];
  for (const f of files) {
    f.lines.forEach((l, i) => {
      if (!l.includes(`"${code}"`)) return;
      const window = f.lines.slice(Math.max(0, i - 6), i + 7).join("\n");
      out.push({ at: `${f.path}:${i + 1}`, arabic: /errorAr/.test(window) && ARABIC.test(window) });
    });
  }
  return out;
}

describe("Phase 18 audit A25 — every listed refusal carries an Arabic sentence (source)", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === "tests" || n === "generated" ? [] : walk(p);
    return /\.ts$/.test(n) && !p.includes("controls") ? [p] : [];
  });
  const files = walk(SRC).map((p) => ({ path: p.slice(SRC.length), lines: readFileSync(p, "utf8").split(/\r?\n/) }));

  it("the check sees a refusal WITH Arabic (known-present) and one without (known-absent)", () => {
    const planted = [{ path: "x.ts", lines: ["throw new E(409, {", "  code: \"known_present\",", "  errorAr: \"لا\",", "});", "", "", "", "", "", "", "", "", "", "", "", "throw new E(409, {", "  code: \"known_absent\",", "  error: \"No.\",", "});"] }];
    expect(sitesOf("known_present", planted).map((s) => s.arabic)).toEqual([true]);
    expect(sitesOf("known_absent", planted).map((s) => s.arabic)).toEqual([false]);
    expect(sitesOf("fiscal_year_start_frozen", files).every((s) => s.arabic), "a refusal that already had Arabic").toBe(true);
  });

  for (const code of CODES) {
    it(`🔴 ${code}: every place the API answers it carries errorAr in Arabic`, () => {
      const sites = sitesOf(code, files);
      expect(sites.length, "the code is still answered somewhere").toBeGreaterThan(0);
      expect(sites.filter((s) => !s.arabic).map((s) => s.at)).toEqual([]);
    });
  }

  it("🔴 the shared protected-account list says, in Arabic, who writes each account", () => {
    const missing = Object.entries(PROTECTED_SYSTEM_ACCOUNTS).filter(([, r]) => !ARABIC.test(String((r as { writtenByAr?: string }).writtenByAr ?? ""))).map(([k]) => k);
    expect(missing).toEqual([]);
  });
});

describeMaybe("Phase 18 audit A25 — two refusals over HTTP carry their Arabic sentence", () => {
  const h = g04Harness("auda25");
  let orgId = "";

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A25 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a manual journal line on output VAT: 422 protected_account, its Arabic sentence naming the account", async () => {
    const acct = async (code: string) => (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2 LIMIT 1`, [orgId, code])).rows[0] as { id: number; name: string };
    const vat = await acct("VAT_OUTPUT");
    const suspense = await acct("SUSPENSE");
    const r = await h.api("admin", "POST", "/journal-entries", {
      date: "2026-10-05", description: "A25 probe",
      lines: [{ accountId: suspense.id, accountName: suspense.name, debitAmount: 10, creditAmount: 0 }, { accountId: vat.id, accountName: vat.name, debitAmount: 0, creditAmount: 10 }],
    });
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([422, "protected_account"]);
    expect(String(r.body?.errorAr)).toMatch(ARABIC);
    expect(String(r.body?.errorAr)).toContain(vat.name);
  });

  it("🔴 a NUL in the address: 400 nul_in_url, with its Arabic sentence", async () => {
    const r = await h.api("admin", "GET", "/invoices%00", undefined);
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([400, "nul_in_url"]);
    expect(String(r.body?.errorAr)).toMatch(ARABIC);
  });
});
