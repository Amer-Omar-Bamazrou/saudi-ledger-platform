/**
 * 🔴 ACCOUNT-CREATION WRITERS (G04 zero-membership, 2026-10-07) — every place
 * in production code that creates a `users` row is NAMED here, and each one
 * writes it inside a transaction (`tx.insert(usersTable)`), beside the row
 * that gives the account its place: its first membership, or — for a platform
 * operator alone — its operator grant.
 *
 * WHY: an account with NO membership is administrable by every tenant admin
 * when confinement is vacuous (G01's operator; G04's new hire, created by
 * `/auth/register` with no membership until a second call). The fix made every
 * writer atomic; this test makes a NEW writer a deliberate act. It fails when
 * a file not listed creates a user, or when a listed file creates one outside
 * a transaction handle. It reads source, so it proves the SHAPE; the
 * behaviour is proven by `g04-zero-membership` (a failed membership write
 * leaves no account — register and invitation acceptance).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** file → what the account is created WITH. */
const WRITERS: Record<string, string> = {
  "apps/api/src/repositories/signup.repository.ts": "public signup: organization + company + admin membership, one transaction",
  "apps/api/src/repositories/userAdmin.repository.ts": "/auth/register: the first membership in an organization the caller administers",
  "apps/api/src/repositories/invitations.repository.ts": "invitation acceptance: the claim and the membership",
  "apps/api/src/services/demo/demoSeed.service.ts": "the demo tenant's admin membership",
  "packages/db/src/seed.ts": "the seeded admin's membership; the seeded operator's grant",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "tests" || name === "__tests__" || name === "generated" || name === "dist") continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("account-creation writers — every user is created inside a transaction, beside its membership", () => {
  const files = [...sourceFiles(join(ROOT, "apps", "api", "src")), ...sourceFiles(join(ROOT, "packages", "db", "src"))];
  const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
  const creating = files.filter((p) => /\.insert\(\s*usersTable\s*\)|INSERT\s+INTO\s+"?users"?\s*\(/i.test(readFileSync(p, "utf8"))).map(rel);

  it("ANTI-VACUITY: the scan reads the source tree and finds the known writers", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(creating).toContain("apps/api/src/repositories/signup.repository.ts");
  });

  it("🔴 no file outside the named list creates a user, and every named file still does", () => {
    expect(creating.filter((f) => !(f in WRITERS)).sort(), "a new account writer must be atomic with its membership and named here").toEqual([]);
    expect(Object.keys(WRITERS).filter((f) => !creating.includes(f)).sort(), "a writer that no longer creates users leaves the list").toEqual([]);
  });

  it("🔴 every creation runs on a TRANSACTION handle — never the bare connection", () => {
    for (const f of creating) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const calls = [...src.matchAll(/(\w+)\s*\.insert\(\s*usersTable\s*\)/g)].map((m) => m[1]);
      expect(calls.length, `${f}: at least one creation`).toBeGreaterThan(0);
      expect(calls.filter((receiver) => receiver !== "tx"), `${f}: users inserted outside a transaction handle`).toEqual([]);
    }
  });
});
