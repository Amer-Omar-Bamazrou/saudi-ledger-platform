/**
 * 🔴 19B S1 (v4 §5.3, D1) — THE CLASS TABLE AGAINST THE CONTRACT, BOTH WAYS.
 *
 *  1. The structure the seam walks IS the served contract: `contractShapes.generated.ts` regenerated from openapi.yaml
 *     is byte-identical to the checked-in file.
 *  2. Every contract field has a class — a field added without one fails here, by name (default deny: `standard` is
 *     given, never assumed).
 *  3. Every row names a field the contract has — a row left behind by a removed field fails here.
 *  4. The table's own rules: a node with a protected field names a resource that exists in PERMISSION_MATRIX; a
 *     `writeAlsoNeeds` or a condition names a field of its own node.
 *  5. v4 §5.2's decisions, pinned field by field (presence), so a reclassification is a visible edit.
 *  6. The routes outside the contract: their table can only shrink.
 * The runtime half — every key the test lane's traffic serves — is the seam's own strict mode (seam.ts).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERMISSION_MATRIX } from "@workspace/db";
import { CONTRACT } from "../lib/fieldClasses/contractShapes.generated";
import { contractFields } from "../lib/fieldClasses/shapes";
import { FIELD_CLASSES, FIELD_CLASS_TABLE, SERVED_BEYOND_CONTRACT, fieldSpec, indexTable } from "../lib/fieldClasses/classTable";
import { OUTSIDE_CONTRACT_ROUTES } from "../lib/fieldClasses/outsideContract";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const resources = new Set(PERMISSION_MATRIX.map((r) => r.resource));
const fields = contractFields(CONTRACT);
const index = indexTable(FIELD_CLASS_TABLE);

describe("the class table against the contract (19B S1)", () => {
  it("🔴 the walked structure is the served contract (regenerated = checked in)", () => {
    const r = spawnSync(process.execPath, [`${root}packages/api-spec/scripts/contract-shapes.mjs`, "--check"], { encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`.trim()).toBe("contract shapes: fresh");
    expect(r.status).toBe(0);
  });

  it("🔴 EVERY contract field has a class", () => {
    expect(fields.length).toBeGreaterThan(4_000); // the frame: the whole contract, not a sample
    const missing = fields.filter((f) => !fieldSpec(f.node, f.field)).map((f) => `${f.node}.${f.field}`);
    expect(missing, "give each a class in lib/fieldClasses/classTable.ts").toEqual([]);
  });

  it("🔴 every row names a field the contract has", () => {
    const real = new Set(fields.map((f) => `${f.node}\u0000${f.field}`));
    const stale: string[] = [];
    for (const [node, byField] of index) for (const field of byField.keys()) if (!real.has(`${node}\u0000${field}`)) stale.push(`${node}.${field}`);
    expect(stale, "rows for fields the contract no longer has — delete them").toEqual([]);
  });

  it("the table's own rules hold", () => {
    const problems: string[] = [];
    for (const [node, entry] of Object.entries(FIELD_CLASS_TABLE)) {
      const byField = index.get(node)!;
      const isProtected = [...byField.values()].some((s) => s.cls !== "standard");
      if (isProtected && !entry.resource) problems.push(`${node}: protected fields but no resource`);
      if (entry.resource && !resources.has(entry.resource)) problems.push(`${node}: resource '${entry.resource}' is not in PERMISSION_MATRIX`);
      for (const f of Object.keys(entry.writeAlsoNeeds ?? {})) if (!byField.has(f)) problems.push(`${node}: writeAlsoNeeds names '${f}', not a field of this node`);
      for (const f of Object.keys(entry.conditions ?? {})) {
        if (!byField.has(f)) problems.push(`${node}: a condition names '${f}', not a field of this node`);
        else if (byField.get(f)!.cls === "standard") problems.push(`${node}.${f}: a condition on a standard field`);
      }
      // 19B S3: a per-row resource names a field of its own node, and at least one resource
      if (entry.rowResource) {
        if (!byField.has(entry.rowResource.by)) problems.push(`${node}: rowResource reads '${entry.rowResource.by}', not a field of this node`);
        if (Object.keys(entry.rowResource.resources).length === 0) problems.push(`${node}: rowResource names no resource`);
        if (!entry.resource) problems.push(`${node}: rowResource without a default resource`);
      }
      for (const key of Object.keys(entry)) if (![...FIELD_CLASSES, "resource", "writeAlsoNeeds", "conditions", "rowResource"].includes(key as never)) problems.push(`${node}: unknown key '${key}'`);
    }
    expect(problems).toEqual([]);
  });

  it("🔴 v4 §5.2, field by field (D1, D2)", () => {
    const cls = (k: string) => {
      const i = k.lastIndexOf(".");
      return fieldSpec(k.slice(0, i), k.slice(i + 1))?.cls;
    };
    const expected: Record<string, string> = {
      "Employee.nationalId": "identity", "Employee.gosiNumber": "identity", "Employee.nationality": "identity",
      "Employee.basicSalary": "compensation", "Employee.gosiRegime": "compensation", "Employee.notes": "compensation",
      "Employee.iban": "bank_account", "Employee.bank": "bank_account",
      "Employee.name": "standard", "Employee.status": "standard", "Employee.joiningDate": "standard", "Employee.endDate": "standard",
      // 🔴 Restated by owner item 2 (2026-11-23; v4 §5.2 amended): a payslip's GOSI rates state the employee's GOSI law
      // and so their nationality; a money total over a set the caller chooses is pay, and the Saudi count narrowed to
      // one person is their nationality; a run's basic/allowances split is not in the ledger. Gross, net, both GOSI
      // totals and the counts stay standard (D1).
      "PayrollItem.netPay": "compensation", "PayrollItem.employeeName": "standard", "PayrollItem.gosiEmployeeRate": "compensation",
      "PayrollItem.gosiEmployerRate": "compensation",
      "PayrollRun.totalNetPay": "standard", "PayrollRun.totalGosiEmployee": "standard", "PayrollRun.totalGosiEmployer": "standard",
      "PayrollRun.totalBasicSalary": "compensation", "PayrollRun.totalAllowances": "compensation",
      "EmployeeTotals.grossSalary": "compensation", "EmployeeTotals.gosiEmployer": "compensation", "EmployeeTotals.gosiUnstatedCount": "compensation",
      "EmployeeTotals.saudiCount": "identity", "EmployeeTotals.payNotSetCount": "standard",
      "Customer.nationalId": "identity", "Customer.phone": "contact", "Customer.province": "contact", "Customer.notes": "contact",
      "Customer.country": "standard", "Customer.taxNumber": "standard",
      "Vendor.iban": "bank_account", "Vendor.email": "contact", "Vendor.foreignTaxId": "standard", "Vendor.country": "standard",
      "BankDetailChange.ibanAfter": "bank_account", "BankDetailChange.requestedByName": "standard",
      "WhtWithholding.vendorAddress": "contact", "WhtWithholding.vendorForeignTaxId": "standard",
      "MigrationParty.phone": "contact", "AuditLogEntry.ipAddress": "member_security", "AuditLogEntry.beforeState": "by_entity",
      "SecurityEvent.actorEmail": "member_security", "SessionRecord.ipAddress": "member_security", "SessionUser.email": "member_security",
      "Transaction.description": "bank_narrative", "JournalEntryLine.description": "bank_narrative",
      "Company.street": "standard", "InvoiceIssueView.sellerAddress": "standard",
    };
    for (const [k, c] of Object.entries(expected)) expect(cls(k), k).toBe(c);
    const employee = fieldSpec("Employee", "status")!;
    expect(employee.writeAlsoNeeds).toEqual(["compensation"]);
    expect(fieldSpec("Employee", "nationality")!.writeAlsoNeeds).toEqual(["compensation"]);
    expect(fieldSpec("Employee", "nationalId")!.writeAlsoNeeds).toEqual([]);
    expect(fieldSpec("EmployeeInputFields", "status")!.writeAlsoNeeds).toEqual(["compensation"]);
  });

  it("🔴 every report-export column declares its class (the type requires it); the protected ones are exactly these", () => {
    const src = readFileSync(`${root}apps/api/src/services/reporting/reportExport.service.ts`, "utf8");
    const calls = [...src.matchAll(/\bcol\(/g)].length - 1; // less the definition
    const declared = [...src.matchAll(/, "(?:text|money|int|date)", ("standard"|\{ cls: "([a-z_]+)", resource: "([a-z_]+)" \})\)/g)];
    expect(declared.length, "every col() call names a class").toBe(calls);
    const protectedCols = declared.filter((m) => m[2]).map((m) => `${m[2]}:${m[3]}`).sort();
    // The ledger's text (bank text where a line came from a statement line; S2c) and the WHT beneficiary's address (D9 d).
    expect(protectedCols).toEqual(["bank_narrative:journal_entries", "contact:vendors"]);
  });

  it("🔴 the routes outside the contract: every entry is classified, and the list can only SHRINK", () => {
    const outside = indexTable(OUTSIDE_CONTRACT_ROUTES);
    for (const [route, entry] of Object.entries(OUTSIDE_CONTRACT_ROUTES)) {
      expect(route, "METHOD /template").toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/);
      const isProtected = [...outside.get(route)!.values()].some((s) => s.cls !== "standard");
      if (isProtected) expect(resources.has(entry.resource ?? ""), `${route}: resource`).toBe(true);
    }
    // A route enters the contract and leaves this table in the same commit. Raising this number is a decision.
    expect(Object.keys(OUTSIDE_CONTRACT_ROUTES).length).toBeLessThanOrEqual(OUTSIDE_CONTRACT_CEILING);
    // A route the contract has is classified through the contract, never here.
    const inContract = Object.keys(OUTSIDE_CONTRACT_ROUTES).filter((k) => {
      const [method, template] = k.split(" ") as [string, string];
      return CONTRACT.operations.some((o) => o.method === method && o.path.replace(/\{[^}]+\}/g, "{}") === template.replace(/\{[^}]+\}/g, "{}"));
    });
    expect(inContract, "these routes are in the contract — remove them from the outside table").toEqual([]);
  });

  it("🔴 keys served BEYOND the contract: each on a contract node, none the contract declares, and the list can only SHRINK", () => {
    const beyond = indexTable(SERVED_BEYOND_CONTRACT);
    const declared = new Set(fields.map((f) => `${f.node}\u0000${f.field}`));
    const problems: string[] = [];
    let count = 0;
    for (const [node, byField] of beyond) {
      if (!index.has(node)) problems.push(`${node}: not a contract node`);
      for (const [field, spec] of byField) {
        count++;
        if (declared.has(`${node}\u0000${field}`)) problems.push(`${node}.${field}: the contract declares it — move it to FIELD_CLASS_TABLE`);
        if (spec.cls !== "standard" && !resources.has(SERVED_BEYOND_CONTRACT[node]!.resource ?? "")) problems.push(`${node}.${field}: protected without a resource`);
      }
    }
    expect(problems).toEqual([]);
    expect(count).toBeLessThanOrEqual(SERVED_BEYOND_CEILING);
  });
});

/** Measured 2026-11-22 from the test lane's traffic (the capture in seam.ts, every API test). They only go down. */
const OUTSIDE_CONTRACT_CEILING = 50;
const SERVED_BEYOND_CEILING = 44;
