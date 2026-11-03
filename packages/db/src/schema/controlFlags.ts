/**
 * 🔴 Phase 18 R-11a — DR-14 (owner, 2026-11-01; register §11.82, §11.111): "flags only (self-approval; pairs
 * first). A flag never blocks an act. No new approval framework."
 *
 * A CONTROL FLAG records that one person did both halves of something a second person usually does: approved a
 * document they made (self-approval), or did both acts of one of the five pairs (approve → pay a bill, post →
 * reverse a journal, complete → reopen a reconciliation, commit → reverse a migration, remit → file a WHT month).
 *
 *  - The flag NEVER blocks: it is written in the same transaction as the act it describes, after the act, so a
 *    refused or rolled-back act leaves no flag, and a flag never stops one.
 *  - APPEND-ONLY for every role, the owner included, while its company exists (`control_flags_append_only`, register
 *    §11.113): never edited or truncated, and removed only by the cascade of its company's own removal (no product
 *    route removes a company). The only other bypass is replica mode (owner-only, the test cleanups).
 *  - `actor_user_id` is the connection's DECLARED ACTOR (T1b): the column defaults to it, and the database refuses a
 *    row naming anyone else — a flag records who acted, never a person its writer chose.
 *  - Read by the approvers (`control_flags` read: admin, accountant) on Company settings.
 */
import { pgTable, serial, uuid, integer, text, timestamp, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const CONTROL_FLAG_KINDS = [
  "self_approval",
  "pair_approve_pay",
  "pair_post_reverse",
  "pair_complete_reopen",
  "pair_commit_reverse",
  "pair_remit_file",
] as const;
export type ControlFlagKind = (typeof CONTROL_FLAG_KINDS)[number];

export const controlFlagsTable = pgTable(
  "control_flags",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ControlFlagKind>().notNull(),
    /** The connection's declared actor (T1b) — the database refuses any other. */
    actorUserId: integer("actor_user_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_user_id', true), ''))::integer`),
    /** The document the two acts were about (the audit trail's entity type and id). */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** Its number as a reader knows it (an invoice number, a period), when it has one. */
    reference: text("reference"),
    /** The two acts, in words the reader's list shows (e.g. "created" / "approved"). */
    firstAct: text("first_act").notNull(),
    secondAct: text("second_act").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "control_flags_kind_chk",
      sql`${t.kind} in ('self_approval', 'pair_approve_pay', 'pair_post_reverse', 'pair_complete_reopen', 'pair_commit_reverse', 'pair_remit_file')`,
    ),
    index("control_flags_company_idx").on(t.companyId, t.createdAt),
  ],
);
