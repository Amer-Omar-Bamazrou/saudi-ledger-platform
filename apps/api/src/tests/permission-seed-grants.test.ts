/**
 * THE PERMISSION-MATRIX SEED GRANTS, AUDITED — the gap `CLAUDE.md` §5 named.
 *
 * ── 🔴 WHY THIS EXISTS ─────────────────────────────────────────────────────
 * ENFORCEMENT was audited: `requirePermission` is the single seam, it runs
 * after `resolveTenant`, and the privilege surface map checks that routes sit
 * on the right side of it. **The GRANTS were never audited.** A guard that
 * correctly consults a matrix is worth nothing if the matrix says the wrong
 * thing — the enforcement audit and the policy audit are different questions,
 * and passing the first says nothing about the second.
 *
 * Three failure directions, none of which enforcement testing can see:
 *
 *   OVER-GRANT   a role holds an action the design says it must not. Silent,
 *                and the most consequential: nothing errors, the wrong person
 *                simply succeeds.
 *   UNDER-GRANT  a guarded route has no matching grant. Fail-closed, so it is
 *                a permanent 403 on a working feature — loud for the user,
 *                invisible to us.
 *   DEAD POLICY  a grant for a resource nothing guards. Harmless today and a
 *                trap tomorrow, because it reads as deliberate policy.
 *
 * ── 🔴 THE AUTHORITY PROPERTIES, ASSERTED DIRECTLY ─────────────────────────
 * The matrix's own header states the intent in prose. Prose is not a check, so
 * the two properties that carry real authority are asserted as invariants
 * rather than trusted:
 *
 *   * a VIEWER holds `read` and nothing else — the whole meaning of the role;
 *   * a BOOKKEEPER never holds `approve` or `delete` — "may enter work, never
 *     activate it", which is the separation of duties the four-role model
 *     exists for. A bookkeeper with `approve` could post to the ledger, pay a
 *     bill, and issue a ZATCA tax document.
 *
 * DB-backed where it checks the seeded rows; the SPEC-side assertions are pure.
 */

process.env.PORT ??= "3167";
process.env.SESSION_SECRET ??= "perm-grants-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, PERMISSION_MATRIX } from "@workspace/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, "../routes");

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/** Every resource a route actually guards, read from the source. */
function guardedResources(): Set<string> {
  const found = new Set<string>();
  for (const f of walk(ROUTES)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/requirePermission\(\s*["']([a-z_]+)["']\s*\)/g)) found.add(m[1]);
  }
  return found;
}

const rows = PERMISSION_MATRIX;
const granted = new Set(rows.map((r) => `${r.role}:${r.resource}:${r.action}`));
const resourcesInSpec = new Set(rows.map((r) => r.resource));

describe("the permission matrix's GRANTS, not its enforcement", () => {
  it("the audit is not vacuous — there are real grants and real guarded routes", () => {
    expect(rows.length).toBeGreaterThan(50);
    expect(guardedResources().size).toBeGreaterThan(15);
  });

  // ── OVER-GRANT ───────────────────────────────────────────────────────────

  it("🔴 a VIEWER holds `read` and nothing else", () => {
    const nonRead = rows.filter((r) => r.role === "viewer" && r.action !== "read");
    expect(
      nonRead.map((r) => `${r.resource}:${r.action}`),
      "A viewer holds a non-read grant. The role's entire meaning is that it " +
        "cannot change anything.",
    ).toEqual([]);
    // Paired with presence: a viewer that held NOTHING would also pass the above.
    expect(rows.some((r) => r.role === "viewer" && r.action === "read")).toBe(true);
  });

  it("🔴 a BOOKKEEPER never holds `approve` or `delete`", () => {
    const escalated = rows.filter(
      (r) => r.role === "bookkeeper" && (r.action === "approve" || r.action === "delete"),
    );
    expect(
      escalated.map((r) => `${r.resource}:${r.action}`),
      "A bookkeeper holds activation or destruction authority. `approve` gates " +
        "post / pay / reject / reverse / settle — posting to the ledger, moving " +
        "money, and issuing a ZATCA tax document. The four-role model exists to " +
        "separate entering work from activating it.",
    ).toEqual([]);
    expect(rows.some((r) => r.role === "bookkeeper" && r.action === "create")).toBe(true);
  });

  it("🔴 `delete` is admin-only, everywhere it is granted at all", () => {
    const nonAdminDelete = rows.filter((r) => r.action === "delete" && r.role !== "admin");
    expect(nonAdminDelete.map((r) => `${r.role}:${r.resource}`)).toEqual([]);
  });

  it("🔴 `approve` is limited to admin and accountant", () => {
    const wrong = rows.filter(
      (r) => r.action === "approve" && r.role !== "admin" && r.role !== "accountant",
    );
    expect(wrong.map((r) => `${r.role}:${r.resource}`)).toEqual([]);
  });

  it("period locks are admin-only to create AND delete — closing a period is not ordinary work", () => {
    for (const action of ["create", "delete"] as const) {
      const holders = rows.filter((r) => r.resource === "period_locks" && r.action === action);
      expect(holders.length, `nobody can ${action} a period lock`).toBeGreaterThan(0);
      expect(holders.every((r) => r.role === "admin"), `${action} is not admin-only`).toBe(true);
    }
  });

  // ── UNDER-GRANT ──────────────────────────────────────────────────────────

  it("🔴 every guarded resource has grants — a guard with no policy is a permanent 403", () => {
    const missing = [...guardedResources()].filter((r) => !resourcesInSpec.has(r)).sort();
    expect(
      missing,
      "A route calls requirePermission for a resource the matrix never grants.\n" +
        "The matrix is fail-closed, so EVERY role gets 403 forever — a working\n" +
        "feature nobody can reach, which no enforcement test would notice\n" +
        "because the enforcement is behaving exactly as designed.",
    ).toEqual([]);
  });

  /**
   * 🔴 READ IS THE FLOOR — EXCEPT WHERE RESTRICTING IT IS THE DESIGN.
   *
   * A resource no role can read is normally a page that 403s forever. Two are
   * deliberately not readable by everyone, and BOTH are recorded here with the
   * reason rather than silently exempted — an unexplained exemption is how a
   * real gap gets filed as a known one.
   *
   * The first draft of this test asserted read-for-everyone flatly and went
   * red on exactly these two. That is the check working: it forced the
   * distinction between "nobody thought about read here" and "read is
   * restricted on purpose", which is a distinction the matrix file states in
   * prose and nothing verified.
   */
  const READ_RESTRICTED: Record<string, string> = {
    // Admin-only by design: the trail records who did what, including admins,
    // and it is append-only at the grants. CLAUDE.md states it as the reason
    // the nav entry is admin-gated too.
    audit_logs: "admin-only — the audit trail is not ordinary reading",
    // Not a readable resource at all: `categorize` is an ACTION endpoint
    // (create only). There is nothing to GET.
    categorize: "action endpoint, create-only — there is no read route",
  };

  it("🔴 every guarded resource is readable by every role, or is a NAMED exception", () => {
    const roles = ["admin", "accountant", "bookkeeper", "viewer"];
    const problems: string[] = [];
    for (const resource of guardedResources()) {
      if (resource in READ_RESTRICTED) continue;
      for (const role of roles) {
        if (!granted.has(`${role}:${resource}:read`)) problems.push(`${role} cannot read ${resource}`);
      }
    }
    expect(
      problems,
      "A guarded resource is unreadable by a role and is not a named exception.\n" +
        "Either grant read, or add it to READ_RESTRICTED with the reason — the\n" +
        "point of the list is that restricting read stays a decision.",
    ).toEqual([]);
  });

  it("every READ_RESTRICTED entry is still real — the obsolete-assertion rule", () => {
    // An exemption for a resource that no longer exists is a claim about
    // nothing, and it rots quietly.
    const guarded = guardedResources();
    const stale = Object.keys(READ_RESTRICTED).filter((r) => !guarded.has(r));
    expect(stale, "READ_RESTRICTED names resources nothing guards any more").toEqual([]);
    // And each must genuinely be restricted; if read were opened up, the
    // exemption should go rather than sit there licensing a future removal.
    const notActuallyRestricted = Object.keys(READ_RESTRICTED).filter((r) =>
      ["admin", "accountant", "bookkeeper", "viewer"].every((role) =>
        granted.has(`${role}:${r}:read`),
      ),
    );
    expect(notActuallyRestricted, "listed as read-restricted but readable by everyone").toEqual([]);
  });

  // ── DEAD POLICY ──────────────────────────────────────────────────────────

  it("🔴 no grant exists for a resource nothing guards", () => {
    const guarded = guardedResources();
    /**
     * `users` is the documented exception and stays: those endpoints run BEFORE
     * `resolveTenant`, manage the global identity directory, and are guarded by
     * the session-role admin check instead. It is seeded for completeness and
     * the matrix's header says so — recorded here so the exemption is a
     * decision with a reason rather than a hole in the assertion.
     */
    const EXEMPT = new Set(["users"]);
    const dead = [...resourcesInSpec].filter((r) => !guarded.has(r) && !EXEMPT.has(r)).sort();
    expect(
      dead,
      "Grants exist for resources no route guards. Harmless today, and they read " +
        "as deliberate policy — so the next person to add a route for one of them " +
        "inherits an access decision nobody made.",
    ).toEqual([]);
  });

  // ── THE SEEDED ROWS MATCH THE CODE ───────────────────────────────────────

  (REAL_DB ? it : it.skip)("🔴 the DATABASE holds exactly the grants the code defines", async () => {
    /**
     * The matrix is data, and data drifts from the definition that produced it:
     * a re-seed that never ran, a hand-edited row, a migration that added a
     * resource. `requirePermission` reads the TABLE, not this file, so the
     * table is what actually governs access.
     */
    const db = await pool.query<{ role: string; resource: string; action: string }>(
      `SELECT role, resource, action FROM permissions`,
    );
    const inDb = new Set(db.rows.map((r) => `${r.role}:${r.resource}:${r.action}`));
    expect(inDb.size, "the permissions table is empty — nothing is seeded").toBeGreaterThan(50);

    const missingFromDb = [...granted].filter((k) => !inDb.has(k)).sort();
    const extraInDb = [...inDb].filter((k) => !granted.has(k)).sort();

    expect(missingFromDb, "grants the code defines that the database does not hold").toEqual([]);
    expect(
      extraInDb,
      "🔴 the database grants access the code does not define. These rows govern " +
        "real requests and no one reviewing the matrix file would see them.",
    ).toEqual([]);
  });
});
