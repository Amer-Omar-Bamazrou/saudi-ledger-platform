/**
 * 🔴 19B S6 (control 19B-S6B) — REPORT SCHEDULES AND THE IN-APP DELIVERY STORE (v4 §6.2, §8 D6, §9 D7; scope 19.14).
 *
 * SCHEDULE
 *  - by role: a viewer schedules to themselves and may not deliver to others (refused by name, and the refusal is
 *    RECORDED); a bookkeeper delivers to members; a recipient who is not an active member is refused;
 *  - recipients are shown by NAME and ROLE only — never an email.
 * RUN
 *  - one stored copy PER RECIPIENT, built from THAT recipient's grants: the bank's text is in the accountant's copy and
 *    nowhere in the viewer's (presence, absence, movement — the viewer's copy still has the typed line's text);
 *  - one run per period: a second run the same business day, and two runs at once, deliver nothing more;
 *  - an owner who is no longer a member: the run is refused and recorded; a recipient who is no longer a member, or
 *    whose role may not run the dataset, is skipped and recorded.
 * OPEN (D7)
 *  - only the recipient opens a copy; anyone else — another member, another company, another organization — gets 404;
 *  - grants are checked AGAIN at open: a class lost since delivery is withheld; a lost `run` opens nothing, recorded;
 *  - INTEGRITY: a copy whose content no longer matches its SHA-256 is refused, recorded and alarmed;
 *  - EXPIRY: the job clears the content and keeps the tombstone; an expired copy opens as a message with no data.
 * THE STORE'S PROTECTIONS
 *  - the request's role holds SELECT only; the table has exactly one file that touches it (a ratchet).
 *
 * DB-backed; skips on the DB-free placeholder.
 */
process.env.PORT ??= "3262";
process.env.SESSION_SECRET ??= "s6-report-schedules-000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, PERMISSION_MATRIX, type PermissionRow } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { alerter } from "../lib/alerter";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s6-report-schedules-password-2026";
const h = g04Harness("s6sch");
const BANK_TEXT = "S6 BANK SARIE TRANSFER REF 4417";
const TYPED_TEXT = "S6 typed accrual";
const NOW = new Date("2026-10-20T09:00:00Z"); // a business day in October, Riyadh
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;

const without = (pred: (r: PermissionRow) => boolean) => PERMISSION_MATRIX.filter((r) => !pred(r));

describeDb("19B S6 — report schedules and the delivery store", () => {
  let orgId = "";
  let otherOrgId = "";
  const ids: Record<string, number> = {};
  const defs: Record<string, number> = {};
  const events = async (action: string) =>
    (await pool.query(`SELECT * FROM permission_refusal_events WHERE organization_id = $1 AND action = $2 ORDER BY id`, [orgId, action])).rows;
  const deliveries = async (scheduleId: number) =>
    (await pool.query(`SELECT d.* FROM report_deliveries d JOIN report_runs r ON r.id = d.run_id WHERE r.schedule_id = $1 ORDER BY d.id`, [scheduleId])).rows;
  const run = async (now = NOW) => (await import("../services/reporting/reportSchedules.job")).reportSchedulesJob.runOnce(now, orgId);
  const expire = async (now: Date) => (await import("../services/reporting/reportSchedules.job")).reportDeliveryExpiryJob.runOnce(now);
  const jl = (name: string) => ({ name, dataset: "journal_lines", columns: ["date", "entryNumber", "textOrigin", "description", "debit"], period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, filters: {}, sort: "date" });

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S6 Schedules Co", "319191919191995");
    for (const role of ROLES) ids[role] = await h.mkUser(role, PW, orgId, role);
    ids.viewer2 = await h.mkUser("viewer2", PW, orgId, "viewer");
    ids.leaver = await h.mkUser("leaver", PW, orgId, "accountant");
    for (const who of [...ROLES, "viewer2", "leaver"]) expect(await h.login(who, h.email(who), PW)).toBe(200);
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "S6 Schedules Other Co", "319191919192001");
    ids.outsider = await h.mkUser("outsider", PW, otherOrgId, "admin");
    expect(await h.login("outsider", h.email("outsider"), PW)).toBe(200);

    // the product's own rows: a bank line posted from a transaction, and a typed entry — both in October
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "S6 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const row = await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: bank.body.id });
    expect(row.status, JSON.stringify(row.body)).toBe(201);
    const je = await h.api("admin", "POST", "/journal-entries", { date: "2026-10-15", description: TYPED_TEXT, lines: [
      { accountId: await acct("RENT_UTILITIES"), accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
      { accountId: await acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
    ] });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {})).status).toBe(200);

    for (const who of ["accountant", "bookkeeper", "viewer", "leaver"]) {
      const d = await h.api(who, "POST", "/report-definitions", jl(`${who} lines`));
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      defs[who] = d.body.id;
    }
    const cash = await h.api("bookkeeper", "POST", "/report-definitions", { name: "cash", dataset: "cash_movements", columns: ["date", "signedAmount"], period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, filters: {}, sort: null });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    defs.cash = cash.body.id;
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); vi.restoreAllMocks(); await h.stop(); await h.cleanup(); });

  it("🔴 schedule, by role: a viewer schedules to themselves and may not deliver to others — refused by name and RECORDED", async () => {
    const before = (await events("schedule")).length;
    const self = await h.api("viewer", "POST", "/report-schedules", { definitionId: defs.viewer, cadence: "daily" });
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    expect(self.body.recipients).toEqual([{ userId: ids.viewer, name: expect.any(String), role: "viewer" }]);
    expect((await events("schedule")).length).toBe(before); // an allowed schedule records nothing

    const others = await h.api("viewer", "POST", "/report-schedules", { definitionId: defs.viewer, cadence: "weekly", recipientUserIds: [ids.viewer, ids.accountant] });
    expect([others.status, others.body.code, others.body.act]).toEqual([403, "report_act_not_granted", "deliver"]);
    const recorded = (await events("schedule")).slice(before);
    expect(recorded.map((e) => [e.actor_user_id, e.resource, e.refusal_code])).toEqual([[ids.viewer, "report_dataset.journal_lines", "report_act_not_granted"]]);

    const bad: [Record<string, unknown>, number, string][] = [
      [{ definitionId: defs.viewer, cadence: "hourly" }, 400, "report_bad_filter"],
      [{ definitionId: defs.accountant, cadence: "daily" }, 404, "not_found"], // someone else's, not shared: not found
      [{ definitionId: 2_000_000_000, cadence: "daily" }, 404, "not_found"], // the same answer as one that does not exist
    ];
    for (const [body, status, code] of bad) {
      const r = await h.api("viewer", "POST", "/report-schedules", body);
      expect([r.status, r.body.code ?? ""], JSON.stringify(body)).toEqual([status, code]);
    }
  });

  it("🔴 recipients are members, picked and shown by name and role only — never an email; an outsider or a leaver is refused", async () => {
    const picker = await h.api("bookkeeper", "GET", "/report-schedules/recipients");
    expect(picker.status, JSON.stringify(picker.body)).toBe(200);
    expect(Object.keys(picker.body.items[0]).sort()).toEqual(["name", "role", "userId"]);
    expect(picker.body.items.map((m: { userId: number }) => m.userId).sort()).toEqual([ids.admin, ids.accountant, ids.bookkeeper, ids.viewer, ids.viewer2, ids.leaver].sort());
    expect(picker.text).not.toContain("@test.local");
    // the admin's picker is the same: names and roles, for every role
    expect((await h.api("admin", "GET", "/report-schedules/recipients")).text).not.toContain("@test.local");

    const outsider = await h.api("bookkeeper", "POST", "/report-schedules", { definitionId: defs.bookkeeper, cadence: "daily", recipientUserIds: [ids.outsider] });
    expect([outsider.status, outsider.body.code]).toEqual([422, "report_recipient_not_member"]);
    const ok = await h.api("bookkeeper", "POST", "/report-schedules", { definitionId: defs.bookkeeper, cadence: "daily", recipientUserIds: [ids.accountant, ids.viewer] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.recipients.map((r: { userId: number; role: string }) => [r.userId, r.role]).sort()).toEqual([[ids.accountant, "accountant"], [ids.viewer, "viewer"]].sort());
    expect(ok.text).not.toContain("@test.local");
    const list = await h.api("bookkeeper", "GET", "/report-schedules");
    expect(list.body.items.map((s: { id: number }) => s.id)).toContain(ok.body.id);
    expect(list.text).not.toContain("@test.local");
    // another member does not see, and cannot end, a schedule that is not theirs
    expect((await h.api("accountant", "GET", "/report-schedules")).body.items.map((s: { id: number }) => s.id)).not.toContain(ok.body.id);
    expect((await h.api("accountant", "DELETE", `/report-schedules/${ok.body.id}`)).status).toBe(404);
    ids.bookkeeperSchedule = ok.body.id;
  });

  it("🔴 a run stores one copy per recipient, built from THAT recipient's grants: the bank's text is in the accountant's and nowhere in the viewer's", async () => {
    const result = await run();
    expect(result.failed, JSON.stringify(result)).toBe(0);
    const copies = await deliveries(ids.bookkeeperSchedule);
    expect(copies.map((c) => c.recipient_user_id).sort()).toEqual([ids.accountant, ids.viewer].sort());
    const of = (userId: number) => copies.find((c) => c.recipient_user_id === userId)!;
    const acc = JSON.stringify(of(ids.accountant));
    const view = JSON.stringify(of(ids.viewer));
    expect(acc).toContain(BANK_TEXT); // presence
    expect(view).not.toContain(BANK_TEXT); // absence — never written into the viewer's copy
    expect(view).toContain(TYPED_TEXT); // movement: the viewer's copy is not empty of text; only the bank's is gone
    expect(of(ids.viewer).content.withheld.map((w: { path: string; class: string }) => [w.path, w.class])).toEqual([["rows[].description", "bank_narrative"]]);
    expect(of(ids.accountant).content.withheld).toEqual([]);
    for (const c of copies) {
      expect(c.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect([c.report_name, c.dataset, c.row_count, c.expired_at]).toEqual(["bookkeeper lines", "journal_lines", c.content.rows.length, null]);
      expect(new Date(c.expires_at).getTime()).toBeGreaterThan(new Date(c.created_at).getTime());
    }
    expect(of(ids.accountant).row_count).toBeGreaterThanOrEqual(3);
  });

  it("🔴 one run per period: the same business day again, and two runs at once, deliver nothing more; the next day runs again", async () => {
    const before = (await deliveries(ids.bookkeeperSchedule)).length;
    await run();
    await Promise.all([run(), run()]);
    expect((await deliveries(ids.bookkeeperSchedule)).length).toBe(before);
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM report_runs WHERE schedule_id = $1`, [ids.bookkeeperSchedule])).rows[0].n)).toBe(1);
    // two processes at the next period: exactly one run row, exactly one copy per recipient
    const next = new Date("2026-10-21T09:00:00Z");
    await Promise.all([run(next), run(next)]);
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM report_runs WHERE schedule_id = $1`, [ids.bookkeeperSchedule])).rows[0].n)).toBe(2);
    expect((await deliveries(ids.bookkeeperSchedule)).length).toBe(before + 2);
  });

  it("🔴 an owner who left: the run is refused and recorded. A recipient who left, or whose role may not run the data, is skipped and recorded", async () => {
    const leaverSchedule = await h.api("leaver", "POST", "/report-schedules", { definitionId: defs.leaver, cadence: "daily", recipientUserIds: [ids.leaver, ids.admin] });
    expect(leaverSchedule.status, JSON.stringify(leaverSchedule.body)).toBe(201);
    const cashSchedule = await h.api("bookkeeper", "POST", "/report-schedules", { definitionId: defs.cash, cadence: "daily", recipientUserIds: [ids.bookkeeper, ids.viewer, ids.viewer2] });
    expect(cashSchedule.status, JSON.stringify(cashSchedule.body)).toBe(201);
    await pool.query(`UPDATE organization_memberships SET status = 'inactive' WHERE organization_id = $1 AND user_id = ANY($2)`, [orgId, [ids.leaver, ids.viewer2]]);
    const day = new Date("2026-10-22T09:00:00Z");
    const runsBefore = (await events("schedule_run")).length;
    const deliverBefore = (await events("deliver")).length;
    await run(day);

    // the leaver's schedule: refused as a whole — nobody receives a report run in the name of someone with no access
    expect(await deliveries(leaverSchedule.body.id)).toEqual([]);
    const refused = (await pool.query(`SELECT status, outcome_code FROM report_runs WHERE schedule_id = $1`, [leaverSchedule.body.id])).rows;
    expect(refused).toEqual([{ status: "refused", outcome_code: "report_schedule_owner_not_member" }]);
    expect((await events("schedule_run")).slice(runsBefore).map((e) => [e.actor_user_id, e.refusal_code])).toEqual([[ids.leaver, "report_schedule_owner_not_member"]]);

    // the cash schedule: the bookkeeper receives it; the viewer (no grant on cash movements) and the leaver are skipped
    expect((await deliveries(cashSchedule.body.id)).map((c) => c.recipient_user_id)).toEqual([ids.bookkeeper]);
    const skipped = (await events("deliver")).slice(deliverBefore).filter((e) => e.resource === "report_dataset.cash_movements");
    expect(skipped.map((e) => [e.recipient_user_id, e.refusal_code]).sort()).toEqual([[ids.viewer, "report_dataset_not_granted"], [ids.viewer2, "report_recipient_not_member"]].sort());
    expect(skipped.every((e) => e.actor_user_id === ids.bookkeeper)).toBe(true);
    const counts = (await pool.query(`SELECT status, delivered_count, skipped_count FROM report_runs WHERE schedule_id = $1`, [cashSchedule.body.id])).rows;
    expect(counts).toEqual([{ status: "delivered", delivered_count: 1, skipped_count: 2 }]);
    // and a member who left is no longer offered as a recipient
    const offered = (await h.api("bookkeeper", "GET", "/report-schedules/recipients")).body.items.map((m: { userId: number }) => m.userId);
    expect([offered.includes(ids.leaver), offered.includes(ids.viewer2), offered.includes(ids.viewer)]).toEqual([false, false, true]);
  });

  it("🔴 only the recipient opens a copy; grants are checked again at open; a lost run opens nothing and is recorded", async () => {
    const copies = await deliveries(ids.bookkeeperSchedule);
    const accCopy = copies.find((c) => c.recipient_user_id === ids.accountant)!;
    const viewCopy = copies.find((c) => c.recipient_user_id === ids.viewer)!;

    const mine = await h.api("accountant", "GET", "/report-deliveries");
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items.map((d: { id: number }) => d.id)).toContain(accCopy.id);
    expect(mine.body.items.map((d: { id: number }) => d.id)).not.toContain(viewCopy.id);
    expect(JSON.stringify(mine.body)).not.toContain(BANK_TEXT); // the list is the tombstone's facts, never the content

    const opened = await h.api("accountant", "GET", `/report-deliveries/${accCopy.id}`);
    expect([opened.status, opened.body.status, opened.body.reportName, opened.body.dataset]).toEqual([200, "available", "bookkeeper lines", "journal_lines"]);
    expect(opened.body.rows.journal_lines.map((r: { description?: string }) => r.description)).toContain(BANK_TEXT);
    expect(opened.body.total).toBe(opened.body.rows.journal_lines.length);
    // not the recipient: another member, and another organization — the same answer as a missing copy
    for (const who of ["viewer", "admin", "bookkeeper", "outsider"]) expect((await h.api(who, "GET", `/report-deliveries/${accCopy.id}`)).status, who).toBe(404);
    expect((await h.api("accountant", "GET", "/report-deliveries/2000000000")).status).toBe(404);

    // 🔴 the grant is lost AFTER delivery: the stored copy still holds the text, the opened one does not
    primePermissionCache(without((r) => r.role === "accountant" && r.resource === "journal_entries" && r.action === "field.bank_narrative.read"));
    try {
      const narrowed = await h.api("accountant", "GET", `/report-deliveries/${accCopy.id}`);
      expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
      expect(narrowed.text).not.toContain(BANK_TEXT);
      expect(narrowed.text).toContain(TYPED_TEXT);
      expect(narrowed.body.withheld.map((w: { path: string; class: string }) => [w.path, w.class])).toEqual([["rows[].description", "bank_narrative"]]);
    } finally { primePermissionCache(PERMISSION_MATRIX); }
    expect((await h.api("accountant", "GET", `/report-deliveries/${accCopy.id}`)).text).toContain(BANK_TEXT); // and it comes back with the grant

    // 🔴 `run` on the dataset is lost: nothing opens, and the refusal is recorded against the recipient
    const before = (await events("deliver")).length;
    primePermissionCache(without((r) => r.role === "accountant" && r.resource === "report_dataset.journal_lines" && r.action === "run"));
    try {
      const lost = await h.api("accountant", "GET", `/report-deliveries/${accCopy.id}`);
      expect([lost.status, lost.body.code]).toEqual([403, "report_dataset_not_granted"]);
      expect(lost.text).not.toContain(BANK_TEXT);
    } finally { primePermissionCache(PERMISSION_MATRIX); }
    expect((await events("deliver")).slice(before).map((e) => [e.actor_user_id, e.recipient_user_id, e.refusal_code])).toEqual([[ids.accountant, ids.accountant, "report_dataset_not_granted"]]);
  });

  it("🔴 integrity: a copy whose content no longer matches its SHA-256 is refused, recorded and alarmed — and shows nothing", async () => {
    const copy = (await deliveries(ids.bookkeeperSchedule)).filter((c) => c.recipient_user_id === ids.accountant).at(-1)!;
    const fire = vi.spyOn(alerter, "fire").mockResolvedValue(undefined as never);
    const before = (await events("deliver")).length;
    await pool.query(`UPDATE report_deliveries SET content = jsonb_set(content, '{rows,0,debit}', '999999') WHERE id = $1`, [copy.id]);
    try {
      const r = await h.api("accountant", "GET", `/report-deliveries/${copy.id}`);
      expect([r.status, r.body.code]).toEqual([409, "report_delivery_integrity"]);
      expect(r.text).not.toContain("999999");
      expect(r.text).not.toContain(BANK_TEXT);
      expect(typeof r.body.errorAr).toBe("string");
      expect((await events("deliver")).slice(before).map((e) => [e.recipient_user_id, e.refusal_code])).toEqual([[ids.accountant, "report_delivery_integrity"]]);
      expect(fire).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(fire.mock.calls[0])).not.toContain(BANK_TEXT); // the alarm names the copy, never its content
    } finally {
      await pool.query(`UPDATE report_deliveries SET content = $2::jsonb WHERE id = $1`, [copy.id, JSON.stringify(copy.content)]);
      fire.mockRestore();
    }
    expect((await h.api("accountant", "GET", `/report-deliveries/${copy.id}`)).status).toBe(200); // restored, it opens: the check reads the content
  });

  it("🔴 expiry: the job clears the content and keeps the tombstone; an expired copy opens as a message with no data", async () => {
    const copies = await deliveries(ids.bookkeeperSchedule);
    const copy = copies.find((c) => c.recipient_user_id === ids.accountant)!;
    const kept = copies.filter((c) => c.id !== copy.id).map((c) => c.id); // none of these is due
    expect(kept.length).toBeGreaterThanOrEqual(2);
    // not yet due: the job clears nothing
    expect((await expire(new Date(new Date(copy.created_at).getTime() + 60_000))).expired).toBe(0);
    // this one copy's time has come (by the clock the open uses): created long ago, due a second ago
    await pool.query(`UPDATE report_deliveries SET created_at = now() - interval '400 days', expires_at = now() - interval '1 second' WHERE id = $1`, [copy.id]);
    // 🔴 its time has come and the job has NOT run yet: the row still holds the content, and the open already shows none
    const early = await h.api("accountant", "GET", `/report-deliveries/${copy.id}`);
    expect([early.status, early.body.status, early.body.total]).toEqual([200, "expired", 0]);
    expect(early.text).not.toContain(BANK_TEXT);
    expect((await pool.query(`SELECT content IS NOT NULL AS held FROM report_deliveries WHERE id = $1`, [copy.id])).rows[0].held).toBe(true);
    const out = await expire(new Date());
    expect(out.expired).toBe(1); // this copy, and no other

    const row = (await pool.query(`SELECT * FROM report_deliveries WHERE id = $1`, [copy.id])).rows[0];
    expect([row.content, row.expired_at !== null]).toEqual([null, true]);
    // the tombstone: id, report, recipient, created, expired and hash
    expect([row.id, row.definition_id, row.report_name, row.recipient_user_id, row.content_sha256, row.row_count]).toEqual([copy.id, copy.definition_id, copy.report_name, copy.recipient_user_id, copy.content_sha256, copy.row_count]);
    expect(JSON.stringify(row)).not.toContain(BANK_TEXT);
    // no other table of the store holds the content
    for (const t of ["report_runs", "report_schedules", "report_schedule_recipients", "report_definitions", "permission_refusal_events"]) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t} x WHERE x.organization_id = $1 AND to_jsonb(x)::text LIKE $2`, [orgId, `%${BANK_TEXT}%`]);
      expect(rows[0].n, t).toBe(0);
    }
    // movement: the copies not yet due still hold theirs
    const others = (await pool.query(`SELECT count(*)::int AS n FROM report_deliveries WHERE id = ANY($1) AND content IS NOT NULL`, [kept])).rows[0].n;
    expect(others).toBe(kept.length);

    const opened = await h.api("accountant", "GET", `/report-deliveries/${copy.id}`);
    expect([opened.status, opened.body.status, opened.body.total]).toEqual([200, "expired", 0]);
    expect(opened.body.message).toMatch(/^This delivery expired on \d{4}-\d{2}-\d{2}\. Run the report again to see current figures\.$/);
    expect(typeof opened.body.messageAr).toBe("string");
    expect(opened.body.rows).toEqual({});
    expect(opened.text).not.toContain(BANK_TEXT);
    const listed = (await h.api("accountant", "GET", "/report-deliveries")).body.items.find((d: { id: number }) => d.id === copy.id);
    expect(listed.status).toBe("expired");
  });

  it("🔴 the store's protections: the request's role holds SELECT only, and exactly one file touches the table", async () => {
    const { rows } = await pool.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'report_deliveries' AND grantee = 'authenticated' ORDER BY 1`);
    expect(rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
    for (const t of ["report_runs", "report_schedules", "report_schedule_recipients"]) {
      const g = (await pool.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'authenticated' ORDER BY 1`, [t])).rows.map((r) => r.privilege_type);
      expect(g, t).not.toContain("DELETE");
      expect(g, t).not.toContain("TRUNCATE");
    }
    // 🔴 THE RATCHET: every source file that names the store's table. A second reader fails here.
    const src = join(import.meta.dirname, "..");
    const touching: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "tests" && name !== "node_modules") walk(p); continue; }
        if (!/\.(ts|mts)$/.test(name)) continue;
        if (/reportDeliveriesTable|report_deliveries\b/.test(readFileSync(p, "utf8"))) touching.push(p.slice(src.length + 1).replace(/\\/g, "/"));
      }
    };
    walk(src);
    expect(touching.sort()).toEqual(["controls/registry.ts", "repositories/reportDeliveries.repository.ts"]);
  });

  it("🔴 isolation: another organization's copy is absent here and present there", async () => {
    const def = await h.api("outsider", "POST", "/report-definitions", jl("outsider lines"));
    const sched = await h.api("outsider", "POST", "/report-schedules", { definitionId: def.body.id, cadence: "daily" });
    expect(sched.status, JSON.stringify(sched.body)).toBe(201);
    const job = (await import("../services/reporting/reportSchedules.job")).reportSchedulesJob;
    await job.runOnce(NOW, otherOrgId);
    const theirs = (await h.api("outsider", "GET", "/report-deliveries")).body.items as { id: number }[];
    expect(theirs.length).toBe(1); // movement: the other organization shows its own
    const mineIds = ((await h.api("admin", "GET", "/report-deliveries")).body.items as { id: number }[]).map((d) => d.id);
    expect(mineIds).not.toContain(theirs[0]!.id);
    expect((await h.api("admin", "GET", `/report-deliveries/${theirs[0]!.id}`)).status).toBe(404);
    expect((await h.api("admin", "GET", "/report-schedules")).body.items.map((s: { id: number }) => s.id)).not.toContain(sched.body.id);
    expect((await h.api("admin", "DELETE", `/report-schedules/${sched.body.id}`)).status).toBe(404);
    // ending a schedule: its owner only, and it runs no more
    expect((await h.api("outsider", "DELETE", `/report-schedules/${sched.body.id}`)).status).toBe(204);
    await job.runOnce(new Date("2026-10-23T09:00:00Z"), otherOrgId);
    expect(((await h.api("outsider", "GET", "/report-deliveries")).body.items as unknown[]).length).toBe(1);
  });
});
