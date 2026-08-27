/**
 * F2 — what the operator job runner may actually reach, decided HERE.
 *
 * 🔴 THE DEFECT THIS REPLACES. `POST /api/operator/zatca/jobs/:name/run`
 * validated the requested job against `getScheduler().names()` — **the whole
 * scheduler registry**. That registry is owned by `jobs/index.ts` and grows
 * whenever any milestone adds a background job, so the operator surface's reach
 * expanded every time, with nobody deciding that it should.
 *
 * The numbers at the time this was written:
 *
 *   - the operator UI offers **three** buttons (drain outbox, sweep archive,
 *     re-check renewals) — and the route's own doc-comment names those three;
 *   - the API permitted **nine**.
 *
 * The six nobody chose included jobs that write into tenants' ledgers, email
 * tenants' admins, irreversibly promote captures into a store that by design
 * cannot delete, purge staged bytes, and reset the demo database.
 *
 * 🔴 Neither file was wrong. `jobs/index.ts` correctly registers every job —
 * `runNow` is how a job stays operable with its timer off, which is a
 * deliberate and load-bearing design (the `ZATCA_WORKER_ENABLED` scope-drift
 * fix depends on it). `routes/operator.ts` correctly validates its input
 * against a list. The defect is the EDGE: one file's list became another
 * file's permission, so a registration decision silently doubled as an
 * authorization decision. That is the composition class named in CLAUDE.md §3
 * — invisible to any review reading one file at a time — and it is why this
 * audit enumerated the privilege's REACH rather than its routes.
 *
 * THE RULE: the operator surface declares its own reach. A job being
 * registered says nothing about whether an operator may run it; only this file
 * says that. `tests/operator-job-reach.test.ts` fails when the two lists
 * disagree in EITHER direction, so a new job cannot become operator-runnable by
 * default, and cannot be quietly forgotten either — it must be classified.
 */

/** Why a job is or is not reachable from the operator surface. */
export interface OperatorJobRule {
  /** May an authenticated platform operator trigger this job over HTTP? */
  readonly operatorRunnable: boolean;
  /** The reason, in the terms that decided it. Reviewed, not inferred. */
  readonly reason: string;
}

/**
 * Every registered job, classified. Keyed by the job's registered name.
 *
 * The three `true` entries are exactly the three the operator UI offers and the
 * route's doc-comment names — this restores the documented intent rather than
 * inventing a policy. Everything else is `false` because nothing ever decided
 * otherwise; each can be opened deliberately, with a surface to drive it.
 */
export const OPERATOR_JOB_RULES: Readonly<Record<string, OperatorJobRule>> = {
  "einvoice-outbox": {
    operatorRunnable: true,
    reason:
      "The reason this surface exists: a stalled outbox is quiet neglect against ZATCA's " +
      "24-hour reporting deadline, and draining it is the operator's documented act. " +
      "🔴 It TRANSMITS tenants' invoices to a tax authority — irreversible and external — " +
      "which is why the run is audited.",
  },
  "einvoice-archive": {
    operatorRunnable: true,
    reason: "Idempotent sweep; documented operator act; no external or tenant-visible effect.",
  },
  "zatca-renewal-reminders": {
    operatorRunnable: true,
    reason:
      "Documented operator act — chasing an expiring PCSID is the operator's job, since " +
      "renewal needs an OTP only the tenant can obtain. Emails the tenant's active admins, " +
      "which is the point of it rather than a side effect.",
  },

  // ── Not reachable from the operator surface ──────────────────────────────
  // None of these was ever a decision about operator authority; they became
  // reachable by being registered. Each is a tenant-data or destructive act.
  "capture-promotion": {
    operatorRunnable: false,
    reason:
      "Promotes a tenant's captured documents into an archive that by design has no delete " +
      "(ZATCA §5.5). Irreversible, and the erasability question is still open with the " +
      "advisor (C8) — not an act to expose on a maintenance panel.",
  },
  "capture-purge": {
    operatorRunnable: false,
    reason: "Deletes tenants' staged capture bytes and rows. Destructive tenant-data act.",
  },
  "recurring-documents": {
    operatorRunnable: false,
    reason:
      "Writes draft documents into tenants' ledgers. Drafts move no money, but authorship " +
      "matters: a document appearing in a tenant's ledger because a platform operator " +
      "pressed a button is not a thing the product should be able to do.",
  },
  "platform-alarms": {
    operatorRunnable: false,
    reason:
      "Harmless in itself — it pages OUR webhook, not a tenant — but no operator surface " +
      "offers it, and adding reach nobody asked for is the habit this file exists to break. " +
      "Flip to true with a button if manually testing paging turns out to be wanted.",
  },
  "demo-reset": {
    operatorRunnable: false,
    reason:
      "Wipes and re-seeds the database. 🔴 Its own precondition already refuses when " +
      "DEMO_MODE is off, so production was never reachable — but that guard lives in " +
      "another service, and 'safe because something else checks' is exactly the coupling " +
      "this audit is closing. Defence in depth: the surface does not offer it either.",
  },
  "scheduled-findings": {
    operatorRunnable: false,
    reason:
      "Creates tenant-visible findings runs and emails tenants' admins. An operator " +
      "triggering a tenant's quarterly review would forge the cadence the run claims to " +
      "represent (AI-5's (org, period) row is the CLAIM that a period was reviewed).",
  },
};

/** The job names an operator may trigger. The route's allowlist. */
export function operatorRunnableJobNames(): string[] {
  return Object.entries(OPERATOR_JOB_RULES)
    .filter(([, rule]) => rule.operatorRunnable)
    .map(([name]) => name);
}

/** True when `name` is classified AND operator-runnable. Unknown ⇒ false. */
export function isOperatorRunnable(name: string): boolean {
  return OPERATOR_JOB_RULES[name]?.operatorRunnable === true;
}
