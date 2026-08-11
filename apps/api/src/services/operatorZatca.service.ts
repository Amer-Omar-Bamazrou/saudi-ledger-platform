/**
 * Operator-side ZATCA visibility (M12.8).
 *
 * ── What this deliberately does and does NOT expose ─────────────────────────
 * The M11.3 rule holds: platform-operator status grants ZERO access to any
 * tenant's financial data. Everything here is OPERATIONAL METADATA about the
 * e-invoicing pipeline — counts, statuses, ages, certificate expiry dates,
 * onboarding state. No invoice amounts, no customer names, no XML, no key
 * material. An operator can see that a company's queue is stuck; they cannot see
 * what is in it.
 *
 * ── The two failures this surface exists to catch ───────────────────────────
 * Both are QUIET NEGLECT rather than loud rejection, which is why they need a
 * place a human actually looks:
 *
 *   1. **A stalled outbox.** A rejected document is visible and someone acts on
 *      it. A simplified invoice silently missing ZATCA's 24-hour reporting
 *      deadline looks like nothing is wrong, and is legal exposure for the
 *      tenant from SAR 5,000.
 *   2. **An expiring PCSID.** At expiry, signing stops dead and the tenant
 *      cannot legally invoice. Renewal needs an OTP only THEY can obtain, so a
 *      late warning cannot be fixed by us at all.
 *
 * 🔴 This is VISIBILITY, not alerting. Nothing here pages a human. Wiring these
 * numbers to real alerting remains a documented pre-production requirement.
 */
import { loadEnv } from "@workspace/config";
import { ownerDb, companiesTable, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { einvoiceOutboxRepository } from "../repositories/einvoiceOutbox.repository";
import { einvoiceArchiveJobRepository } from "../repositories/einvoiceArchive.repository";
import { renewalService, REMINDER_THRESHOLDS_DAYS } from "./einvoice/renewal/renewal.service";
import { signingService } from "./einvoice/signing/signing.service";
import { getScheduler } from "../jobs";

const DAY_MS = 86_400_000;

export interface OutboxHealth {
  overdueMinutes: number;
  overdue: { total: number; oldestAgeMinutes: number | null; byFlow: Record<string, number> };
  needsReview: number;
  archive: { archived: number; pendingArchive: number };
  workerEnabled: boolean;
}

export const operatorZatcaService = {
  /** The outbox age alarm + archive coverage, in one call for the dashboard. */
  async health(): Promise<OutboxHealth> {
    const env = loadEnv();
    const overdueMinutes = env.ZATCA_OVERDUE_MINUTES;

    const [overdue, needsReview, archive] = await Promise.all([
      einvoiceOutboxRepository.listOverdue(overdueMinutes, 500),
      einvoiceOutboxRepository.listNeedingReview(500),
      einvoiceArchiveJobRepository.stats(),
    ]);

    const byFlow: Record<string, number> = {};
    for (const row of overdue) byFlow[row.flow] = (byFlow[row.flow] ?? 0) + 1;

    return {
      overdueMinutes,
      overdue: {
        total: overdue.length,
        // `listOverdue` orders by created_at, so the first row is the oldest.
        // Age matters more than count: one document 23 hours old is a bigger
        // problem than fifty that are 61 minutes old.
        oldestAgeMinutes: await oldestAgeMinutes(overdue[0]?.id),
        byFlow,
      },
      needsReview: needsReview.length,
      archive,
      workerEnabled: env.ZATCA_WORKER_ENABLED,
    };
  },

  /** Documents past the overdue threshold — metadata only, never the XML. */
  async overdue(limit = 100) {
    const env = loadEnv();
    const rows = await einvoiceOutboxRepository.listOverdue(env.ZATCA_OVERDUE_MINUTES, limit);
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      companyId: r.companyId,
      invoiceId: r.invoiceId,
      flow: r.flow,
      status: r.status,
      attemptCount: r.attemptCount,
      ambiguous: r.ambiguous,
    }));
  },

  /** Documents a human must reconcile. */
  async needsReview(limit = 100) {
    const rows = await einvoiceOutboxRepository.listNeedingReview(limit);
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      companyId: r.companyId,
      invoiceId: r.invoiceId,
      flow: r.flow,
      status: r.status,
      attemptCount: r.attemptCount,
      ambiguous: r.ambiguous,
    }));
  },

  /**
   * Certificates expiring inside `days`, with the reminder state and the
   * company they belong to.
   */
  async expiringCertificates(days = 90) {
    const [expiring, raised] = await Promise.all([
      renewalService.listExpiring(days),
      renewalService.listRaised(),
    ]);

    const now = Date.now();
    const byCredential = new Map<string, number[]>();
    for (const r of raised) {
      byCredential.set(r.credentialId, [...(byCredential.get(r.credentialId) ?? []), r.thresholdDays]);
    }

    const companies = await companyLabels(expiring.map((c) => c.companyId));

    return expiring.map((c) => {
      const daysRemaining = c.notAfter ? Math.floor((c.notAfter.getTime() - now) / DAY_MS) : null;
      return {
        credentialId: c.credentialId,
        companyId: c.companyId,
        companyName: companies.get(c.companyId)?.name ?? null,
        organizationId: companies.get(c.companyId)?.organizationId ?? null,
        environment: c.environment,
        notAfter: c.notAfter,
        daysRemaining,
        expired: daysRemaining !== null && daysRemaining < 0,
        remindersRaised: (byCredential.get(c.credentialId) ?? []).sort((a, b) => b - a),
        // Which windows have passed with no reminder recorded — the gap the
        // operator can actually act on by contacting the tenant.
        remindersMissing: REMINDER_THRESHOLDS_DAYS.filter(
          (t) =>
            daysRemaining !== null &&
            daysRemaining <= t &&
            !(byCredential.get(c.credentialId) ?? []).includes(t),
        ),
      };
    });
  },

  /**
   * Per-company ZATCA onboarding state.
   *
   * 🔴 Derived from `zatca_credentials.status`, NOT from a column on
   * `companies`. `companies.zatca_onboarding_status` existed from M12.1a and was
   * never written by any code — every row read 'not_started' forever, so a view
   * built on it would have reported that nobody had onboarded. It was dropped in
   * M12.8's migration; the vault is the single source of truth.
   */
  async onboardingStatus() {
    const env = loadEnv();
    const rows = await ownerDb
      .select({
        companyId: companiesTable.id,
        companyName: companiesTable.name,
        organizationId: companiesTable.organizationId,
        organizationName: organizationsTable.name,
        vatNumber: companiesTable.vatNumber,
        egsSerialNumber: companiesTable.egsSerialNumber,
      })
      .from(companiesTable)
      .leftJoin(organizationsTable, eq(companiesTable.organizationId, organizationsTable.id));

    return Promise.all(
      rows.map(async (row) => {
        const credential = await signingService.findActiveMetadata(row.companyId, env.ZATCA_ENVIRONMENT);
        return {
          ...row,
          environment: env.ZATCA_ENVIRONMENT,
          credentialStatus: credential?.status ?? "not_onboarded",
          notAfter: credential?.notAfter ?? null,
          // A company cannot onboard without a VAT number (M11.6 fails closed),
          // so this is the operator's first diagnostic for a stuck tenant.
          readyToOnboard: !!row.vatNumber,
        };
      }),
    );
  },

  /** Run one background job on demand — the jobs are useful with the worker off. */
  async runJob(name: string) {
    return { job: name, result: await getScheduler().runNow(name) };
  },

  jobNames() {
    return getScheduler().names();
  },
};

async function oldestAgeMinutes(documentId: string | undefined): Promise<number | null> {
  if (!documentId) return null;
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS minutes
       FROM einvoice_documents WHERE id = $1`,
    [documentId],
  );
  return rows[0] ? Math.floor(Number(rows[0].minutes)) : null;
}

async function companyLabels(companyIds: string[]) {
  const map = new Map<string, { name: string; organizationId: string }>();
  if (companyIds.length === 0) return map;
  const rows = await ownerDb
    .select({
      id: companiesTable.id,
      name: companiesTable.name,
      organizationId: companiesTable.organizationId,
    })
    .from(companiesTable);
  for (const r of rows) {
    if (companyIds.includes(r.id)) map.set(r.id, { name: r.name, organizationId: r.organizationId });
  }
  return map;
}
