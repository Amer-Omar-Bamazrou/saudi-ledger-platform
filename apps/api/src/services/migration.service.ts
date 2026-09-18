/**
 * BATCH 1C — MIGRATION OF AN EXISTING BUSINESS (2026-09-18).
 *
 * Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
 * §15 (the accountant's decisions A1/A2/A3, verified), §15.4 (chart mapping),
 * §15.5 (the model), §15.6 (reconciliation R1–R10 and invariants).
 *
 * Phase 1 (this file's first half): the batch lifecycle and the chart-of-
 * accounts MAPPING LAYER. Saudi Ledger's chart cannot be replaced — services
 * resolve accounts by role (`system_code`) inside the posting seam, there is
 * exactly one AR and one AP control account per organisation (the party is on
 * the line), and cash lives on one D-3 leaf per bank account. So every old
 * account carries an explicit, audited decision about where its balance
 * lands; nothing is guessed from a name; unmapped rows block the migration.
 *
 * What this service NEVER does: post anything before commit; invent a
 * balancing amount; let an old receivable/payable account become a second
 * control account; land a balance on the CASH header or on
 * OPENING_BALANCE_EQUITY by mapping; skip a row that carries a balance.
 */
import { SYSTEM_ACCOUNTS, MIGRATION_ONLY_SYSTEM_CODES } from "@workspace/db";
import type { MigrationBatch, MigrationChartRow } from "@workspace/db";
import { round2 } from "../lib/money";
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { migrationRepository } from "../repositories/migration.repository";
import { auditService } from "./audit.service";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toFixed(2);

/** The day before, in calendar terms — the opening date is DEFINED, never chosen (pack §5). */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export type ChartRowInput = {
  sourceCode: string;
  sourceName: string;
  sourceNameAr?: string | null;
  sourceParentCode?: string | null;
  sourceType: "asset" | "liability" | "equity" | "income" | "expense";
  sourceIsGroup?: boolean;
  openingDebit?: number;
  openingCredit?: number;
  sourceRole?: string | null;
  evidenceNote?: string | null;
};

export type ChartDecisionInput = {
  decision: "map_to_system" | "map_to_bank" | "create" | "merge_into" | "skip";
  targetSystemCode?: string | null;
  targetBankAccountId?: number | null;
  targetCategoryId?: number | null;
  skipReason?: string | null;
};

/** Role hints → the ONE deterministic suggestion each admits. A name is never consulted. */
const ROLE_SUGGESTION: Record<string, { decision: "map_to_system"; targetSystemCode: string }> = {
  receivable: { decision: "map_to_system", targetSystemCode: SYSTEM_ACCOUNTS.AR },
  payable: { decision: "map_to_system", targetSystemCode: SYSTEM_ACCOUNTS.AP },
  vat_output: { decision: "map_to_system", targetSystemCode: SYSTEM_ACCOUNTS.VAT_OUTPUT },
  vat_input: { decision: "map_to_system", targetSystemCode: SYSTEM_ACCOUNTS.VAT_INPUT },
  retained_earnings: { decision: "map_to_system", targetSystemCode: SYSTEM_ACCOUNTS.RETAINED_EARNINGS },
  customer_deposits: { decision: "map_to_system", targetSystemCode: SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS },
};
/** A bank/cash role hint suggests the KIND of decision; which bank is the operator's. */
const ROLE_KIND: Record<string, "map_to_bank"> = { bank: "map_to_bank", cash: "map_to_bank" };

/** The system codes an old CONTROL account may map to — and nothing else. */
const CONTROL_ROLE_TARGET: Record<string, string> = { receivable: SYSTEM_ACCOUNTS.AR, payable: SYSTEM_ACCOUNTS.AP };

/** System accounts a mapping may name. CASH is a header; OPENING_BALANCE_EQUITY is the balancing side, never a target. */
function mappableSystemCodes(): Set<string> {
  return new Set(Object.values(SYSTEM_ACCOUNTS).filter((c) => c !== SYSTEM_ACCOUNTS.CASH && !MIGRATION_ONLY_SYSTEM_CODES.includes(c)));
}

/** The type a system code has — a mapping across types is refused (an old expense cannot become AR). */
const SYSTEM_TYPE: Record<string, string> = {
  AR: "asset", CASH: "asset", SUSPENSE: "asset", TRANSFER_CLEARING: "asset", TRANSFER_SUSPENSE: "asset", VAT_INPUT: "asset",
  AP: "liability", VAT_OUTPUT: "liability", SALARIES_PAYABLE: "liability", GOSI_PAYABLE: "liability", CUSTOMER_DEPOSITS: "liability", CUSTOMER_CREDITS: "liability",
  EXTERNAL_TRANSFERS: "equity", OPENING_BALANCE_EQUITY: "equity", RETAINED_EARNINGS: "equity",
  SALES: "income",
  PURCHASES: "expense", SALARIES: "expense", GOSI_EXPENSE: "expense",
};

function assertDraft(batch: MigrationBatch) {
  if (batch.status === "committed" || batch.status === "reversed") {
    throw new BusinessRuleError(409, { error: `Migration batch ${batch.id} is ${batch.status} and cannot be changed. A committed migration is corrected by reversal, never by editing.`, code: "migration_batch_immutable", field: "id" });
  }
  if (batch.status === "discarded") {
    throw new BusinessRuleError(409, { error: `Migration batch ${batch.id} was discarded.`, code: "migration_batch_discarded", field: "id" });
  }
}

function toBatchOut(b: MigrationBatch) {
  return {
    id: b.id,
    status: b.status,
    sourceSystem: b.sourceSystem,
    sourceVersion: b.sourceVersion ?? null,
    cutoverDate: b.cutoverDate,
    openingDate: b.openingDate,
    notes: b.notes ?? null,
    contentHash: b.contentHash ?? null,
    openingJournalEntryId: b.openingJournalEntryId ?? null,
    clearingJournalEntryId: b.clearingJournalEntryId ?? null,
    reversalJournalEntryId: b.reversalJournalEntryId ?? null,
    createdBy: b.createdBy ?? null,
    validatedAt: b.validatedAt ? b.validatedAt.toISOString() : null,
    committedBy: b.committedBy ?? null,
    committedAt: b.committedAt ? b.committedAt.toISOString() : null,
    reversedAt: b.reversedAt ? b.reversedAt.toISOString() : null,
    reversalReason: b.reversalReason ?? null,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export type MigrationBatchOut = ReturnType<typeof toBatchOut>;

/** What blocks a row TODAY — computed on read so the wizard and the validator cannot disagree. */
export function chartRowProblems(row: MigrationChartRow, rows: MigrationChartRow[]): string[] {
  const problems: string[] = [];
  const dr = num(row.openingDebit), cr = num(row.openingCredit);
  const hasBalance = Math.abs(dr - cr) > 0.005 || dr > 0.005 || cr > 0.005;
  if (row.sourceIsGroup && hasBalance) problems.push("a group (header) row carries a balance — move it to a posting child in the source file");
  if (row.sourceParentCode && !rows.some((r) => r.sourceCode === row.sourceParentCode)) problems.push(`parent ${row.sourceParentCode} is not in the file`);
  if (!row.decision) problems.push("no mapping decision");
  if (row.decision === "skip" && hasBalance) problems.push("skipped with a non-zero balance");
  if (row.sourceRole && CONTROL_ROLE_TARGET[row.sourceRole] && row.decision && (row.decision !== "map_to_system" || row.targetSystemCode !== CONTROL_ROLE_TARGET[row.sourceRole])) {
    problems.push(`a ${row.sourceRole} account must map to ${CONTROL_ROLE_TARGET[row.sourceRole]}`);
  }
  return problems;
}

function toChartRowOut(row: MigrationChartRow, rows: MigrationChartRow[]) {
  const suggestion = row.sourceRole && ROLE_SUGGESTION[row.sourceRole]
    ? ROLE_SUGGESTION[row.sourceRole]
    : row.sourceRole && ROLE_KIND[row.sourceRole]
      ? { decision: ROLE_KIND[row.sourceRole], targetSystemCode: null }
      : null;
  return {
    id: row.id,
    sourceCode: row.sourceCode,
    sourceName: row.sourceName,
    sourceNameAr: row.sourceNameAr ?? null,
    sourceParentCode: row.sourceParentCode ?? null,
    sourceType: row.sourceType,
    sourceIsGroup: row.sourceIsGroup,
    openingDebit: num(row.openingDebit),
    openingCredit: num(row.openingCredit),
    sourceRole: row.sourceRole ?? null,
    evidenceNote: row.evidenceNote ?? null,
    decision: (row.decision ?? null) as MigrationChartRow["decision"],
    targetSystemCode: row.targetSystemCode ?? null,
    targetBankAccountId: row.targetBankAccountId ?? null,
    targetCategoryId: row.targetCategoryId ?? null,
    skipReason: row.skipReason ?? null,
    resolvedCategoryId: row.resolvedCategoryId ?? null,
    suggestion,
    problems: chartRowProblems(row, rows),
  };
}

function chartSummary(rows: MigrationChartRow[]) {
  const totalDebit = round2(rows.reduce((s, r) => s + num(r.openingDebit), 0));
  const totalCredit = round2(rows.reduce((s, r) => s + num(r.openingCredit), 0));
  const byDecision: Record<string, number> = {};
  for (const r of rows) byDecision[r.decision ?? "unmapped"] = (byDecision[r.decision ?? "unmapped"] ?? 0) + 1;
  const blocked = rows.filter((r) => chartRowProblems(r, rows).length > 0).length;
  return {
    rows: rows.length,
    mapped: rows.filter((r) => r.decision != null).length,
    unmapped: rows.filter((r) => r.decision == null).length,
    blocked,
    totalDebit,
    totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) < 0.005,
    byDecision,
  };
}

export const migrationService = {
  // ── batches ──
  async createBatch(body: { sourceSystem?: string; sourceVersion?: string | null; cutoverDate?: string; notes?: string | null; idempotencyKey?: string | null }, userId: number | null) {
    const sourceSystem = body.sourceSystem?.trim();
    if (!sourceSystem) throw new BadRequestError("sourceSystem is required — name the system the balances come from.");
    if (!body.cutoverDate || !ISO_DATE.test(body.cutoverDate) || Number.isNaN(Date.parse(body.cutoverDate))) throw new BadRequestError("cutoverDate must be YYYY-MM-DD.");
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await migrationRepository.findBatchByIdempotencyKey(idempotencyKey);
      if (existing) return toBatchOut(existing);
    }
    const [live] = await migrationRepository.findLiveBatch();
    if (live) {
      throw new BusinessRuleError(409, { error: `This company already has a committed migration (batch ${live.id}, cutover ${live.cutoverDate}). Reverse it before starting another.`, code: "migration_already_committed", field: "cutoverDate" });
    }
    const [batch] = await migrationRepository.insertBatch({
      status: "draft",
      sourceSystem,
      sourceVersion: body.sourceVersion?.trim() || null,
      cutoverDate: body.cutoverDate,
      openingDate: dayBefore(body.cutoverDate),
      notes: body.notes?.trim() || null,
      idempotencyKey,
      createdBy: userId,
    });
    await auditService.record({ action: "migration_batch_create", entityType: "migration_batch", entityId: batch.id, after: toBatchOut(batch) });
    return toBatchOut(batch);
  },

  async listBatches() {
    return (await migrationRepository.listBatches()).map(toBatchOut);
  },

  async getBatch(id: number) {
    const [batch] = await migrationRepository.findBatch(id);
    if (!batch) throw new NotFoundError("Migration batch not found");
    return { ...toBatchOut(batch), counts: await migrationRepository.counts(id), validation: batch.validation ?? null, reconciliation: batch.reconciliation ?? null };
  },

  async requireBatch(id: number): Promise<MigrationBatch> {
    const [batch] = await migrationRepository.findBatch(id);
    if (!batch) throw new NotFoundError("Migration batch not found");
    return batch;
  },

  async discardBatch(id: number, userId: number | null) {
    const batch = await this.requireBatch(id);
    assertDraft(batch);
    const [updated] = await migrationRepository.updateBatch(id, { status: "discarded" });
    await auditService.record({ action: "migration_batch_discard", entityType: "migration_batch", entityId: id, before: { status: batch.status }, after: { status: "discarded", by: userId } });
    return toBatchOut(updated);
  },

  /** Any staging change re-opens the batch: a validated batch must be validated again before commit. */
  async touch(batch: MigrationBatch) {
    if (batch.status === "validated") await migrationRepository.updateBatch(batch.id, { status: "draft", validatedAt: null, validation: null, contentHash: null });
  },

  // ── chart ──
  async importChart(batchId: number, body: { rows?: ChartRowInput[] | null }, userId: number | null) {
    const batch = await this.requireBatch(batchId);
    assertDraft(batch);
    const rows = body.rows ?? [];
    if (rows.length === 0) throw new BadRequestError("At least one chart row is required.");
    const seen = new Set<string>();
    const values = rows.map((r, i) => {
      const code = String(r.sourceCode ?? "").trim();
      const name = String(r.sourceName ?? "").trim();
      if (!code) throw new BadRequestError(`rows[${i}].sourceCode is required.`);
      if (!name) throw new BadRequestError(`rows[${i}].sourceName is required.`);
      if (seen.has(code)) throw new BadRequestError(`rows[${i}]: account code ${code} appears twice in the file — one row per old account.`);
      seen.add(code);
      if (!["asset", "liability", "equity", "income", "expense"].includes(r.sourceType)) {
        throw new BadRequestError(`rows[${i}] (${code}): sourceType must be asset, liability, equity, income or expense — the file must state it; nothing is inferred from the name.`);
      }
      const dr = round2(num(r.openingDebit)), cr = round2(num(r.openingCredit));
      if (!Number.isFinite(dr) || !Number.isFinite(cr) || dr < 0 || cr < 0) throw new BadRequestError(`rows[${i}] (${code}): balances must be non-negative numbers (a credit balance goes in openingCredit).`);
      if (r.sourceRole && !(r.sourceRole in ROLE_SUGGESTION) && !(r.sourceRole in ROLE_KIND)) throw new BadRequestError(`rows[${i}] (${code}): unknown sourceRole ${r.sourceRole}.`);
      return {
        batchId,
        sourceSystem: batch.sourceSystem,
        sourceCode: code,
        sourceName: name,
        sourceNameAr: r.sourceNameAr?.trim() || null,
        sourceParentCode: r.sourceParentCode?.trim() || null,
        sourceType: r.sourceType,
        sourceIsGroup: !!r.sourceIsGroup,
        sourceCurrency: "SAR",
        openingDebit: fmt(dr),
        openingCredit: fmt(cr),
        sourceRole: r.sourceRole ?? null,
        evidenceNote: r.evidenceNote?.trim() || null,
      };
    });
    // Replacing the chart resets every decision — a decision about a row that no longer exists is meaningless.
    await migrationRepository.deleteChartRows(batchId);
    await migrationRepository.insertChartRows(values);
    await this.touch(batch);
    await auditService.record({ action: "migration_chart_import", entityType: "migration_batch", entityId: batchId, after: { rows: values.length, by: userId } });
    return this.getChart(batchId);
  },

  async getChart(batchId: number) {
    await this.requireBatch(batchId);
    const rows = await migrationRepository.chartRows(batchId);
    return { batchId, rows: rows.map((r) => toChartRowOut(r, rows)), summary: chartSummary(rows) };
  },

  async decideChartRow(batchId: number, rowId: number, body: ChartDecisionInput, userId: number | null) {
    const batch = await this.requireBatch(batchId);
    assertDraft(batch);
    const [row] = await migrationRepository.findChartRow(batchId, rowId);
    if (!row) throw new NotFoundError("Chart row not found in this batch");
    const rows = await migrationRepository.chartRows(batchId);
    const dr = num(row.openingDebit), cr = num(row.openingCredit);
    const hasBalance = dr > 0.005 || cr > 0.005;
    const refuse = (error: string, code = "mapping_target_refused") => { throw new BusinessRuleError(422, { error, code, field: "decision" }); };

    const values: Partial<typeof row> = { decision: body.decision, targetSystemCode: null, targetBankAccountId: null, targetCategoryId: null, skipReason: null, decidedBy: userId, decidedAt: new Date() };

    if (row.sourceIsGroup && hasBalance) refuse(`${row.sourceCode} is a group row with a balance of ${fmt(dr - cr)}; a header cannot carry a balance here — move it to a posting child in the source file.`);

    switch (body.decision) {
      case "map_to_system": {
        const code = body.targetSystemCode?.trim();
        if (!code) throw new BadRequestError("map_to_system needs targetSystemCode.");
        if (!mappableSystemCodes().has(code)) {
          if (MIGRATION_ONLY_SYSTEM_CODES.includes(code)) refuse(`${code} is the migration's balancing account and is never a mapping target — the opening journal derives it.`);
          if (code === SYSTEM_ACCOUNTS.CASH) refuse(`CASH is a non-posting header; map a bank or cash account to its own bank (map_to_bank).`);
          refuse(`${code} is not a system account of this platform.`);
        }
        if (row.sourceRole && CONTROL_ROLE_TARGET[row.sourceRole] && CONTROL_ROLE_TARGET[row.sourceRole] !== code) {
          refuse(`${row.sourceCode} is a ${row.sourceRole} account and must map to ${CONTROL_ROLE_TARGET[row.sourceRole]} — every old control account lands on the one control account, with the party on each line.`);
        }
        if (SYSTEM_TYPE[code] && SYSTEM_TYPE[code] !== row.sourceType) {
          refuse(`${row.sourceCode} is ${row.sourceType} but ${code} is ${SYSTEM_TYPE[code]} — a balance does not change nature by mapping.`);
        }
        if (row.sourceIsGroup) refuse(`${row.sourceCode} is a group row; only posting accounts map to a system account.`);
        const [cat] = await migrationRepository.findSystemCategory(code);
        if (!cat) throw new BusinessRuleError(422, { error: `System account ${code} is not seeded for this organisation.`, code: "reference_not_found", field: "targetSystemCode" });
        values.targetSystemCode = code;
        break;
      }
      case "map_to_bank": {
        const bankId = Number(body.targetBankAccountId);
        if (!Number.isInteger(bankId) || bankId <= 0) throw new BadRequestError("map_to_bank needs targetBankAccountId.");
        if (row.sourceType !== "asset") refuse(`${row.sourceCode} is ${row.sourceType}; only an asset account maps to a bank.`);
        if (row.sourceRole && CONTROL_ROLE_TARGET[row.sourceRole]) refuse(`${row.sourceCode} is a ${row.sourceRole} account and cannot map to a bank.`);
        const [bank] = await migrationRepository.findBankAccount(bankId);
        // RLS hides another tenant's bank; the company arm is checked explicitly (banks are company-scoped).
        if (!bank || bank.companyId !== batch.companyId) throw new BusinessRuleError(422, { error: `Bank account ${bankId} does not exist for this company.`, code: "reference_not_found", field: "targetBankAccountId" });
        if (!bank.isActive) refuse(`Bank account ${bank.name} is inactive.`);
        const [leaf] = await migrationRepository.bankLeaf(bankId);
        if (!leaf) throw new BusinessRuleError(422, { error: `Bank account ${bank.name} has no GL cash account (D-3 leaf).`, code: "reference_not_found", field: "targetBankAccountId" });
        if (rows.some((r) => r.id !== row.id && r.decision === "map_to_bank" && r.targetBankAccountId === bankId)) {
          refuse(`Bank account ${bank.name} is already the target of another row; one old account per bank — merge them in the source file if they are one account.`);
        }
        values.targetBankAccountId = bankId;
        break;
      }
      case "create": {
        if (row.sourceRole && CONTROL_ROLE_TARGET[row.sourceRole]) refuse(`${row.sourceCode} is a ${row.sourceRole} account; it maps to ${CONTROL_ROLE_TARGET[row.sourceRole]}, it is not created.`);
        if (body.targetCategoryId != null) {
          const [parent] = await migrationRepository.findCategory(Number(body.targetCategoryId));
          if (!parent) throw new BusinessRuleError(422, { error: `Parent category ${body.targetCategoryId} does not exist.`, code: "reference_not_found", field: "targetCategoryId" });
          if (parent.isPosting) refuse(`${parent.name} is a posting account, not a header — a created account needs a header parent (or none).`);
          if (parent.type !== row.sourceType) refuse(`${parent.name} is ${parent.type}; ${row.sourceCode} is ${row.sourceType}.`);
          values.targetCategoryId = parent.id;
        }
        break;
      }
      case "merge_into": {
        const catId = Number(body.targetCategoryId);
        if (!Number.isInteger(catId) || catId <= 0) throw new BadRequestError("merge_into needs targetCategoryId.");
        const [cat] = await migrationRepository.findCategory(catId);
        if (!cat) throw new BusinessRuleError(422, { error: `Category ${catId} does not exist.`, code: "reference_not_found", field: "targetCategoryId" });
        if (cat.isSystem) refuse(`${cat.name} is a system account — use map_to_system${cat.systemCode ? ` (${cat.systemCode})` : ""}.`);
        if (!cat.isPosting) refuse(`${cat.name} is a header; a balance merges only into a posting account.`);
        if (cat.type !== row.sourceType) refuse(`${cat.name} is ${cat.type}; ${row.sourceCode} is ${row.sourceType}.`);
        if (row.sourceIsGroup) refuse(`${row.sourceCode} is a group row; only posting accounts merge.`);
        values.targetCategoryId = cat.id;
        break;
      }
      case "skip": {
        if (hasBalance) throw new BusinessRuleError(422, { error: `${row.sourceCode} carries ${fmt(dr)} Dr / ${fmt(cr)} Cr; only a zero-balance account may be skipped — a balance must land somewhere.`, code: "skip_requires_zero_balance", field: "decision" });
        const reason = body.skipReason?.trim();
        if (!reason) throw new BadRequestError("skip needs skipReason.");
        values.skipReason = reason;
        break;
      }
      default:
        throw new BadRequestError("decision must be map_to_system, map_to_bank, create, merge_into or skip.");
    }

    const [updated] = await migrationRepository.updateChartRow(rowId, values);
    await this.touch(batch);
    await auditService.record({
      action: "migration_chart_decide",
      entityType: "migration_chart_row",
      entityId: rowId,
      before: { decision: row.decision, targetSystemCode: row.targetSystemCode, targetBankAccountId: row.targetBankAccountId, targetCategoryId: row.targetCategoryId },
      after: { decision: updated.decision, targetSystemCode: updated.targetSystemCode, targetBankAccountId: updated.targetBankAccountId, targetCategoryId: updated.targetCategoryId, skipReason: updated.skipReason, by: userId },
    });
    const all = await migrationRepository.chartRows(batchId);
    return toChartRowOut(updated, all);
  },
};
