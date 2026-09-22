/**
 * Batch 1C UI — the pure half of the migration workspace, pinned.
 */
import { describe, expect, it } from "vitest";
import {
  ageingBucket, coerceRow, csvTemplate, groupByType, mergeTargets, parseStagedText, reliefLabel, sectionForCheck, summariseChecks, systemTargets, verdictOf, verdictLabel, FIELDS_OF, CHECK_SECTION,
} from "./migrationImport";

describe("parseStagedText — CSV and JSON into the PUT bodies", () => {
  it("reads the CSV template of every set back into typed rows with no errors", () => {
    for (const kind of ["chart", "parties", "openItems", "advances"] as const) {
      const r = parseStagedText(kind, csvTemplate(kind));
      expect(r.errors, kind).toEqual([]);
      expect(r.rows.length, kind).toBe(1);
      expect(r.format).toBe("csv");
    }
  });
  it("coerces numbers, booleans, dates and nested historicalVat keys; snake_case and spaced headers are accepted", () => {
    const csv = ["item_type,source id,party_source_id,documentNumber,issue_date,dueDate,original_amount,outstanding_amount,composition_unknown,historical_vat_category,historical_vat.rate,historical_vat_bad_debt_relief_claimed",
      "ar,SI-1,C1,INV-1,2026-05-10,2026-06-09,\"10,000.00\",4500,yes,S,15,yes"].join("\n");
    const r = parseStagedText<Record<string, unknown>>("openItems", csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toEqual({ itemType: "ar", sourceId: "SI-1", partySourceId: "C1", documentNumber: "INV-1", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10000, outstandingAmount: 4500, compositionUnknown: true, historicalVat: { category: "S", rate: 15, badDebtReliefClaimed: true } });
  });
  it("🔴 the Art. 40(9) flag is three-valued: yes / no / blank survive as true / false / null — and an item without any VAT facts sends historicalVat null, never {}", () => {
    const csv = ["itemType,sourceId,partySourceId,documentNumber,issueDate,dueDate,originalAmount,outstandingAmount,historicalVat.badDebtReliefClaimed",
      "ar,A,C1,INV-A,2026-05-10,2026-06-09,100,100,yes", "ar,B,C1,INV-B,2026-05-10,2026-06-09,100,100,no", "ar,C,C1,INV-C,2026-05-10,2026-06-09,100,100,", "ar,D,C1,INV-D,2026-05-10,2026-06-09,100,100,maybe"].join("\n");
    const r = parseStagedText<{ sourceId: string; historicalVat: { badDebtReliefClaimed?: boolean | null } | null }>("openItems", csv);
    expect(r.rows.map((x) => [x.sourceId, x.historicalVat])).toEqual([["A", { badDebtReliefClaimed: true }], ["B", { badDebtReliefClaimed: false }], ["C", null]]);
    expect(r.errors).toEqual(["row 4: historicalVat.badDebtReliefClaimed must be yes, no or blank (unknown)"]);
  });
  it("names the defective row and keeps the good ones; unknown columns are reported, not silently dropped", () => {
    const csv = ["sourceCode,sourceName,sourceType,openingDebit,colour", "1100,Bank,asset,abc,blue", "1200,Debtors,asset,10,red", "1300,Nope,widget,1,green"].join("\n");
    const r = parseStagedText("chart", csv);
    expect(r.rows.length).toBe(1);
    expect(r.errors).toEqual(["Unknown column(s) ignored: colour", "row 1: openingDebit must be a number", "row 3: sourceType must be one of asset, liability, equity, income, expense"]);
  });
  it("accepts a JSON array or { rows: [...] }, refuses anything else, and reports empty input as empty", () => {
    expect(parseStagedText("parties", JSON.stringify([{ partyType: "customer", sourceId: "C1", name: "A" }])).rows).toEqual([{ partyType: "customer", sourceId: "C1", name: "A" }]);
    expect(parseStagedText("parties", JSON.stringify({ rows: [{ partyType: "vendor", sourceId: "V1", name: "B" }] })).rows.length).toBe(1);
    expect(parseStagedText("parties", "{\"x\":1}").errors[0]).toMatch(/array of rows/);
    expect(parseStagedText("parties", "[not json").errors[0]).toMatch(/Not valid JSON/);
    expect(parseStagedText("parties", "   ")).toEqual({ rows: [], errors: [], format: "empty" });
  });
  it("coerceRow (the row editor) applies the same rules as the file import", () => {
    expect(coerceRow("advances", { sourceId: "ADV-1", partySourceId: "C3", bankSourceCode: "1100", amount: "3000", receivedAt: "2026-06-01", vatPosition: "invoiced" }, "row").row).toEqual({ sourceId: "ADV-1", partySourceId: "C3", bankSourceCode: "1100", amount: 3000, receivedAt: "2026-06-01", vatPosition: "invoiced" });
    expect(coerceRow("advances", { sourceId: "ADV-1" }, "row").errors).toContain("row: partySourceId is required");
  });
});

describe("read-side labels and maps", () => {
  it("🔴 relief flag reads Yes / No / Unknown in both languages — null and undefined are both Unknown", () => {
    expect([reliefLabel(true, "en"), reliefLabel(false, "en"), reliefLabel(null, "en"), reliefLabel(undefined, "en")]).toEqual(["Yes", "No", "Unknown", "Unknown"]);
    expect([reliefLabel(true, "ar"), reliefLabel(false, "ar"), reliefLabel(null, "ar")]).toEqual(["نعم", "لا", "غير معروف"]);
  });
  it("🔴 OPENING_BALANCE_EQUITY and CASH can never be offered as a system target, whatever the org's chart carries", () => {
    const cats = [
      { id: 1, systemCode: "AR", name: "Receivables", nameAr: "الذمم", type: "asset", isPlatformSystemAccount: true },
      { id: 2, systemCode: "CASH", name: "Cash", nameAr: "نقد", type: "asset", isPlatformSystemAccount: true },
      { id: 3, systemCode: "OPENING_BALANCE_EQUITY", name: "OBE", nameAr: "OBE", type: "equity", isPlatformSystemAccount: true },
      { id: 4, systemCode: "RETAINED_EARNINGS", name: "RE", nameAr: "RE", type: "equity", isPlatformSystemAccount: true },
      { id: 5, systemCode: null, name: "Rent", nameAr: "إيجار", type: "expense", isPlatformSystemAccount: false },
      // 🔴 FA-D: a SEEDED DEFAULT carries a code but is NOT one of the platform's
      // own system accounts. `map_to_system` refuses it and `merge_into` accepts it,
      // so it must appear under exactly one of the two doors — the disagreement that
      // left an "Equipment at cost" row with no reachable target at all.
      { id: 6, systemCode: "FIXED_ASSETS", name: "Equipment at cost", nameAr: "معدات", type: "asset", isPlatformSystemAccount: false },
    ] as const;
    expect(systemTargets(cats).map((c) => c.code)).toEqual(["AR", "RETAINED_EARNINGS"]);
    expect(systemTargets(cats, "equity").map((c) => c.code)).toEqual(["RETAINED_EARNINGS"]);
    expect(systemTargets(cats, "asset").map((c) => c.code)).toEqual(["AR"]); // FIXED_ASSETS is NOT here…
    const posting = cats.map((c) => ({ ...c, isPosting: true }));
    expect(mergeTargets(posting, "expense").map((c) => c.id)).toEqual([5]);
    expect(mergeTargets(posting, "asset").map((c) => c.id)).toEqual([6]); // …it is HERE, and CASH/AR are not
  });
  it("every server control points at a section, and the unknown ones fall back to the validation view", () => {
    for (const id of Object.keys(CHECK_SECTION)) expect(sectionForCheck(id)).toBe(CHECK_SECTION[id]);
    expect(sectionForCheck("SOMETHING_NEW")).toBe("validation");
    expect(sectionForCheck("OPEN_ITEMS")).toBe("ar");
  });
  it("verdicts: fail → BLOCKED, warn → WARNING, skip → NOT APPLICABLE, pass → PASS; the summary counts them", () => {
    expect(["fail", "warn", "skip", "pass"].map((s) => verdictLabel(verdictOf({ status: s as never }), "en"))).toEqual(["BLOCKED", "WARNING", "NOT APPLICABLE", "PASS"]);
    expect(summariseChecks([{ status: "fail" }, { status: "fail" }, { status: "warn" }, { status: "pass" }, { status: "skip" }] as never)).toEqual({ blocking: 2, warnings: 1, passed: 1, skipped: 1 });
  });
  it("ageing buckets at the opening date", () => {
    expect(ageingBucket("2026-06-30", "2026-06-30")).toEqual({ days: 0, bucket: "current" });
    expect(ageingBucket("2026-06-09", "2026-06-30")).toEqual({ days: 21, bucket: "1-30" });
    expect(ageingBucket("2026-03-01", "2026-06-30").bucket).toBe("90+");
    expect(ageingBucket("2026-07-10", "2026-06-30")).toEqual({ days: 0, bucket: "current" });
  });
  it("groupByType keeps the accounting order and totals per group to the halala", () => {
    const g = groupByType([{ type: "liability", debit: 0, credit: 7000.004 }, { type: "asset", debit: 30000, credit: 0 }, { type: "asset", debit: 25000, credit: 0 }]);
    expect(g.map((x) => [x.type, x.debit, x.credit])).toEqual([["asset", 55000, 0], ["liability", 0, 7000], ["equity", 0, 0], ["income", 0, 0], ["expense", 0, 0]]);
  });
  it("every set has a spec, and every spec field is addressable by the template header", () => {
    for (const [kind, fields] of Object.entries(FIELDS_OF)) {
      const header = csvTemplate(kind as never).split("\n")[0].split(",");
      expect(header, kind).toEqual(fields.map((f) => f.name));
    }
  });
});
