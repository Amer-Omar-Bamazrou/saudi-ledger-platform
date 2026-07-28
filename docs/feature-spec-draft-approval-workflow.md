# Feature Spec — Draft/Approval Workflow + 4-Role Model

**Status:** Approved, **deferred**. Do **not** implement before Milestone 6.
**Target:** a new milestone **after M6 (Backend Layering)**. This feature must be
built in the **M6 service layer**, not in the current fat route handlers — the
draft→approval state machine and each entity's "on approve" action belong in
services/repositories, not in HTTP handlers.

**Owner decision:** approved by the product owner. This document captures the
agreed design so it isn't lost; it is a specification, not an implementation.

---

## 1. Summary

Introduce a **universal draft/approval workflow** across all financial records,
backed by a **4-role model** (adding **Bookkeeper**). Every financial record is
created as a **draft** that has **no effect on the accounts** (GL, balances,
reports, VAT/Zakat) until it is **approved**. This generalizes a pattern the
ledger already uses for journal entries (draft → posted) to all financial
records, and adds a role that can *enter* work but not *approve* it.

The goal is real-world bookkeeping separation of duties: a bookkeeper enters
transactions, an accountant/admin reviews and approves, and only approved records
touch the books.

---

## 2. Roles (4-role model — replaces the current 3 roles)

The current model is `admin | accountant | viewer`. This feature replaces it with
**four** roles. Roles remain sourced from `organization_memberships` (per M4) and
enforced via the centralized permission layer (per M5).

| Role | Financial data | Users & settings | Can approve? | Notes |
| --- | --- | --- | --- | --- |
| **Admin** | Full control | Full control (users, settings) | **Yes** | Superset of Accountant + administration. |
| **Accountant** | Full financial control | **No** user/settings access | **Yes** | Can create and self-approve financial records; cannot manage users or org settings. |
| **Bookkeeper** *(NEW)* | Create **drafts only** | No | **No** | Enters records; every record they create goes to `PENDING` for someone else to approve. |
| **Viewer** | Read-only | No | No | Unchanged from today. |

Key distinctions from the current 3-role model:
- **Accountant loses user/settings access** (today the coarse model effectively
  lets accountants do most writes; user management is admin-only already). Under
  this model, user/settings management is **Admin-only**, and Accountant is
  strictly financial.
- **Bookkeeper is new**: a create-drafts-only role with **no approval authority**.

> The permission matrix (M5, `packages/db` `PERMISSION_MATRIX`) must be extended
> for the 4th role and the new draft/approve actions. Because M5 authorization is
> **data-driven**, most of this is seed/matrix changes plus a new `approve`
> action — but the draft state machine itself is application logic (see §9).

---

## 3. Core principle — everything flows through drafts

**Every financial record is created as a draft.** A draft does **not** affect the
accounts in any way — not the general ledger, not account balances, not financial
reports, not VAT/Zakat computations — **until it is approved**.

- A **Bookkeeper**'s new record is created in `PENDING`, awaiting approval by an
  Accountant or Admin.
- An **Accountant** or **Admin** may **self-approve on create** — i.e. create and
  approve in one step, so their records become active immediately (they hold
  approval authority, so there is no one else to wait for).

There is no path by which a record affects the books without passing through
`APPROVED`.

---

## 4. Draft lifecycle (state machine)

```
              create
                │
     ┌──────────┴───────────┐
     │                      │  (Accountant/Admin self-approve on create)
     ▼                      ▼
  PENDING ───approve───► APPROVED ──(fires per-entity "on approve" action)
     │                      
     │                      
     ├─ reject: send back ──► (editable draft, back to PENDING on resubmit)
     │
     └─ reject: hard delete ─► (row removed — NO archive of rejected drafts)
```

**States:**
- **PENDING** — created, awaiting approval. No effect on the accounts.
- **APPROVED** — approved; the record is now active and its **per-entity "on
  approve" action fires** (see §5). Only approved records affect the books.

**Transitions:**
- `create` → `PENDING` (Bookkeeper), or `create` → `APPROVED` (Accountant/Admin
  self-approve on create).
- `approve` (`PENDING` → `APPROVED`) — performed by an Accountant or Admin. Fires
  the entity's on-approve action.
- `reject` — performed by an Accountant/Admin on a `PENDING` draft. Two options
  (approver's choice):
  1. **Send back** to the bookkeeper to **edit and resubmit** (stays a draft;
     resubmission returns it to `PENDING`), or
  2. **Hard delete** the draft.
  There is **no archive of rejected drafts** — a hard-rejected draft is deleted.

**Who can do what:**
- Bookkeeper: `create` (→ PENDING), edit their own PENDING drafts, resubmit.
- Accountant / Admin: everything above, plus `approve`, `reject (send back)`,
  `reject (delete)`, and self-approve-on-create.
- Viewer: none of the above (read-only, and see §8 on visibility of drafts).

---

## 5. Per-entity "on approve" action

Approval is not just a status flip — it **fires the entity's activation action**,
which is what actually affects the books. Each financial entity defines its own
on-approve behavior. Examples:

| Entity | On approve → |
| --- | --- |
| **Journal entry** | Posts to the GL (`status: posted`, `postedAt` stamped) — the existing posting path. |
| **Invoice** | Becomes an **active** invoice (recognized in AR / revenue, VAT applies, ZATCA/e-invoice hash chain as today). |
| **Bill** | Becomes an active bill (recognized in AP / expense, input VAT applies). |
| **Payment** | Applied against its invoice/bill; affects cash/bank and AR/AP. |
| **Payroll run** | Approved run posts its GL impact / becomes payable. |

The on-approve action must go through the **existing trusted accounting paths**
(GL posting, period-lock checks, VAT/Zakat, invoice hash chaining) — this feature
gates *when* those fire (on approval), it does not reimplement them. Period-lock
enforcement still applies at approval time.

---

## 6. Scope — which records

**In scope (all financial records):**
- Journal entries
- Invoices
- Bills
- Payments (customer receipts, vendor payments)
- Payroll (payroll runs)

**Explicitly excluded (reference / master data):**
- Categories, customers, vendors, products.

Reference data is **not** subject to draft/approval — it is created and edited
directly (still permission-gated per M5). **Confirm the exact in-scope entity
list at build time** against the then-current schema (e.g. treatment of credit
notes, debit notes, quotations, purchase orders, fixed-asset acquisitions) — the
principle is "anything that hits the ledger/balances flows through drafts; pure
master data does not."

---

## 7. Correctness requirement (non-negotiable)

**Reports, GL queries, and every balance/aggregate must filter to APPROVED
records only.** A `PENDING` draft must **never** affect any balance, statement,
tax computation, or aggregate — not trial balance, income statement, balance
sheet, cash flow, AR/AP aging, VAT return, or Zakat base.

Implications:
- Every read path that computes money (reports, summaries, dashboards, tax) must
  include the approved-status filter. This is the single most important
  invariant of the feature and must be covered by tests: create a `PENDING` draft
  for each entity type and assert **zero** movement in every balance/report until
  it is approved, then the expected movement after approval.
- Drafts may be **listed** in operational/worklist views (e.g. "pending
  approvals") but must be visually and structurally separated from posted data,
  and must never leak into financial aggregates.

---

## 8. Visibility of drafts

- A **pending-approvals worklist** shows drafts awaiting action, scoped to the
  tenant and to the approver's role.
- Bookkeepers see their own drafts and any sent back to them.
- Viewers see **approved** data only (drafts are operational, not part of the
  reported books).
- All draft visibility remains tenant-scoped (M3/M4 RLS + tenant context) and
  permission-gated (M5).

---

## 9. Alignment with the existing journal-entry engine

This feature **generalizes an existing pattern** rather than inventing a new one.
Today, `journal_entries` already separates *draft* from *posted-to-GL*:

- `journal_entries.status` is `draft | posted | reversed` (default `draft`), with
  a `posted_at` timestamp set on posting, and an index on
  `(organization_id, status)`.
- Posting is a distinct action (`POST /journal-entries/:id/post`) that transitions
  `draft → posted`.
- **Reports already filter `status = 'posted'`** for GL, trial balance, and
  statement queries — pending/draft entries do not affect balances today.

The draft/approval workflow **lifts this exact shape to every financial entity**:
a status that gates ledger impact, an explicit approval transition that fires the
activation action, and read paths that only aggregate the "active/approved" state.
Mapping: journal-entry `draft` ≈ `PENDING`, `posted` ≈ `APPROVED`, and the
existing "post to GL" is that entity's on-approve action. Where this feature adds
new behavior is the **approval authority** (who may flip the state — Bookkeeper
cannot) and the **generalization** to invoices/bills/payments/payroll.

---

## 10. Data-model implications (high level — finalize at build)

- Each in-scope entity needs an approval **status** (`pending | approved`) plus
  approval metadata (`approved_by`, `approved_at`, and, for send-backs, the
  submitting user). Journal entries already have a compatible `status` — reconcile
  its `draft|posted|reversed` vocabulary with `pending|approved` (likely keep the
  richer JE lifecycle and treat `draft`↔`pending`, `posted`↔`approved`).
- Composite indexes leading with `(organization_id, status)` on hot read paths
  (mirroring the existing `journal_entries_org_status_idx`).
- No archive table for rejected drafts (hard delete, per §4).
- Permission matrix gains the 4th role and an `approve` action; seed accordingly.

---

## 11. Where this must live (M6 dependency)

This feature is **gated on M6 (Route → Controller → Service → Repository
layering)** and must be built there:

- The **draft state machine** and each entity's **on-approve action** live in the
  **service layer**, invoked by controllers, with data access in repositories —
  **not** in route handlers. Building it in today's fat route files would bake
  business logic into HTTP handlers and have to be torn out during M6.
- Approval must reuse the existing accounting core (GL posting, period locks,
  VAT/Zakat, invoice hashing) through services — never reimplement it.

**Therefore: do not implement before M6 is complete.**

---

## 12. Non-goals / out of scope

- Multi-step / multi-level approval chains (only single approve by
  Accountant/Admin here).
- Configurable per-tenant approval policies (this is a fixed workflow).
- Archiving or audit-trailing of rejected drafts (hard delete; note that M7 audit
  logging will still record create/approve/reject *actions*).
- Changing the accounting logic itself — this only gates *when* it fires.
- Reference/master-data approval (explicitly excluded, §6).

---

## 13. Open questions to resolve at build time

1. Final in-scope entity list (credit/debit notes, quotations, POs, fixed-asset
   acquisitions?) — confirm against the schema at build time.
2. Exact status vocabulary reconciliation with the existing journal-entry
   `draft|posted|reversed` lifecycle (and reversal of an approved record).
3. Whether a Bookkeeper may edit a `PENDING` draft freely until first review, and
   what resubmission does to prior approver comments.
4. UI worklist design for pending approvals (out of scope for the accounting core;
   minimal until the platform's UI phase).
5. Interaction with period locks at approval time (a draft created in an open
   period but approved after the period locks — expected: approval is rejected
   with the standard closed-period error, same as posting today).
```

---

*This spec is deferred. See `CLAUDE.md` → Known Issues / Deferred. Do not
implement before M6.*
