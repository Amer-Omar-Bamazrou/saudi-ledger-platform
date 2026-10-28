/**
 * 🔴 Phase 18 G1 — VAT invoices: owner decisions 6, 8 and 13 (register §11.30;
 * final-run memo §2 G; scoped D-4 statement register §11.37). Each DECIDED
 * 2026-10-27: an owner decision based on research, not a professional
 * opinion; reversible; to be reviewed before go-live.
 *
 *  - 6: a supplier's invoice whose VAT is not 15 % of the taxable amount. VAT
 *    ABOVE the rate is held whole until the supplier's credit note corrects it;
 *    no user act confirms it. Non-zero VAT BELOW the rate is held until the
 *    user confirms the figures with an evidence note; a changed figure voids
 *    the confirmation. Never more than the VAT shown is claimed.
 *  - 8: a sales debit note states the substance of the extra charge, with no
 *    default. Only a price change on the original supply is a debit note (with
 *    the date the price changed); a new supply, compensation and a late-payment
 *    fee are refused, each naming its route. The Art. 54(6) deadline is shown;
 *    a late note is never refused.
 *  - 13: a withdrawal states its reason, and the full Art. 52(8) calculation is
 *    stored with the 15 % rate and the VAT on the nominal supply.
 *
 * Acts go through HTTP, so a field the route drops is seen; set-up uses the
 * product's own services. DB-backed (sl_test / CI); skips on the placeholder.
 */
process.env.PORT ??= "3244";
process.env.SESSION_SECRET ??= "phase18-vat-g1-decisions-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { assetsService } from "../services/assets.service";
import { billsService } from "../services/bills.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18VatG1DecisionsPw1!";
const SUPPLIER_VAT = "300000000000003";

describeMaybe("Phase 18 G1 — VAT invoices: decisions 6, 8 and 13", () => {
  const h = g04Harness("p18vatg1");
  let orgId = "", companyId = "", userId = 0, vendorId = 0, customerId = 0, catId = 0;

  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const flagCodes = (b: { vatEvidence: { flags: Array<{ code: string; severity: string }> } }) =>
    b.vatEvidence.flags.map((f) => `${f.severity}:${f.code}`);
  const bill = async (body: Record<string, unknown>) => {
    const res = await h.api("admin", "POST", "/bills", {
      vendorId, supplierDocumentKind: "tax_invoice", date: "2026-09-10", items: [], ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const approveBill = async (id: number) => {
    const res = await h.api("admin", "POST", `/bills/${id}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const issuedInvoice = async (date: string) => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date, items: [{ description: "Consulting", quantity: 1, unitPrice: 1000, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const issued = await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    return issued.body;
  };
  const debitNote = (originalInvoiceId: number, extra: Record<string, unknown>) =>
    h.api("admin", "POST", "/invoices", {
      documentType: "debit_note", originalInvoiceId, noteReason: "Price revised", customerId, date: "2026-10-20",
      items: [{ description: "Price increase", quantity: 1, unitPrice: 100, vatRate: 15 }], ...extra,
    });
  /** An asset bought and capitalised through the product's own paths (fixed-assets-disposal's set-up). */
  const assetInService = async (name: string, cost: number, lifeMonths: number, available: string) => {
    const draft = await h.inTenant(orgId, companyId, userId, () => assetsService.create({
      name, categoryId: catId, acquisitionDate: available, availableForUseDate: available, cost, usefulLifeMonths: lifeMonths, vatInputTaxAmount: Math.round(cost * 15) / 100,
    }, userId));
    const b = await h.inTenant(orgId, companyId, userId, () => billsService.create({
      supplierDocumentKind: "tax_invoice", vendorReference: `SUP-${name}`, date: available, vendorId,
      subtotal: cost, vatAmount: Math.round(cost * 15) / 100, total: Math.round(cost * 115) / 100, capitalisesAssetId: draft.id, items: [],
    }, userId));
    await h.inTenant(orgId, companyId, userId, () => billsService.approve(b.id, {}, userId));
    return draft.id as number;
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    // an issuing company: a tax invoice names the seller's VAT number, CR and address
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'VAT G1 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = await h.mkUser("admin", PW, orgId, "admin");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G1 Supplier',$2) RETURNING id`, [orgId, SUPPLIER_VAT])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'G1 Buyer') RETURNING id`, [orgId])).rows[0].id;
    catId = (await h.inTenant(orgId, companyId, userId, () => assetsService.createCategory({ name: "G1 Machines", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  // ── decision 6 ────────────────────────────────────────────────────────────

  it("control 6: VAT at 15 % is evidenced and claimed at approval, as before", async () => {
    const before = await gl("VAT_INPUT");
    const b = await bill({ vendorReference: "G1-OK-1", subtotal: 1000, vatAmount: 150, total: 1150 });
    expect(b.vatEvidence.status).toBe("evidenced");
    const posted = await approveBill(b.id);
    expect([posted.inputVat.state, await gl("VAT_INPUT") - before]).toEqual(["claimed", 150]);
  });

  it("control 6: a mixed-rate invoice (a 0 % line and a 15 % line) is not in dispute and is claimed", async () => {
    const b = await bill({ vendorReference: "G1-MIX-1", items: [
      { description: "Standard-rated part", quantity: 1, unitPrice: 1000, vatRate: 15 },
      { description: "Zero-rated part", quantity: 1, unitPrice: 500, vatRate: 0 },
    ] });
    expect(b.vatEvidence.status).toBe("evidenced");
    expect(flagCodes(b).filter((c) => c.startsWith("blocking:"))).toEqual([]);
  });

  it("🔴 6: VAT ABOVE 15 % of the taxable amount (a header-only bill) is HELD WHOLE at approval — never VAT_INPUT — and the flag names the supported and disputed VAT", async () => {
    const before = { vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE") };
    const b = await bill({ vendorReference: "G1-ABOVE-1", subtotal: 1000, vatAmount: 200, total: 1200 });
    expect(b.vatEvidence.status).toBe("awaiting_evidence");
    expect(flagCodes(b)).toContain("blocking:supplier_vat_above_rate");
    expect(b.vatEvidence.flags.find((f: { code: string }) => f.code === "supplier_vat_above_rate").amounts).toEqual({ shown: 200, supported: 150, disputed: 50 });
    const posted = await approveBill(b.id);
    expect([posted.inputVat.state, posted.inputVat.pending]).toEqual(["awaiting_evidence", 200]);
    expect([await gl("VAT_INPUT") - before.vat, await gl("VAT_AWAITING_EVIDENCE") - before.hold]).toEqual([0, 200]);
  });

  it("🔴 6: a LINE above 15 % holds the bill; supported = Σ min(line VAT, 15 % × line base)", async () => {
    const b = await bill({ vendorReference: "G1-LINE-1", items: [
      { description: "Overcharged line", quantity: 1, unitPrice: 1000, vatRate: 20 },
      { description: "Zero-rated line", quantity: 1, unitPrice: 500, vatRate: 0 },
    ] });
    expect(b.vatEvidence.status).toBe("awaiting_evidence");
    expect(b.vatEvidence.flags.find((f: { code: string }) => f.code === "supplier_vat_above_rate")?.amounts).toEqual({ shown: 200, supported: 150, disputed: 50 });
  });

  it("🔴 6: no user act claims VAT above the rate; the SUPPLIER'S credit note correcting the excess releases it, and the claim is the supported VAT, never more", async () => {
    const before = await gl("VAT_INPUT");
    const b = await bill({ vendorReference: "G1-ABOVE-2", subtotal: 2000, vatAmount: 400, total: 2400 });
    await approveBill(b.id);
    // supplying evidence again changes nothing while the excess stands
    const early = await h.api("admin", "POST", `/bills/${b.id}/evidence`, { evidenceDate: "2026-09-20" });
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect([early.body.inputVat.state, flagCodes(early.body)]).toEqual(["awaiting_evidence", expect.arrayContaining(["blocking:supplier_vat_above_rate"])]);
    // no confirmation is accepted for it
    const confirm = await h.api("admin", "POST", `/bills/${b.id}/vat-figures-confirmation`, { note: "The supplier insists" });
    expect([confirm.status, confirm.body.code]).toEqual([422, "vat_above_rate_needs_supplier_correction"]);
    // the supplier's credit note takes back the 100 charged above the rate
    const note = await bill({ documentType: "credit_note", creditNoteAgainstBillId: b.id, vendorReference: "G1-CN-1", date: "2026-09-25", subtotal: 0, vatAmount: 100, total: 100 });
    await approveBill(note.id);
    const claimed = await h.api("admin", "POST", `/bills/${b.id}/evidence`, { evidenceDate: "2026-09-28" });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect([claimed.body.inputVat.state, claimed.body.inputVat.claimedOn, await gl("VAT_INPUT") - before]).toEqual(["claimed", "2026-09-28", 300]);
  });

  it("🔴 6: non-zero VAT BELOW 15 % is held until the user decides; the confirmation (with its evidence note) claims what is shown, on the evidence date", async () => {
    const before = await gl("VAT_INPUT");
    const b = await bill({ vendorReference: "G1-BELOW-1", subtotal: 1000, vatAmount: 100, total: 1100 });
    expect([b.vatEvidence.status, flagCodes(b)]).toEqual(["awaiting_evidence", expect.arrayContaining(["blocking:supplier_vat_below_rate_unconfirmed"])]);
    const posted = await approveBill(b.id);
    expect([posted.inputVat.state, await gl("VAT_INPUT") - before]).toEqual(["awaiting_evidence", 0]);
    const noNote = await h.api("admin", "POST", `/bills/${b.id}/vat-figures-confirmation`, { note: "  " });
    expect([noNote.status, noNote.body.code]).toEqual([400, "vat_figures_confirmation_note_required"]);
    const ok = await h.api("admin", "POST", `/bills/${b.id}/vat-figures-confirmation`, { note: "Delivery note DN-77 and the supplier's email of 2026-09-12: part of the order is zero-rated", evidenceDate: "2026-09-15" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect([ok.body.vatEvidence.status, flagCodes(ok.body)]).toEqual(["evidenced", expect.arrayContaining(["warning:supplier_vat_figures_confirmed"])]);
    expect(ok.body.vatFiguresConfirmation).toMatchObject({ subtotal: 1000, vatAmount: 100, confirmedBy: userId, current: true });
    expect([ok.body.inputVat.state, ok.body.inputVat.claimedOn, await gl("VAT_INPUT") - before]).toEqual(["claimed", "2026-09-15", 100]);
  });

  it("🔴 6: a confirmation is VOID once the figures change, and none is taken where nothing is in dispute", async () => {
    const b = await bill({ vendorReference: "G1-BELOW-2", subtotal: 1000, vatAmount: 100, total: 1100 });
    const ok = await h.api("admin", "POST", `/bills/${b.id}/vat-figures-confirmation`, { note: "Order PO-9 shows a mixed-rate supply" });
    expect([ok.status, ok.body.vatEvidence?.status], JSON.stringify(ok.body)).toEqual([200, "evidenced"]);
    const edited = await h.api("admin", "PATCH", `/bills/${b.id}`, { vatAmount: 90, total: 1090 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect([edited.body.vatEvidence.status, flagCodes(edited.body), edited.body.vatFiguresConfirmation?.current]).toEqual(["awaiting_evidence", expect.arrayContaining(["blocking:supplier_vat_below_rate_unconfirmed"]), false]);
    const fine = await bill({ vendorReference: "G1-OK-2", subtotal: 1000, vatAmount: 150, total: 1150 });
    const none = await h.api("admin", "POST", `/bills/${fine.id}/vat-figures-confirmation`, { note: "Nothing to confirm" });
    expect([none.status, none.body.code]).toEqual([422, "vat_figures_not_in_dispute"]);
  });

  // ── decision 8 ────────────────────────────────────────────────────────────

  it("control 8: a credit note needs no substance", async () => {
    const inv = await issuedInvoice("2026-08-04");
    const cn = await h.api("admin", "POST", "/invoices", { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Goods returned", customerId, date: "2026-10-20", items: [{ description: "Return", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
  });

  it("🔴 8: a debit note must state the substance of the extra charge — there is no default", async () => {
    const inv = await issuedInvoice("2026-08-05");
    const res = await debitNote(inv.id, {});
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([400, "debit_note_substance_required"]);
  });

  it("🔴 8: a new supply, compensation and a late-payment fee are refused as debit notes, each naming its route; the substance is refused on any other document", async () => {
    const inv = await issuedInvoice("2026-08-06");
    const got: Array<[number, string]> = [];
    for (const s of ["new_supply", "compensation", "late_payment_fee"]) {
      const res = await debitNote(inv.id, { chargeSubstance: s, chargeEventDate: "2026-09-01" });
      got.push([res.status, res.body.code]);
    }
    expect(got).toEqual([[422, "extra_charge_is_new_supply"], [422, "extra_charge_is_compensation"], [422, "late_payment_fee_needs_substance"]]);
    const onCredit = await h.api("admin", "POST", "/invoices", { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Goods returned", customerId, date: "2026-10-20", chargeSubstance: "price_change", items: [{ description: "Return", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    expect([onCredit.status, onCredit.body.code]).toEqual([400, "charge_substance_only_on_debit_note"]);
  });

  it("🔴 8: a price change needs the day the price changed — not before the original, not after the note; the Art. 54(6) deadline is shown, and a LATE note is issued, never refused", async () => {
    const inv = await issuedInvoice("2026-08-07");
    const noDate = await debitNote(inv.id, { chargeSubstance: "price_change" });
    const early = await debitNote(inv.id, { chargeSubstance: "price_change", chargeEventDate: "2026-08-01" });
    const later = await debitNote(inv.id, { chargeSubstance: "price_change", chargeEventDate: "2026-10-25" });
    expect([[noDate.status, noDate.body.code], [early.status, early.body.code], [later.status, later.body.code]]).toEqual([
      [400, "charge_event_date_required"], [422, "charge_event_date_before_original"], [422, "charge_event_date_after_note"],
    ]);
    const late = await debitNote(inv.id, { chargeSubstance: "price_change", chargeEventDate: "2026-09-01" });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect(late.body).toMatchObject({ chargeSubstance: "price_change", chargeEventDate: "2026-09-01", art54Deadline: "2026-10-15", issuedAfterDeadline: true });
    const issued = await h.api("admin", "POST", `/invoices/${late.body.id}/approve`, {});
    expect([issued.status, issued.body.issuedAfterDeadline], JSON.stringify(issued.body)).toEqual([200, true]);
  });

  // ── decision 13 ───────────────────────────────────────────────────────────

  it("control 13: a scrap needs no withdrawal reason", async () => {
    const id = await assetInService("G1Press", 12_000, 24, "2026-03-01");
    const res = await h.api("admin", "POST", `/assets/${id}/dispose`, { date: "2026-05-10", kind: "scrapped", reason: "Damaged beyond repair" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("🔴 13: a withdrawal states WHY it left (private use, gift, cessation of taxable use) — there is no default", async () => {
    const id = await assetInService("G1Gen1", 24_000, 24, "2026-03-01");
    const none = await h.api("admin", "POST", `/assets/${id}/dispose`, { date: "2026-05-15", kind: "withdrawn", reason: "Taken out of the business" });
    const bad = await h.api("admin", "POST", `/assets/${id}/dispose`, { date: "2026-05-15", kind: "withdrawn", reason: "Taken out of the business", withdrawalReason: "lent_out" });
    expect([[none.status, none.body.code], [bad.status, bad.body.code]], JSON.stringify([none.body, bad.body])).toEqual([[400, "withdrawal_reason_required"], [400, "withdrawal_reason_invalid"]]);
  });

  it("🔴 13: the FULL Art. 52(8) calculation is stored on the disposal — purchase value, recovery %, adjustment period, years elapsed and remaining, the value, the 15 % rate and the VAT", async () => {
    const id = await assetInService("G1Gen2", 24_000, 24, "2026-03-01");
    const res = await h.api("admin", "POST", `/assets/${id}/dispose`, { date: "2026-05-15", kind: "withdrawn", reason: "Taken into the owner's private use", withdrawalReason: "private_use" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const calc = {
      rule: "VAT IR Art. 52(8)", route: "art_52_8_formula",
      purchaseValue: 24_000, initialRecoveryPct: 100, adjustmentPeriodYears: 2, yearsElapsed: 1, yearsRemaining: 1,
      nominalSupplyValue: 12_000, vatRatePct: 15, vatOnNominalSupply: 1_800,
    };
    expect(res.body.disposal).toMatchObject({ withdrawalReason: "private_use", nominalSupplyValue: 12_000, nominalSupplyCalculation: calc });
    const read = await h.api("admin", "GET", `/assets/${id}`);
    expect(read.body.disposal).toMatchObject({ withdrawalReason: "private_use", nominalSupplyCalculation: calc });
  });
});
