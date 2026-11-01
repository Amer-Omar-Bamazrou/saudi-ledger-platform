/**
 * 🔴 Phase 18 R-4 — AC-4, memo §2g (register §11.93): an ISSUED invoice's
 * e-invoice document refuses UPDATE, DELETE and TRUNCATE for EVERY role. The
 * UPDATE/DELETE halves are PR C's (0125, by trigger, for any role); TRUNCATE
 * is 0150's (a statement trigger on T1b's pattern — the owner held the
 * privilege and no trigger stood in the way).
 *
 * The probe names HOW each role is refused: by the trigger (the row was
 * reached) or by privilege (no grant — a weaker guard, one grant away). The
 * shared table is never truncated: T1b's two halves prove TRUNCATE.
 * DB-backed; skips without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { releaseIssuedInvoicesForTeardown, writeIssuedFixture } from "./helpers/issuedInvoiceFixtures";
import { deleterFor } from "./helpers/replica";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString && !connectionString.includes("placeholder") ? describe : describe.skip;
const SLUG = "p18-r4-einvoice-frozen";
const ROLES = ["postgres", "authenticated", "service_role", "anon"] as const;
type Role = (typeof ROLES)[number];
type Attempt = { refused: boolean; by: "trigger" | "privilege" | "rls" | null; code: string | null; constraint: string | null; rowCount: number | null; message?: string };

describeMaybe("Phase 18 R-4 — an issued invoice's e-invoice document is frozen for every role", () => {
  let orgId = "", companyId = "", invoiceId = 0, docId = "";

  /** One statement as `role`, inside a transaction that is always rolled back; the refusal classified. */
  async function attempt(role: Role, sql: string, params: unknown[] = []): Promise<Attempt> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (role !== "postgres") {
        await c.query(`SET LOCAL ROLE ${role}`);
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
      }
      try {
        const r = await c.query(sql, params);
        // under RLS a role may "succeed" on zero rows — that is not a refusal, and not a reach either
        return { refused: false, by: (r.rowCount ?? 0) === 0 && role !== "postgres" ? "rls" : null, code: null, constraint: null, rowCount: r.rowCount ?? null };
      } catch (e) {
        const err = e as { code?: string; constraint?: string; message?: string };
        const by = err.code === "42501" ? "privilege" : err.code === "23514" ? "trigger" : null;
        return { refused: true, by, code: err.code ?? null, constraint: err.constraint ?? null, rowCount: null, message: err.message };
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  const truncateTrigger = async () =>
    (await pool.query(
      `SELECT p.proname AS fn, t.tgenabled AS enabled
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'einvoice_documents'::regclass AND NOT t.tgisinternal
          AND (t.tgtype & 32) <> 0 AND (t.tgtype & 2) <> 0 AND (t.tgtype & 1) = 0`)).rows.map((r) => `${r.fn}:${r.enabled}`);
  const truncateRefusedBy = async (fn: string): Promise<Attempt> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE TEMP TABLE r4_truncate_probe (id int) ON COMMIT DROP`);
      await c.query(`CREATE TRIGGER r4_truncate_probe_trg BEFORE TRUNCATE ON r4_truncate_probe FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`);
      try {
        await c.query(`TRUNCATE r4_truncate_probe`);
        return { refused: false, by: null, code: null, constraint: null, rowCount: null };
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        return { refused: true, by: err.code === "23514" ? "trigger" : null, code: err.code ?? null, constraint: err.constraint ?? null, rowCount: null };
      }
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  };

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    // the freeze under test refuses the teardown too: the fixture writer releases the issued rows in replica mode first
    await releaseIssuedInvoicesForTeardown(`organization_id IN ${O}`);
    for (const t of ["einvoice_documents", "invoices", "customers", "audit_logs", "categories", "companies"]) {
      await deleterFor(pool, t).query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => { if (!/does not exist/.test(e.message)) throw e; });
    }
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('R4 Frozen Org', '${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1, 'R4 Co', '1010101013', '399999999999977') RETURNING id`, [orgId])).rows[0].id;
    // an ISSUED invoice, planted as the suites' fixture writer plants one (replica mode), and its signed document
    invoiceId = (await writeIssuedFixture(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, subtotal, vat_amount, total, invoice_hash, issued_at)
       VALUES ($1, $2, 'R4-001', '2026-08-01', 'sent', 100, 15, 115, 'cjQtaGFzaA==', now()) RETURNING id`, [orgId, companyId])).rows[0].id;
    docId = (await writeIssuedFixture(
      `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, flow, status, signed_xml, invoice_hash, created_at)
       VALUES ($1, $2, $3, 'reporting', 'reported', '<Invoice>r4</Invoice>', 'cjQtaGFzaA==', now()) RETURNING id`, [orgId, companyId, invoiceId])).rows[0].id;
  });
  afterAll(cleanup);

  it("control: the worker's transmission columns stay writable — the freeze is not a blanket refusal", async () => {
    for (const role of ["postgres", "authenticated"] as const) {
      const a = await attempt(role, `UPDATE einvoice_documents SET last_error = to_jsonb('r4 probe'::text) WHERE id = $1`, [docId]);
      expect([role, a.refused, a.rowCount], `${role}: last_error — ${a.message ?? "no error"}`).toEqual([role, false, 1]);
    }
  });

  it("🔴 UPDATE of a signed column is refused for every role — by the trigger where the row is reached, by privilege where there is no grant", async () => {
    const seen: Record<string, string> = {};
    for (const role of ROLES) {
      const a = await attempt(role, `UPDATE einvoice_documents SET signed_xml = '<Invoice>tampered</Invoice>' WHERE id = $1`, [docId]);
      expect(a.refused, `${role}: UPDATE signed_xml must be refused (${a.code ?? "no error"}, rows ${a.rowCount})`).toBe(true);
      seen[role] = `${a.by}:${a.constraint ?? a.code}`;
    }
    // the record: who is refused by WHAT (a privilege refusal is one grant away; a trigger refusal is not)
    expect(seen).toEqual({
      postgres: "trigger:einvoice_document_frozen",
      authenticated: "trigger:einvoice_document_frozen",
      service_role: "privilege:42501",
      anon: "privilege:42501",
    });
  });

  it("🔴 DELETE is refused for every role", async () => {
    const seen: Record<string, string> = {};
    for (const role of ROLES) {
      const a = await attempt(role, `DELETE FROM einvoice_documents WHERE id = $1`, [docId]);
      expect(a.refused, `${role}: DELETE must be refused`).toBe(true);
      seen[role] = `${a.by}:${a.constraint ?? a.code}`;
    }
    expect(seen).toEqual({
      postgres: "trigger:einvoice_document_frozen",
      authenticated: "trigger:einvoice_document_frozen",
      service_role: "privilege:42501",
      anon: "privilege:42501",
    });
    expect((await pool.query(`SELECT count(*)::int AS c FROM einvoice_documents WHERE id = $1`, [docId])).rows[0].c).toBe(1);
  });

  it("🔴 TRUNCATE is refused for every role: a BEFORE TRUNCATE trigger stands on the table (0150), its function refuses the statement, and the roles without the privilege are refused before any lock", async () => {
    expect(await truncateTrigger(), "the table carries the statement trigger").toEqual(["guard_einvoice_document_truncate:O"]);
    const owner = await truncateRefusedBy("guard_einvoice_document_truncate");
    expect([owner.refused, owner.by, owner.constraint]).toEqual([true, "trigger", "einvoice_document_frozen"]);
    for (const role of ["authenticated", "service_role", "anon"] as const) {
      const a = await attempt(role, `TRUNCATE einvoice_documents`);
      expect([role, a.refused, a.by], `${role}: TRUNCATE`).toEqual([role, true, "privilege"]);
    }
  });
});
