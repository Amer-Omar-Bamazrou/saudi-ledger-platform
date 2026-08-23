import { pgTable, serial, text, timestamp, integer, uuid, jsonb, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * Findings (AI-3a) — the deterministic internal-consistency checks, as ROWS
 * with state, never a report file.
 *
 * 🔴 Scope is the owner's Q2 answer (2026-08-24): INTERNAL-CONSISTENCY ONLY
 * until C10 closes — duplicates, numbering gaps AS OBSERVATIONS (C12: gaps
 * are lawful), overdue documents, stale drafts, undeclared transfers,
 * unposted rows. Nothing here asserts a tax or compliance position; the
 * (b)-widening (citation-carrying checks like Art. 50 meal VAT) is QUEUED
 * for post-C10, recorded in ai-build-order-proposal.md §0.
 *
 * Identity: `(organization_id, kind, ref_key)` — re-running the checks
 * UPSERTS rather than duplicating, which is what lets `status` mean
 * something across runs: `open` (detected, unhandled), `acknowledged` (a
 * human decided it is known/intentional — SURVIVES re-detection),
 * `resolved` (the condition vanished from a later run — machine-set, never
 * user-set; the row is kept as the record that it was found).
 *
 * `delivered` records where the finding was sent (owner Q3: "otherwise 'we
 * told them' is unfalsifiable"). On-demand runs record in_app at creation;
 * the scheduled push channels (admin email + unread-escalation) land with
 * AI-5 and write into the same column.
 *
 * 🔴 No severity column, deliberately — the status palette is reserved for
 * real STATES (§4), and "how bad is a duplicate bill" is a judgment the
 * platform does not make. A finding is a kind plus facts, rendered in words.
 */
export const findingsTable = pgTable(
  "findings",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    /** Set only for per-company findings (invoice-number gaps). */
    companyId: uuid("company_id").references(() => companiesTable.id),
    kind: text("kind").notNull(),
    /** Stable identity of THIS finding within its kind — the upsert key. */
    refKey: text("ref_key").notNull(),
    /** The numbers and names the UI renders. Shape is per-kind, owned by the service. */
    facts: jsonb("facts").notNull(),
    status: text("status").notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** users.id of the acknowledger — identity resolution via the audit-trail precedent. */
    acknowledgedBy: integer("acknowledged_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Where this finding was sent: e.g. {"in_app": "<iso>"}; AI-5 adds email/escalation keys. */
    delivered: jsonb("delivered").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [unique("findings_org_kind_ref_key").on(t.organizationId, t.kind, t.refKey)],
);

export type Finding = typeof findingsTable.$inferSelect;
