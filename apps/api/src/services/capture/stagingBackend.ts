/**
 * The DELETABLE staging seam (queue item B3, technical half).
 *
 * ── Why this is a separate interface from `ArchiveStore` ───────────────────
 * `ArchiveStore` has no `delete` and must never gain one: ZATCA §5.5 forbids
 * deleting or altering a generated invoice, and M12.8 made that absolute by
 * removing deletion from the interface rather than by asking callers not to use
 * it. An interface with a `delete` on it is an interface every implementation
 * can destroy a legally-retained artifact through.
 *
 * Staged captures are a different class of object: whatever a user pointed a
 * phone at, evidence of nothing until it is posted to a bill. They MUST be
 * deletable — that is the entire reason staging exists.
 *
 * So deletion lives here, on its own contract, over its own prefix. One
 * archive, one staging buffer, two different guarantees, and no way to reach
 * the first through the second.
 *
 * ── What this replaces, and why it was worse than a missing feature ────────
 * `stagingStore.remove` used to reach past `ArchiveStore` for the `local-fs`
 * case and **return silently** for every other backend. On cloud storage the
 * bytes stayed and the caller was told nothing — so `purgeOnce` went on to
 * delete the metadata row, leaving orphaned objects AND destroying the only
 * index to them. You could not enumerate what was left behind, retry it, or
 * prove what had happened.
 *
 * 🔴 A no-op that reports success is worse than an unimplemented method that
 * throws. The second is a gap; the first is a false statement, and the caller
 * builds on it. Every method here either does the thing or raises.
 */
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { loadEnv } from "@workspace/config";
import { authHeader, bucketConfig, objectUrl } from "../../lib/storage";

/** Raised when a backend genuinely cannot delete — never returned as success. */
export class StagingDeleteFailed extends Error {
  constructor(
    readonly provider: string,
    readonly path: string,
    message: string,
  ) {
    super(`staging delete failed on ${provider} for "${path}": ${message}`);
    this.name = "StagingDeleteFailed";
  }
}

export interface StagingBackend {
  readonly provider: string;
  /**
   * Delete a staged object.
   *
   * MUST be idempotent — an object that is already gone is a success, because
   * the caller's question is "are the bytes gone?", not "did I remove them".
   * MUST throw {@link StagingDeleteFailed} if the bytes might still exist.
   */
  remove(stagedPath: string): Promise<void>;
}

export class LocalFsStagingBackend implements StagingBackend {
  readonly provider = "local-fs";

  constructor(private readonly root: string) {}

  async remove(stagedPath: string): Promise<void> {
    const root = resolve(this.root);
    const target = resolve(join(root, stagedPath));
    // The path segment derives from a user-supplied filename, so never delete
    // outside the archive root. A traversal attempt is a FAILURE, not a quiet
    // skip — a skip here is how the caller learns the wrong thing again.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new StagingDeleteFailed(this.provider, stagedPath, "path escapes the archive root");
    }
    try {
      await rm(target, { force: true }); // `force` makes a missing file a success
    } catch (err) {
      throw new StagingDeleteFailed(
        this.provider,
        stagedPath,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Supabase Storage staging deletion — the case that was missing entirely.
 *
 * Deliberately NOT implemented on `SupabaseArchiveStore`: that class backs the
 * immutable archive, and giving it a delete would put the capability one typo
 * away from a retained invoice. This is a separate object against the same
 * bucket and the same REST plumbing.
 */
export class SupabaseStagingBackend implements StagingBackend {
  readonly provider = "supabase-storage";

  constructor(private readonly bucket: string) {}

  async remove(stagedPath: string): Promise<void> {
    const c = bucketConfig(this.bucket);
    let res: Response;
    try {
      res = await fetch(objectUrl(c, stagedPath), {
        method: "DELETE",
        headers: authHeader(c),
      });
    } catch (err) {
      throw new StagingDeleteFailed(
        this.provider,
        stagedPath,
        err instanceof Error ? err.message : String(err),
      );
    }
    // 404 = already gone, which satisfies the caller's actual question.
    if (res.ok || res.status === 404) return;
    throw new StagingDeleteFailed(this.provider, stagedPath, `HTTP ${res.status}`);
  }
}

let cached: StagingBackend | null = null;

/**
 * Choose the staging backend from configuration — the same shape as
 * `resolveArchiveStore`, so the hosting decision applies to both without a
 * second provider setting.
 */
export function resolveStagingBackend(): StagingBackend {
  if (cached) return cached;
  const env = loadEnv();
  cached =
    env.ZATCA_ARCHIVE_PROVIDER === "supabase-storage"
      ? new SupabaseStagingBackend(env.ZATCA_ARCHIVE_BUCKET)
      : new LocalFsStagingBackend(env.ZATCA_ARCHIVE_DIR);
  return cached;
}

/** Test hook — drop the memoized backend so a suite can swap providers. */
export function resetStagingBackendForTests(backend?: StagingBackend): void {
  cached = backend ?? null;
}
