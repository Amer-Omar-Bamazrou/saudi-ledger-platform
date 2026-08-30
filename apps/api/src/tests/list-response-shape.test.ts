/**
 * A PAGE'S HAND-WRITTEN RESPONSE TYPE, CHECKED AGAINST THE REAL RESPONSE.
 *
 * ── 🔴 WHY THIS EXISTS ─────────────────────────────────────────────────────
 * `apiFetch<T>` is a cast, not a check. The page author writes an interface
 * describing what they BELIEVE the endpoint returns, TypeScript agrees with
 * them by construction, and nothing anywhere compares the belief to the
 * server. §3 already flags this — "where `apiFetch` is used, the type is a
 * claim nobody checks" — and the claim has now been wrong five times:
 *
 *   ApAging.tsx        declared an array, got an object    → BLANK PAGE (B1)
 *   AssetSchedule.tsx  cost/bookValue/category/usefulLife  → every money cell NaN
 *   PayrollReport.tsx  month/grossSalary/gosi/netSalary    → filters to EMPTY, always
 *   Customers.tsx      balance/totalBilled                 → "Total AR" is always 0.00
 *   Vendors.tsx        balance/totalBilled                 → "Total AP" is always 0.00
 *
 * 🔴 Four of those five render a PLAUSIBLE WRONG ANSWER rather than an error.
 * A blank page gets reported. "Total AR 0.00" and an empty payroll report are
 * statements about the tenant's own money that look exactly like true ones, so
 * nobody reports them — including us, for as long as they have been shipped.
 *
 * ── WHY IT MEASURES INSTEAD OF READING ─────────────────────────────────────
 * The response shape is assembled by spreads (`{...row, grossSalary: …}`) over
 * a Drizzle row, so no static read of the service tells you the key set — you
 * would be re-deriving it, and a guard that re-derives the thing it checks
 * shares the defect it exists to detect. So this calls the REAL service against
 * REAL rows and takes `Object.keys` of what comes back. That is the standing
 * rule "validate from real ledger rows", applied to a contract instead of a
 * calculation.
 *
 * ── THE ANTI-VACUITY HALF, WHICH IS THE LOAD-BEARING ONE ───────────────────
 * An empty list has no keys, and every assertion below would pass over it —
 * the confident zero, in the instrument. So each fixture must return at least
 * one row, and the scan must find at least as many declarations as it does
 * today. If either collapses, THAT is what goes red, and it names the reason.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3141";
process.env.SESSION_SECRET ??= "list-response-shape-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const PAGES_DIR = join(repoRoot, "apps", "web", "src", "pages");

/* ────────────────────────────── the scan ─────────────────────────────── */

interface Declaration {
  file: string;
  type: string;
  endpoint: string;
  fields: string[];
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * Finds `useQuery<Foo[]>({ … apiFetch("/endpoint") … })` and pairs it with the
 * page's own `interface Foo`. Deliberately narrow: it only claims to cover the
 * list-of-entities shape, which is where every one of the five defects lived.
 * A shape it cannot parse is simply not reported — and the count assertion
 * below is what stops that silence from growing.
 */
function scanDeclarations(): Declaration[] {
  const out: Declaration[] = [];
  for (const file of walk(PAGES_DIR)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(repoRoot.length + 1).split("\\").join("/");
    for (const m of src.matchAll(/useQuery<(\w+)\[\]>\s*\(\{([\s\S]{0,400}?)\}\)/g)) {
      const [, type, body] = m;
      const ep = /apiFetch(?:<[^>]*>)?\(\s*[`"']([^`"'?$]+)/.exec(body);
      if (!ep) continue;
      const iface = new RegExp(`interface\\s+${type}\\s*\\{([\\s\\S]*?)\\n?\\}`).exec(src);
      if (!iface) continue;
      const fields = [...iface[1].matchAll(/([a-zA-Z_]\w*)\s*\??\s*:/g)].map((f) => f[1]);
      out.push({ file: rel, type, endpoint: ep[1].replace(/\/$/, ""), fields });
    }
  }
  return out;
}

/**
 * The scan found this many declarations when the guard was written. It may
 * grow. If it SHRINKS, either pages were deleted or — the case this number
 * exists for — a call style changed into one the scanner cannot see, which
 * would silently drop pages out of coverage while the suite stayed green.
 * That is the shrink-check `route-reachability` already carries, for the same
 * reason.
 */
const DECLARATIONS_AT_WRITING = 24;

/* ─────────────────────── fields allowed to be absent ──────────────────── */

/**
 * A declared field the LIST genuinely does not carry, with the reason. Each
 * entry is a promise that the page does not compute with the field — it is
 * populated from a different call, or read from a single-entity fetch.
 * 🔴 A number a page REDUCES over never belongs here. That is the defect.
 */
const ALLOWED_ABSENT: Record<string, Record<string, string>> = {
  "apps/web/src/pages/ScanReview.tsx": {
    created:
      "returned by POST /vendors so the UI can say the vendor was just created; documented at the declaration",
  },
};

/* ───────────────────────────── the fixtures ───────────────────────────── */

const SLUG = "list-response-shape";

/**
 * Endpoints a page declares a type for that this guard does NOT measure, each
 * with what it would take. 🔴 Stated rather than omitted: an uncovered endpoint
 * is a gap, and a gap nobody can see is indistinguishable from coverage.
 */
const UNCOVERED: Record<string, string> = {
  "/quotations":
    "needs a quotation with lines; the conversion axis is derived, so a bare row would under-report keys",
  "/purchase-orders": "same as /quotations, on the billing axis",
  "/transactions/review": "needs a staged statement upload to produce a pending row with a suggestion",
  "/recurring": "rule rows carry a run-history join; needs a generated run to be non-vacuous",
  "/auth/users": "identity layer — outside RLS and outside a tenant connection (§4)",
  "/operator/zatca/certificates": "operator surface; needs an onboarded company with a credential",
  "/operator/zatca/onboarding": "operator surface; needs an onboarded company with a credential",
};

interface Ctx {
  orgId: string;
  companyId: string;
}

/** endpoint → the real response, via the real service, inside a tenant transaction. */
const FIXTURES: Record<string, () => Promise<unknown[]>> = {
  "/assets": async () => (await import("../services/assets.service")).assetsService.list(),
  "/customers": async () => (await import("../services/customers.service")).customersService.list({}),
  "/vendors": async () => (await import("../services/vendors.service")).vendorsService.list({}),
  "/employees": async () => (await import("../services/employees.service")).employeesService.list({}),
  "/bank-accounts": async () => (await import("../services/bankAccounts.service")).bankAccountsService.list(),
  "/products": async () => (await import("../services/products.service")).productsService.list({}),
  "/budgets": async () => (await import("../services/budgets.service")).budgetsService.list(),
  "/categories": async () => (await import("../services/categories.service")).categoriesService.list(),
  "/payroll": async () => (await import("../services/payroll.service")).payrollService.list(),
  "/period-locks": async () => (await import("../services/periodLocks.service")).periodLocksService.list(),
  /**
   * 🔴 The paginated one, and the reason it is here. `/invoices` returns
   * `{items, page, totals}`; a page declaring `useQuery<Invoice[]>` over it
   * gets an object where it expects an array. That is B1's defect exactly, and
   * it is the shape two pages of this codebase were shipped with. The fixture
   * unwraps `items` so the FIELD check still runs, and the envelope check below
   * catches a page that never unwraps it.
   */
  "/invoices": async () => {
    const { invoicesService } = await import("../services/invoices.service");
    return (await invoicesService.list({})).items as unknown[];
  },
};

/** Endpoints whose real response is an envelope rather than a bare array. */
const ENVELOPE_ENDPOINTS = new Set(["/invoices"]);

async function inTenant<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const conn = await beginTenantConnection({
    organizationId: ctx.orgId,
    companyId: ctx.companyId,
    role: "authenticated",
  });
  try {
    const out = await conn.run(fn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

describeMaybe("a page's declared list type matches the real response", () => {
  const ctx: Ctx = { orgId: "", companyId: "" };
  const declarations = scanDeclarations();
  /** endpoint → the keys the real service actually returned. */
  const observed = new Map<string, Set<string>>();
  const rowCounts = new Map<string, number>();

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM payroll_items WHERE organization_id IN ${org}`);
    for (const t of [
      "payroll_runs",
      "period_locks",
      "budgets",
      "products",
      "fixed_assets",
      "bank_accounts",
      "employees",
      "customers",
      "vendors",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(
      `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`,
    );
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    ctx.orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Shape Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    ctx.companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Shape Co') RETURNING id`, [
        ctx.orgId,
      ])
    ).rows[0].id;
    const o = ctx.orgId;
    const c = ctx.companyId;

    // One row per list. Values are irrelevant; PRESENCE is the whole point,
    // because an empty list has no keys and would pass every assertion.
    const catId = (
      await pool.query(
        `INSERT INTO categories (organization_id, name, name_ar, type)
         VALUES ($1,'Shape Cat','فئة','expense') RETURNING id`,
        [o],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Shape Customer')`, [o]);
    await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Shape Vendor')`, [o]);
    await pool.query(
      `INSERT INTO fixed_assets (organization_id, company_id, asset_number, name, purchase_date,
                                 purchase_cost, useful_life_years, current_book_value)
       VALUES ($1,$2,'FA-SHAPE','Shape Asset','2026-01-01',1000,5,800)`,
      [o, c],
    );
    await pool.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name)
       VALUES ($1,$2,'Shape Acct','Shape Bank')`,
      [o, c],
    );
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, basic_salary)
       VALUES ($1,$2,'EMP-SHAPE','Shape Employee',5000)`,
      [o, c],
    );
    await pool.query(`INSERT INTO products (organization_id, name) VALUES ($1,'Shape Product')`, [o]);
    await pool.query(
      `INSERT INTO budgets (organization_id, company_id, name, period, category_id, budgeted_amount)
       VALUES ($1,$2,'Shape Budget','2026',$3,1200)`,
      [o, c, catId],
    );
    await pool.query(`INSERT INTO payroll_runs (organization_id, company_id, period) VALUES ($1,$2,'2026-07')`, [
      o,
      c,
    ]);
    await pool.query(`INSERT INTO period_locks (organization_id, company_id, period) VALUES ($1,$2,'2026-06')`, [
      o,
      c,
    ]);
    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, document_type,
                             date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,'INV-SHAPE','invoice','2026-07-01','2026-07-31',100,15,115,0,'sent')`,
      [o, c],
    );

    for (const [endpoint, fetchRows] of Object.entries(FIXTURES)) {
      const rows = (await inTenant(ctx, fetchRows)) as Record<string, unknown>[];
      rowCounts.set(endpoint, rows.length);
      observed.set(endpoint, new Set(rows.length > 0 ? Object.keys(rows[0]) : []));
    }
  }, 60_000);

  afterAll(wipe);

  it("🔴 every fixture returned at least one row (anti-vacuity)", () => {
    const empty = [...rowCounts.entries()].filter(([, n]) => n === 0).map(([e]) => e);
    expect(
      empty,
      `These fixtures returned NO rows, so their key sets are empty and every field assertion\n` +
        `below would pass vacuously over them — the confident zero, inside the instrument:\n  ${empty.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the scan still sees the pages it saw when this guard was written", () => {
    expect(
      declarations.length,
      `The scan found ${declarations.length} list declarations, down from ${DECLARATIONS_AT_WRITING}.\n` +
        `Either pages were removed, or a call style changed into one this scanner cannot parse —\n` +
        `which drops pages out of coverage silently. Widen scanDeclarations(), do not lower this number.`,
    ).toBeGreaterThanOrEqual(DECLARATIONS_AT_WRITING);
  });

  it("🔴 every declared field exists in the real response", () => {
    const problems: string[] = [];
    for (const d of declarations) {
      const keys = observed.get(d.endpoint);
      if (!keys) continue; // uncovered — reported by its own test below
      const allowed = ALLOWED_ABSENT[d.file] ?? {};
      const missing = d.fields.filter((f) => !keys.has(f) && !(f in allowed));
      if (missing.length > 0) {
        problems.push(
          `${d.file} declares ${d.type} for GET ${d.endpoint} with ${missing.length} field(s) the ` +
            `endpoint does not return: ${missing.join(", ")}\n` +
            `      the response actually carries: ${[...keys].sort().join(", ")}`,
        );
      }
    }
    expect(
      problems,
      `A page is reading fields the API never sends. TypeScript cannot see this — apiFetch<T>\n` +
        `is a cast — and the symptom is a plausible wrong number, not an error:\n\n  ${problems.join("\n\n  ")}\n\n` +
        `Fix the page to use the real field names, or make the endpoint return the field.\n` +
        `Do NOT add it to ALLOWED_ABSENT if the page computes with it.`,
    ).toEqual([]);
  });

  it("🔴 a page reading an ENVELOPE endpoint does not declare a bare array", () => {
    const problems: string[] = [];
    for (const d of declarations) {
      if (!ENVELOPE_ENDPOINTS.has(d.endpoint)) continue;
      const src = readFileSync(join(repoRoot, d.file), "utf8");
      // The page must dereference `items` somewhere — the paginated shape.
      if (!src.includes(".items")) {
        problems.push(`${d.file} declares ${d.type}[] for GET ${d.endpoint}, which returns {items, page, totals}`);
      }
    }
    expect(
      problems,
      `GET on a paginated endpoint returns an OBJECT. A page that treats it as an array throws on the\n` +
        `first .filter/.reduce and renders NOTHING — B1's blank page, exactly:\n  ${problems.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every declared endpoint is either measured or named as uncovered", () => {
    const endpoints = [...new Set(declarations.map((d) => d.endpoint))];
    const unaccounted = endpoints.filter((e) => !(e in FIXTURES) && !(e in UNCOVERED));
    expect(
      unaccounted,
      `A page declares a response type for an endpoint this guard neither measures nor lists as a\n` +
        `known gap, so its claim is unchecked and nothing says so:\n  ${unaccounted.join("\n  ")}\n\n` +
        `Add a fixture to FIXTURES (preferred), or an entry to UNCOVERED stating what it would take.`,
    ).toEqual([]);
  });
});
