import { pgTable, integer, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { zatcaCredentialsTable } from "./zatcaCredentials";

/**
 * PCSID expiry reminders already raised (M12.8).
 *
 * ── Why a table rather than a timestamp on the credential ───────────────────
 * The reminder job runs on a schedule and must not re-notify on every pass. It
 * could have set `last_reminder_at` on `zatca_credentials`, but the credential
 * row is the vault's — mutating it for notification bookkeeping widens what
 * touches the table holding signing keys, for no benefit. A separate table also
 * makes the natural idempotency key expressible directly:
 * **one row per (credential, threshold)**, unique.
 *
 * That uniqueness is the mechanism, not a nicety. The scheduler is in-process
 * and single-instance today, so two API instances with the worker enabled would
 * each run the check — and duplicate reminders about a certificate that stops
 * signing would train the tenant to ignore them. Making the DB the guarantee
 * means correctness does not depend on a deployment assumption.
 *
 * ── Owner-only, like the vault ──────────────────────────────────────────────
 * No RLS and no app-role grants. It carries no key material, but it is keyed to
 * `zatca_credentials`, is written only by a background job on the owner
 * connection, and is read only by the operator surface — no business route is
 * on its path. The migration REVOKEs the Supabase default
 * REFERENCES/TRIGGER/TRUNCATE grants for the same reason M12.5 did.
 */
export const zatcaCredentialRemindersTable = pgTable(
  "zatca_credential_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => zatcaCredentialsTable.id, { onDelete: "cascade" }),
    /** Company, denormalised so the operator view needs no join into the vault. */
    companyId: uuid("company_id").notNull(),

    /** 90, 30 or 7 — which T-minus window this reminder announced. */
    thresholdDays: integer("threshold_days").notNull(),
    /** The `not_after` in force when the reminder was raised. */
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),

    /**
     * Whether the notification actually went anywhere.
     *
     * 🔴 The platform's `mailer` is still a no-op that reports
     * `delivered: false`, so today this records `false` and the reminder is
     * visible ONLY in the app and the operator UI. That is recorded rather than
     * assumed: an absent reminder is worse than a late one here, because
     * renewal needs an OTP only the TENANT can obtain from their own Fatoora
     * portal — we cannot fix a missed deadline on their behalf.
     */
    emailDelivered: text("email_delivered").notNull().default("false"),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("zatca_credential_reminders_unq").on(table.credentialId, table.thresholdDays),
    index("zatca_credential_reminders_company_idx").on(table.companyId),
  ],
);

export type ZatcaCredentialReminderRow = typeof zatcaCredentialRemindersTable.$inferSelect;
