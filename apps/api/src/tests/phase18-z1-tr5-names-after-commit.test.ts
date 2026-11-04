/**
 * 🔴 Phase 18 final round — TR-5 (owner, 2026-11-04): "the bank-detail decision resolves the requester's and decider's
 * names only AFTER its transaction commits (toOut → memberNamesByIds uses ownerDb while the tenant transaction is open).
 * Also, g04-zero-membership.test.ts must not create or drop a trigger on organization_memberships while other test files
 * run. Prove both." Register §11.133.
 *
 * What it failed as: a decision answered 500 after 15,037 ms, the app's idle-in-transaction timeout. The request's tenant
 * transaction sat open, holding its row locks, while a separate owner connection waited to read the identity tables, and
 * that suite's trigger DDL holds a lock on one of those tables.
 *
 * The proof looks at the moment the names are read: from an independent connection, is the decision already committed?
 * Fault-free and with no lock held, so it is deterministic. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3218";
process.env.SESSION_SECRET ??= "z1-tr5-names-after-commit-00000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { membersRepository } from "../repositories/members.repository";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Z1NamesAfterCommitPw1!";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA1310000000111122223333";
const CHANGES = "/companies/current/bank-detail-changes";

describeMaybe("TR-5: a bank-detail decision's names are read only after it has committed", () => {
  const h = g04Harness("z1tr5");
  const ids: Record<string, number> = {};
  let orgId = "";

  const statusOf = async (id: number) => (await pool.query(`SELECT status FROM bank_detail_change_requests WHERE id = $1`, [id])).rows[0]?.status as string;
  const hold = async (name: string) => {
    const made = await h.api("first", "POST", "/vendors", { name, residency: "resident", iban: IBAN_A });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const held = await h.api("first", "PATCH", `/vendors/${made.body.id}`, { iban: IBAN_B });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const pending = held.body.pendingBankDetailChanges as Array<{ id: number; status: string; requestedByName: string | null }>;
    expect(pending.map((p) => p.status)).toEqual(["pending"]);
    return pending[0]!;
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("pair");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1, 'Z1 Co', 1)`, [orgId]);
    ids.first = await h.mkUser("first", PW, orgId, "admin");
    ids.second = await h.mkUser("second", PW, orgId, "admin");
    await h.start();
    for (const who of ["first", "second"]) expect(await h.login(who, h.email(who), PW)).toBe(200);
  }, 120_000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 when the names are read, the decision is already visible to another connection (committed), and the response carries both names", async () => {
    const change = await hold("Z1 Supplier committed");
    const seen: string[] = [];
    const real = membersRepository.memberNamesByIds.bind(membersRepository);
    vi.spyOn(membersRepository, "memberNamesByIds").mockImplementation(async (org, userIds) => {
      seen.push(await statusOf(change.id));
      return real(org, userIds);
    });
    const r = await h.api("second", "PUT", `${CHANGES}/${change.id}/decision`, { decision: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(seen.length, "the names were read for this decision").toBeGreaterThan(0);
    expect(new Set(seen), "committed before any name was read").toEqual(new Set(["approved"]));
    expect([r.body.status, r.body.requestedBy, r.body.decidedBy]).toEqual(["approved", ids.first, ids.second]);
    expect(r.body.requestedByName, "the requester's name").toBeTruthy();
    expect(r.body.decidedByName, "the decider's name").toBeTruthy();
  });

  it("🔴 a rejection too: committed before the names are read", async () => {
    const change = await hold("Z1 Supplier rejected");
    const seen: string[] = [];
    const real = membersRepository.memberNamesByIds.bind(membersRepository);
    vi.spyOn(membersRepository, "memberNamesByIds").mockImplementation(async (org, userIds) => {
      seen.push(await statusOf(change.id));
      return real(org, userIds);
    });
    const r = await h.api("second", "PUT", `${CHANGES}/${change.id}/decision`, { decision: "reject" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(new Set(seen)).toEqual(new Set(["rejected"]));
  });

  it("🔴 the identity layer failing cannot undo the decision: it stands, the answer is 200, and the names read null", async () => {
    const change = await hold("Z1 Supplier names fail");
    vi.spyOn(membersRepository, "memberNamesByIds").mockRejectedValue(new Error("z1 probe: identity read failed"));
    const r = await h.api("second", "PUT", `${CHANGES}/${change.id}/decision`, { decision: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusOf(change.id)).toBe("approved");
    expect([r.body.status, r.body.requestedByName, r.body.decidedByName]).toEqual(["approved", null, null]);
  });

  it("a list and a held write still answer with the names (the same seam, nothing lost)", async () => {
    const change = await hold("Z1 Supplier listed");
    expect(change.requestedByName, "a held write names its requester").toBeTruthy();
    const list = await h.api("second", "GET", CHANGES);
    expect(list.status).toBe(200);
    const mine = (list.body.items as Array<{ id: number; requestedByName: string | null }>).find((x) => x.id === change.id);
    expect(mine?.requestedByName, "the list names the requester").toBeTruthy();
  });
});

describe("TR-5: no test changes a trigger on an identity table while other test files run", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const IDENTITY = ["organization_memberships", "organizations", "users", "platform_operators"];
  /** A statement that takes a table lock every request's authentication then queues behind. */
  const offends = (text: string) =>
    [...text.matchAll(/\b(?:CREATE(?:\s+OR\s+REPLACE)?(?:\s+CONSTRAINT)?|DROP)\s+TRIGGER\b[^`;]*?\bON\s+"?(\w+)"?/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((table) => IDENTITY.includes(table));

  it("the scan sees what it must (its own known-present cases)", () => {
    expect(offends("await pool.query(`DROP TRIGGER IF EXISTS t1 ON organization_memberships`)")).toEqual(["organization_memberships"]);
    expect(offends("CREATE TRIGGER t2 BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()")).toEqual(["users"]);
    expect(offends("CREATE TRIGGER t3 BEFORE TRUNCATE ON g16_truncate_probe FOR EACH STATEMENT EXECUTE FUNCTION f()")).toEqual([]);
  });

  it("🔴 no API test file does it", () => {
    const self = fileURLToPath(import.meta.url).split(/[\\/]/).pop();
    const found = readdirSync(HERE)
      .filter((f) => f.endsWith(".test.ts") && f !== self)
      .filter((f) => offends(readFileSync(join(HERE, f), "utf8")).length > 0);
    expect(found).toEqual([]);
  });
});
