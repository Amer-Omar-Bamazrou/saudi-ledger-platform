/**
 * Verification documents (M11.4) — upload / storage / download + boundary.
 *
 * Proves: magic-byte validation (bytes, not declared mime/extension), a real
 * round-trip through the private bucket, filename sanitization (no path
 * traversal), org-scoped access (org B cannot read org A's doc), the audit trail
 * (document_uploaded + operator document_viewed), and — over the real app —
 * multipart upload plus an attachment-only (never inline) download.
 *
 * Requires BOTH a real DB and Storage credentials (SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY). CI provides neither the Storage service nor those
 * vars, so this suite skips there; run locally against the Supabase stack.
 */

// app.ts calls loadEnv() at import — provide the non-storage vars CI omits. We do
// NOT default the SUPABASE_* vars: their ABSENCE is exactly how this suite skips.
process.env.PORT ??= "3102";
process.env.SESSION_SECRET ??= "documents-test-session-secret-key-0123456789abcd";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { documentsService } from "../services/documents.service";
import { __resetRateLimitsForTests } from "../routes/auth";
import { storage } from "../lib/storage";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const STORAGE = REAL_DB && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const describeMaybe = STORAGE ? describe : describe.skip;
if (!STORAGE) {
  // eslint-disable-next-line no-console
  console.warn("[documents] DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required — skipping.");
}

const PW = "DocPw123!";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describeMaybe("verification documents (M11.4)", () => {
  let userA = 0;
  let operatorId = 0;
  let orgA = "";
  let orgB = "";

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'doctest-%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'doctest-%')`;

  const cleanup = async () => {
    const paths = await pool.query(`SELECT storage_path FROM verification_documents WHERE organization_id IN ${ORG_FILTER}`);
    for (const r of paths.rows) await storage.removeObject(r.storage_path);
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM verification_documents WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'doctest-%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'doctest-%'`);
  };

  const mkUser = async (email: string) =>
    (await pool.query(`INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$1,$2,'viewer',true) RETURNING id`, [email, await bcrypt.hash(PW, 12)])).rows[0].id as number;
  const mkOrg = async (slug: string, status = "pending_review") =>
    (await pool.query(`INSERT INTO organizations (name,slug,verification_status) VALUES ($1,$1,$2) RETURNING id`, [slug, status])).rows[0].id as string;
  const secEvents = async (orgId: string) =>
    (await pool.query(`SELECT action FROM security_audit_logs WHERE organization_id = $1`, [orgId])).rows.map((r) => r.action as string);

  beforeAll(async () => {
    // C1: the rate-limit store is now SHARED (Postgres), so a suite that
    // logs in repeatedly consumes the SAME budget as every parallel suite —
    // the per-fork privacy MemoryStore accidentally provided is gone.
    await __resetRateLimitsForTests();
    await cleanup();
    userA = await mkUser("doctest-user@test.local");
    operatorId = await mkUser("doctest-operator@test.local");
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);
    orgA = await mkOrg("doctest-a");
    orgB = await mkOrg("doctest-b");
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [userA, orgA]);
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("service: validation, storage round-trip, scoping, audit", () => {
    let docId = "";

    it("rejects a file whose bytes are not an allowed type (magic-byte sniff)", async () => {
      await expect(
        documentsService.upload(userA, orgA, "cr_certificate", { buffer: Buffer.from("hello not a pdf"), originalName: "fake.pdf" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an invalid document type", async () => {
      await expect(
        documentsService.upload(userA, orgA, "passport", { buffer: PDF, originalName: "x.pdf" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("uploads a valid PDF: stores bytes, records metadata, audits the upload", async () => {
      const meta = await documentsService.upload(userA, orgA, "cr_certificate", { buffer: PDF, originalName: "cr.pdf" }, { actorEmail: "doctest-user@test.local" });
      docId = meta.id;
      expect(meta).toMatchObject({ organizationId: orgA, type: "cr_certificate", mimeType: "application/pdf", sizeBytes: PDF.length });
      expect(await secEvents(orgA)).toContain("verification.document_uploaded");

      const back = await documentsService.download(orgA, docId);
      expect(back.bytes.equals(PDF)).toBe(true);
    });

    it("sanitizes the filename (strips path components, forces the sniffed extension)", async () => {
      const meta = await documentsService.upload(userA, orgA, "other", { buffer: PNG, originalName: "../../etc/passwd" }, {});
      expect(meta.fileName).not.toContain("/");
      expect(meta.fileName.endsWith(".png")).toBe(true);
    });

    it("org B cannot download org A's document (404, org-scoped)", async () => {
      await expect(documentsService.download(orgB, docId)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("operator download returns the bytes AND is audited as a cross-tenant view", async () => {
      const back = await documentsService.operatorView(operatorId, orgA, docId, { actorEmail: "doctest-operator@test.local" });
      expect(back.bytes.equals(PDF)).toBe(true);
      expect(await secEvents(orgA)).toContain("verification.document_viewed");
    });

    it("lists an org's documents", async () => {
      const { documents } = await documentsService.listForOrg(orgA);
      expect(documents.length).toBeGreaterThanOrEqual(2);
      expect(documents.some((d) => d.id === docId)).toBe(true);
    });
  });

  describe("end-to-end: multipart upload + attachment-only download", () => {
    let server: http.Server;
    let base = "";
    let cookie = "";

    async function login(email: string) {
      cookie = "";
      const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
      const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
      if (sid) cookie = sid.split(";")[0];
      return res.status;
    }

    beforeAll(async () => {
      const app = (await import("../app")).default;
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("uploads via multipart then downloads as a forced attachment (never inline)", async () => {
      expect(await login("doctest-user@test.local")).toBe(200);

      const form = new FormData();
      form.append("type", "vat_certificate");
      form.append("file", new Blob([PDF], { type: "application/pdf" }), "vat.pdf");
      const up = await fetch(`${base}/onboarding/documents`, { method: "POST", headers: { cookie }, body: form });
      expect(up.status).toBe(201);
      const meta = (await up.json()) as { id: string };

      const dl = await fetch(`${base}/onboarding/documents/${meta.id}`, { headers: { cookie } });
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await dl.arrayBuffer()).equals(PDF)).toBe(true);
    });

    it("rejects an oversized upload with 400 (multer limit)", async () => {
      expect(await login("doctest-user@test.local")).toBe(200);
      const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
      const form = new FormData();
      form.append("type", "other");
      form.append("file", new Blob([big], { type: "application/pdf" }), "big.pdf");
      const up = await fetch(`${base}/onboarding/documents`, { method: "POST", headers: { cookie }, body: form });
      expect(up.status).toBe(400);
    });
  });
});
