/**
 * M12.6 — outbox transport mechanics.
 *
 * ── 🔴 WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT ─────────────────────────
 * They mock the {@link ZatcaHttpClient} boundary, so they prove the TRANSPORT:
 * claiming, concurrency safety, backoff, state transitions, idempotency and the
 * handling of ambiguous failures.
 *
 * **They prove NOTHING about whether ZATCA accepts our documents.** No request
 * leaves the machine. Acceptance is M12.4/M12.7, against the live API — and at
 * time of writing ZATCA's hosts are unreachable (`docs/zatca/README.md`), which
 * is precisely why the transport was built to be verifiable without them.
 *
 * DB-backed; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { einvoiceOutboxRepository } from "../repositories/einvoiceOutbox.repository";
import { EInvoiceWorker, backoffSeconds } from "../services/einvoice/outbox/worker";
import { mapZatcaResponse } from "../services/einvoice/zatca/errorMapping";
import type { ZatcaHttpClient, ZatcaRequest, ZatcaResponse } from "../services/einvoice/zatca/zatcaHttpClient";
import { createZatcaDirectProvider } from "../services/einvoice/zatca/zatcaDirectProvider";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[einvoice-outbox] no real DATABASE_URL — skipping.");

const SLUG = "m126-outbox";

/** A scripted client. Records what it was asked to send. */
function fakeClient(script: (req: ZatcaRequest) => ZatcaResponse): ZatcaHttpClient & { sent: ZatcaRequest[] } {
  const sent: ZatcaRequest[] = [];
  return {
    sent,
    async send(req) {
      sent.push(req);
      return script(req);
    },
  };
}

/**
 * Wrap the fake HTTP boundary in the REAL provider (S1).
 *
 * These tests used to construct the worker with a raw client, which meant they
 * exercised the transport while BYPASSING the `EInvoiceProvider` seam — the same
 * bypass that made the seam only one-third wired in production. Driving the real
 * provider over a fake socket keeps the boundary exactly where it was (scripted
 * HTTP responses) and now covers the seam as well.
 */
function providerWith(
  client: ZatcaHttpClient,
  resolveTransportCredentials: (companyId: string) => Promise<{ certificateBase64: string; secret: string } | null>,
) {
  return createZatcaDirectProvider({ client, resolveTransportCredentials });
}

const ACCEPTED: ZatcaResponse = { httpStatus: 200, body: { status: "REPORTED" }, networkFailure: false, errorMessage: null };
const REJECTED: ZatcaResponse = { httpStatus: 400, body: { errors: [{ code: "X" }] }, networkFailure: false, errorMessage: null };
const TIMEOUT: ZatcaResponse = { httpStatus: null, body: null, networkFailure: true, errorMessage: "ETIMEDOUT" };

describeMaybe("M12.6 — outbox transport (mocked at the HTTP boundary)", () => {
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let invoiceSeq = 0;

  const creds = async () => ({ certificateBase64: "CERT", secret: "SECRET" });

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  /** Insert an invoice + a queued outbox row, as approval would. */
  async function queueDocument(opts: { flow?: "clearance" | "reporting"; signed?: boolean } = {}): Promise<string> {
    invoiceSeq += 1;
    const inv = (
      await pool.query(
        `INSERT INTO invoices (organization_id, company_id, invoice_number, date, customer_id, status)
         VALUES ($1,$2,$3,'2026-04-01',$4,'sent') RETURNING id`,
        [orgId, companyId, `OB-${invoiceSeq}`, customerId],
      )
    ).rows[0].id;

    const { rows } = await pool.query(
      `INSERT INTO einvoice_documents
         (organization_id, company_id, invoice_id, flow, status, invoice_hash, signed_xml, zatca_uuid)
       VALUES ($1,$2,$3,$4,'pending',$5,$6, gen_random_uuid()) RETURNING id`,
      [
        orgId,
        companyId,
        inv,
        opts.flow ?? "reporting",
        opts.signed === false ? null : "SGVsbG8=",
        opts.signed === false ? null : "<Invoice/>",
      ],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status) VALUES ('Outbox','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Outbox Co') RETURNING id`, [orgId])
    ).rows[0].id;
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Cust') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(cleanup);
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM einvoice_documents WHERE organization_id = $1`,
      [orgId],
    );
  });

  // ── Claiming ─────────────────────────────────────────────────────────────

  it("claims due work and marks it submitting in ONE atomic statement", async () => {
    await queueDocument();
    const claimed = await einvoiceOutboxRepository.claimDue("w1", 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].attemptCount).toBe(1);

    // Re-claiming finds nothing: the row is no longer pending.
    expect(await einvoiceOutboxRepository.claimDue("w2", 10)).toHaveLength(0);
  });

  it("CONCURRENCY: two workers claiming at once never get the same row", async () => {
    for (let i = 0; i < 6; i++) await queueDocument();

    // FOR UPDATE SKIP LOCKED is what makes this safe — neither blocks, and no
    // row is handed to both. This is the property that lets us scale out by
    // adding processes rather than redesigning.
    const [a, b] = await Promise.all([
      einvoiceOutboxRepository.claimDue("worker-a", 6),
      einvoiceOutboxRepository.claimDue("worker-b", 6),
    ]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6); // no duplicates across workers
  });

  it("does not claim a row whose backoff has not elapsed", async () => {
    const id = await queueDocument();
    await einvoiceOutboxRepository.claimDue("w1", 10);
    await einvoiceOutboxRepository.markFailed(id, {
      errors: [{ e: 1 }],
      zatcaStatus: null,
      ambiguous: false,
      retryInSeconds: 3600,
    });
    expect(await einvoiceOutboxRepository.claimDue("w1", 10)).toHaveLength(0);
  });

  // ── State transitions ────────────────────────────────────────────────────

  it("a definitive acceptance is terminal and records ZATCA's status", async () => {
    const id = await queueDocument({ flow: "reporting" });
    const client = fakeClient(() => ACCEPTED);
    await new EInvoiceWorker({ provider: providerWith(client, creds), organizationId: orgId }).runOnce();

    const row = await einvoiceOutboxRepository.findById(id);
    expect(row!.status).toBe("reported");
    // Terminal: a further pass must not pick it up again.
    expect(await einvoiceOutboxRepository.claimDue("w1", 10)).toHaveLength(0);
  });

  it("clearance acceptance yields `cleared`, not `reported`", async () => {
    const id = await queueDocument({ flow: "clearance" });
    const client = fakeClient(() => ({ ...ACCEPTED, body: { status: "CLEARED", clearedInvoice: "<Cleared/>" } }));
    await new EInvoiceWorker({ provider: providerWith(client, creds), organizationId: orgId }).runOnce();

    const row = await einvoiceOutboxRepository.findById(id);
    expect(row!.status).toBe("cleared");
    const { rows } = await pool.query(`SELECT cleared_xml FROM einvoice_documents WHERE id = $1`, [id]);
    // ZATCA's stamped XML is the legal document and must be retained.
    expect(rows[0].cleared_xml).toBe("<Cleared/>");
  });

  it("a non-2xx response is RETRYABLE, never guessed into `rejected`", async () => {
    const id = await queueDocument();
    const client = fakeClient(() => REJECTED);
    await new EInvoiceWorker({ provider: providerWith(client, creds), organizationId: orgId }).runOnce();

    const row = await einvoiceOutboxRepository.findById(id);
    // Until M12.4 supplies real error semantics, a 4xx is NOT assumed terminal:
    // misclassifying a retryable error as terminal strands a valid invoice.
    expect(row!.status).toBe("failed");
  });

  it("escalates to needs_review once attempts are exhausted, instead of retrying forever", async () => {
    const id = await queueDocument();
    const client = fakeClient(() => REJECTED);
    const worker = new EInvoiceWorker({ provider: providerWith(client, creds), maxAttempts: 2, organizationId: orgId });

    await worker.runOnce(); // attempt 1 → failed, backoff
    await pool.query(`UPDATE einvoice_documents SET next_attempt_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await worker.runOnce(); // attempt 2 → exhausted

    const row = await einvoiceOutboxRepository.findById(id);
    expect(row!.status).toBe("needs_review");
    // And it stops consuming ZATCA quota.
    expect(await einvoiceOutboxRepository.claimDue("w1", 10)).toHaveLength(0);
  });

  // ── Idempotency and the ambiguous case ───────────────────────────────────

  it("AMBIGUOUS FAILURE: a timeout never schedules a blind retry", async () => {
    const id = await queueDocument();
    const client = fakeClient(() => TIMEOUT);
    await new EInvoiceWorker({ provider: providerWith(client, creds), organizationId: orgId }).runOnce();

    const row = await einvoiceOutboxRepository.findById(id);
    // ZATCA may have processed it. Resubmitting risks a duplicate; abandoning it
    // strands a consumed ICV. So it goes to a human, not back into the queue.
    expect(row!.ambiguous).toBe(true);
    expect(row!.status).toBe("needs_review");
    expect(await einvoiceOutboxRepository.claimDue("w1", 10)).toHaveLength(0);
  });

  it("IDEMPOTENCY: a retry resubmits byte-identical content; the worker mints nothing", async () => {
    const id = await queueDocument();
    const client = fakeClient(() => REJECTED);
    const worker = new EInvoiceWorker({ provider: providerWith(client, creds), organizationId: orgId });

    await worker.runOnce();
    await pool.query(`UPDATE einvoice_documents SET next_attempt_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await worker.runOnce();

    expect(client.sent).toHaveLength(2);
    // Identical payload, identical uuid and hash. The worker only ever READS the
    // identifiers approval committed, so it cannot produce a second document for
    // one invoice or consume a second ICV.
    expect(client.sent[0].invoiceBase64).toBe(client.sent[1].invoiceBase64);
    expect(client.sent[0].uuid).toBe(client.sent[1].uuid);
    expect(client.sent[0].invoiceHash).toBe(client.sent[1].invoiceHash);
  });

  it("one invoice can never have two outbox rows", async () => {
    const id = await queueDocument();
    const { rows } = await pool.query(`SELECT invoice_id FROM einvoice_documents WHERE id = $1`, [id]);
    await expect(
      pool.query(
        `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, flow) VALUES ($1,$2,$3,'reporting')`,
        [orgId, companyId, rows[0].invoice_id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  // ── Crash recovery ───────────────────────────────────────────────────────

  it("reclaims a dead worker's rows AS AMBIGUOUS, not as fresh work", async () => {
    const id = await queueDocument();
    await einvoiceOutboxRepository.claimDue("dying-worker", 10);
    await pool.query(`UPDATE einvoice_documents SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [id]);

    expect(await einvoiceOutboxRepository.reclaimStale(60)).toBe(1);
    const row = await einvoiceOutboxRepository.findById(id);
    // The dead worker may have sent it before dying, so it must be reconciled
    // rather than resubmitted — the claim query skips ambiguous rows.
    expect(row!.ambiguous).toBe(true);
    expect(await einvoiceOutboxRepository.claimDue("w1", 10)).toHaveLength(0);
  });

  // ── Visibility ───────────────────────────────────────────────────────────

  it("surfaces overdue documents — quiet neglect is the dangerous failure", async () => {
    const id = await queueDocument();
    await pool.query(`UPDATE einvoice_documents SET created_at = now() - interval '3 hours' WHERE id = $1`, [id]);
    const overdue = await einvoiceOutboxRepository.listOverdue(60);
    // A simplified invoice silently missing ZATCA's 24h reporting window is
    // legal exposure for the tenant and nothing about it looks broken.
    expect(overdue.map((r) => r.id)).toContain(id);
  });

  it("an unsigned document is not retried — it needs re-issuing, not resending", async () => {
    const id = await queueDocument({ signed: false });
    const client = fakeClient(() => ACCEPTED);
    await new EInvoiceWorker({ provider: providerWith(client, creds), organizationId: orgId }).runOnce();

    expect(client.sent).toHaveLength(0); // never transmitted
    expect((await einvoiceOutboxRepository.findById(id))!.status).toBe("needs_review");
  });

  it("a company without credentials retries rather than failing permanently", async () => {
    const id = await queueDocument();
    const client = fakeClient(() => ACCEPTED);
    await new EInvoiceWorker({ provider: providerWith(client, async () => null), organizationId: orgId }).runOnce();

    expect(client.sent).toHaveLength(0);
    // Onboarding may complete at any moment, so this is not the document's fault.
    expect((await einvoiceOutboxRepository.findById(id))!.status).toBe("failed");
  });
});

// ── Pure units (no DB) ─────────────────────────────────────────────────────

describe("M12.6 — backoff and response mapping", () => {
  it("backs off exponentially, then gives up rather than hammering ZATCA", () => {
    expect(backoffSeconds(1, 5)).toBe(30);
    expect(backoffSeconds(2, 5)).toBe(60);
    expect(backoffSeconds(4, 5)).toBe(240);
    expect(backoffSeconds(5, 5)).toBeNull(); // exhausted → needs_review
  });

  it("maps a network failure to ambiguous, and a real response to not-ambiguous", () => {
    expect(mapZatcaResponse(TIMEOUT, "reporting").ambiguous).toBe(true);
    expect(mapZatcaResponse(REJECTED, "reporting").ambiguous).toBe(false);
  });

  it("NEVER returns `rejected` — nothing is guessed terminal before M12.4", () => {
    // The mapping table is deliberately empty. Populating it from the PDF would
    // encode guesses from the source that has been wrong thirteen times.
    for (const r of [REJECTED, TIMEOUT, { httpStatus: 500, body: {}, networkFailure: false, errorMessage: null }]) {
      expect(mapZatcaResponse(r as any, "clearance").status).not.toBe("rejected");
    }
  });
});
