/**
 * D-3 / G3 — the per-bank cash CUT-OVER, run per company (2026-09-16).
 *
 *   DATABASE_URL=... npx tsx src/scripts/cashCutover.ts               # dry-run, every company with header lines
 *   DATABASE_URL=... npx tsx src/scripts/cashCutover.ts --company <uuid>
 *   DATABASE_URL=... npx tsx src/scripts/cashCutover.ts --commit [--company <uuid>]
 *   DATABASE_URL=... npx tsx src/scripts/cashCutover.ts --json report.json
 *
 * Same shape as backfillTransferPostings.ts: one tenant transaction per
 * (organization, company), the service does the work, the script prints.
 *
 * The dry-run classifies every historical cash line still on "Cash and Bank"
 * and prints every BLOCKING record with the fields a reviewer needs (record
 * id, entry, date, amount, current account, known bank, candidate banks,
 * classification, reason, required remediation). It writes nothing to the
 * books; it records the run as evidence (`cash_cutover_runs`).
 *
 * `--commit` ATTRIBUTES (never rewrites) the lines of a company whose
 * classification is entirely DETERMINISTIC, atomically, with the invariants
 * asserted inside the transaction — not one journal line changes; a blocked
 * company is reported and skipped — never partially migrated, never guessed.
 * Rerunning a completed company is a no-op. There is no `--force`.
 */
import { writeFileSync } from "node:fs";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { cashCutoverService, CashCutoverBlockedError, type ClassifiedLine, type CutoverReport } from "../services/accounting/cashCutover.service";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const COMMIT = process.argv.includes("--commit");
const ONLY_COMPANY = arg("--company");
const JSON_OUT = arg("--json");

function money(n: number) {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function printBlocking(l: ClassifiedLine) {
  console.log(`  ▸ line ${l.lineId}  entry ${l.entryNumber} (je ${l.journalEntryId}, ${l.entryStatus})  ${l.date}  Dr ${money(l.debit)} / Cr ${money(l.credit)}`);
  console.log(`      current account : ${l.currentAccountName} (#${l.currentAccountId})`);
  console.log(`      source          : ${l.sourceKind}${l.transactionId != null ? ` tx ${l.transactionId}` : ""}${l.paymentId != null ? ` payment ${l.paymentId}` : ""}${l.invoiceId != null ? ` invoice ${l.invoiceId}` : ""}${l.billId != null ? ` bill ${l.billId}` : ""}`);
  console.log(`      known bank      : ${l.knownBankAccountId ?? "—"}    candidate banks on date (informational): ${l.candidateBankAccountIds.length ? l.candidateBankAccountIds.join(", ") : "none"}`);
  console.log(`      classification  : ${l.classification}`);
  console.log(`      reason          : ${l.reason}`);
  console.log(`      remediation     : ${l.requiredRemediation ?? "—"}`);
}

function printReport(label: string, r: CutoverReport) {
  console.log(`\n═══ ${label} ═══`);
  console.log(`header account #${r.headerAccountId} · ${r.lines.length} unattributed historical cash line(s) (${r.attributedBefore} already attributed) · cash position ${money(r.cashBefore)}`);
  console.log(`DETERMINISTIC ${r.counts.DETERMINISTIC} · AMBIGUOUS_REQUIRES_REVIEW ${r.counts.AMBIGUOUS_REQUIRES_REVIEW} · UNMAPPABLE ${r.counts.UNMAPPABLE} · INCONSISTENT ${r.counts.INCONSISTENT}`);
  if (r.plan.length > 0) {
    console.log(`plan${r.blocked ? " (PROVISIONAL — blocked lines excluded)" : ""}:`);
    for (const p of r.plan) console.log(`  bank ${p.bankAccountId} → GL #${p.glAccountId} "${p.glAccountName}": ${p.lines} line(s), net ${money(p.net)}`);
  }
  const blocking = r.lines.filter((l) => l.classification !== "DETERMINISTIC");
  if (blocking.length > 0) {
    console.log(`🔴 BLOCKED — ${blocking.length} record(s) require remediation before this company can be cut over:`);
    for (const l of blocking) printBlocking(l);
  } else if (r.lines.length > 0) {
    console.log("✓ clean — every unattributed line is deterministically attributable to a bank.");
  } else {
    console.log("nothing to do — every cash line on the header already carries its bank attribution.");
  }
}

async function main() {
  const { rows: targets } = await pool.query<{ org_id: string; slug: string; company_id: string; company: string; n: string }>(
    `SELECT o.id AS org_id, o.slug, c.id AS company_id, c.name AS company, count(l.id) AS n
       FROM companies c
       JOIN organizations o ON o.id = c.organization_id
       JOIN categories h ON h.organization_id = o.id AND h.system_code = 'CASH'
       LEFT JOIN journal_entry_lines l ON l.account_id = h.id AND l.company_id = c.id
       LEFT JOIN cash_line_bank_attributions a ON a.line_id = l.id
      WHERE ($1::uuid IS NULL OR c.id = $1::uuid) AND (a.id IS NULL OR $1::uuid IS NOT NULL)
      GROUP BY 1, 2, 3, 4
     HAVING count(l.id) > 0 OR $1::uuid IS NOT NULL
      ORDER BY o.slug, c.name`,
    [ONLY_COMPANY],
  );
  console.log(`${targets.length} company(ies) with historical cash lines on the header${COMMIT ? " — COMMIT mode" : " — dry-run"}`);

  const out: Record<string, unknown> = {};
  let blockedCompanies = 0;
  for (const t of targets) {
    const label = `${t.slug} / ${t.company} (${t.company_id})`;
    const conn = await beginTenantConnection({ organizationId: t.org_id, companyId: t.company_id, role: "authenticated" });
    try {
      if (!COMMIT) {
        const report = await conn.run(() =>
          auditContext.run({ userId: null, organizationId: t.org_id, ipAddress: null }, () => cashCutoverService.dryRun({ record: true })),
        );
        await conn.commit(); // the run record only; the books were not written
        printReport(label, report);
        out[t.company_id] = { label, mode: "dry_run", ...report };
        if (report.blocked) blockedCompanies++;
      } else {
        const result = await conn.run(() =>
          auditContext.run({ userId: null, organizationId: t.org_id, ipAddress: null }, () => cashCutoverService.commit()),
        );
        await conn.commit();
        printReport(label, result);
        console.log(result.state === "committed"
          ? `✓ COMMITTED run ${result.runId}: ${result.attributed} line(s) attributed to their banks (no journal line changed); cash ${money(result.cashBefore)} → ${money(result.cashAfter)}`
          : "✓ nothing to do — already fully attributed.");
        out[t.company_id] = { label, mode: "commit", ...result };
      }
    } catch (err) {
      await conn.rollback();
      if (err instanceof CashCutoverBlockedError) {
        printReport(label, err.report);
        console.log(`✗ NOT committed — rolled back: ${err.message}`);
        out[t.company_id] = { label, mode: "commit", refused: err.message, ...err.report };
        blockedCompanies++;
      } else {
        console.error(`${label}: rolled back —`, err instanceof Error ? err.message : err);
        out[t.company_id] = { label, error: err instanceof Error ? err.message : String(err) };
        blockedCompanies++;
      }
    }
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log(`\nreport written to ${JSON_OUT}`);
  }
  await pool.end();
  if (blockedCompanies > 0) {
    console.log(`\n${blockedCompanies} company(ies) blocked or failed. No guessed mapping was made.`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
