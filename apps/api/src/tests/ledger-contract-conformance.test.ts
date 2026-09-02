/**
 * LEDGER CONTRACT CONFORMANCE — journal entries, payroll, employees and fixed
 * assets, validated against the generated Zod schemas on REAL ROWS (contract
 * milestone, batch 4). Same instrument as the report, party and document
 * suites: responses parse after a JSON round-trip; bodies are the generated
 * ones; rows are asserted PRESENT before any schema is checked.
 *
 * ── 🔴 THE CONFIDENT ZERO THIS BATCH WAS WRITTEN AROUND ─────────────────────
 * The journal-entry LIST used to be built from header rows only:
 * `buildJEOut(row)` with no lines gave every list row `totalDebit: 0,
 * totalCredit: 0, lines: []` — and the ledger page rendered those zeros in its
 * debit/credit columns and read `lines` from the same rows for its detail
 * panel. The list case below asserts the seeded entry's totals are the seeded
 * amounts, not zero. (The detail panel now fetches the entry.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import {
  ListJournalEntriesResponse,
  CreateJournalEntryBody,
  CreateJournalEntryResponse,
  GetJournalEntryResponse,
  PostJournalEntryResponse,
  ReverseJournalEntryResponse,
  ListPayrollRunsResponse,
  CreatePayrollRunBody,
  CreatePayrollRunResponse,
  GetPayrollRunResponse,
  ApprovePayrollRunResponse,
  ListEmployeesResponse,
  CreateEmployeeBody,
  CreateEmployeeResponse,
  UpdateEmployeeBody,
  UpdateEmployeeResponse,
  GetEmployeeResponse,
  ListAssetsResponse,
  CreateAssetBody,
  CreateAssetResponse,
  UpdateAssetBody,
  UpdateAssetResponse,
  GetAssetResponse,
  DepreciateAssetBody,
  DepreciateAssetResponse,
} from "@workspace/api-zod";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { payrollService } from "../services/payroll.service";
import { employeesService } from "../services/employees.service";
import { assetsService } from "../services/assets.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[ledger-contract-conformance] no real DATABASE_URL — skipping.");

const SLUG = "ledger-contract";
const EMAIL = "ledger-contract@test.local";
const DATE = "2026-06-15";

type ParseResult = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };
function issues(r: ParseResult): string {
  if (r.success || !r.error) return "";
  return r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
}

describeMaybe("ledger contract conformance — journal entries, payroll, employees, assets on real rows", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let cash = { id: 0, name: "" };
  let equity = { id: 0, name: "" };

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of ["payroll_items", "payroll_runs", "depreciation_entries", "fixed_assets", "employees", "journal_entry_lines", "journal_entries", "document_numbers"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Ledger Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'Ledger Co','1010101059') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','LC',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    const c = await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`, [orgId]);
    const e = await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND type = 'equity' ORDER BY id LIMIT 1`, [orgId]);
    cash = { id: Number(c.rows[0].id), name: c.rows[0].name };
    equity = { id: Number(e.rows[0].id), name: e.rows[0].name };
  });

  afterAll(cleanup);

  function conforms(schema: { safeParse: (v: unknown) => ParseResult }, value: unknown, label: string) {
    const r = schema.safeParse(JSON.parse(JSON.stringify(value)));
    expect(r.success, `${label} does not conform to its generated schema:\n${issues(r)}`).toBe(true);
  }

  // ── journal entries ─────────────────────────────────────────────────────
  let jeId = 0;

  it("POST /journal-entries — a balanced draft with its lines", async () => {
    expect(CreateJournalEntryBody.safeParse({ date: DATE, description: "x", lines: [{ accountId: cash.id, accountName: "Cash", debitAmount: 1, creditAmount: 0 }] }).success).toBe(false); // minItems 2
    expect(CreateJournalEntryBody.safeParse({ date: DATE, description: "x", lines: [{ accountName: "Cash", debitAmount: 1, creditAmount: 0 }, { accountName: "Equity", debitAmount: 0, creditAmount: 1 }] }).success).toBe(false); // accountId required
    const body = CreateJournalEntryBody.parse({
      date: DATE,
      description: "Owner capital",
      lines: [
        { accountId: cash.id, accountName: cash.name, debitAmount: 5000, creditAmount: 0 },
        { accountId: equity.id, accountName: equity.name, debitAmount: 0, creditAmount: 5000 },
      ],
    });
    const out = await inTenant(() => journalEntriesService.create(body, userId));
    jeId = out.id;
    expect(out.status).toBe("draft");
    expect(out.totalDebit).toBe(5000);
    expect(out.lines.length).toBe(2);
    conforms(CreateJournalEntryResponse, out, "createJournalEntry");
  });

  it("🔴 GET /journal-entries — each LIST row carries ITS OWN totals (they used to be zero)", async () => {
    const out = await inTenant(() => journalEntriesService.list({ limit: 50, offset: 0 }));
    expect(out.items.length).toBeGreaterThan(0);
    const mine = out.items.find((e) => e.id === jeId);
    expect(mine?.totalDebit).toBe(5000);
    expect(mine?.totalCredit).toBe(5000);
    conforms(ListJournalEntriesResponse, out, "listJournalEntries");
  });

  it("GET /journal-entries/{id} — with its lines", async () => {
    const out = await inTenant(() => journalEntriesService.getById(jeId));
    expect(out.lines.length).toBe(2);
    conforms(GetJournalEntryResponse, out, "getJournalEntry");
  });

  it("POST /journal-entries/{id}/post and /reverse — the original STAYS in the books", async () => {
    const posted = await inTenant(() => journalEntriesService.post(jeId, userId));
    expect(posted.status).toBe("posted");
    conforms(PostJournalEntryResponse, posted, "postJournalEntry");
    const rev = await inTenant(() => journalEntriesService.reverse(jeId));
    expect(rev.reversal.status).toBe("posted");
    expect(rev.reversal.lines.length).toBe(2);
    conforms(ReverseJournalEntryResponse, rev, "reverseJournalEntry");
    const original = await inTenant(() => journalEntriesService.getById(jeId));
    expect(original.status).toBe("reversed");
  });

  it("DELETE /journal-entries/{id} — drafts only", async () => {
    const d = await inTenant(() => journalEntriesService.create(CreateJournalEntryBody.parse({ date: DATE, description: "tmp", lines: [{ accountId: cash.id, accountName: cash.name, debitAmount: 1, creditAmount: 0 }, { accountId: equity.id, accountName: equity.name, debitAmount: 0, creditAmount: 1 }] }), userId));
    await inTenant(() => journalEntriesService.deleteDraft(d.id));
    await expect(inTenant(() => journalEntriesService.getById(d.id))).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── employees ───────────────────────────────────────────────────────────
  let employeeId = 0;

  it("POST /employees — Saudi and non-Saudi, with DERIVED gross and GOSI", async () => {
    expect(CreateEmployeeBody.safeParse({ name: "x", basicSalary: "" }).success).toBe(false);
    const sa = await inTenant(() => employeesService.create(CreateEmployeeBody.parse({ employeeNumber: "E-1", name: "Saudi Employee", nationality: "SA", basicSalary: 10000, housingAllowance: 2000, transportAllowance: 500 })));
    employeeId = sa.id;
    expect(sa.grossSalary).toBe(12500);
    expect(sa.gosiEmployee).toBeCloseTo(975, 2);
    conforms(CreateEmployeeResponse, sa, "createEmployee(SA)");
    const other = await inTenant(() => employeesService.create(CreateEmployeeBody.parse({ employeeNumber: "E-2", name: "Expat Employee", nationality: "EG", basicSalary: 6000 })));
    expect(other.gosiEmployee).toBe(0);
    conforms(CreateEmployeeResponse, other, "createEmployee(non-SA)");
  });

  it("GET /employees — a page with set-wide totals; GET/PATCH /employees/{id}", async () => {
    const out = await inTenant(() => employeesService.list({ limit: 50, offset: 0 }));
    expect(out.items.length).toBe(2);
    expect(out.totals.saudiCount).toBe(1);
    conforms(ListEmployeesResponse, out, "listEmployees");
    const one = await inTenant(() => employeesService.getById(employeeId));
    conforms(GetEmployeeResponse, one, "getEmployee");
    const upd = await inTenant(() => employeesService.update(employeeId, UpdateEmployeeBody.parse({ department: "Finance" })));
    expect(upd.department).toBe("Finance");
    conforms(UpdateEmployeeResponse, upd, "updateEmployee");
  });

  // ── payroll ─────────────────────────────────────────────────────────────
  let runId = 0;

  it("POST /payroll — a draft run from every active employee; GET /payroll and /payroll/{id}", async () => {
    expect(CreatePayrollRunBody.safeParse({}).success).toBe(false);
    const run = await inTenant(() => payrollService.create(CreatePayrollRunBody.parse({ period: "2026-06" }), userId));
    runId = run.id;
    expect(run.status).toBe("draft");
    expect(run.totalNetPay).toBeGreaterThan(0);
    conforms(CreatePayrollRunResponse, run, "createPayrollRun");
    const list = await inTenant(() => payrollService.list());
    expect(list.length).toBe(1);
    expect(list[0].employeeCount).toBe(2);
    conforms(ListPayrollRunsResponse, list, "listPayrollRuns");
    const detail = await inTenant(() => payrollService.getById(runId));
    expect(detail.items.length).toBe(2);
    expect(detail.items.every((i) => typeof i.employeeName === "string")).toBe(true);
    conforms(GetPayrollRunResponse, detail, "getPayrollRun");
  });

  it("POST /payroll/{id}/approve — posted to the GL, and the response conforms", async () => {
    const out = await inTenant(() => payrollService.approve(runId, userId));
    expect(out.status).not.toBe("draft");
    conforms(ApprovePayrollRunResponse, out, "approvePayrollRun");
  });

  // ── assets ──────────────────────────────────────────────────────────────
  let assetId = 0;

  it("POST /assets, GET /assets (with totals), GET/PATCH /assets/{id}", async () => {
    expect(CreateAssetBody.safeParse({ assetNumber: "A", name: "x", purchaseDate: DATE, purchaseCost: 1000, usefulLifeYears: 0 }).success).toBe(false);
    const a = await inTenant(() => assetsService.create(CreateAssetBody.parse({ assetNumber: "FA-1", name: "Laptop", purchaseDate: DATE, purchaseCost: 12000, salvageValue: 0, usefulLifeYears: 5 })));
    assetId = a.id;
    expect(a.monthlyDepreciation).toBe(200);
    conforms(CreateAssetResponse, a, "createAsset");
    const list = await inTenant(() => assetsService.list({ limit: 50, offset: 0 }));
    expect(list.items.length).toBe(1);
    expect(list.totals.activeCount).toBe(1);
    conforms(ListAssetsResponse, list, "listAssets");
    const got = await inTenant(() => assetsService.getById(assetId));
    conforms(GetAssetResponse, got, "getAsset");
    const upd = await inTenant(() => assetsService.update(assetId, UpdateAssetBody.parse({ location: "HQ" })));
    expect(upd.location).toBe("HQ");
    conforms(UpdateAssetResponse, upd, "updateAsset");
  });

  it("POST /assets/{id}/depreciate — one month, and the history shows it", async () => {
    expect(DepreciateAssetBody.safeParse({}).success).toBe(false);
    const entry = await inTenant(() => assetsService.depreciate(assetId, DepreciateAssetBody.parse({ period: "2026-07" }).period));
    expect(entry.amount).toBe(200);
    expect(entry.bookValueAfter).toBe(11800);
    conforms(DepreciateAssetResponse, entry, "depreciateAsset");
    const got = await inTenant(() => assetsService.getById(assetId));
    expect(got.depreciationHistory.length).toBe(1);
    expect(got.accumulatedDepreciation).toBe(200);
    conforms(GetAssetResponse, got, "getAsset(after depreciation)");
  });

  it("🔴 the instrument is not vacuous — a wrong shape FAILS", async () => {
    const list = await inTenant(() => journalEntriesService.list({ limit: 50, offset: 0 }));
    const broken = { ...list, items: list.items.map(({ totalDebit, ...r }) => ({ ...r, debit: totalDebit })) };
    expect(ListJournalEntriesResponse.safeParse(JSON.parse(JSON.stringify(broken))).success).toBe(false);
    expect(ListPayrollRunsResponse.safeParse([{ id: 1, period: "2026-01", status: "draft" }]).success).toBe(false);
  });
});
