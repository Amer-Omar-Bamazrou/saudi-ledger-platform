# Runbook — the permission grants: release, reconcile, recover

**Status (2026-11-22): built in Phase 19B S0 (D10). Current state authority: CLAUDE.md §2.**

## The model, in four lines

- **`PERMISSION_MATRIX`** (`packages/db/src/permissions.ts`) is the only definition of who may do what.
- The **`permissions` table** is what is enforced. Two readers use it: the API's grant cache (`apps/api/src/lib/rbac.ts`) and the database's posting checks (`role_holds_grant`, `org_usable_approver_count`, migration 0155).
- **The API refuses to start while the table differs from the matrix.** The refusal names every difference and the database (`apps/api/src/lib/permissionStartupCheck.ts`). The API never inserts or deletes a grant itself.
- **`permissions:reconcile`** (`packages/db/src/permissionReconcile.ts`) is the one way to make them agree. Every run that changes something is recorded in `permission_reconciliations` (append-only), with every removed grant kept in full.

Migrations no longer write grants; `tests/permission-grant-migration-ratchet.test.ts` enforces it. To change access, change the matrix and reconcile.

## The command

```bash
pnpm --filter @workspace/db run permissions:reconcile --env <environment>             # dry run: lists, writes nothing
pnpm --filter @workspace/db run permissions:reconcile --env <environment> --apply     # additions only
pnpm --filter @workspace/db run permissions:reconcile --env <environment> --apply \
     --approve-removals <environment>:<sha256 from the dry run>                       # with removals
pnpm --filter @workspace/db run permissions:reconcile --env <environment> --restore <id>   # put a removal back
```

`DATABASE_URL` names the database, on the owner connection. `--env` names the environment, for example `demo`, `staging` or `production`. The record carries the name, and an approval only works for the environment it names. `--actor` (or `RECONCILE_ACTOR`) names who ran it; the default is the operating-system user.

| Exit | Meaning |
| --- | --- |
| 0 | Done, or a dry run, whatever it found |
| 2 | Refused by name. Nothing changed. |
| 1 | An error. The transaction rolled back, so nothing changed. |

Refusals, each by name:

| Code | When |
| --- | --- |
| `removal_needs_approval` | There is a removal and no approval was given |
| `removal_approval_mismatch` | The approval names another environment, or another removal set |
| `reconcile_in_progress` | Another run holds the lock on this database |
| `posting_checks_disagree` | After the changes, the database's posting checks do not answer as the matrix does |
| `drift_remains` | The table still differs after the run |
| `environment_invalid` | The environment name is not valid |
| `reconciliation_not_found` | `--restore` names a run that is not recorded |
| `nothing_to_restore` | Every grant that run removed is already back |

## What an apply does

It runs in **one transaction** on the owner connection, under the advisory lock `pg_advisory_xact_lock(1901900168)`, with the table locked against other writers:

1. Read the difference.
2. If anything is to be removed, check the approval. It must be exactly `<environment>:<sha256>`, where the hash covers the sorted `role:resource:action` lines of the removal set the dry run showed. **The owner gives it, in release review, for each environment.** An approval for one set or one environment never applies to another.
3. Insert the missing grants, and delete the approved extra ones.
4. Check that the table now equals the matrix, and that the database's posting checks answer as the matrix does.
5. Record the run: who, when, the environment, the database, the grants added, and the grants removed in full.

**If any step fails, the whole run rolls back.** Nothing is applied and nothing is recorded.

**Additions need no approval.** A release that only adds grants reconciles without one.

## The release order

1. **Migrate:** `pnpm --filter @workspace/db run migrate`.
2. **Dry run** the reconcile for the environment, and read it:
   - **additions only:** go on;
   - **removals:** stop. The owner reads the removal set and gives the approval for this environment.
3. **Apply** (`--apply`, plus `--approve-removals …` when there are removals).
4. **Start, or restart, every API process.** Each one runs the startup check at boot and loads its grants then; a running process keeps the grants it loaded.

The demo deployment (`railway.json`) runs steps 1–3 as its pre-deploy command, additions only: `migrate`, then `permissions:reconcile --env demo --apply`. A release whose matrix removes a grant fails there, refused by name, until the owner's approval is passed for `demo`.

**CI's test job** runs steps 1 and 3 the same way (`--env ci-test --apply`, additions only), so the API suites run against the matrix, never against the grants migrations happen to insert (owner, 2026-11-22). **The API suites refuse to start** while a real database's table differs from the matrix — their global setup is the API's own startup check (`apps/api/src/tests/globalSetup.ts`). On a local or scratch database after a matrix change: dry run, then `--apply` (with the owner's approval for any removal), then run the suites.

## Recovery

### A reconcile that fails part-way

It rolls back whole. The table is exactly as it was before, and nothing is recorded. Read the refusal or the error, fix its cause, and run the command again from the dry run. There is nothing half-applied to undo.

### A deployment rolled back after a removal

The newer release removed a grant and reconciled it, approved and recorded as run `#N`. Then the deployment was rolled back to the older code, whose matrix still has that grant. The older code's startup check sees the grant as **missing**, and the API **refuses to start** until it is back.

Putting it back is an **addition**, so it needs no approval. Either:

- with the newer code's command: `permissions:reconcile --env <environment> --restore <N>`, recorded as its own run that points at `#N`; or
- with the older code's reconcile, if it has one: `--apply` adds the missing grant.

Then start the API. If the release is later re-deployed, its dry run shows the same removal again, and it needs the owner's approval again.

## Where each environment stands

The dry run of 2026-11-22 found no difference in any of these (evidence `2026-11-17-phase19-research/s0/10-dry-runs.log`):

- `sl_e2e`;
- `sl_test`;
- the development database (local Supabase, `postgres`);
- a fresh database built as CI's browser job builds it (migrations, then the seed);
- the two scratch databases.

Two environments are not in that list:

- **CI's test job migrates but does not seed.** Its table holds the 50 grants migrations inserted before S0. That lane never boots the API's entry point (tests import the app), so the startup check does not run there. Tests that need the grants seed or prime them for themselves.
- **The demo deployment** has not been deployed. Its pre-deploy command used to migrate only: the table would have held those 50 grants, and the API would have refused most actions. It now reconciles the additions before the API starts.

The seed (`pnpm --filter @workspace/db run seed`, used in development and by CI's browser job) still inserts any missing matrix grant without a record. It never removes a grant and never writes one outside the matrix.
