/**
 * 🔴 19B S6 (control 19B-S6a) — SAVED REPORTS: a definition (dataset, columns in order, period, filters, sort) owned by a
 * member, optionally shared with roles of the same organization. v4 §4 and §6.2; scope 19.9–19.13.
 *
 *  - THE ROLE × ACT MATRIX for `save` and `share`: every role saves what it may run and no more (a viewer is refused
 *    the VAT lines, D3); a viewer may not share.
 *  - THE BUILDER CANNOT NAME WHAT THE DATASET DOES NOT OFFER: an unknown column, an undeclared filter, a sort the
 *    dataset does not support, a malformed period — each refused by name, nothing stored.
 *  - SHOWING A WITHHELD COLUMN is allowed, and it comes back withheld at every run. (No dataset today offers a filter
 *    or a sort on a protected column, so the refusal of such a USE at save cannot be reached through one; decide()'s
 *    own suite holds it on a constructed dataset, and the save goes through that same decide().)
 *  - SHARING NEVER WIDENS: a definition shared with a role that cannot run its dataset is listed for nobody of that
 *    role, and the dataset's own endpoint still refuses them (the run re-checks at every request).
 *  - OWNERSHIP: only the owner changes, shares or archives; another member who can see it is told so (403), one who
 *    cannot gets 404 — the same answer as a missing one.
 *  - ISOLATION (presence, absence, movement): another organization's, and another company's, definition is not listed
 *    and reads as not found here — and IS listed there.
 *
 * DB-backed; skips on the DB-free placeholder.
 */
process.env.PORT ??= "3261";
process.env.SESSION_SECRET ??= "s6-report-definitions-00000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, type PermissionRow } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s6-report-definitions-password-26";
const h = g04Harness("s6def");
const DEFS = "/report-definitions";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;

const body = (over: Record<string, unknown> = {}) => ({
  name: "October sales",
  dataset: "sales_documents",
  columns: ["documentNumber", "date", "customerName", "signedTotal"],
  period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" },
  filters: {},
  sort: "-date",
  ...over,
});
const noViewerBankText = PERMISSION_MATRIX.filter((r: PermissionRow) => !(r.role === "viewer" && r.resource === "journal_entries" && r.action === "field.bank_narrative.read"));

describeDb("19B S6 — saved report definitions", () => {
  let orgId = "";
  let otherOrgId = "";
  let companyId = "";
  let secondCompanyId = "";
  const ids: Record<string, number> = {};
  const stored = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM report_definitions WHERE organization_id = $1`, [orgId])).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S6 Definitions Co", "319191919191961");
    secondCompanyId = await h.mkCompany(orgId, "S6 Second Co", "319191919191979");
    for (const role of ROLES) ids[role] = await h.mkUser(role, PW, orgId, role);
    ids.accountant2 = await h.mkUser("accountant2", PW, orgId, "accountant");
    for (const who of [...ROLES, "accountant2"]) expect(await h.login(who, h.email(who), PW)).toBe(200);
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "S6 Other Org Co", "319191919191987");
    ids.outsider = await h.mkUser("outsider", PW, otherOrgId, "admin");
    expect(await h.login("outsider", h.email("outsider"), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 save, by role: each role saves the datasets it may run; a viewer is refused the VAT lines, by name", async () => {
    const out: Record<string, number[]> = {};
    for (const role of ROLES) {
      const sales = await h.api(role, "POST", DEFS, body({ name: `${role} sales` }));
      const vat = await h.api(role, "POST", DEFS, body({ name: `${role} vat`, dataset: "vat_lines", columns: ["documentNumber", "vat"], sort: null }));
      out[role] = [sales.status, vat.status];
      if (vat.status !== 201) expect([vat.body.code, vat.body.act]).toEqual(["report_dataset_not_granted", "save"]);
    }
    // v4 §6.2: the VAT lines are not a viewer dataset (D3); every writing role runs all five as the matrix stands
    expect(out).toEqual({ admin: [201, 201], accountant: [201, 201], bookkeeper: [201, 201], viewer: [201, 403] });
    const saved = await h.api("viewer", "POST", DEFS, body({ name: "viewer shape" }));
    expect(saved.body).toMatchObject({
      name: "viewer shape", dataset: "sales_documents", columns: ["documentNumber", "date", "customerName", "signedTotal"],
      period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, filters: {}, sort: "-date", sharedRoles: [], mine: true, ownerUserId: ids.viewer,
    });
    expect(typeof saved.body.ownerName).toBe("string");
    expect(JSON.stringify(saved.body)).not.toContain("@test.local"); // the owner is a name, never an email
  });

  it("🔴 the builder cannot name what the dataset does not offer — each refused by name, and nothing is stored", async () => {
    const before = await stored();
    const tries: [Record<string, unknown>, number, string][] = [
      [{ dataset: "payroll_lines" }, 400, "report_unknown_dataset"],
      [{ columns: ["documentNumber", "salary"] }, 400, "report_unknown_column"],
      [{ sort: "customerName" }, 400, "report_unknown_column"], // a real column the dataset does not sort by
      [{ filters: { account_id: "5" } }, 400, "report_bad_filter"], // journal lines declare it; sales documents do not
      [{ period: { kind: "fixed", from: "2026-10-31", to: "2026-10-01" } }, 400, "report_bad_filter"],
      [{ period: { kind: "fixed", from: "2026-02-30", to: "2026-03-01" } }, 400, "report_bad_filter"],
      [{ period: { kind: "next_decade" } }, 400, "report_bad_filter"],
      [{ name: "   " }, 400, "report_bad_filter"],
      [{ dataset: "vat_lines", columns: ["vat"], sort: null, period: { kind: "fixed", from: null, to: null } }, 400, "report_bad_filter"],
    ];
    for (const [over, status, code] of tries) {
      const r = await h.api("admin", "POST", DEFS, body(over));
      expect([r.status, r.body.code], JSON.stringify(over)).toEqual([status, code]);
      expect(typeof r.body.errorAr, JSON.stringify(over)).toBe("string");
    }
    expect(await stored()).toBe(before);
    // a relative period is stored as its name — resolved at every run, never frozen into dates
    const rel = await h.api("admin", "POST", DEFS, body({ name: "last month", period: { kind: "last_month" } }));
    expect([rel.status, rel.body.period]).toEqual([201, { kind: "last_month", from: null, to: null }]);
  });

  it("🔴 a saved report may SHOW a column its author cannot read: the run withholds it; a filter on a standard column is saved", async () => {
    primePermissionCache(noViewerBankText);
    try {
      const jl = { dataset: "journal_lines", columns: ["date", "entryNumber", "description", "debit"], sort: "-date" };
      const shown = await h.api("viewer", "POST", DEFS, body({ name: "lines with text", ...jl }));
      expect(shown.status, JSON.stringify(shown.body)).toBe(201);
      const run = await h.api("viewer", "GET", `/reports/datasets/journal_lines/rows?columns=${jl.columns.join(",")}&date_from=2026-10-01&date_to=2026-10-31`);
      expect(run.status).toBe(200);
      expect(run.body.columns.find((c: { key: string }) => c.key === "description").level).toBe("none");
      const before = await stored();
      const filterWithheld = await h.api("viewer", "POST", DEFS, body({ name: "by source", ...jl, filters: { source_type: "manual" } }));
      expect(filterWithheld.status, "sourceType is standard: a viewer may filter by it").toBe(201);
      expect(await stored()).toBe(before + 1);
    } finally { primePermissionCache(PERMISSION_MATRIX); }
  });

  it("🔴 share: a viewer may not; the owner shares with roles; sharing never widens what a role may run", async () => {
    const mine = await h.api("viewer", "POST", DEFS, body({ name: "viewer wants to share" }));
    const refused = await h.api("viewer", "PUT", `${DEFS}/${mine.body.id}/share`, { roles: ["bookkeeper"] });
    expect([refused.status, refused.body.code, refused.body.act]).toEqual([403, "report_act_not_granted", "share"]);

    const cash = await h.api("accountant", "POST", DEFS, body({ name: "cash, shared", dataset: "cash_movements", columns: ["date", "signedAmount"], sort: "-date" }));
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    const bad = await h.api("accountant", "PUT", `${DEFS}/${cash.body.id}/share`, { roles: ["owner"] });
    expect([bad.status, bad.body.code]).toEqual([400, "report_bad_filter"]);
    const shared = await h.api("accountant", "PUT", `${DEFS}/${cash.body.id}/share`, { roles: ["viewer", "bookkeeper"] });
    expect([shared.status, shared.body.sharedRoles]).toEqual([200, ["bookkeeper", "viewer"]]);

    const names = async (who: string) => ((await h.api(who, "GET", DEFS)).body.items as { name: string; mine: boolean }[]).filter((d) => d.name === "cash, shared").map((d) => d.mine);
    // presence: the bookkeeper (who runs cash movements) sees it, as someone else's; absence: the viewer (who cannot) does not
    expect([await names("accountant"), await names("bookkeeper"), await names("viewer"), await names("admin")]).toEqual([[true], [false], [], []]);
    expect((await h.api("viewer", "GET", `${DEFS}/${cash.body.id}`)).status).toBe(404);
    expect((await h.api("viewer", "GET", "/reports/datasets/cash_movements/rows?date_from=2026-10-01&date_to=2026-10-31")).status).toBe(403);
    // movement: unshared, the bookkeeper loses it too
    await h.api("accountant", "PUT", `${DEFS}/${cash.body.id}/share`, { roles: [] });
    expect(await names("bookkeeper")).toEqual([]);
  });

  it("🔴 only the owner changes, shares or archives a definition; a member who can see it is told so, one who cannot gets 404", async () => {
    const d = await h.api("accountant", "POST", DEFS, body({ name: "owned" }));
    await h.api("accountant", "PUT", `${DEFS}/${d.body.id}/share`, { roles: ["accountant", "admin"] });
    for (const [method, path, payload] of [["PUT", "", body({ name: "taken" })], ["PUT", "/share", { roles: [] }], ["DELETE", "", undefined]] as const) {
      const seen = await h.api("accountant2", method, `${DEFS}/${d.body.id}${path}`, payload);
      expect([seen.status, seen.body.code], `${method} ${path}`).toEqual([403, "report_definition_not_owner"]);
      const unseen = await h.api("bookkeeper", method, `${DEFS}/${d.body.id}${path}`, payload);
      expect(unseen.status, `${method} ${path}`).toBe(404);
    }
    const changed = await h.api("accountant", "PUT", `${DEFS}/${d.body.id}`, body({ name: "renamed", columns: ["date", "total"], sort: null }));
    expect([changed.status, changed.body.name, changed.body.columns, changed.body.sort, changed.body.sharedRoles]).toEqual([200, "renamed", ["date", "total"], null, ["accountant", "admin"]]);
    // a change is checked like a save: the owner cannot edit a definition into naming an unknown column
    expect((await h.api("accountant", "PUT", `${DEFS}/${d.body.id}`, body({ columns: ["nope"] }))).body.code).toBe("report_unknown_column");
    expect((await h.api("accountant", "DELETE", `${DEFS}/${d.body.id}`)).status).toBe(204);
    expect((await h.api("accountant", "GET", `${DEFS}/${d.body.id}`)).status).toBe(404);
    expect((await h.api("accountant2", "GET", DEFS)).body.items.map((x: { id: number }) => x.id)).not.toContain(d.body.id);
    // archived, never deleted: a schedule or a delivery that names it keeps its row
    expect((await pool.query(`SELECT archived_at IS NOT NULL AS archived FROM report_definitions WHERE id = $1`, [d.body.id])).rows[0].archived).toBe(true);
  });

  it("🔴 isolation: another organization's, and another company's, definition is absent here and present there", async () => {
    const here = await h.api("admin", "POST", DEFS, body({ name: "ISO here" }));
    const there = await h.api("outsider", "POST", DEFS, body({ name: "ISO other org" }));
    expect([here.status, there.status]).toEqual([201, 201]);
    // a second company's definition, written under that company's own tenant scope and shared with every role
    const secondId = await h.inTenant(orgId, secondCompanyId, ids.admin, async () => {
      const { db, reportDefinitionsTable } = await import("@workspace/db");
      const [row] = await db.insert(reportDefinitionsTable).values({
        organizationId: orgId, companyId: secondCompanyId, ownerUserId: ids.admin, name: "ISO second company", dataset: "sales_documents",
        columns: ["date"], periodKind: "this_month", filters: {}, sharedRoles: ["admin", "accountant", "bookkeeper", "viewer"],
      }).returning({ id: reportDefinitionsTable.id });
      return row!.id;
    });
    const iso = async (who: string) => ((await h.api(who, "GET", DEFS)).body.items as { name: string }[]).map((d) => d.name).filter((n) => n.startsWith("ISO")).sort();
    expect(await iso("admin")).toEqual(["ISO here"]);
    expect(await iso("outsider")).toEqual(["ISO other org"]); // movement: the other organization shows its own
    for (const id of [there.body.id, secondId]) {
      expect((await h.api("admin", "GET", `${DEFS}/${id}`)).status, String(id)).toBe(404);
      expect((await h.api("admin", "PUT", `${DEFS}/${id}`, body())).status, String(id)).toBe(404);
      expect((await h.api("admin", "DELETE", `${DEFS}/${id}`)).status, String(id)).toBe(404);
    }
    // movement: the second company's row is there, under its own scope
    const inSecond = await h.inTenant(orgId, secondCompanyId, ids.admin, async () => {
      const { reportDefinitionsRepository } = await import("../repositories/reportDefinitions.repository");
      return (await reportDefinitionsRepository.listVisible(ids.admin, "admin")).map((d) => d.name);
    });
    expect(inSecond).toEqual(["ISO second company"]);
    expect(companyId).not.toBe(secondCompanyId);
  });
});
