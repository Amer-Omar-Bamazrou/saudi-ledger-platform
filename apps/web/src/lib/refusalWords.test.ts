/**
 * 🔴 Phase 18 audit A25 (2026-11-10): a refusal reaches an Arabic reader in Arabic.
 *
 * The server's sentence is the toast's description for every refusal that has no title of its own (the global mutation
 * cache in App.tsx). It was `error.message` — the English sentence — even in Arabic mode, and `errorAr`, which some
 * refusals already carried, was read on one screen only. `refusalOf` is now the one place a refusal's words are read,
 * and it returns `errorAr` to an Arabic reader.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { refusalOf } from "./openingVatRefusals";

const withLang = (lang: string | null) => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === "ksa_lang" ? lang : null) };
};

describe("A25 — refusalOf speaks the reader's language", () => {
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });
  const refusal = { status: 422, body: { code: "protected_account", error: "VAT Payable is written only by an invoice.", errorAr: "ضريبة القيمة المضافة المستحقة لا يكتب فيها إلا الفاتورة." } };

  it("🔴 Arabic reader, Arabic sentence available: the Arabic sentence", () => {
    withLang("ar");
    expect(refusalOf(refusal)).toEqual({ code: "protected_account", words: refusal.body.errorAr });
  });
  it("English reader: the English sentence", () => {
    withLang("en");
    expect(refusalOf(refusal).words).toBe(refusal.body.error);
  });
  it("Arabic reader, no Arabic sentence: the English one — never an empty description", () => {
    withLang("ar");
    expect(refusalOf({ body: { code: "x", error: "Only English." } }).words).toBe("Only English.");
    expect(refusalOf({ body: { code: "x", error: "Only English.", errorAr: "  " } }).words).toBe("Only English.");
  });
  it("🔴 the global mutation-cache fallback describes a refusal through refusalOf, not the raw message", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain("description: error instanceof Error ? refusalOf(error).words");
    expect(app).not.toContain("description: error instanceof Error ? error.message");
  });
});
