/**
 * AI usage metering (AI-1a) — one row per model call.
 *
 * Owner decision: AI usage is metered per tenant and likely billable. Written
 * by the provider wrapper (`services/ai/metered.ts`) beside the call it
 * measures; append-only at the grants, because a meter someone can edit is
 * not a meter. Failures are rows too (`ok = false`) — a provider outage that
 * vanished from the meter would make the usage curve lie.
 */
import { pgTable, serial, text, timestamp, integer, boolean, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const aiUsageTable = pgTable(
  "ai_usage",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("ai_usage_org_created_idx").on(t.organizationId, t.createdAt),
    index("ai_usage_operation_idx").on(t.operation),
  ],
);

export type AiUsage = typeof aiUsageTable.$inferSelect;
