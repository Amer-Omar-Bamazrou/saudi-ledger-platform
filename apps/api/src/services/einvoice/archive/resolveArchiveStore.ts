/**
 * Choose the archive backend at RUNTIME from configuration (M12.8).
 *
 * The same shape as M12.5's `getKeyWrapper`: the provider is a deployment
 * decision, not a compile-time one. Nothing outside this file names a concrete
 * store, so adding a KSA-resident backend later is a new class plus a case here.
 *
 * Memoized because the store is stateless and the sweep asks for it every pass.
 */
import { loadEnv } from "@workspace/config";
import type { ArchiveStore } from "./archiveStore";
import { LocalFsArchiveStore } from "./localFsArchiveStore";
import { SupabaseArchiveStore } from "./supabaseArchiveStore";

let cached: ArchiveStore | null = null;

export function resolveArchiveStore(): ArchiveStore {
  if (cached) return cached;
  const env = loadEnv();

  switch (env.ZATCA_ARCHIVE_PROVIDER) {
    case "supabase-storage":
      cached = new SupabaseArchiveStore(env.ZATCA_ARCHIVE_BUCKET);
      break;
    case "local-fs":
      cached = new LocalFsArchiveStore(
        env.ZATCA_ARCHIVE_DIR,
        env.APP_BASE_URL ?? env.CORS_ALLOWED_ORIGINS[0] ?? "http://localhost:3000",
      );
      break;
  }

  return cached!;
}

/** Test hook — drop the memoized store so a suite can swap providers. */
export function resetArchiveStoreForTests(): void {
  cached = null;
}
