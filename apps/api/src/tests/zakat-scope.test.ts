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

  /**
   * FA-E (2026-09-22) — THE SHARE SUBJECT TO INCOME TAX now has a writer.
   *
   * The column has existed since FA-A and nothing wrote it: a shape without a
   * producer, which the Art. 17 pool then READ. A reader over an unwritten
   * column is the worse half of that pair — the report refused, told the
   * tenant to declare the share in Company Settings, and Company Settings had
   * no such control. These assertions exist so the writer cannot quietly go
   * away again.
   */
  describe("FA-E — the non-Saudi/non-GCC share (Income Tax Law Art. 2)", () => {
    it("🔴 a new company has NOT DECLARED it, and it round-trips through the product's own write path", async () => {
      await inTenant(() => companiesService.updateCurrent({ ownershipType: null, foreignOwnershipPct: null } as never));
      expect((await inTenant(() => companiesService.getCurrent())).foreignOwnershipPct).toBeNull();

      await inTenant(() => companiesService.updateCurrent({ ownershipType: "MIXED", foreignOwnershipPct: 40 } as never));
      expect((await inTenant(() => companiesService.getCurrent())).foreignOwnershipPct).toBe(40);

      // and it can be TAKEN BACK, like the structure it belongs to
      await inTenant(() => companiesService.updateCurrent({ foreignOwnershipPct: null } as never));
      expect((await inTenant(() => companiesService.getCurrent())).foreignOwnershipPct).toBeNull();
    });

    it("🔴 the structure and the share must state the SAME fact — refused with a sentence, in both directions", async () => {
      await inTenant(() => companiesService.updateCurrent({ ownershipType: "SAUDI_GCC", foreignOwnershipPct: 0 } as never));
      // SAUDI_GCC means 0 %
      await expect(inTenant(() => companiesService.updateCurrent({ foreignOwnershipPct: 40 } as never))).rejects.toThrow(/state different facts/);
      // FOREIGN means 100 %
      await expect(inTenant(() => companiesService.updateCurrent({ ownershipType: "FOREIGN", foreignOwnershipPct: 60 } as never))).rejects.toThrow(/state different facts/);
      // MIXED is strictly between — the ends belong to the other two
      await expect(inTenant(() => companiesService.updateCurrent({ ownershipType: "MIXED", foreignOwnershipPct: 100 } as never))).rejects.toThrow(/state different facts/);
      // and a share with no structure at all says nothing about the regime
      await inTenant(() => companiesService.updateCurrent({ ownershipType: null, foreignOwnershipPct: null } as never));
      await expect(inTenant(() => companiesService.updateCurrent({ foreignOwnershipPct: 40 } as never))).rejects.toThrow(/Declare the ownership structure before the share/);
      // …and the refused value never landed
      expect((await inTenant(() => companiesService.getCurrent())).foreignOwnershipPct).toBeNull();
    });

    it("refuses a percentage outside 0–100 with a 400, not a DB error", async () => {
      await inTenant(() => companiesService.updateCurrent({ ownershipType: "MIXED" } as never));
      await expect(inTenant(() => companiesService.updateCurrent({ foreignOwnershipPct: 140 } as never))).rejects.toThrow(/between 0 and 100/);
      await expect(inTenant(() => companiesService.updateCurrent({ foreignOwnershipPct: -1 } as never))).rejects.toThrow(/between 0 and 100/);
    });

    it("🔴 the DB CHECK refuses the same pairs — the invariant is at the write boundary, not in one path", async () => {
      await pool.query(`UPDATE companies SET ownership_type = 'SAUDI_GCC', foreign_ownership_pct = 0 WHERE id = $1`, [companyId]);
      await expect(
        pool.query(`UPDATE companies SET foreign_ownership_pct = 40 WHERE id = $1`, [companyId]),
      ).rejects.toThrow(/companies_foreign_ownership_pct_chk/);
      // NULL stays legitimate — not declared is a state, not a violation
      await expect(
        pool.query(`UPDATE companies SET foreign_ownership_pct = NULL WHERE id = $1`, [companyId]),
      ).resolves.toBeDefined();
    });
  });
});
