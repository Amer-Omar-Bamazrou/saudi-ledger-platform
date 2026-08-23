/**
 * Findings service (AI-3a) — runs the deterministic internal-consistency
 * checks and owns the finding rows' lifecycle.
 *
 * 🔴 THE INVARIANT THIS FILE EXISTS TO PROTECT: a findings run MOVES NOTHING.
 * No posting, no report figure, no tax number — it writes finding rows and
 * only finding rows. The zero-movement test pins this through the real
 * report services, the same standard every approvable entity carries.
 *
 * Lifecycle: a detected condition upserts by (kind, refKey) — `open` on
 * first sight, refreshed (facts + lastSeen) while it persists, REOPENED if
 * it had been machine-resolved and came back. `acknowledged` is a human's
 * review decision and SURVIVES re-detection — the machine never
 * un-acknowledges a human. A condition absent from a run is machine-resolved
 * and the row is KEPT: the record that it was found is part of the
 * who-finds-out trail, not clutter to purge.
 */
import { ConflictError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { findingsRepository, type DetectedFinding, type Finding } from "../repositories/findings.repository";
import { membersRepository } from "../repositories/members.repository";

/** Every kind the run scans — resolveMissing must see the FULL list, or a retired check's findings would stay open forever. */
export const ALL_FINDING_KINDS = [
  "duplicate_bill",
  "duplicate_transaction",
  "invoice_number_gap",
  "overdue_receivable",
  "overdue_payable",
  "stale_draft",
  "undeclared_transfer",
  "unposted_transaction",
] as const;

export interface FindingsRunSummary {
  created: number;
  reopened: number;
  refreshed: number;
  resolved: number;
  open: number;
}

function toApi(f: Finding, names?: Map<number, string>) {
  return {
    id: f.id,
    companyId: f.companyId,
    kind: f.kind,
    refKey: f.refKey,
    facts: f.facts as Record<string, unknown>,
    status: f.status,
    firstSeenAt: f.firstSeenAt.toISOString(),
    lastSeenAt: f.lastSeenAt.toISOString(),
    acknowledgedAt: f.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: f.acknowledgedBy,
    acknowledgedByName:
      f.acknowledgedBy != null ? (names?.get(f.acknowledgedBy) ?? null) : null,
    resolvedAt: f.resolvedAt?.toISOString() ?? null,
  };
}

export const findingsService = {
  async run(): Promise<FindingsRunSummary> {
    const detected: DetectedFinding[] = (
      await Promise.all([
        findingsRepository.duplicateBills(),
        findingsRepository.duplicateTransactions(),
        findingsRepository.invoiceNumberGaps(),
        findingsRepository.overdueReceivables(),
        findingsRepository.overduePayables(),
        findingsRepository.staleDrafts(),
        findingsRepository.undeclaredTransfers(),
        findingsRepository.unpostedTransactions(),
      ])
    ).flat();

    let created = 0;
    let reopened = 0;
    let refreshed = 0;
    const touchedIds: number[] = [];

    for (const d of detected) {
      const [existing] = await findingsRepository.findByKey(d.kind, d.refKey);
      if (!existing) {
        const [row] = await findingsRepository.insert({
          kind: d.kind,
          refKey: d.refKey,
          companyId: d.companyId,
          facts: d.facts,
        });
        created += 1;
        touchedIds.push(row.id);
      } else if (existing.status === "resolved") {
        await findingsRepository.refresh(existing.id, d.facts, true);
        reopened += 1;
        touchedIds.push(existing.id);
      } else {
        // open stays open; acknowledged stays acknowledged.
        await findingsRepository.refresh(existing.id, d.facts, false);
        refreshed += 1;
      }
    }

    const detectedKeys = new Set(detected.map((d) => `${d.kind}|${d.refKey}`));
    const resolved = await findingsRepository.resolveMissing([...ALL_FINDING_KINDS], detectedKeys);

    // The delivery record (owner Q3): an on-demand run's new/reopened findings
    // are delivered in-app at this moment — the person who ran it is looking.
    await findingsRepository.markDeliveredInApp(touchedIds);

    const counts = await findingsRepository.counts();
    const summary = { created, reopened, refreshed, resolved, open: counts.open };
    await auditService.record({
      action: "create",
      entityType: "findings_run",
      entityId: "on-demand",
      after: summary,
    });
    return summary;
  },

  async list(filter: { status?: string; kind?: string }, organizationId: string) {
    const [rows, counts] = await Promise.all([
      findingsRepository.list(filter),
      findingsRepository.counts(),
    ]);
    // Acknowledger names via the identity layer, scoped to THIS org's own
    // memberships — the M23 precedent, negative property included: a userId
    // with no membership here stays unresolved.
    const ids = [...new Set(rows.map((r) => r.acknowledgedBy).filter((x): x is number => x != null))];
    const names = ids.length ? await membersRepository.memberNamesByIds(organizationId, ids) : undefined;
    return { findings: rows.map((r) => toApi(r, names)), counts };
  },

  async acknowledge(id: number, userId: number | null, organizationId: string) {
    const [existing] = await findingsRepository.findById(id);
    if (!existing) throw new NotFoundError("Finding not found");
    if (existing.status === "resolved") {
      throw new ConflictError(
        "This finding is already resolved — the condition it described is no longer detected, so there is nothing to acknowledge.",
      );
    }
    const [row] = await findingsRepository.acknowledge(id, userId);
    if (!row) throw new NotFoundError("Finding not found");
    await auditService.record({ action: "update", entityType: "finding", entityId: id, before: existing, after: row });
    const names =
      row.acknowledgedBy != null
        ? await membersRepository.memberNamesByIds(organizationId, [row.acknowledgedBy])
        : undefined;
    return toApi(row, names);
  },
};
