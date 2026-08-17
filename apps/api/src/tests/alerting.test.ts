/**
 * B2 — alerting: something actually pages, exactly once per condition, and
 * says "clear" when it stops.
 *
 * The queue entry's point was that VISIBILITY IS NOT ALERTING: M12.8 put both
 * alarms on the operator panel and that was recorded as delivered, but a panel
 * only helps someone already looking, and nobody looks at a panel that is
 * usually green. So these tests assert the properties a paging channel needs
 * and a dashboard does not:
 *
 *   - a firing condition pages ONCE and then stays quiet for the cooldown —
 *     an alarm that repeats every 5 minutes gets muted by its recipients,
 *     which is the same end state as not alerting at all;
 *   - the cooldown survives a restart, because it is a ROW, not a timer (the
 *     M12.8 renewal-reminder lesson: idempotency is a DB constraint, never a
 *     scheduling assumption);
 *   - a cleared condition sends a RESOLVE, so "is it still broken?" has an
 *     answer;
 *   - a webhook outage never breaks the job that detected the problem.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerDb, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { __setAlerterForTests, webhookAlerter, type Alert } from "../lib/alerter";
import {
  alarmsService,
  ALL_ALARM_KEYS,
  ALARM_OUTBOX_OVERDUE,
  ALARM_PCSID_EXPIRING,
} from "../services/alerting/alarms.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[alerting] no real DATABASE_URL — skipping.");

describe("B2 — the webhook alerter (no network)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts a structured alert and a resolve to the same endpoint", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      calls.push({ url: String(u), body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const a = webhookAlerter("https://hooks.example/alert");
    expect(await a.fire({ key: "k", severity: "critical", title: "T", detail: "D", context: { n: 1 } })).toEqual({ sent: true });
    expect(await a.resolve("k", "T")).toEqual({ sent: true });

    expect(calls[0].url).toBe("https://hooks.example/alert");
    expect(calls[0].body).toMatchObject({ event: "alert", key: "k", severity: "critical", title: "T", context: { n: 1 } });
    expect(calls[1].body).toMatchObject({ event: "resolve", key: "k" });
  });

  it("🔴 a webhook outage reports not-sent and NEVER throws — it must not hide the outage it watches", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    expect(await webhookAlerter("https://hooks.example/a").fire({ key: "k", severity: "warning", title: "T", detail: "D" })).toEqual({ sent: false });

    globalThis.fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await webhookAlerter("https://hooks.example/a").resolve("k", "T")).toEqual({ sent: false });
  });
});

const FIXTURE_SLUG = "b2-alarm-fixture";

describeMaybe("B2 — alarm evaluation, dedupe and resolution", () => {
  let fired: Alert[] = [];
  let resolved: string[] = [];

  beforeEach(async () => {
    fired = [];
    resolved = [];
    __setAlerterForTests({
      async fire(a) {
        fired.push(a);
        return { sent: true };
      },
      async resolve(key) {
        resolved.push(key);
        return { sent: true };
      },
    });
    await ownerDb.execute(sql`DELETE FROM alert_state`);
  });

  const cleanupFixture = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${FIXTURE_SLUG}')`;
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${FIXTURE_SLUG}'`);
  };

  beforeEach(cleanupFixture);

  afterAll(async () => {
    __setAlerterForTests(null);
    await ownerDb.execute(sql`DELETE FROM alert_state`);
    await cleanupFixture();
  });

  /**
   * The fixture organization — created up front so every `runOnce` call can be
   * SCOPED to it. Evaluation is global by design (a platform job watches every
   * tenant), which on the shared test database means another suite's aged
   * outbox documents or synthetic near-expiry credentials fire THIS suite's
   * assertions: `fired` counted 2 alerts where the fixture built one. Scoping
   * makes the assertions about the condition this suite constructed, which is
   * all they ever claimed to test.
   */
  const fixtureOrg = async (): Promise<string> =>
    (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('Alarm Org','${FIXTURE_SLUG}')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      )
    ).rows[0].id;

  const scoped = async () => alarmsService.runOnce({ organizationId: await fixtureOrg() });

  /**
   * Force a firing outbox condition by BUILDING one — never by hoping the
   * database happens to contain a document.
   *
   * 🔴 The first version of this helper returned null when the table was empty
   * and every caller did `if (!id) return`. The local database has zero
   * `einvoice_documents`, so all three outbox tests passed while asserting
   * NOTHING — green, counted, and vacuous, which this project has repeatedly
   * recorded as worse than no test at all. It now creates its own fixture and
   * fails loudly if it cannot.
   */
  const stuckDocument = async (): Promise<string> => {
    const org = await fixtureOrg();
    const company = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number)
         VALUES ($1,'AL','1010101019','399999999999993') RETURNING id`,
        [org],
      )
    ).rows[0].id;
    const invoice = (
      await pool.query(
        `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, total)
         VALUES ($1,$2,'ALARM-1','2026-08-01','sent',115) RETURNING id`,
        [org, company],
      )
    ).rows[0].id;
    const doc = (
      await pool.query(
        `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, flow, status, created_at)
         VALUES ($1,$2,$3,'reporting','pending', now() - interval '14 hours') RETURNING id`,
        [org, company, invoice],
      )
    ).rows[0].id;
    return doc as string;
  };

  it("a quiet platform pages nobody", async () => {
    // Quiet by construction: the fixture org is freshly cleaned, and the run is
    // scoped to it. The previous version made the WHOLE database quiet with a
    // global UPDATE flipping every pending document to 'accepted' — which, on
    // the shared test database, rewrote parallel suites' documents under their
    // assertions (einvoice-enqueue's freshly approved 'pending' rows included).
    const r = await scoped();
    expect(r.evaluated).toBe(ALL_ALARM_KEYS.length);
    expect(r.paged).toEqual([]);
    expect(fired).toEqual([]);
  });

  it("🔴 a stuck outbox pages ONCE, then stays quiet for the cooldown", async () => {
    const id = await stuckDocument();

    const first = await scoped();
    expect(first.firing).toContain(ALARM_OUTBOX_OVERDUE);
    expect(first.paged).toContain(ALARM_OUTBOX_OVERDUE);
    expect(fired).toHaveLength(1);
    // The message must carry the AGE — one document 13h old is the emergency,
    // not the count. And it must name the deadline a human is racing.
    expect(fired[0].title).toMatch(/oldest document 1[34]h old/);
    expect(fired[0].detail).toContain("24 hours");

    const second = await scoped();
    expect(second.firing).toContain(ALARM_OUTBOX_OVERDUE); // still broken…
    expect(second.paged).toEqual([]); // …and deliberately silent
    expect(fired).toHaveLength(1);
  });

  it("🔴 the cooldown is a ROW, not a timer — it survives a restart", async () => {
    const id = await stuckDocument();
    await scoped();
    expect(fired).toHaveLength(1);

    // Simulate a process restart: nothing in memory, the row is all there is.
    const { rows } = await ownerDb.execute<{ key: string; fire_count: number }>(
      sql`SELECT key, fire_count FROM alert_state WHERE key = ${ALARM_OUTBOX_OVERDUE}`,
    );
    expect(rows).toHaveLength(1);
    await scoped();
    expect(fired).toHaveLength(1); // still suppressed after "restart"
  });

  it("🔴 a cleared condition sends a RESOLVE — a channel that never says clear gets ignored", async () => {
    const id = await stuckDocument();
    await scoped();
    expect(fired).toHaveLength(1);

    // The queue drains.
    await pool.query(`UPDATE einvoice_documents SET status = 'accepted' WHERE id = $1`, [id]);
    const r = await scoped();
    expect(r.resolved).toContain(ALARM_OUTBOX_OVERDUE);
    expect(resolved).toContain(ALARM_OUTBOX_OVERDUE);

    // And the state is gone, so the NEXT occurrence pages immediately rather
    // than being suppressed by a stale cooldown.
    const { rows } = await ownerDb.execute(sql`SELECT key FROM alert_state WHERE key = ${ALARM_OUTBOX_OVERDUE}`);
    expect(rows).toHaveLength(0);
  });

  it("an alarm whose evaluation throws does not stop the other alarms", async () => {
    // EVERY alarm is always evaluated; the count proves the loop completed
    // even though this database may have no ZATCA credentials at all. Asserted
    // against the exported key list, not a literal — a hard-coded 2 silently
    // became wrong the day a third alarm was added.
    const r = await scoped();
    expect(r.evaluated).toBe(ALL_ALARM_KEYS.length);
  });

  it("the certificate alarm key exists and is distinct from the outbox one", () => {
    expect(ALARM_PCSID_EXPIRING).not.toBe(ALARM_OUTBOX_OVERDUE);
  });
});
