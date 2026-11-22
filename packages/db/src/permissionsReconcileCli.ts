/**
 * `pnpm --filter @workspace/db run permissions:reconcile --env <environment> [--apply] [--approve-removals <approval>]
 *   [--restore <reconciliation id>] [--actor <name>]`
 *
 * 🔴 Phase 19B S0 (D10). A DRY RUN unless `--apply`: it lists every difference between the `permissions` table and
 * `PERMISSION_MATRIX`, and what the database's posting checks answer, and writes nothing. `--apply` adds the missing
 * grants and — only with `--approve-removals <environment>:<sha256 of the removal set>`, the owner's approval for this
 * environment and that exact set — removes the extra ones, in one transaction, recorded in
 * `permission_reconciliations`. `--restore <id>` puts back what a recorded run removed.
 *
 * Exit: 0 done (or a dry run, whatever it found) · 2 refused by name (nothing changed) · 1 an error (nothing changed).
 * Runbook: docs/product/permissions-reconcile-runbook.md.
 */
import { userInfo } from "node:os";
import { pool } from "./index";
import { PERMISSION_MATRIX } from "./permissions";
import {
  PermissionReconcileRefused,
  describeDrift,
  grantKey,
  hasDrift,
  reconcilePermissions,
  restorePermissions,
  type ReconcileResult,
} from "./permissionReconcile";

function parse(argv: string[]) {
  const args = argv.filter((a) => a !== "--");
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    environment: value("--env") ?? "",
    apply: args.includes("--apply"),
    approval: value("--approve-removals") ?? null,
    restore: value("--restore"),
    actor: value("--actor") ?? process.env.RECONCILE_ACTOR ?? userInfo().username,
  };
}

function report(r: ReconcileResult): void {
  const line = (s = "") => console.log(s);
  line(`permissions:reconcile — ${r.kind.replace("_", " ")} · environment '${r.environment}' · database '${r.database}' · matrix ${PERMISSION_MATRIX.length} grants`);
  if (r.kind === "dry_run") {
    if (!hasDrift(r.drift)) line("  The table matches the matrix: nothing to add, nothing to remove.");
    else {
      line(`  To add (in the matrix, not in the table): ${r.drift.missing.length}`);
      for (const m of r.drift.missing) line(`    + ${grantKey(m)}`);
      line(`  To remove (in the table, not in the matrix): ${r.drift.extra.length}`);
      for (const e of r.drift.extra) line(`    - ${grantKey(e)}`);
      if (r.drift.extra.length) {
        line(`  Removals apply only with the owner's approval for this environment and this exact set:`);
        line(`    removal set sha256 ${r.removalSetHash}`);
        line(`    approval form: --approve-removals ${r.environment}:<that sha256>`);
      } else line("  Additions only: --apply reconciles without an approval.");
    }
    line(r.postingCheckDisagreements.length ? `  The database's posting checks DISAGREE with the matrix:\n    ${r.postingCheckDisagreements.join("\n    ")}` : "  The database's posting checks answer as the matrix does.");
    line("  Nothing was written (dry run).");
    return;
  }
  line(`  Added ${r.added.length}${r.added.length ? ":\n    + " + r.added.map(grantKey).join("\n    + ") : ""}`);
  line(`  Removed ${r.removed.length}${r.removed.length ? ":\n    - " + r.removed.map(grantKey).join("\n    - ") : ""}`);
  line(r.reconciliationId ? `  Recorded as permission_reconciliations #${r.reconciliationId}.` : "  Nothing changed; nothing recorded.");
  if (hasDrift(r.driftAfter)) line(`  Still differs from the matrix:\n    ${describeDrift(r.driftAfter).join("\n    ")}`);
  else line("  The table now matches the matrix. Restart every API process: each passes the startup check and reloads its grants.");
}

const opts = parse(process.argv.slice(2));
const client = await pool.connect();
// A checked-out client's socket error is not covered by the pool's listener (tests/severance-amplifier.test.ts): name it
// and fail the run — the open transaction dies with the connection, so nothing is half-applied.
client.on("error", (err) => {
  console.error(`FAILED — the database connection broke; nothing was changed (the transaction died with it): ${err.message}`);
  process.exitCode = 1;
});
let code = 0;
try {
  const result =
    opts.restore !== undefined
      ? await restorePermissions(client, { environment: opts.environment, actor: opts.actor, reconciliationId: Number(opts.restore) })
      : await reconcilePermissions(client, { environment: opts.environment, actor: opts.actor, apply: opts.apply, approval: opts.approval });
  report(result);
} catch (err) {
  if (err instanceof PermissionReconcileRefused) {
    console.error(`REFUSED (${err.code}): ${err.message}`);
    for (const k of (err.detail.extra as string[] | undefined) ?? []) console.error(`    - ${k}`);
    code = 2;
  } else {
    console.error(`FAILED — nothing was changed (the transaction rolled back): ${(err as Error).message}`);
    code = 1;
  }
} finally {
  client.release();
  await pool.end();
}
process.exit(code);
