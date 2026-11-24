/**
 * 🔴 19B S2c — THE AUDIT READER, THE INVOICE `pay` RECORD, AND THE COMPANY'S OWN HELD IBAN (v4 §5.2, D9 (c); plan §14 S2c:
 * "as S2a, plus an audit copy withheld per key, and a `pay` record with no buyer snapshot").
 *
 *  - An audit snapshot is classified KEY BY KEY by the audited entity's own node: a customer's national ID by identity,
 *    its phone by contact, its name standard; a key the node does not list (a column the contract never serves), or
 *    any key of an entity with no node, is withheld from every role but the admin. Presence: the admin reads it all.
 *  - The invoice `pay` record names what a payment changed — never the whole row, so never the buyer's snapshot
 *    (address, national ID) or the printed bank details.
 *  - A held change of the COMPANY's own bank account is the business's record: standard for every role, under S2b's
 *    and S2c's removals too; a supplier's held IBAN still follows the supplier grants (movement).
 * Run under today's matrix and with S2b's and S2c's planned removals primed. DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, S2B_PENDING_REMOVALS, S2C_PENDING_REMOVALS } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { classifyResponse, deciderFor } from "../lib/fieldClasses/seam";
import { AUDIT_ENTITY_NODES, FIELD_CLASS_TABLE } from "../lib/fieldClasses/classTable";
import { g04Harness } from "./helpers/g04Harness";
import { approveHeldIbans } from "./helpers/approveHeldIbans";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2c-audit-password-2026";
const h = g04Harness("s2c-aud");
const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
const PENDING = new Set([...S2B_PENDING_REMOVALS, ...S2C_PENDING_REMOVALS].map(key));
const PRIMED = PERMISSION_MATRIX.filter((r) => !PENDING.has(key(r)));
const grantsOf = (rows: { role: string; resource: string; action: string }[]) => new Set(rows.map(key));

const NID = "1084215622";
const STREET = "S2C-PLANTED-STREET-7731";
const PHONE = "+966500071377";

describe("19B S2c — an audit snapshot, key by key (the walk)", () => {
  const entry = (entityType: string, state: Record<string, unknown>) => ({
    id: "1", userId: 1, actorName: "A", action: "update", entityType, entityId: "7", createdAt: "2026-11-24T00:00:00Z",
    beforeState: state, afterState: state, ipAddress: "203.0.113.9",
  });
  // the route answers a page: { total, limit, offset, logs: AuditLogEntry[] }
  const served = (role: string, matrix: { role: string; resource: string; action: string }[], logs: unknown[]) => {
    const out = classifyResponse("GET", "/api/audit-logs", 200, { total: logs.length, limit: 50, offset: 0, logs }, deciderFor(role, grantsOf(matrix)));
    return { ...out, value: (out.value as { logs: unknown[] }).logs };
  };

  it("every entity the reader maps names a node the class table has", () => {
    expect(Object.values(AUDIT_ENTITY_NODES).filter((n) => !(n in FIELD_CLASS_TABLE))).toEqual([]);
  });

  it("🔴 a customer's snapshot under S2b's and S2c's removals, as a role that may read the audit trail but not those classes: name kept; national ID, phone and an unlisted column withheld — each named", () => {
    const body = [entry("customer", { name: "Planted Buyer", nationalId: NID, phone: PHONE, street: STREET, legacyColumn: "x-7" })];
    // a role that reads no customer identity or contact and no audit member security — the viewer's grants, primed
    const out = served("viewer", PRIMED, body);
    const row = (out.value as Record<string, unknown>[])[0]!;
    expect(row.beforeState).toEqual({ name: "Planted Buyer" });
    expect(row.afterState).toEqual({ name: "Planted Buyer" });
    expect("ipAddress" in row).toBe(false);
    const named = (suffix: string) => out.withheld.filter((w) => w.path.endsWith(suffix)).map((w) => w.class);
    expect([named("beforeState.nationalId"), named("beforeState.phone"), named("beforeState.street"), named("beforeState.legacyColumn"), named("beforeState.name")])
      .toEqual([["identity"], ["contact"], ["contact"], ["member_security"], []]);
    expect(JSON.stringify(out.value)).not.toContain(NID);
    expect(JSON.stringify(out.value)).not.toContain(STREET);
    expect(out.unclassified).toEqual([]);
  });

  it("presence: the admin reads every key, the unlisted one included", () => {
    const body = [entry("customer", { name: "Planted Buyer", nationalId: NID, phone: PHONE, legacyColumn: "x-7" })];
    const row = (served("admin", PRIMED, body).value as Record<string, unknown>[])[0]!;
    expect(row.beforeState).toEqual({ name: "Planted Buyer", nationalId: NID, phone: PHONE, legacyColumn: "x-7" });
    expect(row.ipAddress).toBe("203.0.113.9");
  });

  it("🔴 an entity with no node: every key is the admin's only (an accountant, under S2c's removals, reads none)", () => {
    const body = [entry("migration_batch", { fileName: "parties.csv", rows: 12 })];
    expect(((served("accountant", PRIMED, body).value as Record<string, unknown>[])[0]!).beforeState).toEqual({});
    expect(((served("admin", PRIMED, body).value as Record<string, unknown>[])[0]!).beforeState).toEqual({ fileName: "parties.csv", rows: 12 });
  });

  it("movement: under today's matrix (every grant in place) the same snapshot is served whole to every role", () => {
    const body = [entry("customer", { name: "Planted Buyer", nationalId: NID, legacyColumn: "x-7" })];
    for (const role of ["viewer", "bookkeeper", "accountant"]) {
      expect([role, ((served(role, PERMISSION_MATRIX, body).value as Record<string, unknown>[])[0]!).beforeState]).toEqual([role, { name: "Planted Buyer", nationalId: NID, legacyColumn: "x-7" }]);
    }
  });
});

describeDb("19B S2c — the invoice `pay` record, and the company's own held IBAN (real rows)", () => {
  let orgId = "";
  let invoiceId = 0;
  let bankId = 0;

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2c Audit Co", "319696969696983");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    await h.mkUser("admin2", PW, orgId, "admin"); // two admins: a company IBAN change is held (dual control)
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    const cust = await h.api("accountant", "POST", "/customers", { name: "S2C Buyer", taxNumber: "300000000000003", nationalId: NID, phone: PHONE, buildingNumber: "7731", street: STREET, district: "Olaya", city: "Riyadh", postalCode: "12211" });
    expect(cust.status, JSON.stringify(cust.body)).toBe(201);
    const inv = await h.api("accountant", "POST", "/invoices", { invoiceNumber: "S2C-1", date: "2026-10-05", dueDate: "2026-11-04", customerId: cust.body.id, items: [{ description: "Services", quantity: 1, unitPrice: 1000, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    invoiceId = inv.body.id;
    expect((await h.api("accountant", "POST", `/invoices/${invoiceId}/submit`, {})).status).toBe(200);
    expect((await h.api("admin", "POST", `/invoices/${invoiceId}/approve`, {})).status).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "S2C Ops", bankName: "SNB", currency: "SAR", iban: "SA0380000000608010167519" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
    const paid = await h.api("accountant", "POST", `/invoices/${invoiceId}/pay`, { amount: 400, paidAt: "2026-10-10", bankAccountId: bankId });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    // the company's own bank account changes its IBAN: held for an approver (S3's mechanism, kind bank_account_iban)
    const changed = await h.api("accountant", "PATCH", `/bank-accounts/${bankId}`, { iban: "SA4420000001234567891234" });
    expect(changed.status, JSON.stringify(changed.body)).toBeLessThan(300);
    // and a supplier's IBAN, held too — the movement half
    const sup = await h.api("accountant", "POST", "/vendors", { name: "S2C Supplier", iban: "SA8580000000991234598799" });
    expect(sup.status, JSON.stringify(sup.body)).toBe(201);
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 the `pay` record names what the payment changed — no buyer snapshot, no address, no national ID, no bank details", async () => {
    const rows = (await pool.query(`SELECT before_state, after_state, row_to_json(a)::text AS raw FROM audit_logs a WHERE organization_id = $1 AND entity_type = 'invoice' AND action = 'pay'`, [orgId])).rows;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].after_state).sort()).toEqual(["customerId", "id", "invoiceNumber", "paidAmount", "status", "total"]);
    expect(Object.keys(rows[0].before_state).sort()).toEqual(["customerId", "id", "invoiceNumber", "paidAmount", "status", "total"]);
    expect([rows[0].before_state.paidAmount, rows[0].after_state.paidAmount].map(Number)).toEqual([0, 400]);
    for (const planted of [NID, STREET, PHONE, "issuedBuyer", "issuedBank"]) expect(rows[0].raw, planted).not.toContain(planted);
    // presence: the issued invoice itself still carries the buyer snapshot (the record left it out, the row did not lose it)
    expect((await pool.query(`SELECT issued_buyer FROM invoices WHERE id = $1`, [invoiceId])).rows[0].issued_buyer).toBeTruthy();
  });

  it("🔴 the company's own held IBAN is standard for every role — under S2b's and S2c's removals too; a supplier's follows its grants", async () => {
    primePermissionCache(PRIMED);
    try {
      for (const who of ["viewer", "bookkeeper", "accountant"]) {
        const r = await h.api(who, "GET", "/companies/current/bank-detail-changes");
        expect([who, r.status]).toEqual([who, 200]);
        const company = r.body.items.find((c: { kind: string }) => c.kind === "bank_account_iban");
        expect([who, company?.ibanAfter], JSON.stringify(r.body.items.map((c: Record<string, unknown>) => [c.kind, c.status, c.ibanAfter ?? "(absent)"]))).toEqual([who, "SA4420000001234567891234"]);
        const supplier = r.body.items.find((c: { kind: string }) => c.kind === "vendor_iban");
        const want = who === "accountant" ? "SA8580000000991234598799" : who === "bookkeeper" ? "•••• 8799" : undefined;
        expect([who, supplier?.ibanAfter]).toEqual([who, want]);
      }
    } finally {
      primePermissionCache(PERMISSION_MATRIX);
    }
    expect(await approveHeldIbans(h, "admin")).toBeGreaterThanOrEqual(1);
  });

  it("the audit trail stays the admin's: the viewer, bookkeeper and accountant are refused the route", async () => {
    for (const who of ["viewer", "bookkeeper", "accountant"]) expect([who, (await h.api(who, "GET", "/audit-logs")).status]).toEqual([who, 403]);
    const admin = await h.api("admin", "GET", "/audit-logs");
    expect(admin.status).toBe(200);
  });
});
