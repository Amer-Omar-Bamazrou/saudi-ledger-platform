import { pgTable, uuid, integer, varchar, text, timestamp, bigint, index, check, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

/** Raw bytes. node-postgres maps `bytea` to Buffer in both directions. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * 🔴 Phase 19A (19.1/19.2, owner approval 2026-11-17) — a person's second factor: ONE TOTP secret per account, sealed
 * exactly as a ZATCA private key is (AES-256-GCM under a per-row data key, the data key wrapped by the KMS master key —
 * `services/einvoice/signing/keyWrapper.ts`). The plaintext secret exists in memory only: while it is shown once at
 * enrolment, and while a code is checked. Production therefore depends on the KMS (queue C3).
 *
 * Identity layer: no organization, no RLS, OWNER-ONLY (0166 revokes explicitly). `pending` until one correct code
 * activates it; an ACTIVE factor's secret is never rewritten (0166's trigger) — replacing it is a reset, a separate
 * audited act. `last_used_step` is the replay guard: a step is accepted once.
 */
export const userMfaFactorsTable = pgTable(
  "user_mfa_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
    state: varchar("state", { length: 10 }).notNull().default("pending"),
    kmsProvider: text("kms_provider").notNull(),
    kmsKeyId: text("kms_key_id").notNull(),
    wrappedDataKey: bytea("wrapped_data_key").notNull(),
    encryptedSecret: bytea("encrypted_secret").notNull(),
    secretIv: bytea("secret_iv").notNull(),
    secretAuthTag: bytea("secret_auth_tag").notNull(),
    /** The last TOTP step accepted for this factor; a code from that step or an earlier one is refused. */
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [
    check("user_mfa_factors_state_chk", sql`${t.state} in ('pending', 'active')`),
    check("user_mfa_factors_activated_chk", sql`(${t.state} = 'active') = (${t.activatedAt} is not null)`),
  ],
);

/**
 * 🔴 Phase 19A (19.3) — single-use recovery codes, issued when the factor is activated and shown ONCE. Stored only as
 * hashes made by the password seam (`lib/password.ts`); consumed in the transaction that accepts one. Owner-only.
 */
export const userMfaRecoveryCodesTable = pgTable(
  "user_mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("user_mfa_recovery_codes_user_idx").on(t.userId)],
);

export type UserMfaFactor = typeof userMfaFactorsTable.$inferSelect;
