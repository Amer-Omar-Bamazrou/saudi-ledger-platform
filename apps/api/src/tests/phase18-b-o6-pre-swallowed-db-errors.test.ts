/**
 * 🔴 B-O6-PRE (Phase 18, owner 2026-10-24 evening, item 3): the three places
 * that CATCH a database error inside the request's (or the run's) transaction
 * and carry on.
 *
 * A statement error aborts the whole Postgres transaction. Code that catches it
 * and continues issues every later statement into an aborted transaction, and
 * the COMMIT comes back with the tag ROLLBACK without raising — G60's class
 * (`phase18-s1-g60-run-rollback.test.ts`). B-O6 will make that COMMIT an error
 * ("no 2xx after a failed commit, without exceptions"). These three sites
 * swallow on purpose, so each must first keep its transaction usable, or B-O6
 * turns a deliberate "carry on" into a 500:
 *
 *  1. the statement upload WITHOUT a statement block: per-row errors, by design
 *     (`transactions.service.ts` upload);
 *  2. the AI meter: recording never fails the call (`ai/metered.ts` record);
 *  3. the backfill loop: one failure must not strand the run
 *     (`transactionPosting.service.ts` postMany).
 *
 * Each case plants ONE database error in the middle of otherwise good work and
 * asserts the good work before AND after it persists. The planted errors:
 * an impossible calendar date (22008 at the first statement that reads it), a
 * negative token count (`ai_usage_tokens_check`), and an entry number already
 * taken (23505 on `unique(company_id, entry_number)`).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3227";
process.env.SESSION_SECRET ??= "phase18-b-o6-pre-swallowed-db-errors-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { withSavepoint } from "../lib/savepoint";
import { __resetRateLimitsForTests } from "../routes/auth";
import { auditService } from "../services/audit.service";
import { meteredChat } from "../services/ai/metered";
import type { AiProvider } from "../services/ai/provider";
import { transactionPostingService } from "../services/transactionPosting.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "BO6PreSwallowedDbErrorsPw1!";

describeMaybe("B-O6-PRE — a database error caught inside a transaction leaves the rest of the work saved", () => {
  const h = g04Harness("p18bo6pre");
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let bankAccountId = 0;
  let expenseAccount = 0;

  const descriptionsOnBank = async (prefix: string) =>
    (await pool.query(
      `SELECT description FROM transactions WHERE organization_id = $1 AND bank_account_id = $2 AND description LIKE $3 ORDER BY description`,
      [orgId, bankAccountId, `${prefix}%`],
    )).rows.map((r) => r.description as string);

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "B-O6-PRE Co", "318181818181895");
    userId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "B-O6-PRE Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankAccountId = Number(bank.body.id);
    expenseAccount = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'OFFICE_SUPPLIES'`, [orgId])).rows[0].id);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  describe("1. the upload without a statement block reports a bad row and keeps the good ones", () => {
    const row = (description: string, date: string) => ({ date, description, amount: 115, currency: "SAR", type: "debit" });

    it("🔴 a bad row BETWEEN good rows: both good rows are imported, the bad one is named", async () => {
      const res = await h.api("admin", "POST", "/transactions/upload", {
        bankAccountId,
        autoCategrize: false,
        rows: [row("BO6PRE-A first good", "2026-09-01"), row("BO6PRE-A impossible date", "2026-02-31"), row("BO6PRE-A third good", "2026-09-03")],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect([res.body.inserted, res.body.errors.length], "two imported, one named").toEqual([2, 1]);
      expect(res.body.errors[0], "the bad row, and only it").toMatch(/^Row "BO6PRE-A impossible date" could not be imported/);
      expect(await descriptionsOnBank("BO6PRE-A"), "what the response reports is what the database holds").toEqual(["BO6PRE-A first good", "BO6PRE-A third good"]);
    });

    it("🔴 a bad row FIRST: the good row after it is imported, and only the bad one is named", async () => {
      const res = await h.api("admin", "POST", "/transactions/upload", {
        bankAccountId,
        autoCategrize: false,
        rows: [row("BO6PRE-B impossible date", "2026-02-30"), row("BO6PRE-B good", "2026-09-04")],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect([res.body.inserted, res.body.errors.length]).toEqual([1, 1]);
      expect(res.body.errors[0]).toMatch(/^Row "BO6PRE-B impossible date" could not be imported/);
      expect(await descriptionsOnBank("BO6PRE-B")).toEqual(["BO6PRE-B good"]);
    });
  });

  describe("2. a failed meter row loses only itself", () => {
    const provider = (promptTokens: number): AiProvider => ({
      name: "b-o6-pre-fake",
      chat: async () => ({ text: "fake completion", model: "fake-model", provider: "b-o6-pre-fake", promptTokens, completionTokens: 1, latencyMs: 1 }),
      vision: async () => {
        throw new Error("not used");
      },
    });

    it("🔴 the request's own write before the failed meter row, and a later meter row, are both saved; the completion is returned", async () => {
      const text = await h.inTenant(orgId, companyId, userId, async () => {
        await auditService.record({ action: "create", entityType: "b_o6_pre_probe", entityId: "before-the-meter" });
        // `ai_usage_tokens_check` refuses a negative count: the meter insert fails.
        const out = await meteredChat(provider(-1), "b-o6-pre-meter-refused", { prompt: "x", maxTokens: 5 });
        await meteredChat(provider(3), "b-o6-pre-meter-ok", { prompt: "x", maxTokens: 5 });
        return out.text;
      });
      expect(text, "the caller still has its completion").toBe("fake completion");
      const audit = await pool.query(`SELECT entity_id FROM audit_logs WHERE organization_id = $1 AND entity_type = 'b_o6_pre_probe'`, [orgId]);
      expect(audit.rows.map((r) => r.entity_id), "the request's own write survived the failed meter row").toEqual(["before-the-meter"]);
      const meter = await pool.query(`SELECT operation, prompt_tokens FROM ai_usage WHERE organization_id = $1 AND operation LIKE 'b-o6-pre-meter-%' ORDER BY id`, [orgId]);
      expect(meter.rows, "the refused row is absent, the later one present").toEqual([{ operation: "b-o6-pre-meter-ok", prompt_tokens: 3 }]);
    });

    it("🔴 meter rows recorded AT ONCE in one transaction (as /llm/compare does), one refused: the others and the request's write are saved", async () => {
      const settled = await h.inTenant(orgId, companyId, userId, async () => {
        await auditService.record({ action: "create", entityType: "b_o6_pre_probe", entityId: "before-concurrent-meters" });
        return Promise.allSettled([1, 2, -1, 4, 5].map((tokens) => meteredChat(provider(tokens), `b-o6-pre-concurrent-${tokens}`, { prompt: "x", maxTokens: 5 })));
      });
      expect(settled.map((s) => s.status), "every completion returned").toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
      const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE organization_id = $1 AND entity_type = 'b_o6_pre_probe' AND entity_id = 'before-concurrent-meters'`, [orgId]);
      expect(audit.rowCount, "the request's own write").toBe(1);
      const meter = await pool.query(`SELECT prompt_tokens FROM ai_usage WHERE organization_id = $1 AND operation LIKE 'b-o6-pre-concurrent-%' ORDER BY prompt_tokens`, [orgId]);
      expect(meter.rows.map((r) => r.prompt_tokens), "four rows; the refused one absent").toEqual([1, 2, 4, 5]);
    });

    it("🔴 the MODEL calls still run side by side; only the meter's database write takes turns (/llm/compare's shape, owner 2026-10-26 A3)", async () => {
      // llm.controller.ts compare: Promise.all over the items → categorizeWithLlm →
      // meteredChat. The turn-taking is inside record() (the meter's insert), after
      // provider.chat() has returned, so the model calls must still overlap.
      const N = 5;
      const DELAY_MS = 150;
      let inFlight = 0;
      let mostAtOnce = 0;
      const slow: AiProvider = {
        name: "b-o6-pre-slow",
        chat: async () => {
          inFlight += 1;
          mostAtOnce = Math.max(mostAtOnce, inFlight);
          await new Promise((r) => setTimeout(r, DELAY_MS));
          inFlight -= 1;
          return { text: "slow completion", model: "fake-model", provider: "b-o6-pre-slow", promptTokens: 1, completionTokens: 1, latencyMs: DELAY_MS };
        },
        vision: async () => {
          throw new Error("not used");
        },
      };
      const started = Date.now();
      const settled = await h.inTenant(orgId, companyId, userId, () =>
        Promise.allSettled(Array.from({ length: N }, (_, i) => meteredChat(slow, `b-o6-pre-parallel-${i}`, { prompt: "x", maxTokens: 5 }))),
      );
      const elapsedMs = Date.now() - started;
      expect(settled.map((s) => s.status)).toEqual(Array(N).fill("fulfilled"));
      expect(mostAtOnce, "all the model calls were in flight at the same time").toBe(N);
      expect(elapsedMs, `${elapsedMs} ms against ${N * DELAY_MS} ms for the calls one after another`).toBeLessThan(N * DELAY_MS * 0.6);
      const meter = await pool.query(`SELECT count(*)::int AS n FROM ai_usage WHERE organization_id = $1 AND operation LIKE 'b-o6-pre-parallel-%'`, [orgId]);
      expect(meter.rows[0].n, "every call metered").toBe(N);
    });

    it("outside any transaction (the findings explain pass calls its model there), the completion is still returned", async () => {
      const out = await meteredChat(provider(2), "b-o6-pre-outside-a-transaction", { prompt: "x", maxTokens: 5 });
      expect(out.text).toBe("fake completion");
    });
  });

  describe("savepoint scopes opened side by side in one transaction take turns", () => {
    const probe = (entityId: string) => auditService.record({ action: "create", entityType: "b_o6_pre_scope", entityId });
    const saved = async (prefix: string) =>
      (await pool.query(
        `SELECT entity_id FROM audit_logs WHERE organization_id = $1 AND entity_type = 'b_o6_pre_scope' AND entity_id LIKE $2 ORDER BY entity_id`,
        [orgId, `${prefix}%`],
      )).rows.map((r) => r.entity_id as string);
    // A statement error inside OUR transaction — the thing a savepoint exists to undo.
    const failInsideTheTransaction = () => db.execute(sql`SELECT 1/0`);

    it("🔴 five sibling scopes at once, one failing: four saved, the failure returned as a value, nothing thrown", async () => {
      // allSettled, not all: every sibling finishes before the transaction ends.
      // With `all`, the first rejection ended it while siblings were still issuing
      // statements, and those landed on the released connection.
      const settled = await h.inTenant(orgId, companyId, userId, () =>
        Promise.allSettled(["s1", "s2", "s3-fails", "s4", "s5"].map((id) =>
          withSavepoint(async () => {
            await probe(id);
            await new Promise((r) => setTimeout(r, 5)); // siblings reach the connection in between
            if (id.endsWith("fails")) await failInsideTheTransaction();
            return id;
          }),
        )),
      );
      const thrown = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason));
      expect(thrown, "no scope threw").toEqual([]);
      expect(settled.map((s) => (s as PromiseFulfilledResult<{ ok: boolean }>).value.ok)).toEqual([true, true, false, true, true]);
      expect(await saved("s"), "the failed scope's own write undone, the others kept").toEqual(["s1", "s2", "s4", "s5"]);
    });

    it("a scope opened inside an item nests in it (it does not wait for the item), and its failure undoes only itself", async () => {
      const outcome = await h.inTenant(orgId, companyId, userId, () =>
        withSavepoint(async () => {
          await probe("n-outer");
          const inner = await withSavepoint(async () => {
            await probe("n-inner-fails");
            await failInsideTheTransaction();
          });
          const after = await withSavepoint(() => probe("n-inner-after"));
          return [inner.ok, after.ok];
        }),
      );
      expect(outcome).toEqual({ ok: true, value: [false, true] });
      expect(await saved("n-")).toEqual(["n-inner-after", "n-outer"]);
    });
  });

  describe("3. one failed item of the backfill does not take the others with it", () => {
    const acceptedRow = async (description: string) =>
      Number((await pool.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, currency, type, category_id, review_status, kind, bank_account_id)
         VALUES ($1, $2, '2026-09-10', $3, 230, 'SAR', 'debit', $4, 'accepted', 'operating', $5) RETURNING id`,
        [orgId, companyId, description, expenseAccount, bankAccountId],
      )).rows[0].id);

    it("🔴 the items before and after a failed item are posted and linked; the failed one is reported", async () => {
      const first = await acceptedRow("BO6PRE-C first");
      const taken = await acceptedRow("BO6PRE-C entry number taken");
      const last = await acceptedRow("BO6PRE-C last");
      // The number `post()` will choose for `taken` (one prior entry → "-P1") is already used by a draft.
      await pool.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1, $2, $3, '2026-09-10', 'B-O6-PRE planted', 'draft')`,
        [orgId, companyId, `TXN-${taken}-P1`],
      );

      const result = await h.inTenant(orgId, companyId, userId, () => transactionPostingService.postMany([first, taken, last]));
      expect([result.posted, result.failed.map((f) => f.id)], "two posted, the one with the taken number failed").toEqual([2, [taken]]);

      const linked = await pool.query(
        `SELECT t.id, je.status FROM transactions t LEFT JOIN journal_entries je ON je.id = t.journal_entry_id WHERE t.id = ANY($1::int[]) ORDER BY t.id`,
        [[first, taken, last]],
      );
      expect(linked.rows, "what the run reported is what the database holds").toEqual([
        { id: first, status: "posted" },
        { id: taken, status: null },
        { id: last, status: "posted" },
      ]);
    });
  });
});
