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

interface StorageConfig {
  baseUrl: string;
  serviceKey: string;
  bucket: string;
}

function config(): StorageConfig {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AppError(503, "Document storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }
  return {
    baseUrl: env.SUPABASE_URL.replace(/\/+$/, ""),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.VERIFICATION_DOCS_BUCKET,
  };
}

/** True when both storage credentials are present. */
export function isStorageConfigured(): boolean {
  const env = loadEnv();
  return !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
}

const authHeader = (c: StorageConfig) => ({ Authorization: `Bearer ${c.serviceKey}` });
const objectUrl = (c: StorageConfig, objectPath: string) =>
  `${c.baseUrl}/storage/v1/object/${c.bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;

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
