/**
 * B1 — email delivery actually happens, and reaches the right humans.
 *
 * The queue entry said B1 was "implement `send` and swap the export; nothing
 * else changes". That was wrong in a way this suite pins: the renewal reminder
 * addressed `zatca-admin+<companyId>@invalid.local`, a placeholder that can
 * never receive mail. A working provider behind a placeholder recipient is
 * still an alarm that reaches nobody — so recipients are asserted here, not
 * just delivery.
 *
 * The provider implementations are driven over a FAKE FETCH rather than a real
 * network, the same way the outbox transport is driven over a fake socket: the
 * claim is about what we send and how we handle the response, not about
 * Resend's uptime.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import {
  resendMailer,
  postmarkMailer,
  noopMailer,
  __setMailerForTests,
  type MailMessage,
} from "../lib/mailer";
import { membersRepository } from "../repositories/members.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");

describe("B1 — mail providers (no network)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("resend posts the message and reports delivered", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      calls.push({ url: String(u), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await resendMailer("key_123", "Ledger <no-reply@example.com>").send({
      to: "admin@tenant.example",
      subject: "S",
      text: "T",
    });

    expect(r.delivered).toBe(true);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].headers.Authorization).toBe("Bearer key_123");
    expect(calls[0].body).toMatchObject({ from: "Ledger <no-reply@example.com>", to: ["admin@tenant.example"], subject: "S", text: "T" });
  });

  it("postmark posts the message with its token header", async () => {
    const calls: any[] = [];
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      calls.push({ url: String(u), headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await postmarkMailer("tok_9", "no-reply@example.com").send({ to: "a@b.co", subject: "S", text: "T" });
    expect(r.delivered).toBe(true);
    expect(calls[0].url).toBe("https://api.postmarkapp.com/email");
    expect(calls[0].headers["X-Postmark-Server-Token"]).toBe("tok_9");
    expect(calls[0].body).toMatchObject({ From: "no-reply@example.com", To: "a@b.co", TextBody: "T" });
  });

  it("🔴 a provider rejection or a network failure NEVER throws — it reports undelivered", async () => {
    // The callers have already committed state (a reminder row, an invitation).
    // Throwing here would turn a recorded-but-unsent alarm into a failed job.
    globalThis.fetch = (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    expect(await resendMailer("k", "f@x.co").send({ to: "a@b.co", subject: "s", text: "t" })).toEqual({ delivered: false });

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await postmarkMailer("k", "f@x.co").send({ to: "a@b.co", subject: "s", text: "t" })).toEqual({ delivered: false });
  });

  it("the no-op reports undelivered so callers surface the link instead of implying an email", async () => {
    expect(await noopMailer.send({ to: "a@b.co", subject: "s", text: "t" })).toEqual({ delivered: false });
  });
});

const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[mailer-delivery] no real DATABASE_URL — skipping recipient tests.");

describeMaybe("B1 — the renewal reminder reaches the organization's admins", () => {
  const SLUG = "b1-recipients";
  const ADMIN = "b1-admin@test.local";
  const REMOVED = "b1-removed@test.local";
  const BOOKKEEPER = "b1-bookkeeper@test.local";
  let orgId = "";

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM organization_memberships WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email IN ('${ADMIN}','${REMOVED}','${BOOKKEEPER}')`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1 Org','${SLUG}') RETURNING id`)).rows[0].id;
    const mk = async (email: string, role: string, status: string, isActive = true) => {
      const uid = (
        await pool.query(
          `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'B1',' ','viewer',$2) RETURNING id`,
          [email, isActive],
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,$4)`,
        [uid, orgId, role, status],
      );
    };
    await mk(ADMIN, "admin", "active");
    await mk(REMOVED, "admin", "inactive"); // removed admin — must NOT be mailed
    await mk(BOOKKEEPER, "bookkeeper", "active"); // cannot perform the renewal
  });

  afterAll(cleanup);

  it("🔴 resolves ACTIVE ADMINS only — not removed admins, not non-admins", async () => {
    const emails = await membersRepository.activeAdminEmails(orgId);
    expect(emails).toEqual([ADMIN]);
    expect(emails).not.toContain(REMOVED); // mailing a removed employee is useless and a small leak
    expect(emails).not.toContain(BOOKKEEPER); // renewal needs an admin's Fatoora OTP
  });

  it("an organization with no active admin resolves to nobody rather than to a placeholder", async () => {
    const empty = (
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1 Empty','${SLUG}-empty') RETURNING id`)
    ).rows[0].id;
    expect(await membersRepository.activeAdminEmails(empty)).toEqual([]);
    await pool.query(`DELETE FROM categories WHERE organization_id = $1`, [empty]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [empty]);
  });

  it("the application mailer is swappable for tests and records what it was asked to send", async () => {
    const sent: MailMessage[] = [];
    __setMailerForTests({
      async send(m) {
        sent.push(m);
        return { delivered: true };
      },
    });
    const { mailer } = await import("../lib/mailer");
    await mailer.send({ to: "x@y.co", subject: "s", text: "t" });
    expect(sent).toHaveLength(1);
    __setMailerForTests(null);
  });
});
