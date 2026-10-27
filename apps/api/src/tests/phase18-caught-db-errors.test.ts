/**
 * 🔴 The three catch-and-carry-on places (Phase 18; found with B-O6, register
 * §11.17; owner order 2026-10-26 A4 and final-run memo 2026-10-27 §2 D). Each
 * catches an error and carries on, inside the request's ONE transaction. When
 * the error is the DATABASE's, Postgres has already aborted that transaction:
 * the next statement fails, or B-O6 answers the COMMIT's ROLLBACK as a 500. So
 * the carried-on answer the code meant to give (the discard kept, its pointer
 * left for the purge job; the question refused as "tool_failed"; the plan shown
 * with no WHT estimate) never arrives, and nothing the request did is kept.
 *
 * Each case makes the caught step fail AT THE DATABASE (a real failing
 * statement on the transaction's own connection), then commits the rest: the
 * carried-on answer arrives and its transaction commits.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3240";
process.env.SESSION_SECRET ??= "phase18-caught-db-errors-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Each flag makes the NEXT call of its step fail at the database, once. */
const failNext = vi.hoisted(() => ({ capture: false, wht: false }));

vi.mock("../repositories/capturedDocuments.repository", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../repositories/capturedDocuments.repository")>();
  const real = mod.capturedDocumentsRepository.clearStagingPath.bind(mod.capturedDocumentsRepository);
  mod.capturedDocumentsRepository.clearStagingPath = async (id: string) => {
    if (failNext.capture) { failNext.capture = false; await db.execute(sql`SELECT 1 / 0`); }
    return real(id);
  };
  return mod;
});
vi.mock("../services/capture/stagingStore", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/capture/stagingStore")>();
  mod.stagingStore.remove = async () => {};
  return mod;
});
vi.mock("../services/accounting/wht", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/accounting/wht")>();
  return {
    ...mod,
    decideWithholding: async (...a: Parameters<typeof mod.decideWithholding>) => {
      if (failNext.wht) { failNext.wht = false; await db.execute(sql`SELECT 1 / 0`); }
      return mod.decideWithholding(...a);
    },
  };
});

import { g04Harness } from "./helpers/g04Harness";
import { captureService } from "../services/capture/capture.service";
import { askService, ASK_TOOLS } from "../services/ask.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18CaughtDbErrorsPw1!";

describeMaybe("A caught DATABASE error no longer takes the request's transaction with it", () => {
  const h = g04Harness("p18cdb");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  const inT = <T,>(fn: () => Promise<T>) =>
    h.inTenant(orgId, companyId, adminId, fn).catch((err: Error) => `threw: ${err.name}: ${err.message.slice(0, 160)}`);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Caught DB Errors Co", "318181818181977");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 capture discard: clearing the staged image's pointer fails at the database — the discard still commits, the pointer kept for the purge job", async () => {
    const id = (await pool.query(
      `INSERT INTO captured_documents (organization_id, company_id, status, staging_path, content_type, byte_size, source, sha256)
       VALUES ($1, $2, 'staged', 'p18cdb/staging/one.jpg', 'image/jpeg', 10, 'upload', repeat('a', 64)) RETURNING id`, [orgId, companyId])).rows[0].id as string;
    failNext.capture = true;
    const out = await inT(() => captureService.discard(id));
    const { rows: [row] } = await pool.query(`SELECT status, staging_path FROM captured_documents WHERE id = $1`, [id]);
    expect([out, row]).toEqual([{ status: "discarded", imageDeleted: true }, { status: "discarded", staging_path: "p18cdb/staging/one.jpg" }]);
  });

  it("🔴 /ask: a tool that fails at the database — the question is still answered as refused (tool_failed), and that answer is kept", async () => {
    const tool = ASK_TOOLS.liquidity;
    const realRun = tool.run;
    tool.run = async () => { await db.execute(sql`SELECT 1 / 0`); return {}; };
    const selection = JSON.stringify({ tool: "liquidity", args: {} });
    let out: unknown;
    try {
      out = await inT(() => askService.ask("what is my liquidity?", adminId, { chat: async () => selection }));
    } finally {
      tool.run = realRun;
    }
    const stored = (await pool.query(`SELECT refusal_reason FROM grounded_answers WHERE organization_id = $1 ORDER BY id DESC LIMIT 1`, [orgId])).rows[0]?.refusal_reason ?? null;
    expect([(out as { refusalReason?: string })?.refusalReason ?? out, stored]).toEqual(["tool_failed", "tool_failed"]);
  });

  it("🔴 payment plans: the WHT estimate fails at the database — the list still answers, the plan shown with no estimate", async () => {
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "CDB Main", bankName: "CDB Bank", isDefault: true });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1, 'CDB Non-resident', 'non_resident') RETURNING id`, [orgId])).rows[0].id;
    const billId = (await pool.query(
      `INSERT INTO bills (organization_id, company_id, bill_number, vendor_id, date, status, subtotal, vat_amount, total)
       VALUES ($1, $2, 'CDB-1', $3, '2026-10-01', 'approved', 1000, 0, 1000) RETURNING id`, [orgId, companyId, vendorId])).rows[0].id;
    const created = await inT(() => paymentPlansService.create({ billId, amount: 1000, plannedDate: "2027-01-15", bankAccountId: bank.body.id }, adminId));
    expect(typeof created === "object", JSON.stringify(created)).toBe(true);
    failNext.wht = true;
    const listed = await inT(() => paymentPlansService.list());
    const plan = Array.isArray(listed) ? listed.find((p) => p.billId === billId) : undefined;
    expect([Array.isArray(listed) ? "listed" : listed, plan?.whtEstimate, plan?.amount]).toEqual(["listed", null, 1000]);
  });
});
