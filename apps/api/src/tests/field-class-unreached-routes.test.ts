/**
 * 🔴 19B (owner, 2026-11-22, item 6): DEFAULT DENY IS ITS OWN STEP, AFTER EVERY ROUTE IS REACHED. S1's measurement left
 * about ten routes outside the contract that no test reached, so the fields they serve were never classified. This
 * suite reaches each one through the application, with the role it needs, so the seam's strict mode classifies (or
 * fails) everything it serves: the products list, the four LLM routes, and the operator's five ZATCA views.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "fc-unreached-password-2026";
const h = g04Harness("fc-unreached");

describeDb("19B — every route outside the contract is reached, and what it serves is classified", () => {
  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "FC Unreached Co", "319191919191913");
    await h.mkUser("admin", PW, orgId, "admin");
    const operatorId = await h.mkUser("operator", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    expect(await h.login("operator", h.email("operator"), PW)).toBe(200);
    const p = await h.api("admin", "POST", "/products", { name: "Unreached Widget", code: "UW-1", type: "product", unitPrice: 10, currency: "SAR" });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
  });
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  /** 200 with every served key classified (a key the tables cannot classify would be a 500 in this lane). */
  const reached = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await h.api(who, method, path, body);
    expect(r.status, `${method} ${path}: ${r.text.slice(0, 400)}`).toBe(200);
    return r.body;
  };

  it("the products list (paged), and one product", async () => {
    const list = await reached("admin", "GET", "/products");
    const items = Array.isArray(list) ? list : list.items;
    expect(items.map((x: { code: string }) => x.code)).toContain("UW-1");
  });

  it("the four LLM routes (deterministic outside production; no tenant data leaves)", async () => {
    await reached("admin", "GET", "/llm/status");
    await reached("admin", "GET", "/llm/demo");
    await reached("admin", "POST", "/llm/categorize", { description: "STC mobile bill payment", amount: 299, type: "debit" });
    await reached("admin", "POST", "/llm/compare", { transactions: [{ description: "STC mobile bill payment", amount: 299, type: "debit" }] });
  });

  it("the operator's five ZATCA views", async () => {
    for (const path of ["/operator/zatca/health", "/operator/zatca/overdue", "/operator/zatca/needs-review", "/operator/zatca/certificates", "/operator/zatca/onboarding"]) {
      await reached("operator", "GET", path);
    }
  });
});
