/**
 * 🔴 The error-handling work package (owner-approved 2026-11-17) — every error response is safe and in one shape.
 *
 * The 2026-11-17 walk and the review after it found: a 500 from the reports controller carrying `String(err)` (the
 * exception's own text); the PDF renderer's 503 telling the user to run `npx playwright install chromium`; a library's
 * parse error sent as the message; bodies with no code, no Arabic and no reference. The owner's rule: a stable code, a
 * safe English and a safe Arabic sentence, and a reference; never exception text, stacks, paths, SQL, infrastructure
 * or installation details; the detail kept in the server log under the same reference; error semantics preserved.
 *
 * Presence, absence, movement: the four fields present on every error; the planted secret absent from every body and
 * PRESENT in the log beside the response's reference; a 4xx refusal's own sentence and structured fields unchanged.
 * The HTTP half is DB-backed (sl_test / CI); the rest needs no database.
 */
process.env.PORT ??= "3392";
process.env.SESSION_SECRET ??= "wp-error-bodies-secret-0000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/errorHandler";
import { withReportError } from "../controllers/reports.controller";
import { RendererUnavailableError } from "../services/document/htmlToPdf";
import { BusinessRuleError, NotFoundError } from "../lib/errors";
import { g04Harness } from "./helpers/g04Harness";
import { appOriginHeader } from "./helpers/appOrigin";

const ARABIC = /[؀-ۿ]/;
const SECRET = 'relation "secret_ledger_table" does not exist at /srv/app/dist/index.mjs:4242';

/** The central handler driven directly: what it sent, and what it logged. */
function drive(err: unknown, id = "req-test-0001") {
  const out = { status: 0, body: undefined as any, logged: [] as unknown[] };
  const log = { info() {}, warn(o: unknown) { out.logged.push(o); }, error(o: unknown) { out.logged.push(o); } };
  const res = { headersSent: false, locals: {}, status(s: number) { out.status = s; return this; }, json(b: unknown) { out.body = b; return this; } };
  errorHandler(err, { id, log, originalUrl: "/api/x", url: "/api/x", method: "GET" } as never, res as never, () => {});
  return out;
}
const shaped = (b: any) => {
  expect(typeof b.code, "a stable code").toBe("string");
  expect(b.code).toMatch(/^[a-z][a-z0-9_]+$/);
  expect(typeof b.error, "a safe English sentence").toBe("string");
  expect(typeof b.errorAr, "a safe Arabic sentence").toBe("string");
  expect(b.errorAr).toMatch(ARABIC);
  expect(typeof b.requestId, "a reference").toBe("string");
  expect(b.requestId.length).toBeGreaterThan(0);
};

describe("the central handler — a 5xx never carries its exception's text; the log does, under the same reference", () => {
  it("🔴 an unexpected error: 500 internal_error, both languages, the reference — the SQL and the path only in the log", () => {
    const r = drive(new Error(SECRET), "ref-500");
    expect(r.status).toBe(500);
    shaped(r.body);
    expect(r.body).toMatchObject({ code: "internal_error", requestId: "ref-500" });
    expect(JSON.stringify(r.body)).not.toMatch(/secret_ledger_table|index\.mjs|Internal server error/);
    expect(JSON.stringify(r.logged, (_k, v) => (v instanceof Error ? { message: v.message } : v))).toMatch(/secret_ledger_table/);
    expect(JSON.stringify(r.logged)).toMatch(/ref-500/);
  });

  it("🔴 the PDF renderer: 503 with its code and safe sentences — no cause, no installation instruction; the log has both", () => {
    const r = drive(new RendererUnavailableError("spawn chrome ENOENT /opt/chromium"), "ref-503");
    expect(r.status).toBe(503);
    shaped(r.body);
    expect(r.body.code).toBe("pdf_renderer_unavailable");
    expect(JSON.stringify(r.body)).not.toMatch(/npx|playwright|chromium|ENOENT|C6|hosting/i);
    expect(JSON.stringify(r.logged, (_k, v) => (v instanceof Error ? { message: v.message, diagnostic: (v as any).diagnostic } : v))).toMatch(/npx playwright install chromium/);
  });

  it("🔴 one of our own classes tagged 5xx (a signing fault, a posting bug) says nothing of itself to the user", () => {
    const e = Object.assign(new Error("KMS Decrypt failed for key arn:aws:kms:me-south-1:1234:key/abc"), { statusCode: 502 });
    const r = drive(e);
    expect(r.status).toBe(502);
    shaped(r.body);
    expect(JSON.stringify(r.body)).not.toMatch(/KMS|arn:aws|Decrypt/);
  });

  it("🔴 a 5xx AppError keeps the code in its payload (the limiter's rate_limit_unavailable is keyed on by the client)", async () => {
    const { RateLimitUnavailableError } = await import("../lib/rateLimitStore");
    const r = drive(new RateLimitUnavailableError());
    expect(r.status).toBe(503);
    shaped(r.body);
    expect(r.body.code).toBe("rate_limit_unavailable");
  });

  it("🔴 a library's 4xx (malformed JSON) is answered by its kind, not by the parser's text", () => {
    const e = Object.assign(new SyntaxError("Unexpected token } in JSON at position 12"), { statusCode: 400, type: "entity.parse.failed" });
    const r = drive(e);
    expect(r.status).toBe(400);
    shaped(r.body);
    expect(r.body.code).toBe("invalid_json");
    expect(JSON.stringify(r.body)).not.toMatch(/Unexpected token|position 12/);
  });

  it("movement — a refusal the platform wrote keeps its code, its sentences and its structured fields, and gains the reference", () => {
    const r = drive(new BusinessRuleError(422, { code: "journal_line_party_reason_required", field: "lines[1].partyNoneReason", error: "Line 2: state why.", errorAr: "السطر 2: اذكر السبب." }), "ref-422");
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ code: "journal_line_party_reason_required", field: "lines[1].partyNoneReason", error: "Line 2: state why.", errorAr: "السطر 2: اذكر السبب.", requestId: "ref-422" });
  });

  it("movement — a code the body already carries is never rewritten, whatever its case (TOTALS_MISMATCH is keyed on)", () => {
    const r = drive(new BusinessRuleError(400, { code: "TOTALS_MISMATCH", error: "Totals don't reconcile.", detail: { difference: 5 } }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "TOTALS_MISMATCH", error: "Totals don't reconcile.", detail: { difference: 5 } });
    expect(r.body.errorAr).toMatch(ARABIC);
  });

  it("🔴 an Arabic reader keeps the REASON: a 4xx whose own English sentence has no Arabic one carries that sentence inside its Arabic message (CI e2e, 13B-3 over-credit)", () => {
    const reason = "You cannot credit more VAT than the invoice charged: only 150.00 of the 150.00 VAT charged on INV-9 remains.";
    const r = drive(new BusinessRuleError(422, { code: "credit_note_exceeds_invoice_vat", error: reason }), "ref-reason");
    expect(r.body.error).toBe(reason);
    expect(r.body.errorAr, "Arabic first").toMatch(/^[؀-ۿ]/);
    expect(r.body.errorAr, "and the reason itself, not only a generic sentence").toContain(reason);
    // the movement: where the English IS the generic sentence, nothing is repeated — the Arabic is the generic one alone
    const generic = drive(new BusinessRuleError(422, { code: "credit_note_exceeds_invoice_vat" }), "ref-generic");
    expect(generic.body.errorAr).toMatch(ARABIC);
    expect(generic.body.errorAr).not.toContain(String(generic.body.error));
  });

  it("a refusal with no code and no Arabic keeps its English sentence and gains a status code, Arabic and the reference", () => {
    const r = drive(new NotFoundError("Invoice not found"));
    expect(r.status).toBe(404);
    shaped(r.body);
    expect(r.body).toMatchObject({ code: "not_found", error: "Invoice not found" });
  });

  it("🔴 the reports wrapper hands an unexpected failure to the central handler — it never answers with the exception itself", async () => {
    const sent: unknown[] = [];
    let forwarded: unknown;
    const res = { locals: {}, status() { return this; }, json(b: unknown) { sent.push(b); return this; } };
    await withReportError(async () => { throw new Error(SECRET); })({ log: { error() {} } } as never, res as never, (e?: unknown) => { forwarded = e; });
    expect(sent, "nothing answered here").toEqual([]);
    expect((forwarded as Error)?.message).toBe(SECRET);
  });
});

describe("normaliseErrorBody — one shape, idempotent", () => {
  it("🔴 a 5xx body's own text is dropped; a 4xx body's is kept; normalising twice changes nothing", async () => {
    const mod = await import("../middleware/errorBodies").catch(() => null);
    expect(mod, "middleware/errorBodies exists").not.toBeNull();
    const n = mod!.normaliseErrorBody;
    const five = n(500, { error: `Error: ${SECRET}` }, "r1");
    expect(JSON.stringify(five)).not.toMatch(/secret_ledger_table/);
    expect(five).toMatchObject({ code: "internal_error", requestId: "r1" });
    const four = n(409, { code: "second_admin_required", error: "Another admin approves it.", changeId: 7 }, "r2");
    expect(four).toMatchObject({ code: "second_admin_required", error: "Another admin approves it.", changeId: 7, requestId: "r2" });
    expect(four.errorAr).toMatch(ARABIC);
    expect(n(409, four, "r2")).toEqual(four);
    expect(n(503, { code: "rate_limiter_unavailable", retryAfterSeconds: 30, error: "pg: connection refused 10.0.0.5" }, "r3")).toMatchObject({ retryAfterSeconds: 30 });
    expect(JSON.stringify(n(503, { error: "pg: connection refused 10.0.0.5" }, "r3"))).not.toMatch(/10\.0\.0\.5/);
  });
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
(REAL_DB ? describe : describe.skip)("over HTTP, through the real app — every error a route or guard sends itself is in the one shape", () => {
  const h = g04Harness("wperr");
  beforeAll(async () => { await h.cleanup(); await h.start(); }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const raw = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${h.state.base}${path}`, { ...init, headers: { ...appOriginHeader(), ...(init.headers ?? {}) } });
    const text = await res.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, ref: res.headers.get("x-request-id") };
  };

  it("🔴 a guard's own 401 (no session): code, both languages, and the reference equal to the X-Request-Id header", async () => {
    const r = await raw("/invoices");
    expect(r.status).toBe(401);
    shaped(r.body);
    expect(r.body.code).toBe("unauthorized");
    expect(r.ref, "the header carries the reference").toBeTruthy();
    expect(r.body.requestId).toBe(r.ref);
    expect(r.ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("🔴 a malformed JSON body: 400 invalid_json — the parser's text is not sent", async () => {
    const r = await raw("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: '{"email": "a@b.c", }' });
    expect(r.status).toBe(400);
    shaped(r.body);
    expect(r.body.code).toBe("invalid_json");
    expect(JSON.stringify(r.body)).not.toMatch(/Unexpected|position|JSON at/);
  });

  it("a failed sign-in keeps its own sentence (semantics preserved) and gains the shape", async () => {
    const r = await raw("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nobody-wperr@test.local", password: "not-the-password-1!" }) });
    expect(r.status).toBe(401);
    shaped(r.body);
    expect(r.body.error).toMatch(/invalid|incorrect|password|credentials/i);
  });

  it("two requests carry two different references", async () => {
    const [a, b] = [await raw("/invoices"), await raw("/invoices")];
    expect(a.ref).not.toBe(b.ref);
  });
});
