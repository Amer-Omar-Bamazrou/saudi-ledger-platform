/**
 * Staging storage for captured documents (A1 part 2).
 *
 * ── 🔴 WHY THIS IS NOT `ArchiveStore` ──────────────────────────────────────
 * `ArchiveStore` has **no delete method, by design** — ZATCA §5.5 forbids
 * deleting or altering a generated invoice, and M12.8 made that guarantee
 * absolute by removing deletion from the interface entirely.
 *
 * Captured documents are different in kind. They are whatever a user pointed a
 * phone at: possibly the wrong receipt, possibly blurry, possibly a duplicate,
 * and — the case that decides it — possibly an accidental photograph containing
 * a third party's personal data. Making every one of those permanent and
 * undeletable would be a liability, not a compliance win, and PDPL erasure
 * rights have never been considered in this project (queue item **C8**).
 *
 * So: **stage here (deletable), promote into `ArchiveStore` when the document
 * becomes evidence** — that is, when it is posted to a bill. The archive's
 * guarantee stays exactly as strong as M12.8 made it, and does not reach
 * photographs that are evidence of nothing.
 *
 * This is one archive plus a staging buffer. It is NOT the "second storage
 * mechanism" the M12.8 note warns against — that warning is about two competing
 * archives, and there is still only one.
 *
 * Backed by the same swappable `ArchiveStore` implementations under a separate
 * prefix, so hosting/region decisions apply to both without a second provider.
 */
import { resolveArchiveStore } from "../einvoice/archive/resolveArchiveStore";
import { resolveStagingBackend } from "./stagingBackend";

const STAGING_PREFIX = "staging";

/** Staged objects live under a prefix so promotion is a copy, not a move-in-place. */
const stagedPath = (path: string) => `${STAGING_PREFIX}/${path}`;

export const stagingStore = {
  async put(path: string, bytes: Buffer, contentType: string): Promise<void> {
    await resolveArchiveStore().put(stagedPath(path), bytes, contentType);
  },

  /**
   * Read a staged OR promoted object.
   *
   * `status` decides the prefix: once promoted the bytes live in the archive
   * proper and the staged copy is gone.
   */
  async get(path: string, status: string): Promise<{ bytes: Buffer; contentType: string }> {
    const store = resolveArchiveStore();
    return store.get(status === "promoted" ? path : stagedPath(path));
  },

  /**
   * Delete a staged object. Idempotent; **throws** if the bytes might survive.
   *
   * 🔴 It used to return silently on every backend except `local-fs`, so on
   * cloud storage the caller was told the bytes were gone when they were not —
   * and `purgeOnce` then deleted the metadata row, orphaning the objects and
   * destroying the only index to them (queue B3). Deletion now lives on its own
   * `StagingBackend` contract with a real cloud implementation, and a failure
   * is raised rather than swallowed.
   *
   * `ArchiveStore` still has no `delete` and must never gain one — that
   * guarantee is what this seam exists to protect, not to work around.
   */
  async remove(path: string): Promise<void> {
    await resolveStagingBackend().remove(stagedPath(path));
  },

  /** Copy a staged object into the immutable archive. Idempotent by the archive's own conflict rule. */
  async promote(stagingRelPath: string, archivePath: string, contentType: string): Promise<{ sha256: string; byteSize: number }> {
    const store = resolveArchiveStore();
    const { bytes } = await store.get(stagedPath(stagingRelPath));
    return store.put(archivePath, bytes, contentType);
  },
};
