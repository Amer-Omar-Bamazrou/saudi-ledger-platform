/**
 * 🔴 19B S1 (v4 §4) — THE SEAM'S OWN TESTS, without a database: the walk on planted shapes, the decider, the real
 * contract's employee response, the write check, and the performance budget.
 *
 * S1 withholds nothing (every role holds every grant), so the tests that SHOW withholding prime a matrix with a grant
 * removed — the state an approved S2 removal produces. They prove the mechanism S2 switches on; the HTTP suite
 * (field-class-seam-http.test.ts) proves it end to end, and that S1's own matrix changes nothing.
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_MATRIX, S2A_REMOVALS, fieldGrantAction } from "@workspace/db";
import { fieldSpec } from "../lib/fieldClasses/classTable";
import { walkValue, lastFour, type FieldLookup, type ReadDecider } from "../lib/fieldClasses/walk";
import type { Shape } from "../lib/fieldClasses/shapes";
import { classifyResponse, deciderFor } from "../lib/fieldClasses/seam";
import { fieldWriteRefusal, fieldsWritten } from "../lib/fieldClasses/writeCheck";
import { CONTRACT } from "../lib/fieldClasses/contractShapes.generated";
import { keyPathsOf, walkStructural } from "../lib/fieldClasses/outsideContract";

// ── a planted contract: a person with a protected IBAN and ID, a nested address, a list, a map and a union ──────────
const components: Record<string, Shape> = {
  Person: {
    k: "obj",
    n: "Person",
    p: {
      id: { k: "leaf" },
      name: { k: "leaf" },
      nationalId: { k: "leaf" },
      iban: { k: "leaf" },
      tags: { k: "arr", i: { k: "leaf" } },
      address: { k: "obj", n: "Person.address", p: { city: { k: "leaf" }, country: { k: "leaf" } } },
      accounts: { k: "arr", i: { k: "ref", n: "Account" } },
      totals: { k: "map", v: { k: "ref", n: "Account" } },
      extra: { k: "union", o: [{ k: "leaf" }, { k: "ref", n: "Account" }] },
    },
  },
  Account: { k: "obj", n: "Account", p: { number: { k: "leaf" }, label: { k: "leaf" } } },
};
const TABLE: Record<string, Record<string, { cls: string; resource: string | null }>> = {
  Person: {
    id: { cls: "standard", resource: "people" },
    name: { cls: "standard", resource: "people" },
    nationalId: { cls: "identity", resource: "people" },
    iban: { cls: "bank_account", resource: "people" },
    tags: { cls: "standard", resource: "people" },
    extra: { cls: "standard", resource: "people" },
  },
  "Person.address": { city: { cls: "contact", resource: "people" }, country: { cls: "standard", resource: null } },
  Account: { number: { cls: "bank_account", resource: "people" }, label: { cls: "standard", resource: "people" } },
};
const lookup = ((node: string, field: string) => TABLE[node]?.[field]) as FieldLookup;
const ROOT: Shape = { k: "ref", n: "Person" };
const person = () => ({
  id: 7,
  name: "Hala",
  nationalId: "1012345678",
  iban: "SA03 8000 0000 6080 1016 7519",
  tags: ["a", "b"],
  address: { city: "Riyadh", country: "SA" },
  accounts: [{ number: "SA1111", label: "main" }],
  totals: { x: { number: "SA2222", label: "t" } },
  extra: "plain",
});
const all: ReadDecider = () => "read";

describe("the walk (planted shapes)", () => {
  it("🔴 everything granted: the SAME object back, untouched, nothing withheld or unclassified", () => {
    const value = person();
    const r = walkValue(ROOT, value, "root", lookup, all, components);
    expect(r.value).toBe(value);
    expect(r.withheld).toEqual([]);
    expect(r.unclassified).toEqual([]);
  });

  it("🔴 a class not granted: the key is ABSENT (never null, never zero), named in withheld; the input is not mutated", () => {
    const value = person();
    const noIdentity: ReadDecider = (cls) => (cls === "identity" ? "none" : "read");
    const r = walkValue(ROOT, value, "root", lookup, noIdentity, components);
    const out = r.value as Record<string, unknown>;
    expect("nationalId" in out).toBe(false);
    expect(out.name).toBe("Hala"); // presence: the rest is served
    expect(r.withheld).toEqual([{ path: "nationalId", class: "identity", level: "none" }]);
    expect(value.nationalId).toBe("1012345678"); // the caller's object is untouched
    expect(out.address).toBe(value.address); // and only the path to the change was copied
  });

  it("🔴 last4: an IBAN is served as its last four digits, everywhere it appears (nested, listed, mapped), each named", () => {
    const r = walkValue(ROOT, person(), "root", lookup, (cls) => (cls === "bank_account" ? "last4" : "read"), components);
    const out = r.value as ReturnType<typeof person>;
    expect(out.iban).toBe("•••• 7519");
    expect(out.accounts[0]!.number).toBe("•••• 1111");
    expect(out.totals.x!.number).toBe("•••• 2222");
    expect(r.withheld.map((w) => `${w.path}:${w.level}`).sort()).toEqual(["accounts[].number:last4", "iban:last4", "totals.x.number:last4"]);
    expect(lastFour("SA03 8000 0000 6080 1016 7519")).toBe("•••• 7519");
  });

  it("a nested protected field is withheld at its path; a null plain value is still classified (and withheld as absent)", () => {
    const value = { ...person(), nationalId: null };
    const r = walkValue(ROOT, value, "root", lookup, (cls) => (cls === "contact" || cls === "identity" ? "none" : "read"), components);
    const out = r.value as Record<string, any>;
    expect(out.address).toEqual({ country: "SA" });
    expect("nationalId" in out).toBe(false);
    expect(r.withheld.map((w) => w.path).sort()).toEqual(["address.city", "nationalId"]);
  });

  it("🔴 an undeclared key, and a declared key with no row, are UNCLASSIFIED — named, not guessed", () => {
    const r = walkValue(ROOT, { ...person(), surprise: 1 }, "root", ((n: string, f: string) => (n === "Account" && f === "label" ? undefined : lookup(n, f))) as FieldLookup, all, components);
    expect(r.unclassified.sort()).toEqual(["Account.label", "Person.surprise"]);
  });

  it("🔴 a Date (any non-plain object) is ONE value — classified and withheld as one, never walked into (both walks)", () => {
    const r = walkValue(ROOT, { ...person(), nationalId: new Date("2026-01-01") }, "root", lookup, (cls) => (cls === "identity" ? "none" : "read"), components);
    expect("nationalId" in (r.value as object)).toBe(false);
    expect(r.withheld).toEqual([{ path: "nationalId", class: "identity", level: "none" }]);
    const outsideLookup = ((_route: string, key: string) => (key === "when" ? { cls: "contact", resource: "people" } : key === "who" ? { cls: "standard", resource: null } : undefined)) as FieldLookup;
    const s = walkStructural({ when: new Date("2026-01-01"), who: "x" }, "GET /x", outsideLookup, () => "none");
    expect(s.value).toEqual({ who: "x" });
    expect(s.unclassified).toEqual([]);
    expect(keyPathsOf({ when: new Date(), list: [{ at: new Date() }] }).sort()).toEqual(["list[].at", "when"]);
  });

  it("a union of a plain value and an object: each value classified by its own kind", () => {
    const asObject = walkValue(ROOT, { ...person(), extra: { number: "SA3333", label: "u" } }, "root", lookup, (cls) => (cls === "bank_account" ? "none" : "read"), components);
    expect((asObject.value as any).extra).toEqual({ label: "u" });
    expect(asObject.unclassified).toEqual([]);
  });

  it("the decider: read, then last4 (IBANs only), else none; a role with no loaded grants holds nothing; no role is decided in S2c", () => {
    const grants = new Set([`viewer:vendors:${fieldGrantAction("bank_account", "last4")}`, `admin:vendors:${fieldGrantAction("bank_account", "read")}`]);
    expect(deciderFor("admin", grants)("bank_account", "vendors")).toBe("read");
    expect(deciderFor("viewer", grants)("bank_account", "vendors")).toBe("last4");
    expect(deciderFor("viewer", grants)("contact", "vendors")).toBe("none");
    expect(deciderFor("viewer", null)("contact", "vendors")).toBe("none");
    expect(deciderFor(undefined, null)("contact", "vendors")).toBe("read");
  });
});

// ── the real contract ────────────────────────────────────────────────────────────────────────────────────────────
const grantsOf = (rows: readonly { role: string; resource: string; action: string }[]) => new Set(rows.map((r) => `${r.role}:${r.resource}:${r.action}`));
/**
 * S1's matrix: PERMISSION_MATRIX with S2a's twelve removals restored (restated 2026-11-23, when the matrix lost them) — the
 * every-grant-held base the mechanism tests below were written against. S2a's own matrix is PERMISSION_MATRIX.
 */
const S1_MATRIX = [...PERMISSION_MATRIX, ...S2A_REMOVALS.map(({ role, resource, action }) => ({ role, resource, action }))];
const without = (role: string, resource: string, action: string) => S1_MATRIX.filter((r) => !(r.role === role && r.resource === resource && r.action === action));
const employee = () => ({
  id: 1, employeeNumber: "E-1", name: "Hala", nameAr: null, nationalId: "1012345678", nationality: "SA", jobTitle: null, jobTitleAr: null,
  department: null, basicSalary: 9000, housingAllowance: 2250, transportAllowance: 900, otherAllowances: 0, gosiNumber: null,
  iban: "SA0380000000608010167519", bank: "Rajhi", joiningDate: "2024-01-01", endDate: null, status: "active", notes: null,
  createdAt: "2024-01-01", grossSalary: 12150, gosiEmployee: 1012.5, gosiEmployer: 1062.5, gosiRegime: "law_2024",
  gosiRegimeSetBy: 1, gosiRegimeSetAt: "2024-01-01", gosiRegimeBasis: null, gosiWageBase: 11250, gosiInKindHousing: false, gosiInKindHousingExempt: false,
});

describe("the real contract — GET /employees/{id}", () => {
  it("🔴 S1's matrix (the twelve restored): every role is served the response UNCHANGED (the same object), nothing withheld or unclassified", () => {
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) {
      const body = employee();
      const r = classifyResponse("GET", "/api/employees/1", 200, body, deciderFor(role, grantsOf(S1_MATRIX)));
      expect(r.value, role).toBe(body);
      expect(r.withheld, role).toEqual([]);
      expect(r.unclassified, role).toEqual([]);
    }
  });

  // 🔴 Restated for S2a (2026-11-23): PERMISSION_MATRIX is S2a's. What each role is served is exactly its classes (D2).
  it("🔴 S2a's matrix: the accountant and the admin get the same object; the bookkeeper and the viewer lose exactly their classes, named", () => {
    const keysOf = (...classes: string[]) => Object.keys(employee()).filter((k) => classes.includes(fieldSpec("Employee", k)?.cls ?? "")).sort();
    for (const role of ["admin", "accountant"]) {
      const body = employee();
      const r = classifyResponse("GET", "/api/employees/1", 200, body, deciderFor(role, grantsOf(PERMISSION_MATRIX)));
      expect([r.value === body, r.withheld, r.unclassified], role).toEqual([true, [], []]);
    }
    const keeper = classifyResponse("GET", "/api/employees/1", 200, employee(), deciderFor("bookkeeper", grantsOf(PERMISSION_MATRIX)));
    const kv = keeper.value as Record<string, unknown>;
    for (const k of keysOf("identity", "compensation")) expect(k in kv, `bookkeeper: ${k}`).toBe(false);
    expect([kv.iban, kv.name]).toEqual(["•••• 7519", "Hala"]);
    expect(keeper.withheld.filter((w) => w.class !== "bank_account").map((w) => w.path).sort()).toEqual(keysOf("identity", "compensation"));
    const viewer = classifyResponse("GET", "/api/employees/1", 200, employee(), deciderFor("viewer", grantsOf(PERMISSION_MATRIX)));
    const vv = viewer.value as Record<string, unknown>;
    expect(viewer.withheld.map((w) => w.path).sort()).toEqual(keysOf("identity", "compensation", "bank_account"));
    for (const k of keysOf("identity", "compensation", "bank_account")) expect(k in vv, `viewer: ${k}`).toBe(false);
    expect(keysOf("identity", "compensation", "bank_account").length).toBeGreaterThan(10); // not vacuous
  });

  it("🔴 with ONE grant removed (as an approved S2 removal would): only that class goes, named; every other field is served", () => {
    const grants = grantsOf(without("viewer", "employees", fieldGrantAction("identity", "read")));
    const r = classifyResponse("GET", "/api/employees/1", 200, employee(), deciderFor("viewer", grants));
    const out = r.value as Record<string, unknown>;
    expect(r.withheld.map((w) => `${w.path}:${w.class}`).sort()).toEqual(["gosiNumber:identity", "nationalId:identity", "nationality:identity"]);
    for (const k of ["nationalId", "gosiNumber", "nationality"]) expect(k in out, k).toBe(false);
    expect(out.basicSalary).toBe(9000); // presence: compensation is still granted
    // movement: the admin, whose grant was not removed, still reads it
    expect((classifyResponse("GET", "/api/employees/1", 200, employee(), deciderFor("admin", grants)).value as any).nationalId).toBe("1012345678");
  });

  /** `GET /employees` answers a page: `{ items, page, totals }` (the contract's listEmployees). */
  const employeePage = (items: unknown[]) => ({
    items,
    page: { limit: 50, offset: 0, total: items.length },
    totals: { saudiCount: 1, grossSalary: 12150, gosiEmployer: 1062.5, gosiUnstatedCount: 0 },
  });

  it("🔴 a key the contract does not declare: classified by its SERVED_BEYOND_CONTRACT row, else unclassified by name", () => {
    const grants = grantsOf(PERMISSION_MATRIX);
    const known = classifyResponse("GET", "/api/employees/1", 200, { ...employee(), organizationId: "o", companyId: "c" }, deciderFor("viewer", grants));
    expect(known.unclassified).toEqual([]);
    const unknown = classifyResponse("GET", "/api/employees/1", 200, { ...employee(), surprise: 1 }, deciderFor("viewer", grants));
    expect(unknown.unclassified).toEqual(["Employee.surprise"]);
  });

  it("a list response walks every row", () => {
    const grants = grantsOf(without("bookkeeper", "employees", fieldGrantAction("bank_account", "read")));
    const r = classifyResponse("GET", "/api/employees", 200, employeePage([employee(), employee()]), deciderFor("bookkeeper", grants));
    expect(r.unclassified).toEqual([]);
    expect((r.value as any).items.map((e: any) => e.iban)).toEqual(["•••• 7519", "•••• 7519"]);
    expect(r.withheld.filter((w) => w.class === "bank_account" && w.path === "items[].iban")).toHaveLength(2);
    // Restated for S2a (owner item 2, 2026-11-23): under S1's matrix the bookkeeper still reads pay, so the totals are served.
    expect((r.value as any).totals.grossSalary).toBe(12150);
  });

  it("🔴 S2a (owner item 2): the list's money totals and the two identity counts are withheld from a role without that read, named; the rest is served", () => {
    const page = () => ({ ...employeePage([employee()]), totals: { saudiCount: 1, grossSalary: 12150, gosiEmployer: 1062.5, gosiUnstatedCount: 0, payNotSetCount: 0 } });
    for (const role of ["bookkeeper", "viewer"]) {
      const r = classifyResponse("GET", "/api/employees", 200, page(), deciderFor(role, grantsOf(PERMISSION_MATRIX)));
      expect(r.unclassified, role).toEqual([]);
      expect((r.value as any).totals, role).toEqual({ payNotSetCount: 0 });
      expect((r.value as any).page.total, role).toBe(1);
      expect(r.withheld.filter((w) => w.path.startsWith("totals.")).map((w) => `${w.path}:${w.class}:${w.level}`).sort(), role).toEqual([
        "totals.gosiEmployer:compensation:none", "totals.gosiUnstatedCount:compensation:none", "totals.grossSalary:compensation:none", "totals.saudiCount:identity:none",
      ]);
    }
    for (const role of ["admin", "accountant"]) {
      const body = page();
      expect(classifyResponse("GET", "/api/employees", 200, body, deciderFor(role, grantsOf(PERMISSION_MATRIX))).value, role).toBe(body);
    }
  });

  // Restated for S2a (2026-11-23): "every grant held" is S1's matrix; PERMISSION_MATRIX no longer holds the viewer's.
  it("🔴 the PERFORMANCE BUDGET (stated before the build): 2,000 employee rows, every grant held, in under 500 ms", () => {
    const rows = Array.from({ length: 2_000 }, employee);
    const body = employeePage(rows);
    const decide = deciderFor("viewer", grantsOf(S1_MATRIX));
    classifyResponse("GET", "/api/employees", 200, employeePage(rows.slice(0, 10)), decide); // warm the shape caches
    const t0 = performance.now();
    const r = classifyResponse("GET", "/api/employees", 200, body, decide);
    const ms = performance.now() - t0;
    expect(r.value).toBe(body);
    expect(r.unclassified).toEqual([]);
    // Not vacuous: the same rows with one grant removed are walked to the last row (3 identity fields each).
    const cut = classifyResponse("GET", "/api/employees", 200, employeePage(rows), deciderFor("viewer", grantsOf(without("viewer", "employees", fieldGrantAction("identity", "read")))));
    // + 1 (owner item 2, 2026-11-23): the page's Saudi count is identity too — narrowed to one person it is their nationality.
    expect(cut.withheld).toHaveLength(2_000 * 3 + 1);
    expect(cut.withheld.filter((w) => w.path.startsWith("totals.")).map((w) => w.path)).toEqual(["totals.saudiCount"]);
    console.log(`[19B S1 budget] 2,000 employee rows (${2_000 * Object.keys(employee()).length} keys), every grant held: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

describe("the field-level write check", () => {
  const has = (rows: readonly { role: string; resource: string; action: string }[], role: string) => {
    const g = grantsOf(rows);
    return (resource: string, action: string) => g.has(`${role}:${resource}:${action}`);
  };
  const op = CONTRACT.operations.find((o) => o.method === "PATCH" && o.path === "/employees/{id}")!;

  it("finds the declared fields a body sets, and ignores keys the contract does not declare", () => {
    expect(op?.body, "PATCH /employees/{id} has a JSON body in the contract").toBeTruthy();
    const written = fieldsWritten(op.body!, { name: "x", nationalId: "1", notAField: 1 }, CONTRACT.components).map((f) => f.path).sort();
    expect(written).toEqual(["name", "nationalId"]);
  });

  it("🔴 S1's matrix (the twelve restored) refuses no write, for any role that writes (a viewer's route grants refuse it first)", () => {
    for (const role of ["admin", "accountant", "bookkeeper"]) {
      expect(fieldWriteRefusal("PATCH", "/api/employees/1", { nationalId: "1", basicSalary: 1, status: "active", iban: "SA1" }, has(S1_MATRIX, role))).toBeNull();
    }
  });

  // 🔴 Restated for S2a (O2, D1, D2; 2026-11-23): PERMISSION_MATRIX is S2a's.
  it("🔴 S2a's matrix: the accountant and the admin write every field; the bookkeeper writes the national ID and the IBAN, and is refused pay and status by name", () => {
    const body = { nationalId: "1", basicSalary: 1, status: "active", iban: "SA1" };
    for (const role of ["admin", "accountant"]) expect(fieldWriteRefusal("PATCH", "/api/employees/1", body, has(PERMISSION_MATRIX, role)), role).toBeNull();
    const refused = fieldWriteRefusal("PATCH", "/api/employees/1", body, has(PERMISSION_MATRIX, "bookkeeper")) as { fields: { field: string }[] } | null;
    expect(refused?.fields.map((f) => f.field).sort()).toEqual(["basicSalary", "status"]);
    expect(fieldWriteRefusal("PATCH", "/api/employees/1", { nationalId: "1", iban: "SA1", name: "x" }, has(PERMISSION_MATRIX, "bookkeeper"))).toBeNull();
  });

  it("🔴 a field the role may not write is REFUSED BY NAME (field_write_not_granted), never dropped; the rest alone passes", () => {
    const rows = without("bookkeeper", "employees", fieldGrantAction("compensation", "write"));
    const refusal = fieldWriteRefusal("PATCH", "/api/employees/1", { name: "x", basicSalary: 1 }, has(rows, "bookkeeper"));
    expect(refusal?.code).toBe("field_write_not_granted");
    expect(refusal?.fields).toEqual([{ field: "basicSalary", class: "compensation", resource: "employees" }]);
    expect(refusal?.errorAr).toBeTruthy();
    expect(fieldWriteRefusal("PATCH", "/api/employees/1", { name: "x" }, has(rows, "bookkeeper"))).toBeNull();
  });

  it("🔴 D1/D2: status, dates, nationality and the GOSI number also need compensation to WRITE; the national ID does not", () => {
    const rows = without("bookkeeper", "employees", fieldGrantAction("compensation", "write"));
    for (const field of ["status", "joiningDate", "endDate", "nationality", "gosiNumber"]) {
      const refusal = fieldWriteRefusal("PATCH", "/api/employees/1", { [field]: "x" }, has(rows, "bookkeeper"));
      expect(refusal?.fields.map((f) => `${f.field}:${f.class}`), field).toEqual([`${field}:compensation`]);
    }
    expect(fieldWriteRefusal("PATCH", "/api/employees/1", { nationalId: "1012345678" }, has(rows, "bookkeeper"))).toBeNull();
  });

  it("a read is never checked", () => {
    expect(fieldWriteRefusal("GET", "/api/employees/1", { basicSalary: 1 }, () => false)).toBeNull();
  });
});
