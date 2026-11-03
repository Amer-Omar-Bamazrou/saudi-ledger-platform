/**
 * 🔴 Phase 18 H-11 — DR-18 (D-22): the approvals queue lists what the caller
 * may APPROVE, each row flagged `own` when the caller created it. DECIDED
 * 2026-10-27 — owner accepted the stated recommendation (register §11.59, the
 * scoped D-4 statement, appended before this file).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3261";
process.env.SESSION_SECRET ??= "phase18-h11-approvals-audience-1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H11QuePw1!";
type Row = { entity: string; id: number; own?: boolean };

describeMaybe("Phase 18 H-11 — DR-18: the approvals queue lists what the caller may approve, flagging their own items", () => {
  const h = g04Harness("p18h11que");
  const today = businessToday();
  let byBookkeeper = 0, byAccountant = 0;
  const queue = async (who: string) => {
    const r = await h.api(who, "GET", "/approvals/pending");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Row[];
  };
  const invoices = (rows: Row[]) => rows.filter((r) => r.entity === "invoices").map((r) => [r.id, r.own]).sort((a, b) => Number(a[0]) - Number(b[0]));

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "H11 Co", "399999999999973");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const customerId = (await h.api("admin", "POST", "/customers", { name: "H11 Customer" })).body.id;
    const draft = async (who: string) => {
      const r = await h.api(who, "POST", "/invoices", { date: today, customerId, items: [{ description: "Service", quantity: 1, unitPrice: 100, vatRate: 15 }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as number;
    };
    byBookkeeper = await draft("bookkeeper");
    byAccountant = await draft("accountant");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: an approver's queue lists the item a bookkeeper prepared", async () => {
    expect((await queue("accountant")).some((r) => r.entity === "invoices" && r.id === byBookkeeper)).toBe(true);
  });

  it("🔴 a role that approves nothing gets an empty queue — the viewer, and the bookkeeper who prepared one of the items", async () => {
    expect(await queue("viewer")).toEqual([]);
    expect(await queue("bookkeeper")).toEqual([]);
  });

  it("🔴 each approver sees every waiting item, flagged `own` exactly when that approver created it", async () => {
    expect(invoices(await queue("accountant"))).toEqual([[byBookkeeper, false], [byAccountant, true]]);
    expect(invoices(await queue("admin"))).toEqual([[byBookkeeper, false], [byAccountant, false]]);
  });
});
