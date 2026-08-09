import { pgTable, text, timestamp, uuid, index, customType } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/**
 * ZATCA credential vault (M12.5) — per-company signing keys and CSID credentials.
 *
 * 🔴 THIS TABLE HOLDS THE MOST SENSITIVE DATA IN THE PLATFORM. A leaked private
 * key lets someone issue legally-valid tax invoices in a tenant's name, creating
 * real tax liability for a real business.
 *
 * ── Owner-only: NO RLS, NO app-role grants ──────────────────────────────────
 * The sixth table on the established pattern (`security_audit_logs`,
 * `platform_operators`, `verification_reviews`, `verification_documents`,
 * `organization_invitations`) — but the reasoning here differs from those five.
 *
 * For them, owner-only kept identity data out of tenant scope. Here it is about
 * BLAST RADIUS UNDER APP-ROLE COMPROMISE. RLS answers "can org A read org B's
 * row". It does NOT answer "can a SQL-injection flaw in any of the ~18 business
 * domains read the CURRENT tenant's signing key" — under RLS it could, because
 * the app role is acting as that tenant. With no grants at all, the app role
 * cannot SELECT this table under any tenant context, so no business route is on
 * the attack path.
 *
 * The open TRUNCATE finding reinforces it: the app role holds TRUNCATE on every
 * business table and TRUNCATE BYPASSES RLS. A business-table vault would inherit
 * that exposure.
 *
 * Reachable only from `services/einvoice/signing/` on the BASE (owner)
 * connection. Full design: `docs/zatca/m12-5-credential-vault-design.md`.
 */

/** Raw bytes. node-postgres maps `bytea` to Buffer in both directions. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** Which ZATCA environment a credential belongs to. Identity is per environment. */
export const ZATCA_ENVIRONMENTS = ["sandbox", "simulation", "production"] as const;
export type ZatcaEnvironment = (typeof ZATCA_ENVIRONMENTS)[number];

/**
 * `pending_csr` — key generated, CSR built, no certificate yet.
 * `active`      — PCSID issued and in use. At most ONE per (company, environment).
 * `superseded`  — replaced by rotation. Retained: past invoices were signed with it.
 * `revoked`     — withdrawn. Key material crypto-shredded, metadata retained.
 */
export const ZATCA_CREDENTIAL_STATUSES = [
  "pending_csr",
  "active",
  "superseded",
  "revoked",
] as const;
export type ZatcaCredentialStatus = (typeof ZATCA_CREDENTIAL_STATUSES)[number];

export const zatcaCredentialsTable = pgTable(
  "zatca_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Per COMPANY, not per organization — ZATCA identity is per EGS unit, the
     * same rule that fixed the hash chain in M12.1a.
     *
     * No `organization_id` and no tenant GUC default: this table is never
     * reached through a tenant connection, so an RLS-shaped default would be
     * misleading. Tenancy is enforced by resolving company → org in the service.
     */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companiesTable.id),

    environment: text("environment").notNull(),
    status: text("status").notNull().default("pending_csr"),

    // ── Envelope encryption ──────────────────────────────────────────────────
    // The private key is encrypted with a per-company data key (DEK); the DEK is
    // itself wrapped by the KMS master key. The plaintext DEK is NEVER stored.
    /** 'aws-kms' | 'local-dev'. Stored so a dev-wrapped row is identifiable. */
    kmsProvider: text("kms_provider").notNull(),
    kmsKeyId: text("kms_key_id").notNull(),
    wrappedDataKey: bytea("wrapped_data_key").notNull(),

    /** PKCS#8 DER, AES-256-GCM under the DEK. */
    encryptedPrivateKey: bytea("encrypted_private_key").notNull(),
    privateKeyIv: bytea("private_key_iv").notNull(),
    privateKeyAuthTag: bytea("private_key_auth_tag").notNull(),

    /**
     * 🔴 The CSID secret is A SECRET, not a companion field.
     *
     * ZATCA returns it in the same JSON body as the certificate, so it reads
     * like metadata. It is the password half of the transport's Basic auth and
     * authenticates us to ZATCA as that taxpayer — encrypted exactly like the
     * private key, under the same DEK.
     */
    encryptedCsidSecret: bytea("encrypted_csid_secret"),
    csidSecretIv: bytea("csid_secret_iv"),
    csidSecretAuthTag: bytea("csid_secret_auth_tag"),

    // ── Non-secret companions ────────────────────────────────────────────────
    csrPem: text("csr_pem"),
    /** The CCSID/PCSID. Public by construction — embedded in every signed invoice. */
    certificatePem: text("certificate_pem"),
    egsSerialNumber: text("egs_serial_number"),

    notBefore: timestamp("not_before", { withTimezone: true }),
    /**
     * 🔴 The 5-year PCSID expiry, with NO grace period (confirmed 2026-08-09:
     * 2026-08-09 → 2031-08-08). At expiry signing stops dead and the tenant
     * cannot legally invoice. M12.8's T-90/T-30/T-7 reminders read this column.
     */
    notAfter: timestamp("not_after", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (table) => [
    index("zatca_credentials_company_idx").on(table.companyId, table.environment),
    index("zatca_credentials_not_after_idx").on(table.notAfter),
    // NOTE: the "one ACTIVE credential per (company, environment)" guarantee is a
    // PARTIAL unique index, which Drizzle cannot express. It is hand-written in
    // the migration (same as M11.7's pending-invitation index).
  ],
);

export type ZatcaCredentialRow = typeof zatcaCredentialsTable.$inferSelect;
