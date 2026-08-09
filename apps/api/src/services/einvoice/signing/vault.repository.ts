/**
 * Data access for `zatca_credentials` (M12.5).
 *
 * 🔴 DELIBERATELY NOT EXPORTED FROM `repositories/`.
 *
 * It lives inside `services/einvoice/signing/` rather than the repositories
 * barrel so that "who can reach key material" is answerable by reading imports.
 * `vault-boundary.test.ts` fails the build if `zatcaCredentialsTable` is imported
 * anywhere outside this directory.
 *
 * Every query uses `ownerDb` — the base/owner connection — because the table has
 * no app-role grants. Inside a request the `db` proxy resolves to the tenant
 * connection, which would fail; relying on that failure would be luck, not
 * design.
 *
 * This layer returns ENCRYPTED bytes only. Nothing here decrypts — that is the
 * signing service's sole job.
 */
import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import {
  ownerDb,
  zatcaCredentialsTable,
  type ZatcaCredentialRow,
  type ZatcaCredentialStatus,
  type ZatcaEnvironment,
} from "@workspace/db";

export interface NewCredential {
  companyId: string;
  environment: ZatcaEnvironment;
  kmsProvider: string;
  kmsKeyId: string;
  wrappedDataKey: Buffer;
  encryptedPrivateKey: Buffer;
  privateKeyIv: Buffer;
  privateKeyAuthTag: Buffer;
  csrPem: string;
  egsSerialNumber: string;
}

export const vaultRepository = {
  async insertPending(input: NewCredential): Promise<ZatcaCredentialRow> {
    const [row] = await ownerDb
      .insert(zatcaCredentialsTable)
      .values({ ...input, status: "pending_csr" })
      .returning();
    return row;
  },

  async findById(id: string): Promise<ZatcaCredentialRow | undefined> {
    const [row] = await ownerDb
      .select()
      .from(zatcaCredentialsTable)
      .where(eq(zatcaCredentialsTable.id, id))
      .limit(1);
    return row;
  },

  async findActive(
    companyId: string,
    environment: ZatcaEnvironment,
  ): Promise<ZatcaCredentialRow | undefined> {
    const [row] = await ownerDb
      .select()
      .from(zatcaCredentialsTable)
      .where(
        and(
          eq(zatcaCredentialsTable.companyId, companyId),
          eq(zatcaCredentialsTable.environment, environment),
          eq(zatcaCredentialsTable.status, "active"),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * Attach the issued certificate and activate, superseding any current active
   * credential IN ONE TRANSACTION.
   *
   * The partial unique index makes the database the guarantee: if two
   * onboardings race, one commits and the other fails the constraint rather than
   * leaving a company with two active credentials (and therefore an ambiguous
   * signing identity).
   */
  async activate(input: {
    id: string;
    certificatePem: string;
    sealedCsidSecret: { ciphertext: Buffer; iv: Buffer; authTag: Buffer };
    notBefore: Date | null;
    notAfter: Date | null;
  }): Promise<ZatcaCredentialRow> {
    return ownerDb.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(zatcaCredentialsTable)
        .where(eq(zatcaCredentialsTable.id, input.id))
        .limit(1);
      if (!target) throw new Error("credential not found");

      await tx
        .update(zatcaCredentialsTable)
        .set({ status: "superseded", rotatedAt: new Date() })
        .where(
          and(
            eq(zatcaCredentialsTable.companyId, target.companyId),
            eq(zatcaCredentialsTable.environment, target.environment),
            eq(zatcaCredentialsTable.status, "active"),
            ne(zatcaCredentialsTable.id, input.id),
          ),
        );

      const [row] = await tx
        .update(zatcaCredentialsTable)
        .set({
          status: "active",
          certificatePem: input.certificatePem,
          encryptedCsidSecret: input.sealedCsidSecret.ciphertext,
          csidSecretIv: input.sealedCsidSecret.iv,
          csidSecretAuthTag: input.sealedCsidSecret.authTag,
          notBefore: input.notBefore,
          notAfter: input.notAfter,
          activatedAt: new Date(),
        })
        .where(eq(zatcaCredentialsTable.id, input.id))
        .returning();
      return row;
    });
  },

  /**
   * Revoke and CRYPTO-SHRED.
   *
   * The wrapped data key is overwritten with an empty buffer, which makes the
   * ciphertext permanently undecryptable even to us. Metadata and the (public)
   * certificate are retained, because past invoices were signed under it and the
   * archive must stay verifiable for ZATCA's 6-11 year retention.
   */
  async revoke(id: string, reason: string): Promise<void> {
    await ownerDb
      .update(zatcaCredentialsTable)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        revokedReason: reason,
        wrappedDataKey: Buffer.alloc(0),
        encryptedPrivateKey: Buffer.alloc(0),
        encryptedCsidSecret: null,
      })
      .where(eq(zatcaCredentialsTable.id, id));
  },

  async updateStatus(id: string, status: ZatcaCredentialStatus): Promise<void> {
    await ownerDb
      .update(zatcaCredentialsTable)
      .set({ status })
      .where(eq(zatcaCredentialsTable.id, id));
  },

  /**
   * Active credentials expiring on or before `cutoff` — the query behind M12.8's
   * T-90/T-30/T-7 renewal reminders. Returns metadata only; no key material is
   * decrypted to answer it.
   */
  async listExpiringBefore(cutoff: Date): Promise<ZatcaCredentialRow[]> {
    return ownerDb
      .select()
      .from(zatcaCredentialsTable)
      .where(
        and(
          eq(zatcaCredentialsTable.status, "active"),
          isNotNull(zatcaCredentialsTable.notAfter),
          lte(zatcaCredentialsTable.notAfter, cutoff),
        ),
      );
  },
};
