/**
 * The KMS seam (M12.5) — envelope encryption for ZATCA private keys.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *   private key (PKCS#8 DER) --AES-256-GCM--> encrypted_private_key
 *                       key: DEK (32 random bytes, PER COMPANY)
 *   DEK --KMS wrap--> wrapped_data_key        (the plaintext DEK is never stored)
 *
 * ── Why ONE platform CMK, not one per tenant ────────────────────────────────
 * A CMK costs ~$1/month. Per tenant that is $1,000/month at 1,000 tenants FOR
 * IDENTICAL ISOLATION: a per-company DEK already gives the property that matters
 * — compromising one DEK exposes exactly one company. The CMK only ever wraps
 * DEKs, never invoice data.
 *
 * ── Why an interface at all ─────────────────────────────────────────────────
 * The provider is chosen at DEPLOYMENT. The KSA data-residency decision is still
 * open, the CMK must live in a region consistent with wherever invoice data
 * lands, and committing to a KMS now would partially pre-decide the hosting
 * provider. Same hedge as M12.8's storage backend.
 *
 * DEK caching is deliberately NOT implemented: it would keep plaintext DEKs
 * resident in memory to save $0.03 per 10,000 requests. Cost is not the
 * constraint; memory residency is.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { loadEnv } from "@workspace/config";

export type KmsProvider = "aws-kms" | "local-dev";

export interface KeyWrapper {
  readonly provider: KmsProvider;
  /** Recorded on the row so a dev-wrapped credential is identifiable forever. */
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

/** A fresh 256-bit data key. */
export function generateDataKey(): Buffer {
  return randomBytes(32);
}

/** AES-256-GCM payload. Split out because both the DEK and the row use it. */
export interface SealedBytes {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function sealWithDataKey(plaintext: Buffer, dataKey: Buffer): SealedBytes {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function openWithDataKey(sealed: SealedBytes, dataKey: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", dataKey, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/**
 * Development/test wrapper — AES-256-GCM under a master key from the
 * environment. NEVER reachable in production: `loadEnv` refuses the provider at
 * boot, and the signing service refuses rows stored with it at use time.
 */
export class LocalDevKeyWrapper implements KeyWrapper {
  readonly provider = "local-dev" as const;
  readonly keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKeyMaterial: string) {
    // Hash rather than parse, so any length/encoding of input yields 32 bytes.
    this.#masterKey = createHash("sha256").update(masterKeyMaterial, "utf8").digest();
    // A fingerprint, not the key — safe to store and to log.
    this.keyId = `local-dev:${createHash("sha256").update(this.#masterKey).digest("hex").slice(0, 16)}`;
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    const { ciphertext, iv, authTag } = sealWithDataKey(dataKey, this.#masterKey);
    // iv(12) || authTag(16) || ciphertext — self-describing, like a KMS blob.
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, 12);
    const authTag = wrapped.subarray(12, 28);
    const ciphertext = wrapped.subarray(28);
    return openWithDataKey({ ciphertext, iv, authTag }, this.#masterKey);
  }
}

/** The slice of `@aws-sdk/client-kms` we use, declared locally (see below). */
interface KmsModule {
  KMSClient: new (config: Record<string, unknown>) => {
    send: (command: unknown) => Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
  };
  EncryptCommand: new (input: Record<string, unknown>) => unknown;
  DecryptCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * AWS KMS wrapper.
 *
 * 🔴 `@aws-sdk/client-kms` is deliberately NOT a package dependency, and the
 * import specifier is a runtime variable so neither TypeScript nor esbuild pulls
 * it into the build graph. That is the point of the deployment-time provider
 * choice: a deployment that selects `local-dev` (or a future non-AWS KMS) must
 * not be forced to carry the AWS SDK. Installing it is a DEPLOYMENT step,
 * documented in the design doc's dependency table.
 */
export class AwsKmsKeyWrapper implements KeyWrapper {
  readonly provider = "aws-kms" as const;
  readonly keyId: string;
  readonly #region: string | undefined;
  #module: KmsModule | null = null;
  #client: InstanceType<KmsModule["KMSClient"]> | null = null;

  constructor(keyId: string, region?: string) {
    this.keyId = keyId;
    this.#region = region;
  }

  async #load(): Promise<KmsModule> {
    if (this.#module) return this.#module;
    const specifier = "@aws-sdk/client-kms";
    try {
      this.#module = (await import(/* @vite-ignore */ specifier)) as KmsModule;
    } catch {
      throw new Error(
        "ZATCA_KMS_PROVIDER is 'aws-kms' but @aws-sdk/client-kms is not installed. " +
          "Install it in the deployment that selects the AWS provider.",
      );
    }
    return this.#module;
  }

  async #kms(): Promise<InstanceType<KmsModule["KMSClient"]>> {
    if (!this.#client) {
      const { KMSClient } = await this.#load();
      this.#client = new KMSClient(this.#region ? { region: this.#region } : {});
    }
    return this.#client;
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    const { EncryptCommand } = await this.#load();
    const kms = await this.#kms();
    const out = await kms.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: dataKey }));
    if (!out.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
    return Buffer.from(out.CiphertextBlob);
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const { DecryptCommand } = await this.#load();
    const kms = await this.#kms();
    // KeyId is passed explicitly so a blob wrapped under a DIFFERENT key is
    // rejected rather than silently decrypted by whatever key the blob names.
    const out = await kms.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: this.keyId }));
    if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
    return Buffer.from(out.Plaintext);
  }
}

let cached: KeyWrapper | null = null;

/** The configured wrapper, built once from validated env. */
export function getKeyWrapper(): KeyWrapper {
  if (cached) return cached;
  const env = loadEnv();

  if (env.ZATCA_KMS_PROVIDER === "aws-kms") {
    // loadEnv's superRefine guarantees the key id is present here.
    cached = new AwsKmsKeyWrapper(env.ZATCA_KMS_KEY_ID!, env.ZATCA_KMS_REGION);
    return cached;
  }

  if (!env.ZATCA_DEV_MASTER_KEY) {
    throw new Error(
      "ZATCA_DEV_MASTER_KEY is required when ZATCA_KMS_PROVIDER is 'local-dev'. " +
        "Set any 32+ character development value — it is refused in production.",
    );
  }
  cached = new LocalDevKeyWrapper(env.ZATCA_DEV_MASTER_KEY);
  return cached;
}

/** Test-only: drop the memoized wrapper so a different provider can be built. */
export function resetKeyWrapperForTests(): void {
  cached = null;
}
