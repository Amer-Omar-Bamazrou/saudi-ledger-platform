/**
 * 🔴 Phase 18 audit (2026-11-09), finding A2 — DR-27's "tenant-visible audit" is read a PAGE at a time, and the page
 * says how many rows there are.
 *
 * `GET /orgs/:orgId/security-events` returned the newest 100 rows and nothing else: no total and no way to the 101st
 * row. A reader shown 100 rows could not tell that there were more (§3: does the number shown describe the set the
 * user thinks it describes). The route now takes `limit` and `offset` and answers the organization's total beside the
 * page, newest first.
 *
 * Presence, absence, movement: the pages together are exactly the organization's rows, in order, with no row skipped
 * or repeated; another organization's rows are on none of them; a new event moves the total by one and appears first.
 * DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3398";
process.env.SESSION_SECRET ??= "phase18-audit-a2-security-events-page1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { ListOrgSecurityEventsResponse } from "@workspace/api-zod";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA2SecurityEventsPw1!";
const SEEDED = 7;

type Ev = { id: string; action: string; organizationId: string | null; createdAt: string };
type Page = { events: Ev[]; total: number; limit: number; offset: number };

describeMaybe("Phase 18 audit A2 — the security-events trail is paged, with its total", () => {
  const h = g04Harness("auda2");
  let orgA = "", orgB = "";

  const page = async (who: string, orgId: string, query: string) => {
    const r = await h.api(who, "GET", `/orgs/${orgId}/security-events${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Page;
  };
  const dbIds = async (orgId: string) =>
    (await pool.query(`SELECT id FROM security_audit_logs WHERE organization_id = $1 ORDER BY created_at DESC, id DESC`, [orgId])).rows.map((r) => r.id as string);

  beforeAll(async () => {
    await h.cleanup();
    orgA = await h.mkOrg("a");
    orgB = await h.mkOrg("b");
    await h.mkUser("adminA", PW, orgA, "admin");
    await h.mkUser("adminB", PW, orgB, "admin");
    await h.mkUser("bookA", PW, orgA, "bookkeeper");
    // Fixture: seven events a minute apart in org A, and three in org B (the other scope, which shows its own).
    for (let i = 0; i < SEEDED; i++) {
      await pool.query(`INSERT INTO security_audit_logs (action, organization_id, metadata, created_at) VALUES ('invite.sent', $1, $2, now() - ($3 || ' minutes')::interval)`,
        [orgA, JSON.stringify({ seq: i }), String(10 + i)]);
    }
    for (let i = 0; i < 3; i++) {
      await pool.query(`INSERT INTO security_audit_logs (action, organization_id, created_at) VALUES ('invite.sent', $1, now() - ($2 || ' minutes')::interval)`, [orgB, String(10 + i)]);
    }
    await h.start();
    for (const who of ["adminA", "adminB", "bookA"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a page answers its slice AND the organization's total — the total is the database's count, not the page's", async () => {
    const ids = await dbIds(orgA);
    expect(ids.length, "fixture: org A has at least its seeded rows").toBeGreaterThanOrEqual(SEEDED);
    const p = await page("adminA", orgA, "?limit=3&offset=0");
    expect(p.total).toBe(ids.length);
    expect(p.events.map((e) => e.id)).toEqual(ids.slice(0, 3));
    expect([p.limit, p.offset]).toEqual([3, 0]);
  });

  it("🔴 the pages together are exactly the organization's rows, newest first: none skipped, none repeated", async () => {
    const ids = await dbIds(orgA);
    const seen: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 3) seen.push(...(await page("adminA", orgA, `?limit=3&offset=${offset}`)).events.map((e) => e.id));
    expect(seen).toEqual(ids);
    expect((await page("adminA", orgA, `?limit=3&offset=${ids.length}`)).events, "past the end: an empty page").toEqual([]);
  });

  it("absence: org B's rows are on no page of org A — while org B's admin reads org B's own", async () => {
    const a = await page("adminA", orgA, "?limit=200");
    expect(a.events.every((e) => e.organizationId === orgA)).toBe(true);
    const b = await page("adminB", orgB, "?limit=200");
    expect(b.total).toBe((await dbIds(orgB)).length);
    expect(b.total, "the other scope shows its own rows, so A's absence is not vacuous").toBeGreaterThanOrEqual(3);
    expect(b.events.some((e) => a.events.some((x) => x.id === e.id))).toBe(false);
  });

  it("🔴 movement: a new event moves the total by one and is first on the first page", async () => {
    const before = (await page("adminA", orgA, "?limit=1")).total;
    const sent = await h.api("adminA", "POST", `/orgs/${orgA}/invitations`, { email: `a2-${Date.now()}@example.test`, role: "viewer" });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const after = await page("adminA", orgA, "?limit=1");
    expect(after.total).toBe(before + 1);
    expect(after.events[0]?.action).toBe("invite.sent");
  });

  it("conformance: the response parses as the contract's SecurityEventPage — and the schema refuses a body with no total", async () => {
    const r = await h.api("adminA", "GET", `/orgs/${orgA}/security-events?limit=5`);
    const parsed = ListOrgSecurityEventsResponse.safeParse(JSON.parse(JSON.stringify(r.body)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.events.length).toBe(5);
    expect(ListOrgSecurityEventsResponse.safeParse({ events: [] }).success, "the probe sees a known-bad body").toBe(false);
  });

  it("a page larger than 200 is served as 200 at most; a missing limit is a page of 50", async () => {
    expect((await page("adminA", orgA, "?limit=5000")).limit).toBe(200);
    expect((await page("adminA", orgA, "")).limit).toBe(50);
  });

  it("a bookkeeper of the organization is refused (admins only), paged or not", async () => {
    expect((await h.api("bookA", "GET", `/orgs/${orgA}/security-events?limit=3`)).status).toBe(403);
  });
});
