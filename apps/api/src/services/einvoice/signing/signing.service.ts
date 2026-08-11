/**
 * The narrow signing service (M12.5) — the ONLY code that decrypts key material.
 *
 * 🔴 A leaked ZATCA private key lets someone issue legally-valid tax invoices in
 * a tenant's name, creating real tax liability for a real business. Every design
 * choice below exists to make a leak require several independent mistakes rather
 * than one.
 *
 * ── Scoped access: plaintext never returns to a caller ──────────────────────
 * There is deliberately NO `getPrivateKey()`. Callers pass a callback; the
 * plaintext lives only for its duration and is zeroed in a `finally`. The
 * callback's RETURN VALUE is what escapes — a signature, a response — never the
 * key.
 *
 * ── The seven enforcement layers ────────────────────────────────────────────
 *  1. Type level  — no exported type carries a private-key field.
 *  2. Import guard— the vault repository lives here, not in `repositories/`;
 *                   `vault-boundary.test.ts` fails the build on outside imports.
 *  3. Serialisation — the credential handle's `toJSON()` THROWS. Stringifying it
 *                   is a bug and should be loud, not silently redacted.
 *  4. Logging     — nothing key-bearing is passed to a logger, ever.
 *  5. Errors      — `errorHandler` emits `err.message`, and a crypto library's
 *                   message can embed key material. Everything here is caught and
 *                   re-thrown as `SigningError` with a FIXED message.
 *  6. Memory      — plaintext lives in Buffers, zeroed in `finally`; DER goes
 *                   straight to a KeyObject, never through a PEM string.
 *  7. No HTTP     — no route returns key material. Onboarding takes an OTP and
 *                   returns status.
 *
 * Design: `docs/zatca/m12-5-credential-vault-design.md`
 */
import { createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { loadEnv } from "@workspace/config";
import type { ZatcaCredentialRow, ZatcaEnvironment } from "@workspace/db";
import { assertZatcaCurve, generateZatcaKeyPair } from "../crypto/keys";
import { buildZatcaCsr, type ZatcaCsrInput } from "../crypto/csr";
import {
  generateDataKey,
  getKeyWrapper,
  openWithDataKey,
  sealWithDataKey,
  type KeyWrapper,
} from "./keyWrapper";
import { vaultRepository } from "./vault.repository";

/**
 * The only error this module throws outward.
 *
 * The message is FIXED and carries no detail from the underlying failure,
 * because `errorHandler` puts `err.message` on the wire and an OpenSSL or KMS
 * error can quote key bytes. The real cause is logged internally.
 */
export class SigningError extends Error {
  readonly statusCode = 500;
  /**
   * The underlying failure is attached as `cause` for diagnosis. It is NEVER on
   * the wire: `errorHandler` emits only `err.message`, which is the fixed string
   * below. Without this the original error was discarded entirely, which made a
   * failure in the crypto path effectively undiagnosable.
   */
  constructor(
    public readonly stage: string,
    cause?: unknown,
  ) {
    super("ZATCA signing is unavailable for this company.", { cause });
    this.name = "SigningError";
  }
}

/**
 * The certificate ZATCA returned does not belong to the key we generated.
 *
 * 🔴 THIS IS NOT A THEORETICAL GUARD — it fires against ZATCA's own sandbox.
 * The sandbox's PRODUCTION CSID endpoint returns a SHARED CANNED CERTIFICATE
 * (`CN=TST-886431145-399999999900003`, "Maximum Speed Tech Supply LTD", issued
 * Jan 2024) which is bound to somebody else's key and carries a different VAT
 * number. Storing it would leave a company holding a credential that cannot
 * sign, or — worse — signing as another taxpayer.
 *
 * Unlike `SigningError` this message is safe to surface: it describes a
 * mismatch, and contains no key material.
 */
export class CertificateMismatchError extends Error {
  readonly statusCode = 502;
  constructor(readonly detail: string) {
    super(
      "The certificate ZATCA returned does not match this unit's signing key, so it was " +
        "NOT stored. In the sandbox this is expected: its production CSID endpoint returns a " +
        "shared test certificate that belongs to no one. Onboard against simulation or " +
        "production for a real credential.",
    );
    this.name = "CertificateMismatchError";
  }
}

/** Transport credentials, handed to the HTTP client and nothing else. */
export interface TransportCredentials {
  certificateBase64: string;
  secret: string;
}

/**
 * Wrap a secret-bearing object so that stringifying it throws instead of
 * quietly emitting the secret into a log line or an HTTP body.
 */
function guardSerialisation<T extends object>(value: T): T {
  Object.defineProperty(value, "toJSON", {
    enumerable: false,
    value() {
      throw new Error(
        "Refusing to serialise ZATCA credentials. If you need to send something, " +
          "send a derived value (a signature, a status) — never the credential.",
      );
    },
  });
  return value;
}

/** Zero a buffer. Best-effort defence: Buffers can be wiped, strings cannot. */
function wipe(...buffers: (Buffer | null | undefined)[]): void {
  for (const b of buffers) if (b && b.length) b.fill(0);
}

/**
 * Refuse a credential wrapped by the development wrapper when running in
 * production. This is the SECOND of two independent checks — `loadEnv` already
 * refuses the provider at boot — because shipping fake cryptography is the
 * failure that would be invisible until ZATCA rejected everything.
 */
function assertUsableProvider(row: ZatcaCredentialRow): void {
  if (loadEnv().NODE_ENV === "production" && row.kmsProvider === "local-dev") {
    throw new SigningError("dev-credential-in-production");
  }
}

async function unwrapDataKey(row: ZatcaCredentialRow, wrapper: KeyWrapper): Promise<Buffer> {
  if (row.kmsProvider !== wrapper.provider) {
    // Wrapped by a different provider than the one configured — unwrapping would
    // either fail obscurely or, worse, succeed against the wrong key.
    throw new SigningError("provider-mismatch");
  }
  return wrapper.unwrap(row.wrappedDataKey);
}

export const signingService = {
  /**
   * Generate a key pair, build the CSR, and store the key ENCRYPTED before it is
   * ever written anywhere. Returns the CSR (public) and the row id — never the
   * key.
   */
  async createCredential(input: {
    companyId: string;
    environment: ZatcaEnvironment;
    csr: ZatcaCsrInput;
  }): Promise<{ credentialId: string; csrPem: string; publicKeyPem: string }> {
    const wrapper = getKeyWrapper();
    let dataKey: Buffer | null = null;
    let privateKeyDer: Buffer | null = null;

    try {
      const { privateKey, publicKey, publicKeyPem } = generateZatcaKeyPair();
      assertZatcaCurve(privateKey);
      const csrPem = buildZatcaCsr(input.csr, privateKey, publicKey);

      // Straight to DER bytes — deliberately never a PEM string, which would be
      // immutable and unzeroable (the M12.3 prerequisite fixed in keys.ts).
      privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;

      dataKey = generateDataKey();
      const sealed = sealWithDataKey(privateKeyDer, dataKey);
      const wrappedDataKey = await wrapper.wrap(dataKey);

      const row = await vaultRepository.insertPending({
        companyId: input.companyId,
        environment: input.environment,
        kmsProvider: wrapper.provider,
        kmsKeyId: wrapper.keyId,
        wrappedDataKey,
        encryptedPrivateKey: sealed.ciphertext,
        privateKeyIv: sealed.iv,
        privateKeyAuthTag: sealed.authTag,
        csrPem,
        egsSerialNumber: input.csr.egsSerialNumber,
      });

      // The PUBLIC key is returned deliberately: it is public by construction
      // (it is in the CSR and every issued certificate), and callers need it to
      // verify a signature without ever touching the private half.
      return { credentialId: row.id, csrPem, publicKeyPem };
    } catch (err) {
      if (err instanceof SigningError) throw err;
      throw new SigningError("create", err);
    } finally {
      wipe(dataKey, privateKeyDer);
    }
  },

  /**
   * Attach the certificate and CSID secret returned by ZATCA, and activate.
   * The secret is sealed under the SAME data key as the private key — it is a
   * secret, not a companion field.
   */
  async activateCredential(input: {
    credentialId: string;
    certificatePem: string;
    csidSecret: string;
    notBefore: Date | null;
    notAfter: Date | null;
  }): Promise<void> {
    const wrapper = getKeyWrapper();
    let dataKey: Buffer | null = null;
    let secretBytes: Buffer | null = null;
    let der: Buffer | null = null;

    try {
      const row = await vaultRepository.findById(input.credentialId);
      if (!row) throw new SigningError("activate-missing");
      assertUsableProvider(row);

      dataKey = await unwrapDataKey(row, wrapper);

      // ── Refuse a certificate that is not ours ────────────────────────────
      // Correct in EVERY environment, and it catches the sandbox's canned
      // production CSID automatically. Done BEFORE anything is written, so a
      // mismatched certificate never reaches the vault.
      der = openWithDataKey(
        {
          ciphertext: row.encryptedPrivateKey,
          iv: row.privateKeyIv,
          authTag: row.privateKeyAuthTag,
        },
        dataKey,
      );
      const ourSpki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }))
        .export({ type: "spki", format: "der" }) as Buffer;
      const certSpki = new X509Certificate(input.certificatePem).publicKey.export({
        type: "spki",
        format: "der",
      }) as Buffer;
      if (!ourSpki.equals(certSpki)) {
        throw new CertificateMismatchError(
          `certificate subject ${new X509Certificate(input.certificatePem).subject.replace(/\n/g, " ")}`,
        );
      }

      secretBytes = Buffer.from(input.csidSecret, "utf8");
      const sealedCsidSecret = sealWithDataKey(secretBytes, dataKey);

      await vaultRepository.activate({
        id: input.credentialId,
        certificatePem: input.certificatePem,
        sealedCsidSecret,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
      });
    } catch (err) {
      // The mismatch is deliberately propagated: it is actionable, safe to show,
      // and must not be flattened into the generic signing failure.
      if (err instanceof CertificateMismatchError) throw err;
      if (err instanceof SigningError) throw err;
      throw new SigningError("activate", err);
    } finally {
      wipe(dataKey, secretBytes, der);
    }
  },

  /**
   * Run `fn` with a specific credential's key pair, by id.
   *
   * Needed by onboarding, which must sign the six compliance documents with a
   * credential that is still `pending_csr` — {@link withSigningKey} resolves the
   * ACTIVE credential and would not find it.
   *
   * Same contract: scoped callback, nothing escapes but the return value, and
   * the plaintext is zeroed in a `finally`. Do NOT add a variant that returns
   * the key — sign inside the callback and return the signed artifacts.
   */
  async withCredentialKey<T>(
    credentialId: string,
    fn: (keys: { privateKey: KeyObject; publicKey: KeyObject }) => T | Promise<T>,
  ): Promise<T> {
    const wrapper = getKeyWrapper();
    let dataKey: Buffer | null = null;
    let der: Buffer | null = null;

    try {
      const row = await vaultRepository.findById(credentialId);
      if (!row) throw new SigningError("credential-missing");
      assertUsableProvider(row);

      dataKey = await unwrapDataKey(row, wrapper);
      der = openWithDataKey(
        {
          ciphertext: row.encryptedPrivateKey,
          iv: row.privateKeyIv,
          authTag: row.privateKeyAuthTag,
        },
        dataKey,
      );
      const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      assertZatcaCurve(privateKey);
      return await fn({ privateKey, publicKey: createPublicKey(privateKey) });
    } catch (err) {
      if (err instanceof SigningError) throw err;
      throw new SigningError("sign-by-id", err);
    } finally {
      wipe(dataKey, der);
    }
  },

  /** Metadata for the onboarding status view. NO key material. */
  async findActiveMetadata(
    companyId: string,
    environment: ZatcaEnvironment,
  ): Promise<{ status: string; notAfter: Date | null; egsSerialNumber: string | null } | null> {
    const row = await vaultRepository.findActive(companyId, environment);
    if (!row) return null;
    return { status: row.status, notAfter: row.notAfter, egsSerialNumber: row.egsSerialNumber };
  },

  /** Read a certificate's validity window — public data, no vault access. */
  certificateValidity(certificatePem: string): { notBefore: Date; notAfter: Date } {
    const cert = new X509Certificate(certificatePem);
    return { notBefore: new Date(cert.validFrom), notAfter: new Date(cert.validTo) };
  },

  /**
   * Run `fn` with the decrypted private key. THE ONLY WAY to sign.
   *
   * The KeyObject and its DER source are confined to this call; only `fn`'s
   * return value escapes.
   */
  async withSigningKey<T>(
    companyId: string,
    environment: ZatcaEnvironment,
    fn: (key: KeyObject) => T | Promise<T>,
  ): Promise<T> {
    const wrapper = getKeyWrapper();
    let dataKey: Buffer | null = null;
    let der: Buffer | null = null;

    try {
      const row = await vaultRepository.findActive(companyId, environment);
      if (!row) throw new SigningError("no-active-credential");
      assertUsableProvider(row);

      dataKey = await unwrapDataKey(row, wrapper);
      der = openWithDataKey(
        {
          ciphertext: row.encryptedPrivateKey,
          iv: row.privateKeyIv,
          authTag: row.privateKeyAuthTag,
        },
        dataKey,
      );

      const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      assertZatcaCurve(key);
      return await fn(key);
    } catch (err) {
      if (err instanceof SigningError) throw err;
      throw new SigningError("sign", err);
    } finally {
      wipe(dataKey, der);
    }
  },

  /**
   * Run `fn` with the ACTIVE credential's full signing material — certificate
   * plus key pair (M12.8).
   *
   * {@link withSigningKey} yields only the private key, and {@link withCredentialKey}
   * addresses a credential by id (onboarding, where it is still `pending_csr`).
   * Stamping an invoice needs the certificate too — XAdES embeds it, and the QR
   * carries both its public key (tag 8) and the CA's signature over it (tag 9) —
   * so this is the accessor the issuance path uses.
   *
   * Same contract as its siblings, deliberately: a scoped callback, nothing
   * escapes but the return value, plaintext zeroed in a `finally`. The
   * certificate is public and could safely be returned on its own, but it is
   * passed through the callback anyway so there is exactly ONE shape for
   * reaching signing material. Do NOT add a variant that returns the key.
   */
  async withSigningCredentials<T>(
    companyId: string,
    environment: ZatcaEnvironment,
    fn: (credentials: { certificatePem: string; privateKey: KeyObject; publicKey: KeyObject }) => T | Promise<T>,
  ): Promise<T> {
    const wrapper = getKeyWrapper();
    let dataKey: Buffer | null = null;
    let der: Buffer | null = null;

    try {
      const row = await vaultRepository.findActive(companyId, environment);
      if (!row) throw new SigningError("no-active-credential");
      assertUsableProvider(row);
      if (!row.certificatePem) throw new SigningError("credential-not-activated");

      dataKey = await unwrapDataKey(row, wrapper);
      der = openWithDataKey(
        {
          ciphertext: row.encryptedPrivateKey,
          iv: row.privateKeyIv,
          authTag: row.privateKeyAuthTag,
        },
        dataKey,
      );

      const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
      assertZatcaCurve(privateKey);
      return await fn({
        certificatePem: row.certificatePem,
        privateKey,
        publicKey: createPublicKey(privateKey),
      });
    } catch (err) {
      if (err instanceof SigningError) throw err;
      throw new SigningError("sign", err);
    } finally {
      wipe(dataKey, der);
    }
  },

  /**
   * Run `fn` with the transport credentials (certificate + CSID secret) for
   * ZATCA's Basic auth. Scoped for the same reason as {@link withSigningKey}:
   * the secret reaches the HTTP client and nothing else.
   */
  async withTransportCredentials<T>(
    companyId: string,
    environment: ZatcaEnvironment,
    fn: (credentials: TransportCredentials) => T | Promise<T>,
  ): Promise<T> {
    const wrapper = getKeyWrapper();
    let dataKey: Buffer | null = null;
    let secretBytes: Buffer | null = null;

    try {
      const row = await vaultRepository.findActive(companyId, environment);
      if (!row) throw new SigningError("no-active-credential");
      assertUsableProvider(row);
      if (!row.certificatePem || !row.encryptedCsidSecret || !row.csidSecretIv || !row.csidSecretAuthTag) {
        throw new SigningError("credential-not-activated");
      }

      dataKey = await unwrapDataKey(row, wrapper);
      secretBytes = openWithDataKey(
        {
          ciphertext: row.encryptedCsidSecret,
          iv: row.csidSecretIv,
          authTag: row.csidSecretAuthTag,
        },
        dataKey,
      );

      const credentials = guardSerialisation<TransportCredentials>({
        // ZATCA's Basic-auth username is the base64 of the certificate.
        certificateBase64: Buffer.from(row.certificatePem, "utf8").toString("base64"),
        secret: secretBytes.toString("utf8"),
      });

      return await fn(credentials);
    } catch (err) {
      if (err instanceof SigningError) throw err;
      throw new SigningError("transport-credentials", err);
    } finally {
      wipe(dataKey, secretBytes);
    }
  },

  /**
   * Metadata for the M12.8 renewal reminders. Returns NO key material — the
   * 5-year PCSID expiry has no grace period, so this drives T-90/T-30/T-7 alerts.
   */
  async listExpiring(withinDays: number): Promise<
    { credentialId: string; companyId: string; environment: string; notAfter: Date | null }[]
  > {
    const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    const rows = await vaultRepository.listExpiringBefore(cutoff);
    return rows.map((r) => ({
      credentialId: r.id,
      companyId: r.companyId,
      environment: r.environment,
      notAfter: r.notAfter,
    }));
  },

  /** Revoke and crypto-shred. Metadata + public certificate retained. */
  async revokeCredential(credentialId: string, reason: string): Promise<void> {
    await vaultRepository.revoke(credentialId, reason);
  },
};
