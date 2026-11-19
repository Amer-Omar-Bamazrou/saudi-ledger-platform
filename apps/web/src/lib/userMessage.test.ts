/**
 * 🔴 The error-handling work package (owner-approved 2026-11-17) — what BOTH error classes say to their reader.
 *
 * `e.message` is printed by 63 toasts and inline errors (measured 2026-11-17). It was the server's English sentence, or
 * — from the generated client — "HTTP 409 Conflict: <English>", or for a 500 whatever text the body held. Both classes
 * now build it through `userMessage`: the reader's language, safe words for a 5xx, never a status line.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApiError as AppApiError } from "./api";
import { ApiError as ClientApiError, setErrorMessageResolver } from "@workspace/api-client-react";

const withLang = (lang: string | null) => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === "ksa_lang" ? lang : null) };
};
const ARABIC = /[؀-ۿ]/;
const SECRET = 'error: relation "secret_ledger_table" does not exist';
const refusal = { code: "bank_detail_approver_linked", error: "You cannot approve this change.", errorAr: "لا يمكنك اعتماد هذا التغيير.", requestId: "0f3c9a2e-1111-2222-3333-444455556666" };
const clientError = (status: number, statusText: string, body: unknown) =>
  new ClientApiError(new Response(JSON.stringify(body), { status, statusText }), body, { method: "PUT", url: "/api/x" });

describe("the app's ApiError (apiFetch) — safe, and in the reader's language", () => {
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  it("🔴 Arabic reader: the server's Arabic sentence; English reader: its English one", () => {
    withLang("ar");
    expect(new AppApiError(409, refusal).message).toBe("لا يمكنك اعتماد هذا التغيير.");
    withLang("en");
    expect(new AppApiError(409, refusal).message).toBe("You cannot approve this change.");
  });

  it("🔴 a 500 whose body is NOT the server's normalised shape never shows its text — in either language", () => {
    for (const lang of ["ar", "en"]) {
      withLang(lang);
      const m = new AppApiError(500, { error: SECRET }).message;
      expect(m).not.toMatch(/secret_ledger_table|relation/);
      if (lang === "ar") expect(m).toMatch(ARABIC);
    }
  });

  it("🔴 a normalised 500 shows its safe sentence and a short reference", () => {
    withLang("ar");
    const m = new AppApiError(500, { code: "internal_error", error: "The request could not be completed.", errorAr: "تعذّر إكمال الطلب.", requestId: refusal.requestId }).message;
    expect(m).toContain("تعذّر إكمال الطلب.");
    expect(m).toContain("0f3c9a2e");
    expect(m).not.toContain(refusal.requestId);
  });

  it("🔴 an Arabic reader never gets an English-only 4xx as nothing: no Arabic → the Arabic sentence for its status class", () => {
    withLang("ar");
    const m = new AppApiError(403, { error: "Access denied: role 'viewer' cannot delete invoices" }).message;
    expect(m).toMatch(ARABIC);
    withLang("en");
    expect(new AppApiError(403, { error: "Access denied." }).message).toBe("Access denied.");
  });

  it("an unknown status with an empty body still speaks (never 'Request failed (418)' to an Arabic reader)", () => {
    withLang("ar");
    expect(new AppApiError(418, {}).message).toMatch(ARABIC);
    expect(new AppApiError(0, { code: "network_error" }).message).toMatch(ARABIC);
  });

  it("code-keyed logic still has its fields", () => {
    const e = new AppApiError(409, refusal);
    expect([e.status, e.code, e.body.requestId]).toEqual([409, "bank_detail_approver_linked", refusal.requestId]);
  });
});

describe("the generated client's ApiError — the same sentence, no status line", () => {
  afterEach(() => { setErrorMessageResolver(null); delete (globalThis as { localStorage?: unknown }).localStorage; });

  it("🔴 with the app's resolver registered: the reader's sentence — never 'HTTP 409 Conflict: …'", async () => {
    const { userMessage } = await import("./userMessage");
    setErrorMessageResolver(userMessage);
    withLang("ar");
    const e = clientError(409, "Conflict", refusal);
    expect(e.message).toBe("لا يمكنك اعتماد هذا التغيير.");
    expect(e.message).not.toMatch(/HTTP|409|Conflict/);
    expect([e.status, (e.data as typeof refusal).code]).toEqual([409, "bank_detail_approver_linked"]);
  });

  it("🔴 without a resolver it is still safe: a 4xx's own sentence, a 5xx's text never, and no status line either way", () => {
    expect(clientError(409, "Conflict", refusal).message).toBe("You cannot approve this change.");
    const five = clientError(500, "Internal Server Error", { error: SECRET }).message;
    expect(five).not.toMatch(/secret_ledger_table|HTTP|500|Internal Server Error/);
  });

  it("the technical line survives for a developer, off the user's path", () => {
    expect((clientError(409, "Conflict", refusal) as unknown as { diagnostic: string }).diagnostic).toMatch(/HTTP 409 Conflict/);
  });
});
