/**
 * Storage client (M11.4) — a thin, dependency-free wrapper over the Supabase
 * Storage REST API (reached with the global `fetch`, no SDK).
 *
 * Design invariants:
 *   - API-BROKERED ONLY. Every call here runs server-side with the service-role
 *     key; the key never reaches the browser. Clients upload/download through our
 *     API, which authorizes each request against OUR membership/operator model —
 *     we do NOT rely on Supabase Storage's own RLS (it does not know our model).
 *   - The bucket is PRIVATE; objects are addressed by org-prefixed paths.
 *
 * Not configured? `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are optional so the
 * app boots without storage; document endpoints then fail with a clear 503.
 */
import { loadEnv } from "@workspace/config";
import { AppError } from "./errors";

export interface StorageConfig {
  baseUrl: string;
  serviceKey: string;
  bucket: string;
}

/**
 * Resolve credentials for an arbitrary bucket (M12.8).
 *
 * M11.4 hard-bound this module to one bucket. The e-invoice archive is a
 * SECOND bucket with a different lifetime (6–11 years) and a different access
 * model, so the bucket became a parameter. The auth header and object-URL
 * construction stay in ONE place rather than being copied into the archive
 * backend — that copying is exactly how M11.6's production blocker happened.
 */
export function bucketConfig(bucket: string): StorageConfig {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError(503, "Object storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }
  return {
    baseUrl: env.SUPABASE_URL.replace(/\/+$/, ""),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket,
  };
}

function config(): StorageConfig {
  return bucketConfig(loadEnv().VERIFICATION_DOCS_BUCKET);
}

/** True when both storage credentials are present. */
export function isStorageConfigured(): boolean {
  const env = loadEnv();
  return !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
}

export const authHeader = (c: StorageConfig) => ({ Authorization: `Bearer ${c.serviceKey}` });
export const objectUrl = (c: StorageConfig, objectPath: string) =>
  `${c.baseUrl}/storage/v1/object/${c.bucket}/${encodeObjectPath(objectPath)}`;
/** Percent-encode each segment, preserving the `/` separators. */
export const encodeObjectPath = (objectPath: string) =>
  objectPath.split("/").map(encodeURIComponent).join("/");

export const storage = {
  /** Idempotently ensure the private bucket exists. */
  async ensureBucket(): Promise<void> {
    const c = config();
    const res = await fetch(`${c.baseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...authHeader(c), "content-type": "application/json" },
      body: JSON.stringify({ id: c.bucket, name: c.bucket, public: false }),
    });
    // 200 = created; a "already exists" response (409/400) is fine.
    if (!res.ok && res.status !== 409 && res.status !== 400) {
      throw new AppError(502, `Storage bucket provisioning failed (${res.status}).`);
    }
  },

  /** Upload bytes to `objectPath` (no upsert — paths are unique per document). */
  async putObject(objectPath: string, bytes: Buffer, contentType: string): Promise<void> {
    const c = config();
    const res = await fetch(objectUrl(c, objectPath), {
      method: "POST",
      headers: { ...authHeader(c), "content-type": contentType, "x-upsert": "false" },
      // `Uint8Array` rather than the Node `Buffer` directly: M12.3's crypto
      // dependencies pulled in DOM lib types that narrowed `BodyInit`, and a
      // Buffer no longer satisfies it. Same bytes, no runtime change.
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      throw new AppError(502, `Storage upload failed (${res.status}).`);
    }
  },

  /** Fetch an object's bytes + content type. Missing object → 404. */
  async getObject(objectPath: string): Promise<{ bytes: Buffer; contentType: string }> {
    const c = config();
    const res = await fetch(objectUrl(c, objectPath), { headers: authHeader(c) });
    if (res.status === 404) throw new AppError(404, "Document not found in storage.");
    if (!res.ok) throw new AppError(502, `Storage download failed (${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  },

  /** Best-effort delete (used to roll back a failed upload). */
  async removeObject(objectPath: string): Promise<void> {
    const c = config();
    await fetch(objectUrl(c, objectPath), { method: "DELETE", headers: authHeader(c) }).catch(() => {});
  },
};
