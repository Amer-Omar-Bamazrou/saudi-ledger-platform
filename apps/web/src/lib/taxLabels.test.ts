/**
 * QA-16 (D-04 family) — legal references in the reader's language.
 *
 * The WHT rate schedule stores its citations in English (migration 0113), and
 * the engines write article numbers with English sub-paragraph letters. In the
 * Arabic UI they read as English. The Arabic is the ORIGINAL text of every
 * regulation cited, so the Arabic screen names the regulation by its official
 * Arabic title and numbers sub-paragraphs as the regulation does. 🔴 A citation
 * not recognised in EVERY part stays verbatim — never half-translated.
 */
import { describe, expect, it } from "vitest";
import { articleRef, legalRef, poolLimitLabel } from "./taxLabels";

/** Every distinct `legal_reference` the 0113 seed writes — the strings the pages actually receive. */
const SEEDED = [
  "Income Tax IR Art. 63(1) (MoF Res. 25/1445H)",
  "Income Tax IR Art. 63(1)–(2) (MoF Res. 25/1445H)",
  "Income Tax IR Art. 63(1), (4) (MoF Res. 25/1445H)",
  "Income Tax IR Art. 63(1), (5) (MoF Res. 25/1445H; Res. 484/1444H)",
  "Income Tax IR Art. 63(1), (6) (MoF Res. 25/1445H)",
  "Income Tax IR Art. 63(1), (3) (MoF Res. 25/1445H)",
  "Income Tax IR Art. 63(1), (7) (MoF Res. 25/1445H)",
];

describe("legalRef — a stored English citation in the reader's language", () => {
  it("English is returned exactly as stored", () => {
    for (const s of SEEDED) expect(legalRef(s, "en")).toBe(s);
  });

  it("🔴 Arabic: every seeded citation is rendered fully — the regulation by its official Arabic title, no Latin letter left", () => {
    for (const s of SEEDED) {
      const ar = legalRef(s, "ar");
      expect(ar, s).toMatch(/^المادة /);
      expect(ar, s).toContain("من اللائحة التنفيذية لنظام ضريبة الدخل");
      expect(ar, s).toContain("قرار وزير المالية رقم 25/1445هـ");
      expect(/[A-Za-z]/.test(ar), `${s} → ${ar}`).toBe(false);
    }
    expect(legalRef("Income Tax IR Art. 63(1), (4) (MoF Res. 25/1445H)", "ar")).toBe("المادة 63(1)، (4) من اللائحة التنفيذية لنظام ضريبة الدخل (قرار وزير المالية رقم 25/1445هـ)");
    expect(legalRef("Income Tax IR Art. 63(1), (5) (MoF Res. 25/1445H; Res. 484/1444H)", "ar")).toBe("المادة 63(1)، (5) من اللائحة التنفيذية لنظام ضريبة الدخل (قرار وزير المالية رقم 25/1445هـ؛ القرار رقم 484/1444هـ)");
    expect(legalRef("Income Tax Law Art. 68", "ar")).toBe("المادة 68 من نظام ضريبة الدخل");
    expect(legalRef("Zakat Regulations Arts 21–28", "ar")).toBe("المواد 21–28 من اللائحة التنفيذية لجباية الزكاة");
  });

  it("🔴 anything not recognised in every part stays VERBATIM — never half-translated", () => {
    for (const s of [
      "OECD Model Art. 12",                                  // a source we do not name
      "Income Tax IR Art. 63(1) (Circular 7/1445H)",         // an amending instrument we do not know
      "Income Tax IR Art. 63(n)",                            // a sub-paragraph letter beyond the table
      "Zakat Regulations Art. 63 — see the guide",           // trailing words
    ]) expect(legalRef(s, "ar")).toBe(s);
    expect(legalRef(null, "ar")).toBe("—");
  });
});

describe("articleRef — the engines' article column", () => {
  it("Arabic letters for sub-paragraphs (abjad order), Arabic commas, the two words translated", () => {
    expect(articleRef("17(d),(h),(i)", "ar")).toBe("17(د)، (ح)، (ط)");
    expect(articleRef("2(a), 6(a)", "ar")).toBe("2(أ)، 6(أ)");
    expect(articleRef("17(g)", "ar")).toBe("17(ز)"); // the page's own STEP_LABEL writes 17(ز) — one numbering
    expect(articleRef("23(2), 25, 29", "ar")).toBe("23(2)، 25، 29");
    expect(articleRef("28 (not applied)", "ar")).toBe("28 (لم يُطبَّق)");
    expect(articleRef("declared", "ar")).toBe("مُقرّ");
    expect(articleRef("ledger", "ar")).toBe("الدفاتر");
    expect(articleRef("—", "ar")).toBe("—");
  });
  it("English unchanged; an unknown word stays verbatim in Arabic", () => {
    expect(articleRef("17(d),(h),(i)", "en")).toBe("17(d),(h),(i)");
    expect(articleRef("see note", "ar")).toBe("see note");
  });
});

describe("poolLimitLabel — keyed by the article CODE, the server's sentence otherwise", () => {
  it("Arabic for the five frame limits; English, or an unknown code, keeps the server's words", () => {
    expect(poolLimitLabel("17(a)", "Land is not depreciable…", "ar")).toMatch(/^الأرض لا تُهلك/);
    expect(poolLimitLabel("17(a)", "Land is not depreciable…", "en")).toBe("Land is not depreciable…");
    expect(poolLimitLabel("17(z)", "Something new.", "ar")).toBe("Something new.");
  });
});
