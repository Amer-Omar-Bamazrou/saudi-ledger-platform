/**
 * 🔴 Phase 18 audit (2026-11-09), finding A8 — G29: an `einvoice_documents` row is written only in the issuance's
 * own shape.
 *
 * 0125 froze a document against UPDATE and DELETE, and 0150 against TRUNCATE; nothing guarded INSERT, and the app role
 * holds it. A writer could queue a document for any invoice — a draft, another company's, a long-issued one — and
 * §5.5 forbids removing it again. The chain head is read from these rows, so a forged one becomes the next
 * document's previous-invoice hash.
 *
 * The issuance writes a document inside the sequence lock, right after the invoice is issued and given its ICV and
 * UUID (`invoices.approvable` → `enqueueEInvoice`). So a row is admitted only when its invoice is ISSUED, belongs to
 * the row's own organization and company, carries the row's `zatca_uuid`, and holds its company's NEWEST ICV.
 *
 * Presence, absence, movement: each wrong shape is refused for the app role and the owner alike; the issuance's own
 * shape is admitted for both (so the guard is not a blanket refusal); replica mode stays the fixtures' one bypass.
 * The live issuance path is proven by the suites that approve for an onboarded company (einvoice-enqueue,
 * phase18-g08r-b-onboarded, phase18-audit-a10-xml-parties-read-once). DB-backed (sl_test / CI).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { releaseIssuedInvoicesForTeardown, writeIssuedFixture } from "./helpers/issuedInvoiceFixtures";
import { deleterFor } from "./helpers/replica";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString && !connectionString.includes("placeholder") ? describe : describe.skip;
const SLUG = "p18-audit-a8-doc-insert";
type Role = "postgres" | "authenticated";
type Attempt = { refused: boolean; code: string | null; constraint: string | null; message?: string };

const UUID_A1 = "a8a8a8a8-0000-4000-8000-000000000001";
const UUID_A2 = "a8a8a8a8-0000-4000-8000-000000000002";
const UUID_B1 = "a8a8a8a8-0000-4000-8000-0000000000b1";

describeMaybe("Phase 18 audit A8 — an e-invoice document is inserted only in the issuance's own shape", () => {
  let orgId = "", companyA = "", companyB = "", draftId = 0, olderId = 0, newestId = 0, otherCompanyId = 0;

  /** One INSERT as `role`, scoped to company A, in a transaction that is always rolled back. */
  async function attempt(role: Role, values: { companyId?: string; invoiceId: number; zatcaUuid: string }): Promise<Attempt> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (role !== "postgres") {
        await c.query(`SET LOCAL ROLE ${role}`);
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [values.companyId ?? companyA]);
      }
      try {
        await c.query(
          `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, zatca_uuid, flow, status, invoice_hash, previous_invoice_hash, qr_code, signed_xml)
           VALUES ($1, $2, $3, $4, 'reporting', 'pending', 'YThoYXNo', 'YThwaWg=', 'YThxcg==', '<Invoice>a8</Invoice>')`,
          [orgId, values.companyId ?? companyA, values.invoiceId, values.zatcaUuid]);
        return { refused: false, code: null, constraint: null };
      } catch (e) {
        const err = e as { code?: string; constraint?: string; message?: string };
        return { refused: true, code: err.code ?? null, constraint: err.constraint ?? null, message: err.message };
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  const refusedByGuard = (a: Attempt) => ({ refused: a.refused, code: a.code, constraint: a.constraint });
  const GUARD = { refused: true, code: "23514", constraint: "einvoice_document_issuance_shape" };

  const issued = (companyId: string, number: string, icv: number, uuid: string) => writeIssuedFixture(
    `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, subtotal, vat_amount, total, invoice_hash, issued_at, icv, zatca_uuid)
     VALUES ($1, $2, $3, '2026-10-01', 'sent', 100, 15, 115, 'YThpbnY=', now(), $4, $5) RETURNING id`, [orgId, companyId, number, icv, uuid]).then((r) => r.rows[0].id as number);

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await releaseIssuedInvoicesForTeardown(`organization_id IN ${O}`);
    for (const t of ["einvoice_documents", "invoices", "audit_logs", "categories", "companies"]) {
      await deleterFor(pool, t).query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => { if (!/does not exist/.test(e.message)) throw e; });
    }
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('A8 Doc Insert Org', '${SLUG}') RETURNING id`)).rows[0].id;
    companyA = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1, 'A8 Co A', '1010101021', '399999999999911') RETURNING id`, [orgId])).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1, 'A8 Co B', '1010101022', '399999999999922') RETURNING id`, [orgId])).rows[0].id;
    draftId = (await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, subtotal, vat_amount, total) VALUES ($1, $2, 'A8-DRAFT', '2026-10-01', 'draft', 100, 15, 115) RETURNING id`,
      [orgId, companyA])).rows[0].id;
    olderId = await issued(companyA, "A8-001", 1, UUID_A1);
    newestId = await issued(companyA, "A8-002", 2, UUID_A2);
    otherCompanyId = await issued(companyB, "A8-B-001", 1, UUID_B1);
  });
  afterAll(cleanup);

  for (const role of ["authenticated", "postgres"] as const) {
    it(`🔴 ${role}: a document for an invoice that is not issued (a draft) is refused`, async () => {
      expect(refusedByGuard(await attempt(role, { invoiceId: draftId, zatcaUuid: UUID_A2 }))).toEqual(GUARD);
    });

    it(`🔴 ${role}: a document filed under one company for another company's invoice is refused`, async () => {
      expect(refusedByGuard(await attempt(role, { invoiceId: otherCompanyId, zatcaUuid: UUID_B1 }))).toEqual(GUARD);
    });

    it(`🔴 ${role}: a document whose UUID is not its invoice's is refused`, async () => {
      expect(refusedByGuard(await attempt(role, { invoiceId: newestId, zatcaUuid: UUID_A1 }))).toEqual(GUARD);
    });

    it(`🔴 ${role}: a document for an issued invoice that is not the company's newest ICV is refused`, async () => {
      expect(refusedByGuard(await attempt(role, { invoiceId: olderId, zatcaUuid: UUID_A1 }))).toEqual(GUARD);
    });

    it(`movement — ${role}: the issuance's own shape (issued, same company, its UUID, the newest ICV) is admitted`, async () => {
      expect(refusedByGuard(await attempt(role, { invoiceId: newestId, zatcaUuid: UUID_A2 }))).toEqual({ refused: false, code: null, constraint: null });
      expect(refusedByGuard(await attempt(role, { companyId: companyB, invoiceId: otherCompanyId, zatcaUuid: UUID_B1 })), "company B's own newest").toEqual({ refused: false, code: null, constraint: null });
    });
  }

  it("replica mode stays the fixtures' one bypass (owner-only), as 0125 documents for the freeze", async () => {
    const r = await writeIssuedFixture(
      `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, flow, status) VALUES ($1, $2, $3, 'reporting', 'failed') RETURNING id`,
      [orgId, companyA, olderId]);
    expect(r.rows.length).toBe(1);
  });
});
