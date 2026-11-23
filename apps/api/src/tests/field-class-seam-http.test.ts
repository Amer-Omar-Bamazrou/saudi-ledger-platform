/**
 * 🔴 19B S1 — THE SEAM END TO END, through the real application over HTTP.
 *
 *  1. S1's matrix (PERMISSION_MATRIX with S2a's twelve restored): every role reads the employee whole, and every role
 *     allowed to edit employees writes every field. 🔴 S2a's matrix (PERMISSION_MATRIX since the removal, restated
 *     2026-11-23): an accountant and an admin still do; a bookkeeper reads no identity or pay and the IBAN's last four,
 *     a viewer no identity, pay or IBAN at all, X-Withheld naming each; a bookkeeper's pay write is refused by name.
 *  2. With a grant removed, as an approved S2 removal would leave the table: the field is absent from the response
 *     (never null), the `X-Withheld` header names it, and the rest is served; a write of a field the role may not write
 *     is refused by name and NOTHING is saved; the same request without that field succeeds. Movement: restoring the
 *     grant serves the field again.
 *  3. The seam on its own (a bare app, no database): non-2xx answers pass through; the test lane answers an
 *     unclassified key 500 `field_unclassified`, naming it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";
import { PERMISSION_MATRIX, S2A_REMOVALS, fieldGrantAction } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { fieldClassSeam, WITHHELD_HEADER } from "../lib/fieldClasses/seam";
import { g04Harness } from "./helpers/g04Harness";
import { appOriginHeader } from "./helpers/appOrigin";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeDb = REAL_DB ? describe : describe.skip;

const PW = "s1-seam-password-2026";
const h = g04Harness("s1-seam");
/** S1's matrix: today's PERMISSION_MATRIX with S2a's twelve removals restored — the base the mechanism tests below need. */
const S1_MATRIX = [...PERMISSION_MATRIX, ...S2A_REMOVALS.map(({ role, resource, action }) => ({ role, resource, action }))];
const without = (...grants: [role: string, resource: string, action: string][]) =>
  S1_MATRIX.filter((r) => !grants.some(([role, resource, action]) => r.role === role && r.resource === resource && r.action === action));

describeDb("19B S1 — the seam through the application", () => {
  let employeeId = 0;

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S1 Seam Co", "319191919191943");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    const created = await h.api("admin", "POST", "/employees", {
      employeeNumber: "S1-1", name: "Hala", nationalId: "1012345678", nationality: "SA", basicSalary: 9000,
      iban: "SA0380000000608010167519", bank: "Rajhi", joiningDate: "2024-01-01", status: "active", gosiRegime: "law_2024",
      gosiRegimeBasis: "certificate",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    employeeId = created.body.id;
  });

  afterAll(async () => {
    primePermissionCache(PERMISSION_MATRIX);
    await h.stop();
    await h.cleanup();
  });

  // Restated for S2a (2026-11-23): this read PERMISSION_MATRIX, which no longer holds the twelve; S1's matrix is rebuilt.
  it("🔴 S1's matrix (the twelve restored): every role reads the employee whole; every role that edits employees writes every field", async () => {
    primePermissionCache(S1_MATRIX);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) {
      const r = await h.api(role, "GET", `/employees/${employeeId}`);
      expect(r.status, role).toBe(200);
      expect([r.body.nationalId, r.body.basicSalary, r.body.iban], role).toEqual(["1012345678", 9000, "SA0380000000608010167519"]);
    }
    for (const role of ["admin", "accountant", "bookkeeper"]) {
      const r = await h.api(role, "PATCH", `/employees/${employeeId}`, { basicSalary: 9000, nationalId: "1012345678", status: "active" });
      expect(r.status, `${role}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    primePermissionCache(PERMISSION_MATRIX);
  });

  it("🔴 S2a's matrix (PERMISSION_MATRIX): the accountant and the admin read and write it whole; the bookkeeper and the viewer are served exactly their classes, named", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    for (const role of ["admin", "accountant"]) {
      const r = await h.api(role, "GET", `/employees/${employeeId}`);
      expect([r.body.nationalId, r.body.basicSalary, r.body.iban, r.headers["x-withheld"] ?? null], role).toEqual(["1012345678", 9000, "SA0380000000608010167519", null]);
      const w = await h.api(role, "PATCH", `/employees/${employeeId}`, { basicSalary: 9000, nationalId: "1012345678", status: "active" });
      expect(w.status, `${role}: ${JSON.stringify(w.body)}`).toBe(200);
    }
    const keeper = await h.api("bookkeeper", "GET", `/employees/${employeeId}`);
    expect([keeper.status, keeper.body.name, keeper.body.iban, "nationalId" in keeper.body, "basicSalary" in keeper.body]).toEqual([200, "Hala", "•••• 7519", false, false]);
    const keeperWithheld = JSON.parse(keeper.headers["x-withheld"] ?? "[]") as { path: string; class: string; level: string }[];
    expect(keeperWithheld).toEqual(expect.arrayContaining([{ path: "nationalId", class: "identity", level: "none" }, { path: "basicSalary", class: "compensation", level: "none" }, { path: "iban", class: "bank_account", level: "last4" }]));
    const viewer = await h.api("viewer", "GET", `/employees/${employeeId}`);
    expect([viewer.status, viewer.body.name, "iban" in viewer.body, "nationalId" in viewer.body, "basicSalary" in viewer.body]).toEqual([200, "Hala", false, false, false]);
    expect(JSON.parse(viewer.headers["x-withheld"] ?? "[]")).toEqual(expect.arrayContaining([{ path: "iban", class: "bank_account", level: "none" }]));
    const refused = await h.api("bookkeeper", "PATCH", `/employees/${employeeId}`, { basicSalary: 1 });
    expect([refused.status, refused.body.code]).toEqual([403, "field_write_not_granted"]);
    expect((await h.api("bookkeeper", "PATCH", `/employees/${employeeId}`, { nationalId: "1012345678" })).status).toBe(200); // written, never read back
  });

  it("🔴 a removed read grant: the field is ABSENT and named; the rest is served; restoring it serves it again", async () => {
    primePermissionCache(without(["viewer", "employees", fieldGrantAction("compensation", "read")]));
    const r = await h.api("viewer", "GET", `/employees/${employeeId}`);
    expect(r.status).toBe(200);
    expect("basicSalary" in r.body).toBe(false);
    expect("grossSalary" in r.body).toBe(false);
    expect(r.body.name).toBe("Hala");
    expect(r.body.nationalId).toBe("1012345678");
    const admin = await h.api("admin", "GET", `/employees/${employeeId}`); // the role the removal did not touch
    expect(admin.body.basicSalary).toBe(9000);
    primePermissionCache(S1_MATRIX); // restored (S1's matrix: the viewer then reads pay)
    expect((await h.api("viewer", "GET", `/employees/${employeeId}`)).body.basicSalary).toBe(9000);
    primePermissionCache(PERMISSION_MATRIX);
  });

  it("🔴 a removed write grant: the write is REFUSED BY NAME and nothing is saved; without that field it saves", async () => {
    primePermissionCache(without(["bookkeeper", "employees", fieldGrantAction("compensation", "write")]));
    const refused = await h.api("bookkeeper", "PATCH", `/employees/${employeeId}`, { jobTitle: "Clerk", basicSalary: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("field_write_not_granted");
    expect(refused.body.fields).toEqual([{ field: "basicSalary", class: "compensation", resource: "employees" }]);
    const after = await h.api("admin", "GET", `/employees/${employeeId}`);
    expect([after.body.basicSalary, after.body.jobTitle]).toEqual([9000, null]); // NOTHING of the refused request saved
    const saved = await h.api("bookkeeper", "PATCH", `/employees/${employeeId}`, { jobTitle: "Clerk" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await h.api("admin", "GET", `/employees/${employeeId}`)).body.jobTitle).toBe("Clerk");
    primePermissionCache(PERMISSION_MATRIX);
  });
});

describe("the seam on a bare app (no database)", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).tenant = { role: req.header("x-role") ?? "viewer" };
      next();
    });
    app.use(fieldClassSeam);
    app.get("/api/employees/:id", (req, res) => {
      if (req.params.id === "404") return void res.status(404).json({ error: "no", surprise: 1 });
      res.json({ id: 1, name: "Hala", nationalId: "1012345678", ...(req.params.id === "2" ? { surprise: 1 } : {}) });
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api`;
  });
  afterAll(async () => {
    primePermissionCache(PERMISSION_MATRIX);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("withholds by the role's grants and names it in X-Withheld; S1's matrix sends no header; S2a's withholds the viewer's national ID", async () => {
    primePermissionCache(PERMISSION_MATRIX); // S2a's matrix: the viewer reads no identity (restated 2026-11-23)
    const s2a = await fetch(`${base}/employees/1`);
    expect(JSON.parse(s2a.headers.get(WITHHELD_HEADER) ?? "[]")).toEqual([{ path: "nationalId", class: "identity", level: "none" }]);
    primePermissionCache(S1_MATRIX);
    const full = await fetch(`${base}/employees/1`, { headers: { ...appOriginHeader() } });
    expect(full.headers.get(WITHHELD_HEADER)).toBeNull();
    expect((await full.json()).nationalId).toBe("1012345678");
    primePermissionCache(without(["viewer", "employees", fieldGrantAction("identity", "read")]));
    const cut = await fetch(`${base}/employees/1`);
    expect(JSON.parse(cut.headers.get(WITHHELD_HEADER) ?? "[]")).toEqual([{ path: "nationalId", class: "identity", level: "none" }]);
    expect(await cut.json()).toEqual({ id: 1, name: "Hala" });
  });

  it("🔴 the test lane: a key the table cannot classify fails the response, naming it; a non-2xx answer passes through", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const r = await fetch(`${base}/employees/2`);
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.code).toBe("field_unclassified");
    expect(body.fields).toEqual(["Employee.surprise"]);
    const notFound = await fetch(`${base}/employees/404`);
    expect(notFound.status).toBe(404);
  });
});
