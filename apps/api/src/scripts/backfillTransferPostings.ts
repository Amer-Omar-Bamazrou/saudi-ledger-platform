/**
 * A — GL owns cash: post every accepted transfer (and any still-unposted
 * accepted operating row) that predates the milestone. Run once per
 * deployment after migration 0045.
 *
 * Per-organization, inside a real tenant transaction — the posting path
 * writes RLS-scoped tables and resolves the org's own chart. Locked-period
 * rows are skipped and REPORTED (they stay visible as `unposted_legacy` in
 * the cash reconciliation), exactly like flaw #1's backfill.
 *
 *   DATABASE_URL=... npx tsx src/scripts/backfillTransferPostings.ts
 */
import { pool, beginTenantConnection } from "@workspace/db";
import { transactionPostingService } from "../services/transactionPosting.service";
import { auditContext } from "../lib/auditContext";

async function main() {
  const { rows: orgs } = await pool.query(
    `SELECT DISTINCT o.id, o.slug FROM organizations o
       JOIN transactions t ON t.organization_id = o.id
      WHERE t.review_status = 'accepted' AND t.journal_entry_id IS NULL
        AND t.kind IN ('operating', 'transfer')`,
  );
  console.log(`${orgs.length} organization(s) with unposted accepted rows`);

  for (const org of orgs) {
    const conn = await beginTenantConnection({ organizationId: org.id, role: "authenticated" });
    try {
      const result = await conn.run(() =>
        auditContext.run({ userId: null, organizationId: org.id, ipAddress: null }, () =>
          transactionPostingService.backfill(),
        ),
      );
      await conn.commit();
      console.log(`${org.slug}: posted=${result.posted} skipped=${result.skipped} failed=${result.failed.length}`);
      for (const f of result.failed) console.log(`  FAILED tx ${f.id}: ${f.reason}`);
    } catch (err) {
      await conn.rollback();
      console.error(`${org.slug}: rolled back —`, err instanceof Error ? err.message : err);
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
