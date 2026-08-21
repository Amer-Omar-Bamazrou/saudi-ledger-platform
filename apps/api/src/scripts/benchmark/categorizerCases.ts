/**
 * The categorizer benchmark corpus (AI-1b).
 *
 * Hand-curated, labeled, realistic Saudi bank-statement lines — NOT generated
 * by inverting the engine's regexes. Inverting the rules would test whether
 * the model matches our matcher (the SDK-differential disease: an oracle that
 * shares the defect it should detect); these are written as statement lines a
 * Saudi bank actually prints, and the label is what a bookkeeper would say.
 *
 * 🔴 SYNTHETIC BY DESIGN. Every line is invented; no tenant's statement
 * contributed a byte. That is what makes the corpus legal on the Groq free
 * tier under the owner's boundary (design-ai-layer §12b).
 *
 * `language` drives the §2a hard gate: Arabic and English are SCORED
 * SEPARATELY, and an English-strong/Arabic-poor model fails regardless of its
 * blended score. `hard: true` marks cases the deterministic engine is
 * expected to miss or under-score (novel vendors, paraphrases, noisy OCR-ish
 * text) — the LLM's entire value is measured on these.
 */

export interface BenchmarkCase {
  description: string;
  descriptionAr?: string;
  type: "debit" | "credit";
  /** Ground truth systemCode, or null when the honest answer is "no category" (goes to review). */
  expected: string | null;
  language: "en" | "ar" | "mixed";
  /** True when the deterministic engine is not expected to solve it alone. */
  hard?: boolean;
}

export const BENCHMARK_CASES: BenchmarkCase[] = [
  // ── English, engine-vocabulary territory ─────────────────────────────────
  { description: "POS PURCHASE MADA - JARIR BOOKSTORE RIYADH", type: "debit", expected: "OFFICE_SUPPLIES", language: "en", hard: true },
  { description: "SADAD PAYMENT - MOI TRAFFIC VIOLATION", type: "debit", expected: "GOVT_FEES", language: "en" },
  { description: "SADAD BILL - SAUDI ELECTRICITY COMPANY", type: "debit", expected: "RENT_UTILITIES", language: "en" },
  { description: "STC PAY MONTHLY INVOICE 5G BUSINESS", type: "debit", expected: "TELECOM", language: "en" },
  { description: "MOBILY POSTPAID SETTLEMENT", type: "debit", expected: "TELECOM", language: "en" },
  { description: "WPS SALARY BATCH 2026-07", type: "debit", expected: "SALARIES", language: "en" },
  { description: "GOSI MONTHLY CONTRIBUTION", type: "debit", expected: "GOSI_EXPENSE", language: "en" },
  { description: "ALDREES FUEL STATION 95", type: "debit", expected: "FUEL_TRANSPORT", language: "en" },
  { description: "SASCO PETROL PAYMENT", type: "debit", expected: "FUEL_TRANSPORT", language: "en" },
  { description: "MONTHLY ACCOUNT MAINTENANCE FEE", type: "debit", expected: "BANK_CHARGES", language: "en" },
  { description: "VAT RETURN PAYMENT ZATCA Q2", type: "debit", expected: "VAT_PAYMENT", language: "en" },
  { description: "OFFICE RENT RAMADAN TOWER Q3", type: "debit", expected: "RENT_UTILITIES", language: "en" },
  { description: "BUPA ARABIA MEDICAL PREMIUM", type: "debit", expected: "INSURANCE", language: "en" },
  { description: "MICROSOFT 365 BUSINESS ANNUAL", type: "debit", expected: "IT_SOFTWARE", language: "en" },
  { description: "CUSTOMER PAYMENT INV-2026-000112", type: "credit", expected: "SALES", language: "en" },
  { description: "CONSULTING RETAINER RECEIVED - NAJD CO", type: "credit", expected: "SERVICE_INCOME", language: "en" },

  // ── English, HARD: novel vendors / paraphrase / noise ────────────────────
  { description: "PANDA HYPER MKT STAFF PANTRY RESTOCK", type: "debit", expected: "FOOD_MEALS", language: "en", hard: true },
  { description: "HRSD QIWA CERT REISSUE", type: "debit", expected: "GOVT_FEES", language: "en", hard: true },
  { description: "LINKEDIN ADS CAMPAIGN AUG", type: "debit", expected: "MARKETING", language: "en", hard: true },
  { description: "FLYNAS BOOKING RUH-JED STAFF", type: "debit", expected: "TRAVEL", language: "en", hard: true },
  { description: "PWC ADVISORY RETAINER", type: "debit", expected: "PROFESSIONAL_FEES", language: "en", hard: true },
  { description: "EXTRA STORES LAPTOP X2 ADMIN", type: "debit", expected: "IT_SOFTWARE", language: "en", hard: true },
  { description: "APARTMENT LEASE INCOME UNIT 4B", type: "credit", expected: "RENTAL_INCOME", language: "en", hard: true },

  // ── Arabic, engine-vocabulary territory ──────────────────────────────────
  { description: "", descriptionAr: "مدفوعات سداد - المرور", type: "debit", expected: "GOVT_FEES", language: "ar" },
  { description: "", descriptionAr: "فاتورة شركة الكهرباء السعودية", type: "debit", expected: "RENT_UTILITIES", language: "ar" },
  { description: "", descriptionAr: "سداد فاتورة الاتصالات السعودية", type: "debit", expected: "TELECOM", language: "ar" },
  { description: "", descriptionAr: "رواتب الموظفين يوليو", type: "debit", expected: "SALARIES", language: "ar" },
  { description: "", descriptionAr: "اشتراك التأمينات الاجتماعية", type: "debit", expected: "GOSI_EXPENSE", language: "ar" },
  { description: "", descriptionAr: "محطة وقود الدريس", type: "debit", expected: "FUEL_TRANSPORT", language: "ar" },
  { description: "", descriptionAr: "رسوم إدارية للحساب", type: "debit", expected: "BANK_CHARGES", language: "ar" },
  { description: "", descriptionAr: "سداد ضريبة القيمة المضافة", type: "debit", expected: "VAT_PAYMENT", language: "ar" },
  { description: "", descriptionAr: "إيجار المكتب الربع الثالث", type: "debit", expected: "RENT_UTILITIES", language: "ar" },
  { description: "", descriptionAr: "قسط تأمين طبي بوبا", type: "debit", expected: "INSURANCE", language: "ar" },
  { description: "", descriptionAr: "دفعة عميل فاتورة رقم ١١٢", type: "credit", expected: "SALES", language: "ar" },
  { description: "", descriptionAr: "سداد الزكاة الشرعية", type: "debit", expected: "ZAKAT_PAYMENT", language: "ar" },

  // ── Arabic, HARD ─────────────────────────────────────────────────────────
  { description: "", descriptionAr: "شراء قرطاسية من مكتبة جرير", type: "debit", expected: "OFFICE_SUPPLIES", language: "ar", hard: true },
  { description: "", descriptionAr: "غداء عمل مع العملاء مطعم النخيل", type: "debit", expected: "FOOD_MEALS", language: "ar", hard: true },
  { description: "", descriptionAr: "حملة إعلانية سناب شات", type: "debit", expected: "MARKETING", language: "ar", hard: true },
  { description: "", descriptionAr: "تذاكر طيران ناس جدة", type: "debit", expected: "TRAVEL", language: "ar", hard: true },
  { description: "", descriptionAr: "أتعاب مكتب المحاماة الشهرية", type: "debit", expected: "PROFESSIONAL_FEES", language: "ar", hard: true },
  { description: "", descriptionAr: "صيانة مكيفات المكتب", type: "debit", expected: "REPAIRS", language: "ar", hard: true },
  { description: "", descriptionAr: "إيراد تأجير المستودع", type: "credit", expected: "RENTAL_INCOME", language: "ar", hard: true },
  { description: "", descriptionAr: "شراء أثاث مكتبي جديد", type: "debit", expected: "FIXED_ASSETS", language: "ar", hard: true },

  // ── Mixed AR/EN (the common Saudi statement reality) ─────────────────────
  { description: "POS PURCHASE", descriptionAr: "مطعم البيك الرياض", type: "debit", expected: "FOOD_MEALS", language: "mixed", hard: true },
  { description: "SADAD", descriptionAr: "رسوم مكتب العمل", type: "debit", expected: "GOVT_FEES", language: "mixed", hard: true },
  { description: "TRANSFER IN", descriptionAr: "دفعة مشروع التوريد", type: "credit", expected: "SALES", language: "mixed", hard: true },

  // ── Honest-null cases: the right answer is "send to review" ──────────────
  // 🔴 These measure RESTRAINT. The engine's rule is that an uncategorised row
  // goes to review rather than being guessed; a model that invents a category
  // for these is WRONG even if the invented category is plausible.
  { description: "OUTWARD REMITTANCE REF 99Y1", type: "debit", expected: null, language: "en", hard: true },
  { description: "", descriptionAr: "حوالة صادرة بدون بيان", type: "debit", expected: null, language: "ar", hard: true },
  { description: "MISC ADJUSTMENT", type: "credit", expected: null, language: "en", hard: true },
];
