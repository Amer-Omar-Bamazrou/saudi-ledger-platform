/**
 * 🔴 19B — the owner's three points on review-v2.md (2026-11-24), pinned.
 *
 *  1. `/bank-accounts` serves `pendingBankDetailChanges[].ibanBefore/ibanAfter` as standard. That is correct only if the
 *     list holds the COMPANY's own bank-account changes (a new default, the account's own IBAN) and never a supplier's
 *     or an employee's IBAN change. Pinned: with every kind held at once in one company, every /bank-accounts response
 *     carries company kinds only, and no party IBAN anywhere; the held-change list shows all four (presence).
 *  2. Member security, the policy: an admin reads every member's email and the invitation emails and links; every
 *     member reads their OWN email (/auth/me, sessions); other roles see colleagues' names and roles only. Pinned: the
 *     self-read for every role — under S2c's removals too — and a non-admin listing members or invitations is refused,
 *     with no colleague's or invitee's email in the answer; the admin reads both (presence).
 *  3. `/llm/demo` serves fixed sample transactions and `/llm/compare` echoes the caller's own input. Pinned: a tenant's
 *     real bank text is in neither; the demo is exactly its fixed samples; compare answers exactly the input it got.
 * DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, S2C_REMOVALS } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "review-v2-pins-password-2026";
const h = g04Harness("rv2pin");
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
// restated for S2c's removal: the set is applied in the matrix now, so "today's matrix" and "S2c's removals" are one matrix
const S2C = new Set(S2C_REMOVALS.map(key));

function saIban(bban: string): string {
  const n = BigInt(`${bban}281000`);
  return `SA${String(98n - (n % 97n)).padStart(2, "0")}${bban}`;
}
const COMPANY_IBAN_1 = saIban("10000000111122223333");
const COMPANY_IBAN_2 = saIban("10000000444455556666");
const VENDOR_IBAN = saIban("20000000777788889999");
const EMPLOYEE_IBAN = saIban("30000000121234345656");
const BANK_TEXT = "RV2PIN-TENANT-BANKTEXT-5521";
const INVITEE = "rv2pin-invitee@test.local";

describeDb("19B review-v2 points — pinned", () => {
  let orgId = "";
  const bankResponses: { what: string; text: string; body: any }[] = [];

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "RV2 Pins Co", "319494949494973");
    for (const role of ROLES) await h.mkUser(role, PW, orgId, role);
    await h.mkUser("admin2", PW, orgId, "admin"); // two admins: bank-account changes are held (dual control)
    for (const role of [...ROLES, "admin2"]) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    const record = (what: string, r: { text: string; body: any; status: number }) => { expect(r.status, `${what}: ${r.text}`).toBeLessThan(300); bankResponses.push({ what, text: r.text, body: r.body }); };
    // the company's own: an account, a second one made default (held), the first one's IBAN changed (held)
    const a = await h.api("admin", "POST", "/bank-accounts", { name: "Main", bankName: "SNB", currency: "SAR", iban: COMPANY_IBAN_1 });
    record("create the first account", a);
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "Second", bankName: "Rajhi", currency: "SAR", iban: COMPANY_IBAN_2, isDefault: true });
    record("create a second account as default", b);
    record("change the first account's IBAN", await h.api("accountant", "PATCH", `/bank-accounts/${a.body.id}`, { iban: saIban("10000000999988887777") }));
    // a party's: a supplier's and an employee's IBAN, held
    expect((await h.api("accountant", "POST", "/vendors", { name: "RV2 Supplier", iban: VENDOR_IBAN })).status).toBe(201);
    expect((await h.api("accountant", "POST", "/employees", { employeeNumber: "RV2-1", name: "RV2 Employee", iban: EMPLOYEE_IBAN, joiningDate: "2025-01-01" })).status).toBe(201);
    // and a tenant's real bank text, for point 3
    const bank = a.body.id as number;
    const cat = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES' AND is_posting`, [orgId])).rows[0].id;
    expect((await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: cat, bankAccountId: bank })).status).toBe(201);
    record("list the accounts", await h.api("admin", "GET", "/bank-accounts"));
    record("read one account", await h.api("admin", "GET", `/bank-accounts/${a.body.id}`));
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  describe("1. /bank-accounts: the company's own held changes only", () => {
    it("🔴 every /bank-accounts response carries company kinds only, and no supplier's or employee's IBAN anywhere", () => {
      const kinds = new Set<string>();
      for (const r of bankResponses) {
        const walk = (v: unknown) => {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "pendingBankDetailChanges" && Array.isArray(x)) for (const c of x) kinds.add(String((c as { kind: string }).kind)); walk(x); }
        };
        walk(r.body);
        for (const party of [VENDOR_IBAN, EMPLOYEE_IBAN, VENDOR_IBAN.slice(-8), EMPLOYEE_IBAN.slice(-8)]) expect([r.what, r.text.includes(party)]).toEqual([r.what, false]);
      }
      expect([...kinds].sort()).toEqual(["bank_account_iban", "default_bank_account"]); // presence: both company kinds were served
    });

    it("presence: the held-change list holds all four kinds — the party changes exist, and are not served by /bank-accounts", async () => {
      const r = await h.api("admin", "GET", "/companies/current/bank-detail-changes");
      expect([...new Set((r.body.items as { kind: string }[]).map((c) => c.kind))].sort()).toEqual(["bank_account_iban", "default_bank_account", "employee_iban", "vendor_iban"]);
    });
  });

  describe("2. member security: own email always; others' only to the admin", () => {
    for (const [label, matrix] of [["today's matrix", PERMISSION_MATRIX], ["S2c's removals", PERMISSION_MATRIX.filter((r) => !S2C.has(key(r)))]] as const) {
      it(`🔴 under ${label}: every member reads their own email (/auth/me) and their own sessions`, async () => {
        primePermissionCache(matrix);
        try {
          for (const who of ROLES) {
            const me = await h.api(who, "GET", "/auth/me");
            expect([who, me.status, me.text.includes(h.email(who))]).toEqual([who, 200, true]);
            for (const other of ROLES.filter((x) => x !== who)) expect([who, other, me.text.includes(h.email(other))]).toEqual([who, other, false]);
            expect([who, (await h.api(who, "GET", "/auth/sessions")).status]).toEqual([who, 200]);
          }
        } finally {
          primePermissionCache(PERMISSION_MATRIX);
        }
      });
    }

    it("🔴 a non-admin listing members or invitations is refused — no colleague's or invitee's email in the answer; the admin reads both, the invitation link included", async () => {
      const sent = await h.api("admin", "POST", `/orgs/${orgId}/invitations`, { email: INVITEE, role: "viewer" });
      expect(sent.status, sent.text).toBe(201);
      expect(typeof sent.body.link).toBe("string");
      for (const who of ["viewer", "bookkeeper", "accountant"]) {
        for (const path of [`/orgs/${orgId}/members`, `/orgs/${orgId}/invitations`]) {
          const r = await h.api(who, "GET", path);
          expect([who, path, r.status]).toEqual([who, path, 403]);
          expect([who, path, r.text.includes(INVITEE), ROLES.filter((x) => x !== who && r.text.includes(h.email(x)))]).toEqual([who, path, false, []]);
        }
      }
      const members = await h.api("admin", "GET", `/orgs/${orgId}/members`);
      expect(ROLES.filter((x) => !members.text.includes(h.email(x)))).toEqual([]);
      const invitations = await h.api("admin", "GET", `/orgs/${orgId}/invitations`);
      expect([invitations.status, invitations.text.includes(INVITEE)]).toEqual([200, true]);
    });
  });

  describe("3. /llm/demo and /llm/compare serve no tenant transaction", () => {
    it("🔴 the demo is exactly its fixed samples, for every role — the tenant's bank text is not among them", async () => {
      const sets: string[] = [];
      for (const who of ROLES) {
        const r = await h.api(who, "GET", "/llm/demo");
        expect([who, r.status]).toEqual([who, 200]);
        expect([who, r.text.includes(BANK_TEXT)]).toEqual([who, false]);
        sets.push(JSON.stringify((r.body.transactions as { description: string }[]).map((t) => t.description)));
      }
      expect(new Set(sets).size).toBe(1); // the same fixed list for everyone
      expect(JSON.parse(sets[0]!)).toHaveLength(10);
    });

    it("🔴 compare answers exactly the input it was sent — never a stored transaction", async () => {
      const input = [{ description: "RV2PIN caller input one", amount: 99, type: "debit" }, { description: "RV2PIN caller input two", amount: 5, type: "credit" }];
      const r = await h.api("admin", "POST", "/llm/compare", { transactions: input }); // compare needs llm create (a viewer is refused it)
      expect(r.status, r.text).toBe(200);
      expect((r.body.results as { input: { description: string } }[]).map((x) => x.input.description)).toEqual(input.map((x) => x.description));
      expect(r.text.includes(BANK_TEXT)).toBe(false);
    });
  });
});
