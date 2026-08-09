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
import { createPrivateKey, type KeyObject } from "node:crypto";
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
  constructor(public readonly stage: string) {
    super("ZATCA signing is unavailable for this company.");
    this.name = "SigningError";
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
      throw new SigningError("create");
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

    try {
      const row = await vaultRepository.findById(input.credentialId);
      if (!row) throw new SigningError("activate-missing");
      assertUsableProvider(row);

      dataKey = await unwrapDataKey(row, wrapper);
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
      if (err instanceof SigningError) throw err;
      throw new SigningError("activate");
    } finally {
      wipe(dataKey, secretBytes);
    }
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
      throw new SigningError("sign");
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
      throw new SigningError("transport-credentials");
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
