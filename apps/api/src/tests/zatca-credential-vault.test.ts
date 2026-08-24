/**
 * M12.5 — the ZATCA credential vault.
 *
 * 🔴 The valuable tests here are the NEGATIVE ones. A leaked private key lets
 * someone issue legally-valid tax invoices in a tenant's name, so what matters
 * is not only that signing works but that key material cannot escape by any of
 * the routes it normally escapes by: serialisation, logging, error messages,
 * HTTP responses, or the database row itself.
 *
 * The `KeyWrapper` seam means all of this runs with NO KMS — deterministic and
 * offline. What it does NOT prove is that the AWS IAM/key policy is correct;
 * that is deployment verification (see the design doc, §8).
 */

// loadEnv() validates the whole environment; provide what CI's test job omits.
process.env.SESSION_SECRET ??= "zatca-vault-test-session-secret-0123456789abcdef";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.ZATCA_KMS_PROVIDER ??= "local-dev";
process.env.ZATCA_DEV_MASTER_KEY ??= "vault-test-master-key-not-a-real-secret-0123456789";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { pool } from "@workspace/db";
import {
  signingService,
  SigningError,
  CertificateMismatchError,
} from "../services/einvoice/signing/signing.service";
import { selfSignedCertificate } from "./helpers/selfSignedCert";
import { generateZatcaKeyPair as generateZatcaKeyPairForTest } from "../services/einvoice/crypto/keys";
import { vaultRepository } from "../services/einvoice/signing/vault.repository";
import {
  LocalDevKeyWrapper,
  generateDataKey,
  sealWithDataKey,
  openWithDataKey,
} from "../services/einvoice/signing/keyWrapper";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[zatca-credential-vault] no real DATABASE_URL — skipping DB tests.");

const SLUG = "m125-vault";

const CSR_INPUT: ZatcaCsrInput = {
  commonName: "SLP-EGS-VAULT-001",
  organizationName: "Vault Test Co",
  organizationalUnitName: "Head Office",
  countryName: "SA",
  invoiceType: "1100",
  locationAddress: "Riyadh",
  industryBusinessCategory: "Software",
  organizationIdentifier: "300000000000003",
  egsSerialNumber: "1-SLP|2-Vault|3-EGS001",
  production: false,
};

// ── Provider-agnostic unit tests (no DB) ────────────────────────────────────

describe("M12.5 — envelope encryption primitives", () => {
  it("round-trips a data key through the local wrapper", async () => {
    const wrapper = new LocalDevKeyWrapper("a-development-master-key");
    const dek = generateDataKey();
    const wrapped = await wrapper.wrap(dek);

    expect(wrapped.equals(dek)).toBe(false); // actually encrypted
    expect(await wrapper.unwrap(wrapped)).toEqual(dek);
  });

  it("produces a DIFFERENT wrapped blob each time (fresh IV per wrap)", async () => {
    const wrapper = new LocalDevKeyWrapper("a-development-master-key");
    const dek = generateDataKey();
    expect((await wrapper.wrap(dek)).equals(await wrapper.wrap(dek))).toBe(false);
  });

  it("refuses to unwrap a blob produced under a different master key", async () => {
    const wrapped = await new LocalDevKeyWrapper("master-one").wrap(generateDataKey());
    await expect(new LocalDevKeyWrapper("master-two").unwrap(wrapped)).rejects.toThrow();
  });

  it("detects tampering with the ciphertext (AES-GCM authentication)", () => {
    const dek = generateDataKey();
    const sealed = sealWithDataKey(Buffer.from("sensitive"), dek);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => openWithDataKey(sealed, dek)).toThrow();
  });

  it("exposes a key FINGERPRINT, never the master key itself", () => {
    const material = "a-development-master-key";
    const wrapper = new LocalDevKeyWrapper(material);
    expect(wrapper.keyId).toMatch(/^local-dev:[0-9a-f]{16}$/);
    expect(wrapper.keyId).not.toContain(material);
  });
});

// ── The import boundary (no DB needed) ──────────────────────────────────────

describe("M12.5 — the vault import boundary", () => {
  /**
   * "Who can reach key material" must be answerable by reading imports. If this
   * fails, someone has widened the blast radius — move the code into
   * `services/einvoice/signing/` or go through `signingService`.
   *
   * 🔴 DOCUMENTED LIMITATION (audit 2026-08-20, LOW): this is TEXT matching
   * on import statements — raw SQL against zatca_credentials would slip
   * past, the same tracked limitation as tests/identity-table-boundary. The
   * grants layer (owner-only table, REVOKEs) is the enforcement that does
   * not depend on reading source.
   */
  it("is imported by NOTHING outside services/einvoice/signing/", () => {
    const root = join(__dirname, "..");
    const allowedDir = join("services", "einvoice", "signing");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "node_modules") walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        if (full.includes(allowedDir)) continue;
        if (full.includes(join("src", "tests"))) continue; // this file asserts on it

        const src = readFileSync(full, "utf8");
        if (/zatcaCredentialsTable|vault\.repository/.test(src)) {
          offenders.push(full.replace(root, ""));
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});

// ── DB-backed: the full lifecycle and the leak guards ───────────────────────

describeMaybe("M12.5 — credential vault lifecycle", () => {
  let companyId: string;
  let otherCompanyId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM zatca_credentials WHERE company_id IN
         (SELECT id FROM companies WHERE organization_id IN
           (SELECT id FROM organizations WHERE slug = $1))`,
      [SLUG],
    );
    await pool.query(
      `DELETE FROM companies WHERE organization_id IN (SELECT id FROM organizations WHERE slug = $1)`,
      [SLUG],
    );
    await pool.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  }

  beforeAll(async () => {
    await cleanup();
    const org = await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('Vault','${SLUG}','approved') RETURNING id`,
    );
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Vault Co') RETURNING id`, [
        org.rows[0].id,
      ])
    ).rows[0].id;
    otherCompanyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Other Co') RETURNING id`, [
        org.rows[0].id,
      ])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  /**
   * Activation now REFUSES a certificate whose public key is not the
   * credential's own (M12.4 — it is what catches ZATCA's sandbox handing out a
   * shared canned certificate). So the fixture must be a REAL certificate that
   * genuinely binds this credential's key, not a placeholder PEM.
   */
  async function createAndActivate(company = companyId): Promise<{
    credentialId: string;
    publicKeyPem: string;
  }> {
    const { credentialId, publicKeyPem } = await signingService.createCredential({
      companyId: company,
      environment: "sandbox",
      csr: CSR_INPUT,
    });
    const certificatePem = await signingService.withCredentialKey(
      credentialId,
      ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey),
    );
    await signingService.activateCredential({
      credentialId,
      certificatePem,
      csidSecret: "the-csid-secret-value",
      notBefore: new Date("2026-08-09T00:00:00Z"),
      notAfter: new Date("2031-08-08T21:00:00Z"),
    });
    return { credentialId, publicKeyPem };
  }

  it("🔴 REFUSES a certificate that does not bind this credential's key", async () => {
    // The guard that catches ZATCA's sandbox production CSID — a shared
    // certificate bound to somebody else's key. Correct in every environment.
    const { credentialId } = await signingService.createCredential({
      companyId: companyId,
      environment: "simulation",
      csr: CSR_INPUT,
    });
    const strangerKey = generateZatcaKeyPairForTest();
    await expect(
      signingService.activateCredential({
        credentialId,
        certificatePem: selfSignedCertificate(strangerKey.privateKey, strangerKey.publicKey),
        csidSecret: "irrelevant",
        notBefore: null,
        notAfter: null,
      }),
    ).rejects.toBeInstanceOf(CertificateMismatchError);

    // Nothing was stored.
    const { rows } = await pool.query(
      `SELECT status, certificate_pem FROM zatca_credentials WHERE id = $1`,
      [credentialId],
    );
    expect(rows[0].status).toBe("pending_csr");
    expect(rows[0].certificate_pem).toBeNull();
  });

  it("stores the private key ENCRYPTED — the raw row contains no usable key", async () => {
    const { credentialId } = await signingService.createCredential({
      companyId,
      environment: "sandbox",
      csr: CSR_INPUT,
    });

    const { rows } = await pool.query(
      `SELECT encrypted_private_key, wrapped_data_key, kms_provider, kms_key_id, status
         FROM zatca_credentials WHERE id = $1`,
      [credentialId],
    );
    const row = rows[0];

    expect(row.status).toBe("pending_csr");
    expect(row.kms_provider).toBe("local-dev");
    // The plaintext DEK is never stored, and the key bytes are not PEM anywhere.
    const asText = row.encrypted_private_key.toString("utf8");
    expect(asText).not.toContain("PRIVATE KEY");
    expect(asText).not.toContain("BEGIN");
    expect(row.wrapped_data_key.length).toBeGreaterThan(28);
  });

  it("round-trips: the key retrieved for signing IS the key generated", async () => {
    const { publicKeyPem } = await createAndActivate();

    const message = Buffer.from("invoice-digest-to-be-signed");
    const signature = await signingService.withSigningKey(companyId, "sandbox", (key) =>
      createSign("sha256").update(message).sign(key),
    );

    // Verified with the PUBLIC key returned at creation — proves the exact key
    // pair survived encryption, storage and decryption.
    const ok = createVerify("sha256").update(message).verify(createPublicKey(publicKeyPem), signature);
    expect(ok).toBe(true);
  });

  it("🔴 refuses to serialise transport credentials (JSON.stringify throws)", async () => {
    await createAndActivate(otherCompanyId);

    await signingService.withTransportCredentials(otherCompanyId, "sandbox", (credentials) => {
      expect(credentials.secret).toBe("the-csid-secret-value");
      // The guard that stops a secret being logged or put in an HTTP body.
      expect(() => JSON.stringify(credentials)).toThrow(/Refusing to serialise/);
      expect(() => JSON.stringify({ nested: credentials })).toThrow(/Refusing to serialise/);
      return null;
    });
  });

  it("🔴 leaks nothing through the error message when there is no credential", async () => {
    const fresh = (
      await pool.query(
        `INSERT INTO companies (organization_id, name)
         VALUES ((SELECT id FROM organizations WHERE slug = $1),'No Creds') RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;

    const err = await signingService
      .withSigningKey(fresh, "sandbox", () => "unreachable")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SigningError);
    // A FIXED message: errorHandler puts err.message on the wire, and an OpenSSL
    // or KMS error can quote key bytes.
    expect((err as SigningError).message).toBe("ZATCA signing is unavailable for this company.");
    expect((err as SigningError).stage).toBe("no-active-credential");
  });

  it("🔴 leaks nothing when decryption itself fails (corrupted ciphertext)", async () => {
    const { credentialId } = await createAndActivate();
    await pool.query(
      `UPDATE zatca_credentials SET encrypted_private_key = decode('deadbeef','hex') WHERE id = $1`,
      [credentialId],
    );

    const err = await signingService
      .withSigningKey(companyId, "sandbox", () => "unreachable")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SigningError);
    expect((err as SigningError).message).toBe("ZATCA signing is unavailable for this company.");
    // No OpenSSL detail, no buffer dump, no stack content on the wire.
    expect(JSON.stringify(String((err as Error).message))).not.toMatch(/deadbeef|unsupported|tag/i);
  });

  it("rotation supersedes the old credential — exactly ONE stays active", async () => {
    const rotating = (
      await pool.query(
        `INSERT INTO companies (organization_id, name)
         VALUES ((SELECT id FROM organizations WHERE slug = $1),'Rotate Co') RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;

    const first = await createAndActivate(rotating);
    const second = await createAndActivate(rotating);

    const { rows } = await pool.query(
      `SELECT id, status FROM zatca_credentials WHERE company_id = $1 ORDER BY created_at`,
      [rotating],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));

    expect(byId[first.credentialId]).toBe("superseded");
    expect(byId[second.credentialId]).toBe("active");
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);

    // Superseded rows are RETAINED — past invoices were signed under them and the
    // archive must stay verifiable for ZATCA's 6-11 year retention.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("revocation crypto-shreds the key and makes signing impossible", async () => {
    const shredded = (
      await pool.query(
        `INSERT INTO companies (organization_id, name)
         VALUES ((SELECT id FROM organizations WHERE slug = $1),'Shred Co') RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;

    const { credentialId } = await createAndActivate(shredded);
    await signingService.revokeCredential(credentialId, "compromised");

    const { rows } = await pool.query(
      `SELECT status, wrapped_data_key, encrypted_private_key, certificate_pem
         FROM zatca_credentials WHERE id = $1`,
      [credentialId],
    );
    expect(rows[0].status).toBe("revoked");
    expect(rows[0].wrapped_data_key.length).toBe(0);
    expect(rows[0].encrypted_private_key.length).toBe(0);
    // Metadata + the PUBLIC certificate are retained for audit.
    expect(rows[0].certificate_pem).toContain("BEGIN CERTIFICATE");

    await expect(
      signingService.withSigningKey(shredded, "sandbox", () => "unreachable"),
    ).rejects.toBeInstanceOf(SigningError);
  });

  it("surfaces credentials expiring inside the reminder window (drives M12.8 T-90/30/7)", async () => {
    const expiring = (
      await pool.query(
        `INSERT INTO companies (organization_id, name)
         VALUES ((SELECT id FROM organizations WHERE slug = $1),'Expiring Co') RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;

    const { credentialId } = await createAndActivate(expiring);
    // 30 days out — inside a 90-day window, outside a 7-day one.
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(`UPDATE zatca_credentials SET not_after = $2 WHERE id = $1`, [credentialId, soon]);

    const within90 = await signingService.listExpiring(90);
    const within7 = await signingService.listExpiring(7);

    expect(within90.map((c) => c.credentialId)).toContain(credentialId);
    expect(within7.map((c) => c.credentialId)).not.toContain(credentialId);
    // Metadata only — no key material on the reminder path.
    expect(Object.keys(within90[0])).toEqual(["credentialId", "companyId", "environment", "notAfter"]);
  });

  it("🔴 refuses a credential wrapped by a DIFFERENT provider than the one configured", async () => {
    const mismatch = (
      await pool.query(
        `INSERT INTO companies (organization_id, name)
         VALUES ((SELECT id FROM organizations WHERE slug = $1),'Mismatch Co') RETURNING id`,
        [SLUG],
      )
    ).rows[0].id;

    const { credentialId } = await createAndActivate(mismatch);
    await pool.query(`UPDATE zatca_credentials SET kms_provider = 'aws-kms' WHERE id = $1`, [credentialId]);

    const err = await signingService
      .withSigningKey(mismatch, "sandbox", () => "unreachable")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SigningError);
    expect((err as SigningError).stage).toBe("provider-mismatch");
  });

  it("keeps each company's key separate — one company cannot sign as another", async () => {
    const a = await createAndActivate(companyId);
    const b = await createAndActivate(otherCompanyId);
    expect(a.publicKeyPem).not.toEqual(b.publicKeyPem);

    const message = Buffer.from("cross-company-check");
    const sigA = await signingService.withSigningKey(companyId, "sandbox", (k) =>
      createSign("sha256").update(message).sign(k),
    );

    // A's signature must NOT verify under B's public key.
    expect(
      createVerify("sha256").update(message).verify(createPublicKey(b.publicKeyPem), sigA),
    ).toBe(false);
  });

  it("never returns key material on any value it hands back", async () => {
    const created = await signingService.createCredential({
      companyId,
      environment: "sandbox",
      csr: CSR_INPUT,
    });
    // The returned object is safe to serialise: CSR and public key only.
    const serialised = JSON.stringify(created);
    expect(serialised).not.toContain("PRIVATE KEY");
    expect(Object.keys(created).sort()).toEqual(["credentialId", "csrPem", "publicKeyPem"]);
  });
});

// ── A guard that does not need the DB ───────────────────────────────────────

describe("M12.5 — key material never becomes an unzeroable string", () => {
  it("generateZatcaKeyPair no longer exports privateKeyPem (M12.3 prerequisite)", async () => {
    const { generateZatcaKeyPair } = await import("../services/einvoice/crypto/keys");
    const kp = generateZatcaKeyPair();
    expect(Object.keys(kp).sort()).toEqual(["privateKey", "publicKey", "publicKeyPem"]);
    expect((kp as unknown as Record<string, unknown>).privateKeyPem).toBeUndefined();
  });

  it("assertZatcaCurve validates without exporting the private key (M12.3 prerequisite)", async () => {
    const { assertZatcaCurve, generateZatcaKeyPair } = await import("../services/einvoice/crypto/keys");
    const kp = generateZatcaKeyPair();

    // Still fails closed on the wrong curve — the check was narrowed, not weakened.
    expect(() => assertZatcaCurve(kp.privateKey)).not.toThrow();
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(() => assertZatcaCurve(p256.privateKey)).toThrowError(/secp256k1/);
  });
});
