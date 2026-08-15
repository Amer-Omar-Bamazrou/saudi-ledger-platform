/**
 * M17.1 — the Zakat scope gate (owner decision Q2).
 *
 * Zakat v1 covers 100% Saudi/GCC-owned entities. The rule under test is not
 * "eligible or not" but THREE states, and the third is the point: a company
 * that has declared nothing must be ASKED, never assumed to qualify and never
 * refused on an assumption.
 *
 * The pure rule is tested first; the DB-backed block then proves the column
 * round-trips through the product's own write path and that the CHECK
 * constraint — not just the service — refuses a bad value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { companiesService } from "../services/companies.service";
import { isOwnershipType, zakatScopeFor } from "../lib/zakatScope";

describe("M17.1 — the scope rule", () => {
  it("🔴 an UNDECLARED company is 'not_declared' — not eligible, and not refused", () => {
    // Both collapses are wrong, and each is wrong in its own direction:
    // eligible ⇒ we show a foreign-owned company a Zakat capability it must
    // not use; out_of_scope ⇒ we refuse a Saudi company on an assumption.
    for (const undeclared of [null, undefined, ""]) {
      expect(zakatScopeFor(undeclared).status).toBe("not_declared");
    }
  });

  it("SAUDI_GCC is eligible", () => {
    expect(zakatScopeFor("SAUDI_GCC")).toEqual({ status: "eligible", ownershipType: "SAUDI_GCC" });
  });

  it("FOREIGN and MIXED are out of scope, and say which", () => {
    // The UI shows a different sentence for each, so the discriminant has to
    // survive — "out of scope" alone would make that impossible.
    expect(zakatScopeFor("FOREIGN")).toEqual({ status: "out_of_scope", ownershipType: "FOREIGN" });
    expect(zakatScopeFor("MIXED")).toEqual({ status: "out_of_scope", ownershipType: "MIXED" });
  });

  it("🔴 an unrecognised value fails toward ASKING, never toward granting", () => {
    // Unreachable through the API (service + DB CHECK), so this pins the
    // fallback direction rather than a reachable path: if the enum ever gains
    // a value this module has not been taught, the safe answer is to ask.
    expect(zakatScopeFor("PARTIALLY_SAUDI").status).toBe("not_declared");
    expect(zakatScopeFor("saudi_gcc").status).toBe("not_declared"); // case-sensitive on purpose
  });

  it("the type guard accepts exactly the three values", () => {
    expect(["SAUDI_GCC", "FOREIGN", "MIXED"].every(isOwnershipType)).toBe(true);
    expect(isOwnershipType(null)).toBe(false);
    expect(isOwnershipType("saudi_gcc")).toBe(false);
  });
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[zakat-scope] no real DATABASE_URL — skipping.");

const SLUG = "m17-scope";
const EMAIL = "m17-scope@test.local";

describeMaybe("M17.1 — ownership through the real write path", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Scope Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Scope Co','1010101012','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','SC',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(cleanup);

  it("🔴 a NEW company is NOT DECLARED — the platform asserts nothing on the tenant's behalf", async () => {
    // The whole reason the column has no default. If this ever returns
    // 'SAUDI_GCC', the platform has started making an ownership claim nobody
    // supplied, and that claim decides whether a Zakat surface appears.
    const company = await inTenant(() => companiesService.getCurrent());
    expect(company.ownershipType).toBeNull();
    expect(zakatScopeFor(company.ownershipType).status).toBe("not_declared");
  });

  it("declaring SAUDI_GCC round-trips and makes the company eligible", async () => {
    await inTenant(() => companiesService.updateCurrent({ ownershipType: "SAUDI_GCC" } as never));
    const company = await inTenant(() => companiesService.getCurrent());
    expect(company.ownershipType).toBe("SAUDI_GCC");
    expect(zakatScopeFor(company.ownershipType).status).toBe("eligible");
  });

  it("🔴 a declaration can be TAKEN BACK — null clears it (the path the UI uses)", async () => {
    // A tenant who realises they were wrong must be able to withdraw the claim,
    // not merely swap it for another one. A stale claim gates Zakat standing.
    await inTenant(() => companiesService.updateCurrent({ ownershipType: null } as never));
    const company = await inTenant(() => companiesService.getCurrent());
    expect(company.ownershipType).toBeNull();
  });

  it("…and an empty string clears it too, for raw API callers", async () => {
    await inTenant(() => companiesService.updateCurrent({ ownershipType: "MIXED" } as never));
    expect((await inTenant(() => companiesService.getCurrent())).ownershipType).toBe("MIXED");
    await inTenant(() => companiesService.updateCurrent({ ownershipType: "" } as never));
    expect((await inTenant(() => companiesService.getCurrent())).ownershipType).toBeNull();
  });

  it("FOREIGN is stored and reads as out of scope", async () => {
    await inTenant(() => companiesService.updateCurrent({ ownershipType: "FOREIGN" } as never));
    const company = await inTenant(() => companiesService.getCurrent());
    expect(zakatScopeFor(company.ownershipType)).toEqual({
      status: "out_of_scope",
      ownershipType: "FOREIGN",
    });
  });

  it("refuses an unknown value with a 400, not a DB error", async () => {
    await expect(
      inTenant(() => companiesService.updateCurrent({ ownershipType: "PARTIALLY_SAUDI" } as never)),
    ).rejects.toThrow(/SAUDI_GCC/);
  });

  it("🔴 the DB CHECK refuses it too — the invariant is at the write boundary, not in one path", async () => {
    // The service is one writer. A migration, a script or a future path is
    // another. This is what makes the value trustworthy for every reader.
    await expect(
      pool.query(`UPDATE companies SET ownership_type = 'PARTIALLY_SAUDI' WHERE id = $1`, [companyId]),
    ).rejects.toThrow(/companies_ownership_type_values/);
  });

  it("…and the CHECK still permits NULL, because not-declared is legitimate", async () => {
    await expect(
      pool.query(`UPDATE companies SET ownership_type = NULL WHERE id = $1`, [companyId]),
    ).resolves.toBeDefined();
  });
});
