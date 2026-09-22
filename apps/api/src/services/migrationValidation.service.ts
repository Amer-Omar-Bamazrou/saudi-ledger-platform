/**
 * BATCH 1C — PHASE 2: the OPENING POSITION the staged content implies, and the
 * PRE-COMMIT VALIDATION (decision pack §15.5 steps 6–7 and 9; §15.6).
 *
 * The opening position is what the opening journal WILL post — every mapped
 * chart balance by its target account, with the AR / AP / deposit subledgers
 * derived from the staged items and advances (never imported as independent
 * GL balances: the control balance in the old chart must EQUAL the subledger,
 * or the migration blocks). It is computed; nothing is written.
 *
 * Validation runs every check on the staged content with ZERO ledger writes
 * and stores the result on the batch with a content hash. The checks
 * anticipate the reconciliation gates R1–R10 on the STAGED side; the gates
 * themselves run against the POSTED journal and the ledger read-back at
 * commit (migrationCommit.service.ts) — a validated batch is a batch the
 * commit may attempt, not one that has reconciled.
 *
 * THE DIFFERENCE (`totals.difference` = credit − debit over the mapped rows)
 * is reported so the operator can see what remains to be classified. It is
 * never posted anywhere: a chart that does not balance is REFUSED — there is
 * no opening-balance-equity account, no declaration that turns the refusal
 * into a warning, and no later clearing (accountant A5, 2026-09-20; decision
 * pack §16.12.2). The operator completes the file — the row(s) that carry
 * the difference, mapped or created to the account the cause dictates — and
 * validates again.
 */
import { createHash } from "node:crypto";
import { SYSTEM_ACCOUNTS } from "@workspace/db";
import type { MigrationBatch, MigrationChartRow } from "@workspace/db";
import { round2 } from "../lib/money";
import { businessToday } from "@workspace/shared";
import { fiscalYearContaining, isFiscalCalendar, type FiscalCalendar } from "../lib/fiscalYear";
import { migrationRepository } from "../repositories/migration.repository";
import { auditService } from "./audit.service";
import { migrationService, chartRowProblems, type VatPositionInput } from "./migration.service";
import { readStagedContent, findCandidates, partyProblems, openItemProblems, advanceProblems, type StagedContent } from "./migrationStaging.service";
import { migratedAssetsService, migrationAssetProblems } from "./assets/migratedAssets.service";
import { assetsRepository } from "../repositories/assets.repository";

const num = (v: unknown) => Number(v ?? 0);
const eq = (a: number, b: number) => Math.abs(a - b) < 0.005;

export type ControlCheck = {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn" | "skip";
  expected: number | string | null;
  actual: number | string | null;
  detail: string;
};

type OpeningLine = {
  target: string;
  targetKind: "system" | "bank" | "category" | "create";
  systemCode: string | null;
  categoryId: number | null;
  bankAccountId: number | null;
  accountName: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  debit: number;
  credit: number;
  balance: number;
  sourceCodes: string[];
};

type PartyBalance = { partySourceId: string; partyName: string | null; items: number; total: number };

function groupByParty(rows: { partySourceId: string }[], amountOf: (r: any) => number, nameOf: (id: string) => string | null): PartyBalance[] {
  const m = new Map<string, PartyBalance>();
  for (const r of rows) {
    const cur = m.get(r.partySourceId) ?? { partySourceId: r.partySourceId, partyName: nameOf(r.partySourceId), items: 0, total: 0 };
    cur.items += 1;
    cur.total = round2(cur.total + amountOf(r));
    m.set(r.partySourceId, cur);
  }
  return [...m.values()].sort((a, b) => a.partySourceId.localeCompare(b.partySourceId));
}

/** Build the opening lines from the mapped chart rows. Skipped rows carry no balance by construction and are left out. */
async function openingLines(chart: MigrationChartRow[]): Promise<OpeningLine[]> {
  const mapped = chart.filter((r) => r.decision && r.decision !== "skip");
  const systemCodes = [...new Set(mapped.filter((r) => r.decision === "map_to_system").map((r) => r.targetSystemCode!))];
  const bankIds = [...new Set(mapped.filter((r) => r.decision === "map_to_bank").map((r) => r.targetBankAccountId!))];
  const categoryIds = [...new Set(mapped.filter((r) => r.decision === "merge_into").map((r) => r.targetCategoryId!))];
  const [systemCats, banks, leaves, cats] = await Promise.all([
    migrationRepository.systemCategories(systemCodes),
    migrationRepository.bankAccountsByIds(bankIds),
    migrationRepository.bankLeaves(bankIds),
    migrationRepository.categoriesByIds(categoryIds),
  ]);
  const systemByCode = new Map(systemCats.map((c) => [c.systemCode!, c]));
  const bankById = new Map(banks.map((b) => [b.id, b]));
  const leafByBank = new Map(leaves.map((l) => [l.bankAccountId!, l]));
  const catById = new Map(cats.map((c) => [c.id, c]));

  const lines = new Map<string, OpeningLine>();
  const add = (key: string, seed: Omit<OpeningLine, "debit" | "credit" | "balance" | "sourceCodes">, row: MigrationChartRow) => {
    const cur = lines.get(key) ?? { ...seed, debit: 0, credit: 0, balance: 0, sourceCodes: [] };
    cur.debit = round2(cur.debit + num(row.openingDebit));
    cur.credit = round2(cur.credit + num(row.openingCredit));
    cur.balance = round2(cur.debit - cur.credit);
    cur.sourceCodes.push(row.sourceCode);
    lines.set(key, cur);
  };
  for (const row of mapped) {
    const type = row.sourceType as OpeningLine["type"];
    switch (row.decision) {
      case "map_to_system": {
        const cat = systemByCode.get(row.targetSystemCode!);
        add(`system:${row.targetSystemCode}`, { target: `system:${row.targetSystemCode}`, targetKind: "system", systemCode: row.targetSystemCode!, categoryId: cat?.id ?? null, bankAccountId: null, accountName: cat?.name ?? row.targetSystemCode!, type: (cat?.type as OpeningLine["type"]) ?? type }, row);
        break;
      }
      case "map_to_bank": {
        const bank = bankById.get(row.targetBankAccountId!);
        const leaf = leafByBank.get(row.targetBankAccountId!);
        add(`bank:${row.targetBankAccountId}`, { target: `bank:${row.targetBankAccountId}`, targetKind: "bank", systemCode: null, categoryId: leaf?.id ?? null, bankAccountId: row.targetBankAccountId!, accountName: leaf?.name ?? bank?.name ?? `bank ${row.targetBankAccountId}`, type: "asset" }, row);
        break;
      }
      case "merge_into": {
        const cat = catById.get(row.targetCategoryId!);
        add(`category:${row.targetCategoryId}`, { target: `category:${row.targetCategoryId}`, targetKind: "category", systemCode: null, categoryId: row.targetCategoryId!, bankAccountId: null, accountName: cat?.name ?? `category ${row.targetCategoryId}`, type: (cat?.type as OpeningLine["type"]) ?? type }, row);
        break;
      }
      case "create": {
        add(`create:${row.sourceCode}`, { target: `create:${row.sourceCode}`, targetKind: "create", systemCode: null, categoryId: null, bankAccountId: null, accountName: `${row.sourceCode} ${row.sourceName}`, type }, row);
        break;
      }
    }
  }
  return [...lines.values()].sort((a, b) => a.target.localeCompare(b.target));
}

const lineBalance = (lines: OpeningLine[], target: string) => lines.find((l) => l.target === target)?.balance ?? 0;
/** The mapped balance of a SET of accounts, however the chart row reached them (system, category or created). */
const accountsBalance = (lines: OpeningLine[], categoryIds: number[]) =>
  round2(lines.filter((l) => l.categoryId != null && categoryIds.includes(l.categoryId)).reduce((t, l) => t + l.balance, 0));

export async function computeOpeningPosition(batch: MigrationBatch, c?: StagedContent) {
  const content = c ?? (await readStagedContent(batch));
  const { chart, parties, items, advances } = content;
  const lines = await openingLines(chart);
  const nameOf = (type: "customer" | "vendor") => (id: string) => parties.find((p) => p.partyType === type && p.sourceId === id)?.name ?? null;

  const debit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round2(lines.reduce((s, l) => s + l.credit, 0));
  const ytdIncome = round2(lines.filter((l) => l.type === "income").reduce((s, l) => s + (l.credit - l.debit), 0));
  const ytdExpense = round2(lines.filter((l) => l.type === "expense").reduce((s, l) => s + (l.debit - l.credit), 0));

  const arItems = items.filter((i) => i.itemType === "ar");
  const apItems = items.filter((i) => i.itemType === "ap");
  const arByCustomer = groupByParty(arItems, (i) => num(i.outstandingAmount), nameOf("customer"));
  const apByVendor = groupByParty(apItems, (i) => num(i.outstandingAmount), nameOf("vendor"));
  const depositsByCustomer = groupByParty(advances, (a) => num(a.amount), nameOf("customer"));
  /**
   * 🔴 FA-D (fixed-assets pack §10, §23): a migrated fixed asset creates NO
   * journal line — its cost and its accumulated depreciation are already in
   * the staged trial balance (A5: ONE balanced opening position, never a
   * plug). The register must therefore RECONCILE to the accounts its
   * categories name, exactly as open items reconcile to AR/AP.
   */
  const assetRec = await migratedAssetsService.reconciliation(batch.id);
  const assetControl = {
    assets: assetRec.assets.length,
    registerCost: assetRec.registerCost,
    registerAccumulated: assetRec.registerAccumulated,
    mappedCost: accountsBalance(lines, assetRec.costAccountIds),
    // accumulated depreciation is a CONTRA-asset: a credit balance, read positive
    mappedAccumulated: round2(-accountsBalance(lines, assetRec.accumulatedAccountIds)),
  };
  const arTotal = round2(arByCustomer.reduce((s, p) => s + p.total, 0));
  const apTotal = round2(apByVendor.reduce((s, p) => s + p.total, 0));
  const depositTotal = round2(depositsByCustomer.reduce((s, p) => s + p.total, 0));

  // Banks: every row mapped to a bank, with what the bank record itself says.
  const bankRows = chart.filter((r) => r.decision === "map_to_bank");
  const bankIds = [...new Set(bankRows.map((r) => r.targetBankAccountId!))];
  const [banks, leaves] = await Promise.all([migrationRepository.bankAccountsByIds(bankIds), migrationRepository.bankLeaves(bankIds)]);
  const bankById = new Map(banks.map((b) => [b.id, b]));
  const leafByBank = new Map(leaves.map((l) => [l.bankAccountId!, l]));
  const bankOpenings = bankRows.map((r) => {
    const bank = bankById.get(r.targetBankAccountId!);
    const typed = bank?.openingBalance == null ? null : round2(num(bank.openingBalance));
    return {
      bankAccountId: r.targetBankAccountId!,
      bankName: bank?.name ?? `bank ${r.targetBankAccountId}`,
      sourceCode: r.sourceCode,
      balance: round2(num(r.openingDebit) - num(r.openingCredit)),
      typedOpeningBalance: typed,
      leafCategoryId: leafByBank.get(r.targetBankAccountId!)?.id ?? null,
      evidenceNote: r.evidenceNote ?? null,
      advancesInside: round2(advances.filter((a) => a.bankSourceCode === r.sourceCode).reduce((s, a) => s + num(a.amount), 0)),
    };
  });

  // ── the controls, on the staged side ──
  const controls: ControlCheck[] = [];
  const chartProblems = chart.filter((r) => chartRowProblems(r, chart).length > 0).length;
  controls.push({
    id: "CHART_MAPPED", title: "Every old account has a mapping decision and no open problem", status: chartProblems === 0 && chart.length > 0 ? "pass" : "fail",
    expected: 0, actual: chart.length === 0 ? "no chart staged" : chartProblems,
    detail: chart.length === 0 ? "Import the old chart of accounts first." : chartProblems === 0 ? `${chart.length} rows mapped.` : `${chartProblems} row(s) block — see the chart's problems.`,
  });
  // R5 on the file. A balanced, fully mapped chart gives difference = 0.
  // 🔴 A source position that does NOT balance is REFUSED — always. There is
  // no declaration, no landing account, no warning that lets it through
  // (accountant A5, 2026-09-20). The message names the amount and what
  // classifying it means; the product never chooses the account.
  const difference = round2(credit - debit);
  const balancedTitle = "The old closing balances balance (Σ Dr = Σ Cr) on named accounts — an unexplained difference is a migration failure (R5, R6)";
  if (chart.length === 0) {
    controls.push({ id: "CHART_BALANCED", title: balancedTitle, status: "fail", expected: 0, actual: "no chart staged", detail: "Import the old chart of accounts first." });
  } else if (eq(difference, 0)) {
    controls.push({ id: "CHART_BALANCED", title: balancedTitle, status: "pass", expected: debit, actual: credit, detail: `Dr ${debit.toFixed(2)} = Cr ${credit.toFixed(2)}; every balance lands on a named account.` });
  } else {
    controls.push({
      id: "CHART_BALANCED", title: balancedTitle, status: "fail", expected: debit, actual: credit,
      detail:
        `Dr ${debit.toFixed(2)} ≠ Cr ${credit.toFixed(2)}: ${Math.abs(difference).toFixed(2)} ${difference < 0 ? "on the debit side" : "on the credit side"} is unexplained. ` +
        `The migration is blocked until the difference is classified — investigate its cause and complete the file with the row(s) that carry it, mapped or created to the account the cause dictates ` +
        `(the source's own capital or retained-earnings row where books were kept without equity detail; a missing asset or liability row where the export is incomplete). ` +
        `Nothing is ever carried on a balancing account, and nothing is classified for you.`,
    });
  }
  const arControl = lineBalance(lines, `system:${SYSTEM_ACCOUNTS.AR}`);
  controls.push({
    id: "AR_CONTROL", title: "Receivables control balance = Σ historical AR open items (R2)", status: eq(arControl, arTotal) ? "pass" : "fail",
    expected: arControl, actual: arTotal,
    detail: eq(arControl, arTotal) ? `${arItems.length} item(s) over ${arByCustomer.length} customer(s) = ${arTotal.toFixed(2)}.` : `The old chart's receivable balance mapped to AR is ${arControl.toFixed(2)}; the staged open items sum to ${arTotal.toFixed(2)}. AR is never imported as a bare balance — stage the items that make it up (one composition-unknown item per customer where only a balance is known).`,
  });
  const apControl = round2(-lineBalance(lines, `system:${SYSTEM_ACCOUNTS.AP}`));
  controls.push({
    id: "AP_CONTROL", title: "Payables control balance = Σ historical AP open items (R3)", status: eq(apControl, apTotal) ? "pass" : "fail",
    expected: apControl, actual: apTotal,
    detail: eq(apControl, apTotal) ? `${apItems.length} item(s) over ${apByVendor.length} supplier(s) = ${apTotal.toFixed(2)}.` : `The old chart's payable balance mapped to AP is ${apControl.toFixed(2)}; the staged open items sum to ${apTotal.toFixed(2)}.`,
  });
  const depControl = round2(-lineBalance(lines, `system:${SYSTEM_ACCOUNTS.CUSTOMER_DEPOSITS}`));
  controls.push({
    id: "DEPOSITS_CONTROL", title: "Customer deposits balance = Σ staged advances, each with its VAT position (R10)", status: eq(depControl, depositTotal) ? "pass" : "fail",
    expected: depControl, actual: depositTotal,
    detail: eq(depControl, depositTotal) ? `${advances.length} advance(s) over ${depositsByCustomer.length} customer(s) = ${depositTotal.toFixed(2)}; ${advances.filter((a) => a.vatPosition === "unknown").length} with VAT position unknown (recorded at cash; fail closed downstream).` : `The old chart's balance mapped to CUSTOMER_DEPOSITS is ${depControl.toFixed(2)}; the staged advances sum to ${depositTotal.toFixed(2)}.`,
  });
  // Banks (R4): every bank row lands on a D-3 leaf with evidence, and agrees with the typed opening balance where one was typed.
  const bankIssues: string[] = [];
  for (const b of bankOpenings) {
    if (b.leafCategoryId == null) bankIssues.push(`${b.bankName}: no GL cash account (D-3 leaf)`);
    if (!b.evidenceNote) bankIssues.push(`${b.bankName}: no statement evidence recorded on row ${b.sourceCode} (evidenceNote)`);
    if (b.typedOpeningBalance != null && !eq(b.typedOpeningBalance, 0) && !eq(b.typedOpeningBalance, b.balance)) bankIssues.push(`${b.bankName}: the bank record's typed opening balance ${b.typedOpeningBalance.toFixed(2)} ≠ the old chart's ${b.balance.toFixed(2)} — the typed figure is display-only and must agree, or be cleared`);
    if (b.advancesInside > b.balance + 0.005) bankIssues.push(`${b.bankName}: advances of ${b.advancesInside.toFixed(2)} exceed the bank's balance ${b.balance.toFixed(2)}`);
  }
  const roleBankRows = chart.filter((r) => (r.sourceRole === "bank" || r.sourceRole === "cash") && r.decision !== "map_to_bank" && !(r.decision === "skip"));
  for (const r of roleBankRows) bankIssues.push(`${r.sourceCode} carries a bank/cash role hint and is ${r.decision ?? "undecided"} — a bank balance lands on its own bank`);
  controls.push({
    id: "BANKS", title: "Every bank balance lands on its D-3 leaf, with statement evidence, agreeing with the bank record (R4)", status: bankIssues.length === 0 ? "pass" : "fail",
    expected: 0, actual: bankIssues.length, detail: bankIssues.length === 0 ? `${bankOpenings.length} bank(s).` : bankIssues.join("; "),
  });
  // VAT (R9): the balances mapped to VAT accounts equal the last filed return's closing position, as supplied.
  const vatOut = round2(-lineBalance(lines, `system:${SYSTEM_ACCOUNTS.VAT_OUTPUT}`));
  const vatIn = lineBalance(lines, `system:${SYSTEM_ACCOUNTS.VAT_INPUT}`);
  const vp = (batch.vatPosition ?? null) as VatPositionInput | null;
  if (!vp && eq(vatOut, 0) && eq(vatIn, 0)) {
    controls.push({ id: "VAT_POSITION", title: "VAT balances = the last filed return's closing position (R9)", status: "skip", expected: null, actual: null, detail: "No VAT balance is staged and no return position was supplied." });
  } else if (!vp) {
    controls.push({ id: "VAT_POSITION", title: "VAT balances = the last filed return's closing position (R9)", status: "fail", expected: "return position", actual: `output ${vatOut.toFixed(2)}, input ${vatIn.toFixed(2)}`, detail: "VAT balances are staged but the last filed return's closing position was not supplied — attach it (reference, period, output payable, input recoverable)." });
  } else {
    const ok = eq(vatOut, vp.outputVatPayable) && eq(vatIn, vp.inputVatReceivable);
    controls.push({ id: "VAT_POSITION", title: "VAT balances = the last filed return's closing position (R9)", status: ok ? "pass" : "fail", expected: `output ${num(vp.outputVatPayable).toFixed(2)}, input ${num(vp.inputVatReceivable).toFixed(2)}`, actual: `output ${vatOut.toFixed(2)}, input ${vatIn.toFixed(2)}`, detail: ok ? `Return ${vp.returnReference} (${vp.periodStart} → ${vp.periodEnd}).` : `The staged VAT balances differ from return ${vp.returnReference}'s closing position — reconcile before migrating; historical VAT is never recreated here.` });
  }
  // Parties, items, advances: every row clean.
  const candidates = await findCandidates(parties);
  const partyIssues = parties.filter((p) => partyProblems(p, content, candidates.get(p.id) ?? []).length > 0).length;
  const missingParties = [...new Set([...items.map((i) => `${i.itemType === "ar" ? "customer" : "vendor"}:${i.partySourceId}`), ...advances.map((a) => `customer:${a.partySourceId}`)])]
    .filter((k) => !parties.some((p) => `${p.partyType}:${p.sourceId}` === k));
  controls.push({
    id: "PARTIES", title: "Every party is decided (create / use_existing) and every item and advance names a staged party", status: partyIssues === 0 && missingParties.length === 0 ? "pass" : "fail",
    expected: 0, actual: partyIssues + missingParties.length,
    detail: partyIssues === 0 && missingParties.length === 0 ? `${parties.length} part(ies).` : [partyIssues ? `${partyIssues} party row(s) block` : null, missingParties.length ? `not staged: ${missingParties.slice(0, 10).join(", ")}${missingParties.length > 10 ? "…" : ""}` : null].filter(Boolean).join("; "),
  });
  // FA-D: the staged assets are well-formed, and the register ties to the trial balance.
  const assetCategories = (await assetsRepository.categories(true)).map((c) => c.category);
  const assetIssues = assetRec.assets.filter((a) => migrationAssetProblems(a, batch, assetCategories).length > 0).length;
  /**
   * 🔴 The control fires when EITHER side is non-zero. Gating it on "some
   * asset is staged" would make the dangerous case — asset balances in the
   * trial balance and an EMPTY register — silent, and a silent control reads
   * as a pass (the confident-zero class, CLAUDE.md §3).
   */
  const assetsInPlay = assetRec.assets.length > 0 || Math.abs(assetControl.mappedCost) > 0.005 || Math.abs(assetControl.mappedAccumulated) > 0.005;
  if (assetsInPlay) {
    controls.push({
      id: "FIXED_ASSETS_WELL_FORMED",
      title: "Every migrated fixed asset names an existing category, was in service by the opening date, and carries its VAT facts while inside the Art. 52 adjustment period",
      status: assetIssues === 0 ? "pass" : "fail", expected: 0, actual: assetIssues,
      detail: assetIssues === 0 ? `${assetRec.assets.length} asset(s).` : `${assetIssues} asset(s) block — see each asset's problems.`,
    });
    const costOk = eq(assetControl.registerCost, assetControl.mappedCost);
    const accOk = eq(assetControl.registerAccumulated, assetControl.mappedAccumulated);
    controls.push({
      id: "FIXED_ASSETS_CONTROL",
      title: "The asset register ties to the trial balance: Σ cost = the mapped cost accounts, Σ accumulated = the mapped accumulated-depreciation accounts",
      status: costOk && accOk ? "pass" : "fail",
      expected: `cost ${assetControl.mappedCost.toFixed(2)}, accumulated ${assetControl.mappedAccumulated.toFixed(2)}`,
      actual: `cost ${assetControl.registerCost.toFixed(2)}, accumulated ${assetControl.registerAccumulated.toFixed(2)}`,
      detail: costOk && accOk
        ? `${assetRec.assets.length} asset(s): cost ${assetControl.registerCost.toFixed(2)}, accumulated ${assetControl.registerAccumulated.toFixed(2)}, net book value ${(assetControl.registerCost - assetControl.registerAccumulated).toFixed(2)}.`
        : `A migrated asset adds NO journal line — its figures are already in the trial balance, so the register must state the same ones. `
          + `The chart maps ${assetControl.mappedCost.toFixed(2)} of cost and ${assetControl.mappedAccumulated.toFixed(2)} of accumulated depreciation to these categories' accounts; the staged register says ${assetControl.registerCost.toFixed(2)} and ${assetControl.registerAccumulated.toFixed(2)}. `
          + `Stage the missing asset(s), or correct the chart rows — never a balancing entry.`,
    });
  }
  const itemIssues = items.filter((i) => openItemProblems(i, content).length > 0).length;
  controls.push({ id: "OPEN_ITEMS", title: "Every open item is well-formed: staged party, dated at or before the opening date, an unused original number, one composition-unknown item per party at most", status: itemIssues === 0 ? "pass" : "fail", expected: 0, actual: itemIssues, detail: itemIssues === 0 ? `${items.length} item(s).` : `${itemIssues} item(s) block — see the items' problems.` });
  const advanceIssues = advances.filter((a) => advanceProblems(a, content).length > 0).length;
  controls.push({ id: "ADVANCES", title: "Every advance names a staged customer and a bank row mapped to a bank, dated at or before the opening date", status: advanceIssues === 0 ? "pass" : "fail", expected: 0, actual: advanceIssues, detail: advanceIssues === 0 ? `${advances.length} advance(s).` : `${advanceIssues} advance(s) block.` });
  // The ledger before the opening date must be EMPTY: an opening position is
  // the first thing in these books (R1's read-back is the opening journal
  // alone), not something posted on top of history.
  const priorLedger = await migrationRepository.inBooksLinesUpTo(batch.openingDate);
  controls.push({
    id: "LEDGER_EMPTY", title: `No journal line is in the books on or before the opening date ${batch.openingDate} (R1 precondition)`, status: priorLedger.lines === 0 ? "pass" : "fail",
    expected: 0, actual: priorLedger.lines,
    detail: priorLedger.lines === 0 ? "The opening journal will be the first entry in these books." : `${priorLedger.lines} line(s) (Dr ${priorLedger.debit.toFixed(2)} / Cr ${priorLedger.credit.toFixed(2)}) already sit on or before ${batch.openingDate} — this company has history in Saudi Ledger; an opening position cannot be posted on top of it. Reverse it, or choose a cutover after it.`,
  });
  const today = businessToday();
  controls.push({
    id: "OPENING_DATE", title: "The opening date has passed (a position is stated as at a day that has ended)", status: batch.openingDate <= today ? "pass" : "fail",
    expected: `≤ ${today}`, actual: batch.openingDate, detail: batch.openingDate <= today ? `Opening date ${batch.openingDate}; business date ${today}.` : `Opening date ${batch.openingDate} is after the business date ${today}.`,
  });
  // Fiscal year (A2): the cutover's place in the declared year decides what the P&L rows may say.
  const [company] = await migrationRepository.company(batch.companyId);
  const plRows = chart.filter((r) => (r.sourceType === "income" || r.sourceType === "expense") && r.decision !== "skip" && (num(r.openingDebit) > 0.005 || num(r.openingCredit) > 0.005));
  if (!company || company.fiscalYearStart == null) {
    controls.push({ id: "FISCAL_YEAR", title: "The fiscal year is declared and the YTD P&L rows fit the cutover's place in it (A2)", status: "fail", expected: "declared", actual: "not declared", detail: "Declare the company's fiscal year first — the opening month and the meaning of the YTD balances depend on it." });
  } else {
    const calendar = (isFiscalCalendar(company.fiscalCalendar) ? company.fiscalCalendar : "gregorian") as FiscalCalendar;
    const period = fiscalYearContaining({ fiscalYearStart: company.fiscalYearStart, calendar }, batch.cutoverDate);
    const atYearStart = period.startDate === batch.cutoverDate;
    if (atYearStart && plRows.length > 0) {
      controls.push({ id: "FISCAL_YEAR", title: "The fiscal year is declared and the YTD P&L rows fit the cutover's place in it (A2)", status: "fail", expected: "P&L rows = 0 at a fiscal-year start", actual: `${plRows.length} P&L row(s) with balances`, detail: `Cutover ${batch.cutoverDate} is the first day of fiscal year ${period.label}: the previous year's result belongs in retained earnings, so no P&L account carries a balance into the opening. The file looks pre-closing — take the post-closing balances.` });
    } else {
      controls.push({ id: "FISCAL_YEAR", title: "The fiscal year is declared and the YTD P&L rows fit the cutover's place in it (A2)", status: "pass", expected: period.startDate, actual: batch.cutoverDate, detail: atYearStart ? `Cutover at the start of fiscal year ${period.label}; no P&L balances.` : `Mid-year cutover in fiscal year ${period.label} (${period.startDate} → ${period.endDate}); ${plRows.length} P&L row(s) import as the YTD opening movement dated ${batch.openingDate}: income ${ytdIncome.toFixed(2)}, expense ${ytdExpense.toFixed(2)}, result ${round2(ytdIncome - ytdExpense).toFixed(2)}.` });
    }
  }

  return {
    batchId: batch.id,
    openingDate: batch.openingDate,
    lines,
    totals: {
      debit, credit, balanced: eq(debit, credit),
      difference,
      ytdIncome, ytdExpense, ytdResult: round2(ytdIncome - ytdExpense),
    },
    arByCustomer, apByVendor, depositsByCustomer,
    assetControl,
    banks: bankOpenings,
    controls,
  };
}

/** SHA-256 over the canonical staged content — the commit refuses if it moved since validation. */
export function contentHashOf(c: StagedContent): string {
  const canon = {
    cutoverDate: c.batch.cutoverDate,
    openingDate: c.batch.openingDate,
    vatPosition: c.batch.vatPosition ?? null,
    chart: c.chart.map((r) => [r.sourceCode, r.sourceType, r.sourceIsGroup, r.openingDebit, r.openingCredit, r.decision, r.targetSystemCode, r.targetBankAccountId, r.targetCategoryId]).sort(),
    parties: c.parties.map((p) => [p.partyType, p.sourceId, p.name, p.taxNumber, p.decision, p.existingCustomerId, p.existingVendorId]).sort(),
    items: c.items.map((i) => [i.itemType, i.sourceId, i.partySourceId, i.documentNumber, i.issueDate, i.dueDate, i.originalAmount, i.outstandingAmount, i.compositionUnknown, i.historicalVat]).sort(),
    advances: c.advances.map((a) => [a.sourceId, a.partySourceId, a.bankSourceCode, a.amount, a.receivedAt, a.vatPosition, a.advanceInvoiceNumber, a.advanceInvoiceDate, a.advanceInvoiceTime, a.vatCategory, a.vatRate, a.vatAmount]).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export const migrationValidationService = {
  async getOpeningPosition(batchId: number) {
    const batch = await migrationService.requireBatch(batchId);
    return computeOpeningPosition(batch);
  },

  /** Every check, zero ledger writes; the result and the content hash are stored on the batch. */
  async validate(batchId: number, userId: number | null) {
    const batch = await migrationService.requireBatch(batchId);
    migrationService.assertDraft(batch);
    const content = await readStagedContent(batch);
    const position = await computeOpeningPosition(batch, content);
    const checks = position.controls;
    const ok = checks.every((c) => c.status !== "fail");
    const now = new Date();
    const contentHash = contentHashOf(content);
    const validation = { ok, checks, totals: position.totals, at: now.toISOString() };
    const [updated] = await migrationRepository.updateBatch(batchId, ok
      ? { status: "validated", validatedAt: now, validation, contentHash }
      : { status: "draft", validatedAt: null, validation, contentHash: null });
    await auditService.record({ action: "migration_batch_validate", entityType: "migration_batch", entityId: batchId, after: { ok, failed: checks.filter((c) => c.status === "fail").map((c) => c.id), contentHash: ok ? contentHash : null, by: userId } });
    return { batchId, ok, status: updated.status as "draft" | "validated" | "committed" | "reversed" | "discarded", checks, contentHash: updated.contentHash ?? null, validatedAt: updated.validatedAt ? updated.validatedAt.toISOString() : null };
  },
};
