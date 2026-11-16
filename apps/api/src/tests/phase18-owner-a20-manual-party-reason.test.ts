/**
 * 🔴 Phase 18 owner decision A20 (2026-11-16) — a manual journal line on SECURITY_DEPOSITS_HELD or
 * UNIDENTIFIED_RECEIPTS names the customer, or states why there is none; the reason is stored with the line.
 *
 * The audit's A20: the posting seam requires a party on these two accounts — a customer, or a stated "no party" with
 * a reason (the receipt paths do this). The manual journal did neither: it REFUSED a customer there, and had no way to
 * state "no party", so its only line was party-less and unexplained ("a balance nobody can apply or refund"). The
 * owner's rule: a manual line may name the customer; with no customer it posts only with a stated reason, stored with
 * the line, matching the receipt paths.
 *
 * Presence, absence, movement: a customer is accepted (and recorded as the line's party); no customer and no reason is
 * refused by name; a reason is accepted and stored, and approval posts it; a vendor, a customer together with a
 * reason, and a reason on any other account are refused. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3390";
process.env.SESSION_SECRET ??= "phase18-owner-a20-manual-party-reason1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { postJournalEntry } from "../services/accounting/glPosting";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "OwnerA20PartyReasonPw1!";

describeMaybe("Phase 18 owner decision A20 — a manual line on SECURITY_DEPOSITS_HELD / UNIDENTIFIED_RECEIPTS names its customer or states why not", () => {
  const h = g04Harness("owna20");
  let orgId = "", companyId = "", adminId = 0, customerId = 0, vendorId = 0, seq = 0;
  const acct: Record<string, number> = {};

  const entry = (code: string, party: Record<string, unknown>) => ({
    entryNumber: `A20-${++seq}`,
    date: "2026-11-02",
    description: "A20 manual party",
    lines: [
      { accountId: acct.RENT_UTILITIES, accountName: "rent", debitAmount: 250, creditAmount: 0 },
      { accountId: acct[code], accountName: code, debitAmount: 0, creditAmount: 250, ...party },
    ],
  });
  const line = async (entryId: number, code: string) => (await pool.query(
    `SELECT l.customer_id, l.vendor_id, l.party_type, l.party_none_reason FROM journal_entry_lines l WHERE l.journal_entry_id = $1 AND l.account_id = $2`,
    [entryId, acct[code]])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Owner A20 Co", "318181818181663");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A20 Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A20 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    for (const code of ["RENT_UTILITIES", "OFFICE_SUPPLIES", "SECURITY_DEPOSITS_HELD", "UNIDENTIFIED_RECEIPTS"]) {
      acct[code] = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id;
    }
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  for (const code of ["SECURITY_DEPOSITS_HELD", "UNIDENTIFIED_RECEIPTS"]) {
    it(`🔴 ${code}: a line may name the customer — accepted, and the customer is the line's party`, async () => {
      const r = await h.api("admin", "POST", "/journal-entries", entry(code, { customerId }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await line(r.body.id, code)).toMatchObject({ customer_id: customerId, party_type: "customer", party_none_reason: null });
    });

    it(`🔴 ${code}: no customer and no reason is refused by name`, async () => {
      const r = await h.api("admin", "POST", "/journal-entries", entry(code, {}));
      expect([r.status, r.body?.code, r.body?.field], JSON.stringify(r.body)).toEqual([422, "journal_line_party_reason_required", "lines[1].partyNoneReason"]);
    });

    it(`🔴 ${code}: no customer WITH a stated reason is accepted, the reason stored with the line, and approval posts it`, async () => {
      const reason = "Cash deposit from an unidentified payer, bank reference 7781";
      const r = await h.api("admin", "POST", "/journal-entries", entry(code, { partyNoneReason: reason }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await line(r.body.id, code)).toMatchObject({ customer_id: null, party_type: null, party_none_reason: reason });
      expect((await h.api("admin", "POST", `/journal-entries/${r.body.id}/approve`, {})).status).toBe(200);
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [r.body.id])).rows[0].status).toBe("posted");
    });
  }

  it("a vendor on these accounts is refused", async () => {
    const r = await h.api("admin", "POST", "/journal-entries", entry("UNIDENTIFIED_RECEIPTS", { vendorId }));
    expect([r.status, r.body?.code]).toEqual([422, "journal_line_party_invalid"]);
  });

  it("a customer AND a reason together is refused — a reason says there is no party", async () => {
    const r = await h.api("admin", "POST", "/journal-entries", entry("SECURITY_DEPOSITS_HELD", { customerId, partyNoneReason: "both" }));
    expect([r.status, r.body?.code]).toEqual([422, "journal_line_party_invalid"]);
  });

  it("a no-party reason on any other account is refused (it only means something on these two)", async () => {
    const r = await h.api("admin", "POST", "/journal-entries", entry("OFFICE_SUPPLIES", { partyNoneReason: "not here" }));
    expect([r.status, r.body?.code]).toEqual([422, "journal_line_party_invalid"]);
  });

  it("🔴 the posting seam stores the reason a receipt path states for naming no party (the same column)", async () => {
    const reason = "simplified invoice — no identified customer (seam probe)";
    const je = await h.inTenant(orgId, companyId, adminId, () => postJournalEntry({
      entryNumber: `A20-SEAM-${++seq}`, date: "2026-11-03", description: "A20 seam probe",
      lines: [
        { systemCode: "RENT_UTILITIES", accountName: "Rent", debitAmount: 40, creditAmount: 0 },
        { systemCode: "UNIDENTIFIED_RECEIPTS", accountName: "Unidentified receipts", debitAmount: 0, creditAmount: 40, party: { type: "none", reason } },
      ],
    }));
    try {
      expect(await line(je.id, "UNIDENTIFIED_RECEIPTS")).toMatchObject({ customer_id: null, party_type: null, party_none_reason: reason });
    } finally {
      await releasePostedJournalsForTeardown(`id = $1`, [je.id]);
    }
  });

  it("the database keeps the reason to a line with no party (CHECK)", async () => {
    const r = await h.api("admin", "POST", "/journal-entries", entry("UNIDENTIFIED_RECEIPTS", { customerId }));
    expect(r.status).toBe(201);
    const lineId = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_id = $2`, [r.body.id, acct.UNIDENTIFIED_RECEIPTS])).rows[0].id;
    const err = await pool.query(`UPDATE journal_entry_lines SET party_none_reason = 'forged' WHERE id = $1`, [lineId]).then(() => null, (e: { code?: string; constraint?: string }) => e);
    expect([err?.code, err?.constraint]).toEqual(["23514", "journal_entry_lines_party_none_reason_chk"]);
  });
});
