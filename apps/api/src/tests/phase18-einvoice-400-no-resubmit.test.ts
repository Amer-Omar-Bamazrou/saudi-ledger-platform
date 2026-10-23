/**
 * 🔴 PROOF (Phase 18, owner approval 2026-10-22 item 3a; proof first): a
 * document ZATCA REJECTS with HTTP 400 is never submitted again — it goes
 * straight to `needs_review`. Transient errors keep their retries.
 *
 * Source (official PDF, E-Invoicing Detailed Guideline V2, May 2023): p. 53
 * lists 400 as "Action failed (rejected)"; p. 60: ZATCA does not allow the
 * same document to be submitted twice.
 *
 * The mechanism (main at `ed0bc424`): `zatca/errorMapping.ts` maps every non-2xx
 * other than 303 to a retryable `failed`; the worker (`outbox/worker.ts`)
 * schedules a backoff, and the next claim sends the SAME signed XML again, up
 * to `maxAttempts` (default 5) before `needs_review`.
 *
 * What this file asserts, fix-neutral:
 *  1. a 400 at clearance (standard) and at reporting (simplified): after ONE
 *     worker pass the document is `needs_review` with one attempt, not
 *     ambiguous, never `rejected` (the mapping stays empty until live evidence,
 *     M12.7), and a second pass — with any backoff already elapsed — sends that
 *     document NOTHING: the socket saw exactly one request for it;
 *  2. the instrument sees a retry: a 503 on another document is `failed` with
 *     a scheduled retry, and the second pass sends it AGAIN, byte-identical —
 *     so "one request" above is not a worker that never retries.
 *
 * The documents are real: issued through the product's approval path for an
 * onboarded company, signed, chained; only the ZATCA socket is scripted, under
 * the REAL provider (the einvoice-outbox pattern). DB-backed (sl_test / CI);
 * skips on the DB-free placeholder.
 */
process.env.PORT ??= "3219";
process.env.SESSION_SECRET ??= "phase18-einvoice-400-no-resubmit-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";
import { EInvoiceWorker } from "../services/einvoice/outbox/worker";
import { createZatcaDirectProvider } from "../services/einvoice/zatca/zatcaDirectProvider";
import type { ZatcaHttpClient, ZatcaRequest, ZatcaResponse } from "../services/einvoice/zatca/zatcaHttpClient";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "Einvoice400ProofPw123!";
const VAT = "399999999996023";
const NAME = "E-Invoice 400 Proof Co";
const DATE = "2026-10-05";
const REJECTED_400: ZatcaResponse = { httpStatus: 400, body: { errors: [{ code: "BR-KSA-XX", message: "scripted rejection" }] }, networkFailure: false, errorMessage: null };
const UNAVAILABLE_503: ZatcaResponse = { httpStatus: 503, body: { message: "scripted outage" }, networkFailure: false, errorMessage: null };

describeMaybe("E-invoice worker — a ZATCA 400 is never resubmitted; a transient error is", () => {
  const h = g04Harness("p18e400");
  let orgId = "";
  let companyId = "";
  let b2c = 0;
  let b2b = 0;

  async function purgeCredentials() {
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${h.ORGS})`;
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
  }

  async function issue(customerId: number, unitPrice: number): Promise<number> {
    const created = await h.api("bookkeeper", "POST", "/invoices", { date: DATE, customerId, items: [{ description: "Professional services", quantity: 1, unitPrice, vatRate: 15 }] });
    expect(created.status, `create: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await h.api("accountant", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  }
  const doc = async (invoiceId: number) =>
    (await pool.query(`SELECT status, attempt_count, ambiguous, next_attempt_at IS NOT NULL AS scheduled, zatca_uuid FROM einvoice_documents WHERE invoice_id = $1`, [invoiceId])).rows[0];

  /** One scripted socket under the REAL provider: 400 for the documents named, 503 for every other. */
  function scriptedWorker(rejectUuids: Set<string>) {
    const sent: ZatcaRequest[] = [];
    const client: ZatcaHttpClient = {
      async send(req) {
        sent.push(req);
        return rejectUuids.has(req.uuid) ? REJECTED_400 : UNAVAILABLE_503;
      },
    };
    const provider = createZatcaDirectProvider({ client, resolveTransportCredentials: async () => ({ certificateBase64: "CERT", secret: "SECRET" }) });
    return { worker: new EInvoiceWorker({ provider, organizationId: orgId, batchSize: 100 }), sent };
  }

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
                              building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,$2,'شركة','1010101010',$3,1,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234') RETURNING id`, [orgId, NAME, VAT],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: "SLP-EGS-P18E400", organizationName: NAME, organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: VAT, egsSerialNumber: "1-SLP|2-P18E400|3-EGS001", production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({ credentialId, certificatePem, csidSecret: "csid-secret", notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") });
    b2c = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Walk-in Client','عميل') RETURNING id`, [orgId])).rows[0].id;
    b2b = (await pool.query(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, country)
       VALUES ($1,'Business Client','عميل تجاري','311111111111113','1010202020','4321','Olaya St','Al Olaya','Riyadh','12211','4321','SA') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "E400 Main", bankName: "Riyad Bank", iban: "SA0380000000608010167519", currency: "SAR", isDefault: true });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await purgeCredentials();
    await h.cleanup();
  });

  it("🔴 a 400 at clearance and at reporting goes straight to needs_review and is never sent again; a 503 is retried with the same document", async () => {
    const standard = await issue(b2b, 2_500);
    const simplified = await issue(b2c, 1_200);
    const transient = await issue(b2c, 900);
    const [s, p, t] = [await doc(standard), await doc(simplified), await doc(transient)];
    const { worker, sent } = scriptedWorker(new Set([s.zatca_uuid, p.zatca_uuid]));
    const requestsFor = (uuid: string) => sent.filter((r) => r.uuid === uuid);

    await worker.runOnce();
    const afterOne = { standard: await doc(standard), simplified: await doc(simplified), transient: await doc(transient) };
    // Any backoff has elapsed: whatever the worker would retry, it retries now.
    await pool.query(`UPDATE einvoice_documents SET next_attempt_at = now() - interval '1 hour' WHERE invoice_id = ANY($1::int[]) AND next_attempt_at IS NOT NULL`, [[standard, simplified, transient]]);
    await worker.runOnce();
    const afterTwo = { standard: await doc(standard), simplified: await doc(simplified), transient: await doc(transient) };

    const evidence = {
      afterOne, afterTwo,
      requests: { standard: requestsFor(s.zatca_uuid).length, simplified: requestsFor(p.zatca_uuid).length, transient: requestsFor(t.zatca_uuid).length },
    };
    // eslint-disable-next-line no-console
    console.warn("[E-INVOICE 400]", JSON.stringify(evidence));

    for (const label of ["standard", "simplified"] as const) {
      expect([afterOne[label].status, afterOne[label].attempt_count, afterOne[label].ambiguous], `${label}: a 400 goes to a human at once, not ambiguous`).toEqual(["needs_review", 1, false]);
      expect([afterTwo[label].status, afterTwo[label].attempt_count], `${label}: and stays there`).toEqual(["needs_review", 1]);
    }
    expect(evidence.requests.standard, "standard: ZATCA saw the rejected document ONCE").toBe(1);
    expect(evidence.requests.simplified, "simplified: ZATCA saw the rejected document ONCE").toBe(1);

    // The instrument sees a retry: the transient failure was scheduled and sent again, byte-identical.
    expect([afterOne.transient.status, afterOne.transient.scheduled], "a 503 is retryable, with a scheduled retry").toEqual(["failed", true]);
    expect([afterTwo.transient.attempt_count, evidence.requests.transient], "and is sent again").toEqual([2, 2]);
    const [first, second] = requestsFor(t.zatca_uuid);
    expect(second!.invoiceBase64, "the same signed document").toBe(first!.invoiceBase64);
  }, 240_000);
});
