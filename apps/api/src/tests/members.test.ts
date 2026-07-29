/**
 * Members service (M10.6) — membership provisioning + the non-negotiable
 * authorization property: an admin of org A can NEVER modify org B's members
 * (organization_memberships has no RLS, so authorization is explicit in the
 * service). Also covers the last-admin guard and validation.
 *
 * DB-backed; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { membersService } from "../services/members.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[members] no real DATABASE_URL — skipping members service test.");
}

describeMaybe("membersService — provisioning + explicit cross-org authorization", () => {
  let orgA = "";
  let orgB = "";
  let adminA = 0;
  let adminB = 0;
  let bookkeeper = 0;

  const cleanup = async () => {
    for (const id of [adminA, adminB, bookkeeper]) {
      if (id) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [id]);
    }
    await pool.query(`DELETE FROM users WHERE email LIKE 'members-test-%'`);
    await pool.query(`DELETE FROM organizations WHERE slug IN ('members-a','members-b')`);
  };

  beforeAll(async () => {
    await cleanup();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Members A','members-a') RETURNING id`)).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Members B','members-b') RETURNING id`)).rows[0].id;
    const mkUser = async (email: string) =>
      (await pool.query(`INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$1,' ','viewer',true) RETURNING id`, [email])).rows[0].id;
    adminA = await mkUser("members-test-admin-a@test.local");
    adminB = await mkUser("members-test-admin-b@test.local");
    bookkeeper = await mkUser("members-test-bk@test.local");
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [adminA, orgA]);
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [adminB, orgB]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("an org admin can provision a bookkeeper in their own org", async () => {
    const out = await membersService.assign(adminA, orgA, bookkeeper, "bookkeeper");
    expect(out).toMatchObject({ userId: bookkeeper, organizationId: orgA, role: "bookkeeper", status: "active" });

    const { members } = await membersService.list(adminA, orgA);
    const row = members.find((m) => m.userId === bookkeeper);
    expect(row?.role).toBe("bookkeeper");
  });

  it("CRITICAL: an admin of org B cannot assign or list members in org A (403)", async () => {
    await expect(membersService.assign(adminB, orgA, bookkeeper, "admin")).rejects.toMatchObject({ statusCode: 403 });
    await expect(membersService.list(adminB, orgA)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      membersService.update(adminB, orgA, bookkeeper, { role: "admin" }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("can change a member's role (idempotent upsert / update)", async () => {
    const out = await membersService.update(adminA, orgA, bookkeeper, { role: "accountant" });
    expect(out.role).toBe("accountant");
  });

  it("refuses to remove the last admin of an org (409)", async () => {
    await expect(membersService.update(adminA, orgA, adminA, { role: "viewer" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(membersService.update(adminA, orgA, adminA, { status: "inactive" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("validates role and target user", async () => {
    await expect(membersService.assign(adminA, orgA, bookkeeper, "superuser")).rejects.toMatchObject({ statusCode: 400 });
    await expect(membersService.assign(adminA, orgA, 99999999, "viewer")).rejects.toMatchObject({ statusCode: 404 });
  });
});
