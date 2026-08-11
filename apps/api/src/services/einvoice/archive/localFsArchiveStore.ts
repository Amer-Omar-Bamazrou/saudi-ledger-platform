/**
 * Filesystem archive backend — development, CI, and on-premises deployment.
 *
 * The counterpart to `LocalDevKeyWrapper` in M12.5, with one deliberate
 * difference: that wrapper is REFUSED in production because shipping fake
 * cryptography is never acceptable. This one is NOT refused, because
 * ZATCA §5.5 explicitly permits storing invoices "in a server on-premises in
 * the KSA", so a real deployment onto durable local storage is legitimate.
 *
 * What IS guarded is the trap: `loadEnv` rejects a RELATIVE `ZATCA_ARCHIVE_DIR`
 * in production, because a relative path resolves inside a container and the
 * archive would silently vanish on redeploy — the worst possible outcome for a
 * 6–11 year legal retention obligation.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  ArchiveConflictError,
  type ArchiveLink,
  type ArchivePutResult,
  type ArchiveStore,
} from "./archiveStore";

export class LocalFsArchiveStore implements ArchiveStore {
  readonly provider = "local-fs";

  constructor(
    private readonly root: string,
    /** Base URL the API serves brokered downloads from. */
    private readonly apiBaseUrl: string,
  ) {}

  /**
   * Resolve an object path under the root, refusing anything that escapes it.
   *
   * Object paths are built from tenant-controlled values (the invoice number
   * reaches the filename), so traversal is a real input, not a hypothetical.
   */
  private full(objectPath: string): string {
    const target = resolve(join(this.root, objectPath));
    const base = resolve(this.root);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error("Archive object path escapes the archive root");
    }
    return target;
  }

  async put(objectPath: string, bytes: Buffer, _contentType: string): Promise<ArchivePutResult> {
    const target = this.full(objectPath);
    if (await this.exists(objectPath)) throw new ArchiveConflictError(objectPath);

    await mkdir(dirname(target), { recursive: true });
    // `wx` fails if the file appeared between the check and the write, so the
    // append-only guarantee does not depend on the check-then-act window.
    await writeFile(target, bytes, { flag: "wx" });

    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    };
  }

  async get(objectPath: string): Promise<{ bytes: Buffer; contentType: string }> {
    return { bytes: await readFile(this.full(objectPath)), contentType: "application/xml" };
  }

  async exists(objectPath: string): Promise<boolean> {
    try {
      await stat(this.full(objectPath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * There is no filesystem URL an auditor could open, so the link is brokered
   * by the API. It still satisfies §5.5 — the obligation is that a direct link
   * can be made available, not that the storage layer mints it.
   */
  async directLink(objectPath: string, ttlSeconds: number): Promise<ArchiveLink> {
    return {
      url: `${this.apiBaseUrl.replace(/\/$/, "")}/api/einvoice/archive/${encodeURIComponent(objectPath)}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }
}
