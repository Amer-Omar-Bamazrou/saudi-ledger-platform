# Development Guide

How the backend is structured and the invariants you must preserve when changing
it. If you internalize four things — **layering**, **tenant isolation**,
**RBAC**, and **audit logging** — you can add features that stay consistent with
the rest of the platform.

Read [`local-setup.md`](./local-setup.md) first (to run the app) and
[`../CLAUDE.md`](../CLAUDE.md) alongside this (the rules and current state).
[`architecture-blueprint.md`](./architecture-blueprint.md) is the "why".

---

## 1. The request pipeline

Every authenticated business request flows through the same chain (wired in
`apps/api/src/routes/index.ts`):

```
requireAuth → resolveTenant → requirePermission("<resource>") → controller → service → repository → Postgres (+ RLS)
```

- **`requireAuth`** (`lib/auth.ts`) — 401 if there's no valid session.
- **`resolveTenant`** (`lib/tenant.ts`) — resolves the active organization, opens
  a per-request RLS-scoped DB transaction, attaches `req.tenant`, and binds the
  audit context. The linchpin — see §3.
- **`requirePermission(resource)`** (`lib/rbac.ts`) — fail-closed authorization
  from the active-org role. See §4.
- **controller → service → repository** — the layering. See §2.

`/auth/*` and `/orgs/*` are the exceptions: they run **before** `resolveTenant`
(they manage global identity or are inherently cross-org) and have their own
access rules.

---

## 2. Layering: route → controller → service → repository

The backend is split into four layers across all business domains. Each has one
job; keep logic in the right one.

| Layer          | Directory                       | Responsibility                                                                 | May access the DB? |
| -------------- | ------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| **Route**      | `apps/api/src/routes/`          | HTTP wiring only: parse params, call the controller, send the response.        | No                 |
| **Controller** | `apps/api/src/controllers/`     | Validate input (Zod from `@workspace/api-zod`), orchestrate, shape the response. | No               |
| **Service**    | `apps/api/src/services/`        | Business logic. Owns the operation. Calls the accounting core and the audit service. | No (delegates)  |
| **Repository** | `apps/api/src/repositories/`    | **All** Drizzle/SQL access, tenant-scoped via RLS.                             | **Yes — only here** |

**The rule: no DB access outside repositories.** Services and controllers never
import `db` for queries. If you're reaching for Drizzle in a service, add a
repository method instead.

**The sanctioned exception: the accounting core.** The trusted accounting modules
under `services/accounting/` (`glPosting`, `periodLock`, `zatca`) and
`services/categorization/` keep their direct `db` access. They are correct and
tested — services *call* them; you do not rewrite them or route them through
repositories. This is the one place `db` appears outside a repository.

### What each layer looks like

A repository is a plain object of tenant-scoped query methods (RLS handles the
`organization_id` filter — see §3):

```ts
// repositories/transactions.repository.ts
export const transactionsRepository = {
  findWithCategory(id: number) {
    return db.select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.id, id))
      .limit(1);
  },
  insert(values: typeof transactionsTable.$inferInsert) {
    return db.insert(transactionsTable).values(values).returning();
  },
  // update, remove, list, count …
};
```

A service owns the logic, calls the repository, shapes the response with the
generated Zod schema, and records the mutation:

```ts
// services/transactions.service.ts
async create(d: CreateTransactionInput) {
  const [tx] = await transactionsRepository.insert({
    date: d.date,
    description: d.description,
    amount: String(d.amount),   // numeric column → string (see §6)
    // …
  });
  await auditService.created("transaction", tx.id, tx);   // audit (see §5)
  const [row] = await transactionsRepository.findWithCategory(tx.id);
  return CreateTransactionResponse.parse(buildTransactionRow(row.tx, row.cat));
}
```

Errors are thrown as typed `AppError`s (`lib/errors.ts`) and mapped to HTTP by
the central error handler (`middleware/errorHandler.ts`) — don't build error
responses by hand in services.

---

## 3. Multi-tenancy — how not to break isolation

**Every business row belongs to exactly one organization**, and no request may
ever read or write another org's data. This is enforced in two layers; you rely
on both.

### `resolveTenant` and the RLS-scoped transaction

For each authenticated request, `resolveTenant` (`lib/tenant.ts`):

1. loads the user's active memberships from `organization_memberships`,
2. picks the active org (the session's choice via the org switcher, else the
   primary membership),
3. resolves that org's primary company,
4. **opens a per-request transaction** that `SET LOCAL ROLE`s to the non-owner
   `DB_APP_ROLE` (default `authenticated`) and sets the GUCs
   `app.current_org_id` / `app.current_company_id`, and
5. attaches an immutable `TenantContext { userId, organizationId, companyId, role }`
   to `req.tenant`.

The transaction **commits** when the response succeeds and **rolls back** on
error/abort, so tenant context never leaks across pooled connections.

### Why your queries are already scoped

Postgres **Row-Level Security** policies on every business table check
`organization_id = current_setting('app.current_org_id')`. Because
`resolveTenant` set that GUC for the request's transaction, **a repository query
with no explicit org filter still only sees the active org's rows.** RLS also
enforces it on writes (`WITH CHECK`), and `organization_id` defaults to the GUC,
so inserts are stamped with the right tenant automatically.

**What this means for you as a developer:**

- A normal `db.select().from(x).where(...)` in a repository is **automatically
  tenant-scoped**. You do not (and should not need to) add
  `where(eq(x.organizationId, ...))` yourself for isolation — RLS does it.
- **Never bypass the request `db`.** The `db` you import in a repository is a
  request-scoped proxy that routes onto the RLS transaction. Don't open your own
  pool/connection for business queries, and don't move business queries onto the
  owner connection — that runs as the table owner (which has `BYPASSRLS`) and
  would defeat isolation.
- **Cross-org reads are deliberate and rare.** Only `resolveTenant` and the
  `/orgs` switcher read across orgs, on the base connection, before scoping. If
  you think you need a cross-org query in a business route, you almost certainly
  don't.
- Multi-**company** scoping within an org is not yet fully enforced everywhere
  (e.g. `period_locks` scope by period, not company) — see the deferred items in
  `CLAUDE.md`. RLS still confines everything to the active org.

Isolation is covered by the cross-tenant test suite in
`packages/db/src/__tests__` — if you touch tenancy, run
`pnpm --filter @workspace/db run test`.

---

## 4. RBAC — permission-based authorization

Authorization is centralized, data-driven, and fail-closed.

- **One seam:** `requirePermission(resource)` (`lib/rbac.ts`) guards each business
  route in `routes/index.ts`:
  `router.use("/invoices", requirePermission("invoices"), invoices)`.
- It reads the caller's role from **`req.tenant.role`** (the active-org
  membership role — never the global `users.role`), infers the **action** from
  the HTTP method (`GET`→`read`, `POST`→`create`, `PUT/PATCH`→`update`,
  `DELETE`→`delete`), and checks the `(role, resource, action)` triple against the
  seeded **`permissions`** table.
- **Fail-closed:** no matching grant ⇒ 403.
- **Policy lives in data, not code.** The matrix is
  `PERMISSION_MATRIX` in `packages/db/src/permissions.ts`, seeded idempotently by
  `pnpm --filter @workspace/db run seed`. The API caches it in memory on first
  use — **restart the API to pick up a re-seed.**

The current roles are `admin | accountant | viewer`. To change who can do what,
edit the matrix and re-seed — you don't touch route files. To add a **new
resource**, add its rows to the matrix (see the cookbook, §7).

> Method-based actions are deliberately coarse (a tracked deferral — CLAUDE.md §5 'action-level permissions'): posting to the GL,
> reversing, paying a bill, and approving payroll all resolve to `create`.
> Finer, action-level separation-of-duties controls are a deferred feature
> (`CLAUDE.md`).

---

## 5. Audit logging

Every business mutation writes exactly one append-only, tenant-scoped row to
`audit_logs`, **atomically with the mutation** (same request transaction — a
rolled-back request records nothing).

- **Where:** call `auditService` (`services/audit.service.ts`) **from the service
  layer**, at each mutating operation, after the write.
- **How:** the convenience methods cover the common cases; actor/org/IP come from
  the request's audit context automatically, so you only describe *what* changed:

  ```ts
  await auditService.created("invoice", inv.id, inv);
  await auditService.updated("invoice", inv.id, before, after);
  await auditService.deleted("invoice", inv.id, before);
  // state transitions use record() with a custom action string:
  await auditService.record({ action: "post", entityType: "journal_entry", entityId: je.id, after: je });
  ```

- **Bulk operations record one summary row**, not one per row (see the
  transaction upload / auto-categorize services for the pattern).
- **Append-only is enforced in the DB:** migration `0006` revokes UPDATE/DELETE on
  `audit_logs` from the app role. Don't try to update or delete audit rows.
- **Read** via `GET /api/audit-logs` — tenant-scoped and **admin-only**.

> Global identity/session events (register, password reset, role/membership
> change, org switch) are **not** in `audit_logs` (it's org-scoped). A separate
> actor-centric security-audit log is a future phase — don't shoehorn them in.

---

## 6. Common gotchas

**Numeric columns come back as strings.** Drizzle maps Postgres `numeric` to a
JS **string** to avoid float precision loss. So money/rate columns (`amount`,
`vatAmount`, `vatRate`, `confidenceScore`) are strings on the way out and must be
strings on the way in:

```ts
amount: String(d.amount),                 // write: number → string
amount: Number(tx.amount),                // read:  string → number (in the response builder)
vatAmount: tx.vatAmount != null ? Number(tx.vatAmount) : null,
```

Never do arithmetic on the raw column value without converting, and never send a
raw JS number into a `numeric` insert.

**Config is validated at boot — the app won't start if it's wrong.**
`@workspace/config` (`env.ts`) Zod-validates every env var at startup:
`SESSION_SECRET` must be ≥32 chars (no fallback), `CORS_ALLOWED_ORIGINS` must be
full URLs, `DB_APP_ROLE` must be a valid identifier. Add new config there, not as
ad-hoc `process.env` reads.

**`migrate`/`seed` read `DATABASE_URL` from the shell, not `.env`.** Only the API
loads `apps/api/.env` (via `dotenv`). Export `DATABASE_URL` before running DB
tooling (see `local-setup.md`).

**Schema changes = versioned migrations.** Edit the Drizzle schema under
`packages/db/src/schema/`, then `pnpm --filter @workspace/db run generate` and
commit the SQL. **Never** `drizzle-kit push` against tenant data — it's unsafe
and skips migration history.

**API changes = OpenAPI first.** Edit `packages/api-spec/openapi.yaml`, run
`pnpm --filter @workspace/api-spec run codegen`, then implement against the
regenerated `@workspace/api-zod` / `@workspace/api-client-react`. Never hand-edit
generated files.

**RLS + the owner connection.** Business queries must run on the request-scoped
`db` (non-owner role). The owner/base pool has `BYPASSRLS` and is only for
migrations, seeding, login, the session store, and tenant resolution.

**Restart after re-seeding permissions.** The RBAC matrix is cached in memory.

---

## 7. Cookbook — add a new business domain

This section used to walk a hypothetical `quotations` resource — which has
since been **built for real** (M21), so the working implementation is now the
cookbook, and it is better than any prose: it carries the approval-workflow
wiring, the derived-state pattern, the write guards and the zero-movement
tests a new resource should copy. **Read these files in this order:**

1. `packages/db/src/schema/quotations.ts` — schema + the reasoning comments
2. `packages/db/migrations/0051_m21_1_quotations.sql` — RLS, CHECKs, grants
3. `apps/api/src/repositories/quotations.repository.ts`
4. `apps/api/src/services/quotations.service.ts` (+ `.approvable.ts`, `.presenter.ts`)
5. `apps/api/src/controllers/quotations.controller.ts` and `routes/quotations.ts`
6. `PERMISSION_MATRIX` in `packages/db/src/permissions.ts` — the `quotations` entry
7. `apps/api/src/tests/quotations.test.ts` — the zero-movement + permission tests

The steps below describe the same shape generically — follow them with the
files above open beside you.

1. **Schema** — add `packages/db/src/schema/quotations.ts` with `organization_id`
   (NOT NULL, FK to `organizations`) and `company_id` if it's ledger/accounting
   data; export it from `schema/index.ts`. Model it on an existing table
   (`invoices.ts`).
2. **Migration** — `pnpm --filter @workspace/db run generate`, then extend the
   generated SQL to **enable RLS** and add the `tenant_isolation` policy + app-role
   GRANTs for the new table (mirror an existing table's block in the RLS
   migrations — do **not** use `GRANT … ON ALL TABLES`; grant per-object). Apply
   with `migrate`.
3. **Permissions** — add `quotations` rows to `PERMISSION_MATRIX` in
   `packages/db/src/permissions.ts` (read=all roles; create/update=admin+accountant;
   delete=admin, matching the established default), then `run seed` and restart
   the API.
4. **OpenAPI** — add the paths/schemas to `packages/api-spec/openapi.yaml`, then
   `run codegen`.
5. **Repository** — `repositories/quotations.repository.ts`: tenant-scoped query
   methods only (RLS scopes them).
6. **Service** — `services/quotations.service.ts`: business logic; validate/parse
   with the generated Zod types; call the accounting core if it hits the ledger
   (never reimplement posting); call `auditService` on every create/update/delete.
7. **Controller** — `controllers/quotations.controller.ts`: parse input, call the
   service, shape the response.
8. **Route** — `routes/quotations.ts`: thin HTTP wiring; then mount it in
   `routes/index.ts` **behind the guard**:
   `router.use("/quotations", requirePermission("quotations"), quotations)`.
9. **Tests** — add service/repository tests, and a cross-tenant isolation test if
   it holds financial data. Run `pnpm run typecheck`, both test suites, and
   `build` before pushing.

Following these steps keeps the new domain tenant-isolated, permission-gated, and
audited — consistent with everything else.

## 8. Draft/approval workflow (M10)

The five financial records (journal entries, bills, invoices, payments-via-pay,
payroll runs) flow through **one generic engine** in
`apps/api/src/services/approval/`. Nothing is created "live": a record starts as
a **draft**, moves to **submitted** (the approver's queue), then **approved** —
and only an approved record affects the books (GL, balances, reports, VAT/Zakat).

**The engine never gets forked.** To bring an entity into the workflow you write
one adapter (`services/<entity>.approvable.ts`) implementing the `Approvable`
contract, and delegate the transitions from the service to `approvalService`:

1. **`state(entity)`** — map the entity's native status onto `draft | submitted |
   approved` (post-approval states like `paid`/`reversed` map to `approved`).
2. **`onApprove(entity, actor)`** — fire the entity's EXISTING activation path
   (JE post-to-GL; bill/payroll GL posting; invoice AR + ZATCA hash/QR). This is
   the only place the ledger is touched. Do the period-lock check here (approval
   time). **Never reimplement the accounting core** — call it.
3. **`onSubmit` / `onSendBack`** (optional) — only for entities with an editable
   draft stage; `send-back` records a `review_note`. JE omits both (it approves
   straight from draft).
4. **`snapshot` / `hardDelete`** — audit before-state and reject (hard-delete,
   no archive).

The service methods are thin: `submit`/`sendBack`/`reject`/`approve` just call
`approvalService.<t>(adapter, id, { userId })`. The engine owns the state guards
(fail-closed) and writes the audit entry (`submit`/`send_back`/`approve`/`reject`)
inside the request tenant transaction — atomic with the effect.

**Report filtering (the core invariant).** Every money read path must exclude
pre-approval records. Bills/invoices carry a status, so the reports repository
filters them with `approvedBillsOnly()` / `approvedInvoicesOnly()`
(`status NOT IN ('draft','submitted')`). JE/payroll have no direct report reads —
their only ledger effect is the JE posted at approval, so an unapproved draft
posts nothing. Prove it with a **zero-movement test** (copy
`tests/bills-approval-zero-movement.test.ts`): draft AND submitted move zero in
every relevant report; approval posts it.

**Authorization.** `submit` is a create-level (bookkeeper) action; `approve`,
`send-back`, `reject`, `pay` resolve to the `approve` action via the
`requirePermission` activation-route override (`lib/rbac.ts`) and are
approver-only. Add the sub-route verb to `APPROVE_ROUTE` if it's a new one.

**Provisioning roles.** Assign a user's role in the active org via
`/orgs/:orgId/members` (admin-of-that-org only; identity/infrastructure layer,
pre-`resolveTenant`). Membership role — not the vestigial global `users.role` —
governs business access.

**Out of scope (documented):** `transactions` is the raw operational feed and is
NOT approval-gated, so cash flow / Zakat base / dashboard & VAT summaries reflect
all transactions regardless of approval. Gating it is a deferred future feature.
