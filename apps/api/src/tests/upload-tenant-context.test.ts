/**
 * DEF-1 (acceptance 2026-09-28) — a multipart upload larger than one network
 * chunk LOST THE REQUEST'S TENANT CONTEXT.
 *
 * `resolveTenant` runs the rest of the request inside the tenant transaction's
 * AsyncLocalStorage context. multer finishes parsing from a stream event: when
 * the whole body was already buffered (a ~100-byte fixture) that event fires
 * inside the request's context; when later chunks arrive from the socket (a
 * real receipt photo) it fires in the SOCKET's context, and every handler
 * after it runs with no tenant `db` and no audit context. The fail-closed `db`
 * guard refused the query (500 `db.insert() was called outside a tenant
 * transaction`) — so nothing leaked, but no real photo, PDF or logo could be
 * stored. Every earlier test built its request below this layer (the service
 * called inside a hand-made tenant context), or used a fixture too small to
 * span two chunks — the VOLUME class of "small fixtures test differently".
 *
 * So this suite goes through the REAL app over HTTP, at the sizes users send,
 * and asserts what a stored upload must carry: the original bytes (SHA-256),
 * the uploader's tenant and no other's, its provenance and its audit actor —
 * and that a refused upload leaves neither a row nor a staged file.
 */
process.env.PORT ??= "3103";
process.env.SESSION_SECRET ??= "upload-tenant-context-secret-key-0123456789abcd";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { resetEnvCache } from "@workspace/config";
import { hashPassword } from "../lib/password";
import { capturedDocumentsRepository } from "../repositories/capturedDocuments.repository";
import { resetArchiveStoreForTests } from "../services/einvoice/archive/resolveArchiveStore";
import { resetStagingBackendForTests } from "../services/capture/stagingBackend";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[upload-tenant-context] no real DATABASE_URL — skipping the HTTP suite.");

const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A JPEG as a phone writes it: SOI + JFIF APP0 header, then entropy-coded bytes, then EOI. */
function jpegOf(size: number): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00]);
  return Buffer.concat([head, randomBytes(size - head.length - 2), Buffer.from([0xff, 0xd9])]);
}
/** A PDF: header, an opaque content stream, trailer. */
function pdfOf(size: number): Buffer {
  const head = Buffer.from("%PDF-1.4\n1 0 obj << /Length 0 >> stream\n", "latin1");
  const tail = Buffer.from("\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
  return Buffer.concat([head, randomBytes(size - head.length - tail.length), tail]);
}
/** A PNG: signature + opaque chunks (the sniff reads the signature). */
function pngOf(size: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, randomBytes(size - sig.length)]);
}

// ── The construction: one wrapper owns every multipart parse ────────────────

/** A route source that parses multipart WITHOUT the wrapper. */
const bareMulterParse = (src: string) =>
  /multer/.test(src) && /\.(single|array|fields|any|none)\s*\(/.test(src.replace(/uploadSingle\([^)]*\)/g, ""));

describe("every multipart upload goes through uploadSingle", () => {
  it("the detector sees a bare parse (planted) and passes the wrapped one — so its silence below means something", () => {
    expect(bareMulterParse(`import multer from "multer"; router.post("/", upload.single("document"), h);`)).toBe(true);
    expect(bareMulterParse(`import multer from "multer"; router.post("/", upload.array("docs", 3), h);`)).toBe(true);
    expect(bareMulterParse(`import multer from "multer"; router.post("/", uploadSingle(upload, "document"), h);`)).toBe(false);
  });

  it("🔴 no route calls multer's parsers directly — the context fix lives in ONE place", () => {
    const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../routes");
    const files = readdirSync(routesDir).filter((f) => f.endsWith(".ts") && f !== "documentHttp.ts");
    expect(files.filter((f) => /multer/.test(readFileSync(join(routesDir, f), "utf8"))).sort(), "the routes that parse multipart today")
      .toEqual(["capture.ts", "companies.ts", "onboarding.ts"]);
    const offenders = files.filter((f) => bareMulterParse(readFileSync(join(routesDir, f), "utf8")));
    expect(offenders, "a bare upload.single()/array()/fields() loses the tenant context on a multi-chunk body").toEqual([]);
  });
});

describeMaybe("DEF-1 — uploads keep the request's tenant context at real sizes", () => {
  const SLUG_A = "def1-upload-a";
  const SLUG_B = "def1-upload-b";
  const EMAIL_A = "def1-upload-a@test.local";
  const EMAIL_B = "def1-upload-b@test.local";
  const PW = "Def1-Upload-Pw-2026";

  let server: http.Server;
  let base = "";
  let archiveDir = "";
  let orgA = "", orgB = "", companyA = "", companyB = "";
  let userA = 0;
  let cookieA = "", cookieB = "";

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}'))`;
  const USERS = `(SELECT id FROM users WHERE email IN ('${EMAIL_A}','${EMAIL_B}'))`;
  const cleanup = async () => {
    await pool.query(`DELETE FROM captured_documents WHERE organization_id IN ${ORGS}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${ORGS} OR user_id IN ${USERS}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USERS} OR organization_id IN ${ORGS}`);
    await pool.query(`DELETE FROM users WHERE email IN ('${EMAIL_A}','${EMAIL_B}')`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORGS}`);
    await pool.query(`DELETE FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}')`);
  };

  async function mkTenant(slug: string, email: string, vat: string) {
    const org = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,'approved') RETURNING id`, [slug])).rows[0].id as string;
    const company = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,$2,'1010101010',$3) RETURNING id`, [org, `${slug} Co`, vat])).rows[0].id as string;
    const user = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$1,$2,'viewer',true) RETURNING id`, [email, await hashPassword(PW)])).rows[0].id as number;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [user, org]);
    return { org, company, user };
  }

  async function login(email: string): Promise<string> {
    const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
    expect(res.status, `login ${email}`).toBe(200);
    const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="));
    return sid ? sid.split(";")[0]! : "";
  }

  /** Every file under the staging/archive root — a refused upload must add none. */
  async function filesUnder(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) out.push(join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
    }
    return out.sort();
  }
  const captureRows = async () => Number((await pool.query(`SELECT count(*) FROM captured_documents WHERE organization_id IN ${ORGS}`)).rows[0].count);

  async function upload(cookie: string, bytes: Buffer, name: string, type: string, extra: Record<string, string> = {}) {
    const form = new FormData();
    form.append("document", new Blob([new Uint8Array(bytes)], { type }), name);
    form.append("source", extra.source ?? "manual");
    form.append("extraction", extra.extraction ?? "{}");
    if (extra.fieldSources) form.append("fieldSources", extra.fieldSources);
    const res = await fetch(`${base}/capture`, { method: "POST", headers: { cookie }, body: form });
    return { status: res.status, body: (await res.json().catch(() => null)) as { captureId?: string; error?: string } | null };
  }

  beforeAll(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), "def1-upload-"));
    process.env.ZATCA_ARCHIVE_PROVIDER = "local-fs";
    process.env.ZATCA_ARCHIVE_DIR = archiveDir;
    resetEnvCache();
    resetArchiveStoreForTests();
    resetStagingBackendForTests();

    // CI's test job migrates a FRESH database and does not seed: without the
    // matrix, requirePermission refuses every upload (403) before the path under
    // test is reached. The production matrix, idempotently — no extra grant.
    const { seedPermissions } = await import("@workspace/db");
    await seedPermissions();

    await cleanup();
    ({ org: orgA, company: companyA, user: userA } = await mkTenant(SLUG_A, EMAIL_A, "399999999999993"));
    ({ org: orgB, company: companyB } = await mkTenant(SLUG_B, EMAIL_B, "388888888888883"));

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    cookieA = await login(EMAIL_A);
    cookieB = await login(EMAIL_B);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    await rm(archiveDir, { recursive: true, force: true });
    delete process.env.ZATCA_ARCHIVE_PROVIDER;
    delete process.env.ZATCA_ARCHIVE_DIR;
    resetEnvCache();
    resetArchiveStoreForTests();
    resetStagingBackendForTests();
  });

  // Sizes chosen around the failure: one chunk (1 KB), two-plus chunks (60 KB,
  // 200 KB), and what a phone and a scanner actually produce.
  const CASES: Array<[string, Buffer, string, string]> = [
    ["small 1 KB PNG", pngOf(1024), "small.png", "image/png"],
    ["60 KB JPEG", jpegOf(60 * 1024), "receipt-60k.jpg", "image/jpeg"],
    ["200 KB PDF", pdfOf(200 * 1024), "invoice-200k.pdf", "application/pdf"],
    ["realistic 2.5 MB receipt photo (JPEG)", jpegOf(2_500_000), "IMG_20260928_101500.jpg", "image/jpeg"],
    ["realistic 1.2 MB scanned invoice (PDF)", pdfOf(1_200_000), "scan-invoice.pdf", "application/pdf"],
  ];

  for (const [label, bytes, name, type] of CASES) {
    it(`🔴 ${label}: stored with its bytes, its SHA-256, the uploader's tenant, provenance and audit actor`, async () => {
      const up = await upload(cookieA, bytes, name, type, { source: "manual", fieldSources: JSON.stringify({ total: "manual" }) });
      expect(up.status, `upload ${label}: ${JSON.stringify(up.body)}`).toBe(201);
      const id = up.body!.captureId!;

      const [row] = (await pool.query(
        `SELECT organization_id, company_id, captured_by, sha256, byte_size, content_type, source, field_sources, status, staging_path FROM captured_documents WHERE id = $1`,
        [id],
      )).rows;
      expect(row).toMatchObject({ organization_id: orgA, company_id: companyA, captured_by: userA, sha256: sha256(bytes), byte_size: bytes.length, content_type: type, source: "manual", status: "staged" });
      expect(row.field_sources).toEqual({ total: "manual" });

      // The ORIGINAL bytes come back, byte for byte, from the API and from disk.
      const img = await fetch(`${base}/capture/${id}/image`, { headers: { cookie: cookieA } });
      expect(img.status).toBe(200);
      expect(sha256(Buffer.from(await img.arrayBuffer()))).toBe(sha256(bytes));
      const onDisk = (await filesUnder(archiveDir)).find((f) => f.endsWith(row.staging_path.split("/").pop()));
      expect(onDisk, "the staged file exists").toBeTruthy();
      expect(sha256(await readFile(onDisk!))).toBe(sha256(bytes));

      // The audit row names the actor — the audit context survived the parse too.
      const audit = (await pool.query(`SELECT user_id, organization_id FROM audit_logs WHERE entity_type = 'captured_document' AND entity_id = $1`, [id])).rows;
      expect(audit).toEqual([{ user_id: userA, organization_id: orgA }]);

      // Tenant ownership: another organisation cannot see it (RLS), the owner can.
      expect((await fetch(`${base}/capture/${id}`, { headers: { cookie: cookieB } })).status).toBe(404);
      expect((await fetch(`${base}/capture/${id}`, { headers: { cookie: cookieA } })).status).toBe(200);
    });
  }

  it("🔴 a large upload in organisation B is B's — the context is the uploader's own, not the last one set", async () => {
    const bytes = jpegOf(300 * 1024);
    const [a, b] = await Promise.all([
      upload(cookieA, bytes, "a.jpg", "image/jpeg"),
      upload(cookieB, bytes, "b.jpg", "image/jpeg"),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const owners = (await pool.query(`SELECT id, organization_id, company_id FROM captured_documents WHERE id IN ($1,$2)`, [a.body!.captureId, b.body!.captureId])).rows;
    expect(owners.find((r) => r.id === a.body!.captureId)).toMatchObject({ organization_id: orgA, company_id: companyA });
    expect(owners.find((r) => r.id === b.body!.captureId)).toMatchObject({ organization_id: orgB, company_id: companyB });
  });

  // ── Refusals leave nothing behind ──────────────────────────────────────────

  it("🔴 over the 10 MB limit: a 400 naming the limit, no row, no staged file", async () => {
    const [rows, files] = [await captureRows(), await filesUnder(archiveDir)];
    const up = await upload(cookieA, jpegOf(10 * 1024 * 1024 + 4096), "huge.jpg", "image/jpeg");
    expect(up.status).toBe(400);
    expect(up.body?.error).toMatch(/10 MB/);
    expect(await captureRows()).toBe(rows);
    expect(await filesUnder(archiveDir)).toEqual(files);
  });

  it("🔴 200 KB that is not a document (magic bytes): refused as a 4xx, no row, no staged file", async () => {
    const [rows, files] = [await captureRows(), await filesUnder(archiveDir)];
    const up = await upload(cookieA, randomBytes(200 * 1024), "not-a-receipt.jpg", "image/jpeg");
    expect(up.status).toBeGreaterThanOrEqual(400);
    expect(up.status).toBeLessThan(500);
    expect(await captureRows()).toBe(rows);
    expect(await filesUnder(archiveDir)).toEqual(files);
  });

  it("🔴 a large upload whose ROW cannot be written: 500, no row, and the staged bytes are removed", async () => {
    const [rows, files] = [await captureRows(), await filesUnder(archiveDir)];
    const spy = vi.spyOn(capturedDocumentsRepository, "insert").mockRejectedValueOnce(new Error("injected insert failure"));
    try {
      const up = await upload(cookieA, jpegOf(250 * 1024), "insert-fails.jpg", "image/jpeg");
      expect(up.status).toBe(500);
      expect(spy, "the planted failure was reached — this test is not vacuous").toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await captureRows()).toBe(rows);
    expect(await filesUnder(archiveDir)).toEqual(files);
  });

  // ── The same wrapper, the other tenant-scoped upload: the company logo ─────

  it("🔴 a 200 KB company logo reaches its tenant-scoped company lookup (never the unscoped-db 500)", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pngOf(200 * 1024))], { type: "image/png" }), "logo.png");
    const res = await fetch(`${base}/companies/current/logo`, { method: "PUT", headers: { cookie: cookieA }, body: form });
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      expect(res.status, JSON.stringify(body)).toBe(200);
      const [c] = (await pool.query(`SELECT logo_path FROM companies WHERE id = $1`, [companyA])).rows;
      expect(c.logo_path).toMatch(new RegExp(`^${orgA}/logo/${companyA}-`));
    } else {
      // Storage is not configured here; the lookup ran FIRST, in the tenant
      // context, and the refusal is storage's — never the lost-context 500.
      expect(res.status, JSON.stringify(body)).toBe(503);
      expect(body?.error).toMatch(/Object storage is not configured/);
    }
  });
});
