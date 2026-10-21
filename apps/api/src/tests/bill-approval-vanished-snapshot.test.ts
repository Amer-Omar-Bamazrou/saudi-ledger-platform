/**
 * 🔴 The bill-approval 500 (R3 residual; CI: #208 run 39620756398 and main's post-merge run 39662603965 on
 * `7fbc1e29`) — owner-approved 2026-10-21: prove on unmodified `main`, fix only if it reproduces.
 *
 * Mechanism (read at `7fbc1e29`): the approval engine loads the record, then takes its BEFORE snapshot
 * (`approval.service.ts`, `adapter.snapshot(entity)`) outside the lost-race mapping. The bill adapter's
 * `load` is a plain read, and its `snapshot` (`fullOut`) RE-READS the bill and dereferences the row
 * without a check. A reject that commits between the two reads leaves nothing to re-read: `r!.bill`
 * throws a TypeError, and the act answers 500. The journal-entry and payroll adapters snapshot the row
 * they loaded, so they cannot fail this way.
 *
 * The window is FORCED here, not hoped for: the real adapter is wrapped so that its `load` returns the
 * row it read and THEN a real HTTP reject runs and commits on its own connection — before the engine
 * takes the snapshot. Nothing in production code is changed by the wrapper; it only fixes the order.
 *
 * Fix-neutral invariant: the losing act answers a 4xx — the answer the same act gets sequentially once the
 * bill is gone (404 "Not found") — never a 5xx; the bill is gone and nothing is posted.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3210";
process.env.SESSION_SECRET ??= "bill-approval-vanished-snapshot-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { billApprovable } from "../services/bills.approvable";
import { approvalService } from "../services/approval/approval.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "BillVanishedPw123!";

describeMaybe("the bill-approval 500 — an act whose bill a concurrent reject deleted", () => {
  const h = g04Harness("billvan");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let vendorId = 0;
  let seq = 0;

  async function draftBill(): Promise<{ id: number; no: string }> {
    seq += 1;
    const no = `BILLVAN-${String(seq).padStart(3, "0")}`;
    const r = await h.api("admin", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: "2026-10-05", dueDate: "2026-10-05", vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: 1_000, vatRate: 0 }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.id as number, no };
  }
  const exists = async (id: number) => (await pool.query(`SELECT 1 FROM bills WHERE id = $1`, [id])).rowCount === 1;
  const posted = async (no: string) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `BILL-${no}`])).rows[0].n);

  /**
   * Run `act` through the engine with the REAL bill adapter, whose `load` is followed — before the engine
   * snapshots — by a real HTTP reject that commits on its own connection.
   */
  async function actWhileRejected(act: "approve" | "reject" | "submit", billId: number) {
    const base = billApprovable();
    let rejectedBy: Res | null = null;
    const raced = {
      ...base,
      async load(id: number) {
        const row = await base.load(id);
        rejectedBy = await h.api("admin", "POST", `/bills/${id}/reject`, {});
        return row;
      },
    };
    let outcome: { ok: true } | { ok: false; status: number | undefined; name: string; message: string };
    try {
      const actor = { userId: adminId };
      await h.inTenant(orgId, companyId, adminId, async () => {
        if (act === "approve") await approvalService.approve(raced, billId, actor);
        else if (act === "reject") await approvalService.reject(raced, billId, actor);
        else await approvalService.submit(raced, billId, actor);
      });
      outcome = { ok: true };
    } catch (e) {
      const err = e as { statusCode?: number; name?: string; message?: string };
      outcome = { ok: false, status: err.statusCode, name: err.name ?? "?", message: err.message ?? "" };
    }
    return { outcome, reject: rejectedBy as Res | null };
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Bill Vanished Co", "318181818181863");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Bill Vanished Supplier') RETURNING id`, [orgId])).rows[0].id;
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): once a reject has deleted the bill, approve, reject and submit each answer 404 \"Not found\"", async () => {
    const b = await draftBill();
    expect((await h.api("admin", "POST", `/bills/${b.id}/reject`, {})).status).toBe(204);
    for (const act of ["approve", "reject", "submit"]) {
      const r = await h.api("admin", "POST", `/bills/${b.id}/${act}`, {});
      expect([act, r.status, r.body?.error]).toEqual([act, 404, "Not found"]);
    }
  });

  for (const act of ["approve", "reject", "submit"] as const) {
    it(`🔴 FORCED: a reject commits after the engine LOADED the bill for ${act.toUpperCase()} and before it snapshots — the ${act} answers the sequential 404, never a 5xx; the bill is gone and nothing is posted`, async () => {
      const b = await draftBill();
      const { outcome, reject } = await actWhileRejected(act, b.id);
      // eslint-disable-next-line no-console
      console.warn(`[BILL-500] ${act} while rejected`, JSON.stringify({ reject: reject?.status, outcome }));
      expect(reject?.status, "the concurrent reject went through (the window was opened)").toBe(204);
      expect(outcome.ok, `the ${act} did not succeed on a deleted bill`).toBe(false);
      if (!outcome.ok) {
        expect.soft(outcome.status, `${outcome.name}: ${outcome.message}`).toBe(404);
        expect.soft(outcome.message).toBe("Not found");
      }
      expect(await exists(b.id)).toBe(false);
      expect(await posted(b.no)).toBe(0);
    }, 60_000);
  }
});
