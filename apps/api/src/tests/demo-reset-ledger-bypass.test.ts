/**
 * 🔴 THE DEMO WIPE AND THE APPEND-ONLY VAT LEDGER (2026-09-29).
 *
 * `input_vat_events` is append-only for every role, the owner included
 * (migration 0107), so the weekly demo reset's TRUNCATE was refused. The fix
 * leaves that protection UNCHANGED and confines the demo's way past it —
 * `session_replication_role = replica`, an owner-only setting, SET LOCAL —
 * to ONE function, `truncateDemoTenant`, which re-checks both demo gates
 * (DEMO_MODE, and no organisation but the demo) inside the wipe's own
 * transaction.
 *
 * What this file proves is the other half: THE PRODUCTION PATH CANNOT USE IT.
 * A database with a real tenant — whose ledger events are written here by the
 * PRODUCT — is refused by the full reset and by the function itself, with the
 * events still there afterwards (presence, before and after); DEMO_MODE off is
 * refused; the app role can take neither the setting nor the TRUNCATE; the
 * owner, without the setting, is still refused by the ledger; and no other
 * production file sets replica mode. The demo-only success path is proven on a
 * throwaway demo database (docs/product/phase-13b-vat-claim-ledger-architecture.md §26.10).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { overrides } = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));
vi.mock("@workspace/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/config")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...overrides }) };
});

import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { runDemoReset, truncateDemoTenant, DemoResetRefused } from "../services/demo/demoReset.service";
import { purgeInputVatLedger } from "./helpers/purgeInputVatLedger";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[demo-reset-ledger-bypass] no real DATABASE_URL — skipping.");

type PgError = { code?: string; constraint?: string; message: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };

describeMaybe("demo reset — the production path cannot pass the append-only ledger", () => {
  const SLUG = "demo-bypass-real-tenant";
  const EMAIL = "demo-bypass@test.local";
  let orgId = "", companyId = "", userId = 0, billId = 0;
  const ORG = `SELECT id FROM organizations WHERE slug = '${SLUG}'`;

  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const refusal = async (p: Promise<unknown>): Promise<PgError> => {
    let err: PgError | undefined;
    try { await p; } catch (e) { err = e as PgError; }
    expect(err, "expected a refusal").toBeTruthy();
    return err!;
  };
  const ledger = async () => ({
    events: Number((await pool.query(`SELECT count(*) FROM input_vat_events WHERE organization_id = $1`, [orgId])).rows[0].count),
    bills: Number((await pool.query(`SELECT count(*) FROM bills WHERE organization_id = $1`, [orgId])).rows[0].count),
  });
  const cleanup = async () => {
    await purgeInputVatLedger(ORG);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const t of ["bill_items", "bills", "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "vendors", "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN (${ORG})`);
      }
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('A Real Tenant', $1, 'approved') RETURNING id`, [SLUG])).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'Real Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1, 'R', ' ', 'admin', true) RETURNING id`, [EMAIL])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [userId, orgId]);
    const vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Real Supplier', '399999999999993') RETURNING id`, [orgId])).rows[0].id;
    // A real bill, approved through the product: its input-VAT event is the row that must survive.
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, async () => {
        const b = await billsService.create({ billNumber: "REAL-1", vendorId, vendorReference: "SUP-REAL-1", date: "2026-06-01", subtotal: 1000, vatAmount: 150, total: 1150, supplierDocumentKind: "tax_invoice", items: [] }, userId);
        await billsService.approve(b.id, {}, userId);
        billId = b.id;
      }));
      await conn.commit();
    } catch (err) { await conn.rollback(); throw err; }
  }, 60_000);
  afterEach(() => { for (const k of Object.keys(overrides)) delete overrides[k]; });
  afterAll(cleanup);

  it("the real tenant HAS ledger events to lose (so their survival below is not vacuous)", async () => {
    expect(await ledger()).toEqual({ events: 1, bills: 1 });
    expect(billId).toBeGreaterThan(0);
  });

  it("🔴 the FULL reset, with DEMO_MODE on, refuses on a database holding a real tenant — and its ledger is intact", async () => {
    overrides.DEMO_MODE = true;
    const out = await runDemoReset();
    expect(out.status).toBe("failed");
    expect(out.detail).toContain("Refusing to reset");
    expect(await ledger()).toEqual({ events: 1, bills: 1 });
  });

  it("🔴 the BYPASS FUNCTION itself, called directly with DEMO_MODE on, refuses a database holding a real tenant — replica mode is never taken, nothing is truncated", async () => {
    overrides.DEMO_MODE = true;
    const outcome = await probe(async (c) => {
      let err: unknown;
      try { await truncateDemoTenant(c, ["input_vat_events", "input_vat_balances", "bills"]); } catch (e) { err = e; }
      const mode = (await c.query("SHOW session_replication_role")).rows[0].session_replication_role;
      const events = Number((await c.query(`SELECT count(*) FROM input_vat_events WHERE organization_id = $1`, [orgId])).rows[0].count);
      return { err, mode, events };
    });
    expect(outcome.err).toBeInstanceOf(DemoResetRefused);
    expect((outcome.err as Error).message).toMatch(/never bypassed on a database with real tenants/);
    expect(outcome.mode, "the replica setting was never taken").toBe("origin");
    expect(outcome.events).toBe(1);
  });

  it("🔴 with DEMO_MODE OFF the bypass function refuses before it touches anything", async () => {
    overrides.DEMO_MODE = false;
    const outcome = await probe(async (c) => {
      let err: unknown;
      try { await truncateDemoTenant(c, ["input_vat_events"]); } catch (e) { err = e; }
      return { err, mode: (await c.query("SHOW session_replication_role")).rows[0].session_replication_role };
    });
    expect(outcome.err).toBeInstanceOf(DemoResetRefused);
    expect((outcome.err as Error).message).toMatch(/DEMO_MODE is off/);
    expect(outcome.mode).toBe("origin");
    expect(await ledger()).toEqual({ events: 1, bills: 1 });
  });

  it("🔴 the APP ROLE can take neither the replica setting nor the TRUNCATE — whatever the environment", async () => {
    const setting = await refusal(probe(async (c) => {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SET LOCAL session_replication_role = replica");
    }));
    expect(setting.code, setting.message).toBe("42501");
    const truncate = await refusal(probe(async (c) => {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("TRUNCATE input_vat_events");
    }));
    expect(truncate.code, truncate.message).toBe("42501");
  });

  it("🔴 the ledger's own protection is UNCHANGED: the owner, without the demo function, is still refused a TRUNCATE", async () => {
    const owner = await refusal(probe((c) => c.query("TRUNCATE input_vat_events CASCADE")));
    expect(owner.constraint).toBe("input_vat_events_append_only");
    expect(await ledger()).toEqual({ events: 1, bills: 1 });
  });

  it("🔴 NO OTHER production file sets replica mode — the demo wipe is the only bypass (planted positive proves the detector)", () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "tests") walk(p); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        const text = readFileSync(p, "utf8");
        const n = (text.match(/session_replication_role\s*=\s*replica/gi) ?? []).length;
        if (n > 0) hits.push(`${p.slice(src.length + 1).replace(/\\/g, "/")} x${n}`);
      }
    };
    walk(src);
    expect("SET LOCAL session_replication_role = replica".match(/session_replication_role\s*=\s*replica/gi)).toHaveLength(1);
    expect(hits).toEqual(["services/demo/demoReset.service.ts x1"]);
  });
});
