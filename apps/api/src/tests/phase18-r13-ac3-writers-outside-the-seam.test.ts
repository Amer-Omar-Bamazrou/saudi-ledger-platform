/**
 * 🔴 Phase 18 R-13 — AC-3 (owner, 2026-11-01, memo §3; register §11.120): every writer of journal entries OUTSIDE
 * the posting seam, called through its ACTUAL path against sl_test, and the database guards refusing what they should
 * — G16 (the posted-journal freeze), T1d's CHECKs and approver trigger, T1e's period lock — where they apply.
 *
 *  W1 `journalEntriesService.create`              → insertEntry (a draft header) + insertLines
 *  W2 the manual journal's approval (the engine)  → updateEntryIfStatus: the approver, then the draft → posted flip
 *  W3 `journalEntriesService.reverse`             → the mirror (insertEntry, insertLines, its flip) + the original → reversed
 *  W4 a draft's removal (`deleteDraft`, `reject`) → removeIfStatus(id, "draft")
 *  W5 `migrationCommitService.reverse`            → migrationRepository.markJournalReversed (the opening journal)
 *
 * Each writer runs in a real tenant transaction as the request runs it (`h.inTenant`, which commits, so G16's
 * deferred checks run). Where the writer's path never produces the refused state, the writer's OWN repository call is
 * made without the step its path adds — the database path, not a helper. Routing these writers through the seam is
 * deferred to its own milestone (§11.120 gives the reason).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3225";
process.env.SESSION_SECRET ??= "r13-ac3-writers-outside-the-seam-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { journalEntriesService } from "../services/journalEntries.service";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { migrationRepository } from "../repositories/migration.repository";
import { periodLocksService } from "../services/periodLocks.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R13WritersPw123!";

describeMaybe("Phase 18 R-13 (AC-3) — the writers outside the posting seam, and the guards that hold them", () => {
  const h = g04Harness("r13writers");
  let orgId = "";
  let co = "";
  let coM1 = "";
  let coM2 = "";
  let U = 0;
  let expense = 0;
  let income = 0;
  let seq = 0;
  const run = <T,>(fn: () => Promise<T>, company = co) => h.inTenant(orgId, company, U, fn);
  /** The refusal a call ends in (its database constraint when it has one), or null when it went through. */
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: any) => {
    const c = e?.cause ?? e;
    return { status: e?.statusCode as number | undefined, constraint: (c?.constraint ?? e?.constraint ?? e?.payload?.constraint) as string | undefined, message: String(c?.message ?? e?.message ?? e) };
  });
  const row = async (id: number) => (await pool.query(`SELECT status, approved_by, source_type, source_id, reversal_of, description FROM journal_entries WHERE id = $1`, [id])).rows[0];
  const draft = (date = "2026-10-05") => run(async () => (await journalEntriesService.create({ entryNumber: `R13-${++seq}`, date, description: `R-13 ${seq}`, lines: [
    { accountId: expense, accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 },
    { accountId: income, accountName: "Other Income", debitAmount: 0, creditAmount: 100 },
  ] }, U) as { id: number }).id);
  const posted = async (date = "2026-10-05") => { const id = await draft(date); await run(() => journalEntriesService.approve(id, U)); return id; };
  const header = (extra: Record<string, unknown>) => ({ entryNumber: `R13-H-${++seq}`, date: "2026-10-05", description: "R-13 header", status: "draft", postedAt: null, createdBy: U, ...extra });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    co = await h.mkCompany(orgId, "R13 Co", "319191919197003");
    coM1 = await h.mkCompany(orgId, "R13 M1", "319191919197103");
    coM2 = await h.mkCompany(orgId, "R13 M2", "319191919197203");
    U = await h.mkUser("admin", PW, orgId, "admin");
    const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    expense = await cat("OTHER_EXPENSES");
    income = await cat("OTHER_INCOME");
  }, 180_000);
  afterAll(async () => { await h.cleanup(); });

  describe("W1 — journalEntriesService.create (a draft header and its lines)", () => {
    it("G16 T2: the path writes a header only as a draft; the database refuses a header inserted as posted", async () => {
      expect((await row(await draft())).status).toBe("draft");
      const r = await refusal(run(() => journalEntriesRepository.insertEntry(header({ status: "posted", postedAt: new Date(), sourceType: "manual" }) as never)));
      expect(r, "a header inserted as posted").not.toBeNull();
    });
    it("T1d CHECK: a typed system-shaped number is refused by the path, and by the database through the path's own insert", async () => {
      const viaPath = await refusal(run(() => journalEntriesService.create({ entryNumber: "BILL-77", date: "2026-10-05", description: "typed", lines: [
        { accountId: expense, accountName: "Other Expenses", debitAmount: 1, creditAmount: 0 },
        { accountId: income, accountName: "Other Income", debitAmount: 0, creditAmount: 1 },
      ] }, U)));
      expect(viaPath, "the service refuses it").not.toBeNull();
      const viaDb = await refusal(run(() => journalEntriesRepository.insertEntry(header({ entryNumber: "BILL-77", sourceType: "manual" }) as never)));
      expect(viaDb?.constraint).toBe("journal_entries_manual_number_reserved_chk");
    });
    it("T1d CHECK: a manual entry carries no source id", async () => {
      const r = await refusal(run(() => journalEntriesRepository.insertEntry(header({ sourceType: "manual", sourceId: 5 }) as never)));
      expect(r?.constraint).toBe("journal_entries_source_id_chk");
    });
    it("T1e: a draft dated in a closed month is refused by the path at creation (423), nothing written; the database's own guard fires at posting (W2)", async () => {
      await run(() => periodLocksService.lock({ period: "2026-06", userId: U } as never));
      const before = Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
      const r = await refusal(draft("2026-06-10"));
      expect(r?.status).toBe(423);
      expect(Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(before);
    });
  });

  describe("W2 — the manual journal's approval (the approver, then the flip)", () => {
    it("the path records the approver, then posts", async () => {
      const id = await posted();
      expect(await row(id)).toMatchObject({ status: "posted", approved_by: U });
    });
    it("🔴 T1d approver trigger: the path's own flip, without the approver step it adds first, is refused", async () => {
      const id = await draft();
      const r = await refusal(run(() => journalEntriesRepository.updateEntryIfStatus(id, "draft", { status: "posted", postedAt: new Date() })));
      expect(r?.constraint).toBe("journal_entry_posted_without_approver");
      expect((await row(id)).status).toBe("draft");
    });
    it("🔴 T1e: an approval into a closed month is refused, and the draft stays a draft", async () => {
      const id = await draft("2026-07-15");
      await run(() => periodLocksService.lock({ period: "2026-07", userId: U } as never));
      const r = await refusal(run(() => journalEntriesService.approve(id, U)));
      expect(r, "refused").not.toBeNull();
      expect(r!.status === 423 || r!.constraint === "journal_entry_period_closed", JSON.stringify(r)).toBe(true);
      expect((await row(id)).status).toBe("draft");
    });
    it("🔴 T1e at the database: the path's own flip into a closed month (its approver written first) is refused by the period guard", async () => {
      const id = await draft("2026-05-15");
      await run(() => periodLocksService.lock({ period: "2026-05", userId: U } as never));
      const r = await refusal(run(async () => {
        await journalEntriesRepository.updateEntryIfStatus(id, "draft", { approvedBy: U });
        return journalEntriesRepository.updateEntryIfStatus(id, "draft", { status: "posted", postedAt: new Date() });
      }));
      expect(r?.constraint).toBe("journal_entry_period_closed");
      expect((await row(id)).status).toBe("draft");
    });
    it("🔴 G16 T3: a draft whose stored lines no longer balance — refused by the path (422), and by G16 at commit when the path's own flip skips that check", async () => {
      const id = await draft();
      await pool.query(`UPDATE journal_entry_lines SET debit_amount = 999 WHERE journal_entry_id = $1 AND debit_amount > 0`, [id]);
      const viaPath = await refusal(run(() => journalEntriesService.approve(id, U)));
      expect(viaPath?.status, "the approval's own balance check").toBe(422);
      const viaFlip = await refusal(run(async () => {
        await journalEntriesRepository.updateEntryIfStatus(id, "draft", { approvedBy: U });
        return journalEntriesRepository.updateEntryIfStatus(id, "draft", { status: "posted", postedAt: new Date() });
      }));
      expect(viaFlip, "G16 refuses an unbalanced flip at commit").not.toBeNull();
      expect(viaFlip!.status, "a database refusal, not the service's").toBeUndefined();
      expect((await row(id)).status).toBe("draft");
    });
    it("🔴 G16: once posted, a change through the writer's own update is refused at commit", async () => {
      const id = await posted();
      const r = await refusal(run(() => journalEntriesRepository.updateEntry(id, { description: "changed after posting" })));
      expect(r, "refused").not.toBeNull();
      expect((await row(id)).description).not.toBe("changed after posting");
    });
  });

  describe("W3 — journalEntriesService.reverse (the mirror, and the original)", () => {
    it("the path writes a mirror sourced from the original (T1d) and marks the original reversed", async () => {
      const id = await posted();
      const out = await run(() => journalEntriesService.reverse(id, { reason: "R-13" })) as { reversalId: number };
      expect(await row(out.reversalId)).toMatchObject({ status: "posted", source_type: "reversal", source_id: id, reversal_of: id });
      expect((await row(id)).status).toBe("reversed");
    });
    it("🔴 T1e: a reversal dated in a closed month is refused, nothing written", async () => {
      const id = await posted("2026-08-10");
      await run(() => periodLocksService.lock({ period: "2026-09", userId: U } as never));
      const before = Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
      const r = await refusal(run(() => journalEntriesService.reverse(id, { reason: "R-13", date: "2026-09-15" })));
      expect(r?.status).toBe(423);
      expect(Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(before);
      expect((await row(id)).status).toBe("posted");
    });
    it("🔴 G16 T5: the original turned reversed by the path's own update, with no posted mirror, is refused at commit", async () => {
      const id = await posted();
      const r = await refusal(run(() => journalEntriesRepository.updateEntry(id, { status: "reversed" })));
      expect(r, "refused").not.toBeNull();
      expect((await row(id)).status).toBe("posted");
    });
    it("🔴 T1d CHECK: a reversal header with no source id is refused", async () => {
      const r = await refusal(run(() => journalEntriesRepository.insertEntry(header({ sourceType: "reversal", sourceId: null }) as never)));
      expect(r?.constraint).toBe("journal_entries_source_id_chk");
    });
  });

  describe("W4 — a draft's removal (deleteDraft, reject)", () => {
    it("the path removes a draft and its lines", async () => {
      const id = await draft();
      await run(() => journalEntriesService.deleteDraft(id));
      expect(await row(id)).toBeUndefined();
      const id2 = await draft();
      await run(() => journalEntriesService.reject(id2, U));
      expect(await row(id2)).toBeUndefined();
    });
    it("🔴 G16: a posted entry is refused by the path, and its delete through the repository is refused at commit", async () => {
      const id = await posted();
      expect((await refusal(run(() => journalEntriesService.deleteDraft(id))))?.status).toBe(409);
      const r = await refusal(run(() => journalEntriesRepository.remove(id)));
      expect(r, "refused").not.toBeNull();
      expect((await row(id)).status).toBe("posted");
    });
  });

  describe("W5 — the migration's reversal (the opening journal marked reversed)", () => {
    const commit = async (company: string, capital: string) => {
      const r = <T,>(fn: () => Promise<T>) => run(fn, company);
      const bank = (await r(() => bankAccountsService.create({ name: `R13 Mig ${++seq}`, bankName: "SNB", currency: "SAR" }))).id as number;
      const b = await r(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" } as never, U)) as { id: number };
      await r(() => migrationService.importChart(b.id, { rows: [
        { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 900, sourceRole: "bank", evidenceNote: "Statement at the opening date" },
        { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 100, sourceRole: "receivable" },
        { sourceCode: capital, sourceName: `Capital ${capital}`, sourceType: "equity", openingCredit: 1000 },
      ] } as never, U));
      const chart = await r(() => migrationService.getChart(b.id)) as { rows: Array<{ id: number; sourceCode: string }> };
      const rowOf = (c: string) => chart.rows.find((x) => x.sourceCode === c)!.id;
      await r(() => migrationService.decideChartRow(b.id, rowOf("1100"), { decision: "map_to_bank", targetBankAccountId: bank } as never, U));
      await r(() => migrationService.decideChartRow(b.id, rowOf("1200"), { decision: "map_to_system", targetSystemCode: "AR" } as never, U));
      await r(() => migrationService.decideChartRow(b.id, rowOf(capital), { decision: "create" } as never, U));
      await r(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "customer", sourceId: `C${capital}`, name: `R13 Opening Customer ${capital}` }] } as never, U));
      await r(() => migrationStagingService.importOpenItems(b.id, { rows: [{ itemType: "ar", sourceId: `S${capital}`, partySourceId: `C${capital}`, documentNumber: `INV-R13-${capital}`, issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 100, outstandingAmount: 100 }] } as never, U));
      const val = await r(() => migrationValidationService.validate(b.id, U)) as { ok: boolean; checks: unknown[] };
      expect(val.ok, JSON.stringify(val.checks)).toBe(true);
      await r(() => migrationCommitService.commit(b.id, U));
      const opening = (await pool.query(`SELECT opening_journal_entry_id AS id FROM migration_batches WHERE id = $1`, [b.id])).rows[0].id as number;
      return { batch: b.id, opening };
    };
    it("the path posts the mirror (through the seam) and marks the opening journal reversed", async () => {
      const m = await commit(coM1, "3921");
      await run(() => migrationCommitService.reverse(m.batch, { reason: "the opening was loaded twice" }, U), coM1);
      expect((await row(m.opening)).status).toBe("reversed");
    });
    it("🔴 G16 T5: the path's own mark, with no posted mirror, is refused at commit", async () => {
      const m = await commit(coM2, "3922");
      const r = await refusal(run(() => migrationRepository.markJournalReversed(m.opening), coM2));
      expect(r, "refused").not.toBeNull();
      expect((await row(m.opening)).status).toBe("posted");
    });
  });
});
