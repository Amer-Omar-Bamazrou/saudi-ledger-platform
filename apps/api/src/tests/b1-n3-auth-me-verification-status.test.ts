/**
 * 🔴 Carry-over Batch 1, N-3 (the owner, 2026-11-07): `GET /auth/me` reports the ACTIVE organization's verification
 * status, so the web app routes a not-yet-approved company's user to the review screen before the hub paints.
 *
 * The case that matters is a user in two organizations: the status must follow the organization the session is in,
 * not the first membership, both ways. A user with no organization reads null.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3271";
process.env.SESSION_SECRET ??= "b1-n3-auth-me-verification-stat1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "B1N3AuthMeStatus1!";

describeMaybe("N-3 — /auth/me carries the active organization's verification status", () => {
  const h = g04Harness("b1n3authme");
  let approvedOrg = "", pendingOrg = "";

  beforeAll(async () => {
    await h.cleanup();
    approvedOrg = await h.mkOrg("approved", "approved");
    pendingOrg = await h.mkOrg("pending", "pending_review");
    await h.mkCompany(approvedOrg, "N3 Approved Co", "399999999999953");
    await h.mkCompany(pendingOrg, "N3 Pending Co", "399999999999963");
    // in both: the approved membership is the older one, so it is the default active organization
    const both = await h.mkUser("both", PW, approvedOrg, "admin");
    await pool.query(`INSERT INTO organization_memberships (organization_id, user_id, role, status, created_at) VALUES ($1,$2,'admin','active', now() + interval '1 minute')`, [pendingOrg, both]);
    await h.mkUser("pendingonly", PW, pendingOrg, "admin");
    await h.mkUser("none", PW, null, "admin");
    await h.start();
    for (const who of ["both", "pendingonly", "none"]) expect(await h.login(who, h.email(who), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const statusOf = async (who: string) => {
    const me = await h.api(who, "GET", "/auth/me");
    expect(me.status).toBe(200);
    return [me.body?.organizationId, me.body?.organizationVerificationStatus];
  };

  it("🔴 the status follows the ACTIVE organization, switched both ways", async () => {
    expect(await statusOf("both"), "the default active organization: the older, approved membership").toEqual([approvedOrg, "approved"]);
    expect((await h.api("both", "POST", "/orgs/switch", { organizationId: pendingOrg })).status).toBe(200);
    expect(await statusOf("both"), "switched to the pending organization").toEqual([pendingOrg, "pending_review"]);
    expect((await h.api("both", "POST", "/orgs/switch", { organizationId: approvedOrg })).status).toBe(200);
    expect(await statusOf("both"), "and back").toEqual([approvedOrg, "approved"]);
  });

  it("🔴 a user whose only company is pending reads pending_review", async () => {
    expect(await statusOf("pendingonly")).toEqual([pendingOrg, "pending_review"]);
  });

  it("a user with no organization reads null, not a status", async () => {
    expect(await statusOf("none")).toEqual([null, null]);
  });
});
