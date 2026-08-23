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
  { description: "LINKEDIN ADS CAMPAIGN AUG", type: "debit", expected: "MARKETING", language: "en" },
  { description: "FLYNAS BOOKING RUH-JED STAFF", type: "debit", expected: "TRAVEL", language: "en", hard: true },
  { description: "PWC ADVISORY RETAINER", type: "debit", expected: "PROFESSIONAL_FEES", language: "en" },
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
  { description: "", descriptionAr: "غداء عمل مع العملاء مطعم النخيل", type: "debit", expected: "FOOD_MEALS", language: "ar" },
  { description: "", descriptionAr: "حملة إعلانية سناب شات", type: "debit", expected: "MARKETING", language: "ar" },
  { description: "", descriptionAr: "تذاكر طيران ناس جدة", type: "debit", expected: "TRAVEL", language: "ar", hard: true },
  { description: "", descriptionAr: "أتعاب مكتب المحاماة الشهرية", type: "debit", expected: "PROFESSIONAL_FEES", language: "ar", hard: true },
  { description: "", descriptionAr: "صيانة مكيفات المكتب", type: "debit", expected: "REPAIRS", language: "ar", hard: true },
  { description: "", descriptionAr: "إيراد تأجير المستودع", type: "credit", expected: "RENTAL_INCOME", language: "ar", hard: true },
  { description: "", descriptionAr: "شراء أثاث مكتبي جديد", type: "debit", expected: "FIXED_ASSETS", language: "ar" },

  // ── Mixed AR/EN (the common Saudi statement reality) ─────────────────────
  { description: "POS PURCHASE", descriptionAr: "مطعم البيك الرياض", type: "debit", expected: "FOOD_MEALS", language: "mixed" },
  { description: "SADAD", descriptionAr: "رسوم مكتب العمل", type: "debit", expected: "GOVT_FEES", language: "mixed", hard: true },
  { description: "TRANSFER IN", descriptionAr: "دفعة مشروع التوريد", type: "credit", expected: "SALES", language: "mixed", hard: true },

  // ── Honest-null cases: the right answer is "send to review" ──────────────
  // 🔴 These measure RESTRAINT. The engine's rule is that an uncategorised row
  // goes to review rather than being guessed; a model that invents a category
  // for these is WRONG even if the invented category is plausible.
  { description: "OUTWARD REMITTANCE REF 99Y1", type: "debit", expected: null, language: "en", hard: true },
  { description: "", descriptionAr: "حوالة صادرة بدون بيان", type: "debit", expected: null, language: "ar", hard: true },
  { description: "MISC ADJUSTMENT", type: "credit", expected: null, language: "en", hard: true },

  // ═══════════════════════════════════════════════════════════════════════
  // EXPANSION (2026-08-23). The owner's constraint: at 9–10 hard cases per
  // language, ONE case moved the hard-gate verdict by ~11 points — the corpus,
  // not model availability, was the binding constraint on model selection.
  // Hard cases now number 30+ per language (one case ≈ 3 points), EN and AR
  // deliberately EQUAL-N so the §2a gap compares like with like.
  //
  // Authoring rules unchanged: realistic Saudi statement lines, labels are
  // what a bookkeeper would say, never generated from the engine's regexes.
  // 🔴 A case whose ground truth is genuinely arguable between two codes was
  // EXCLUDED rather than labeled — an instrument case must not punish a
  // defensible answer. (Dropped on that rule: a bare "TAMARA SETTLEMENT"
  // credit — the engine's own m16 design says review-not-guess for bare
  // gateway settlements, while a bookkeeper would say SALES; a case the
  // platform itself cannot answer one way does not belong in the corpus.)
  // ═══════════════════════════════════════════════════════════════════════

  // ── English, HARD — novel vendors ────────────────────────────────────────
  { description: "HUNGERSTATION ORDER TEAM IFTAR RAMADAN", type: "debit", expected: "FOOD_MEALS", language: "en" },
  { description: "LULU HYPERMARKET PANTRY WATER COFFEE", type: "debit", expected: "FOOD_MEALS", language: "en" },
  { description: "AWS EMEA SARL USAGE AUG26", type: "debit", expected: "IT_SOFTWARE", language: "en" },
  { description: "SALLA PLATFORM SUBSCRIPTION RENEWAL", type: "debit", expected: "IT_SOFTWARE", language: "en" },
  { description: "TIKTOK ADS TOPUP REF T8812", type: "debit", expected: "MARKETING", language: "en" },
  { description: "IKEA BUSINESS DESKS AND CHAIRS INV 8871", type: "debit", expected: "FIXED_ASSETS", language: "en", hard: true },
  { description: "MOVENPICK HOTEL RIYADH 2 NIGHTS SUPPLIER VISIT", type: "debit", expected: "TRAVEL", language: "en" },
  { description: "CAREEM BUSINESS RIDES AUG STATEMENT", type: "debit", expected: "FUEL_TRANSPORT", language: "en" },
  { description: "ARAMEX SHIPPING CHARGES SEP", type: "debit", expected: "FUEL_TRANSPORT", language: "en" },
  { description: "MRSOOL COURIER DOCS TO CLIENT SAME DAY", type: "debit", expected: "FUEL_TRANSPORT", language: "en" },
  { description: "TAWUNIYA MOTOR FLEET POLICY RENEWAL", type: "debit", expected: "INSURANCE", language: "en" },

  // ── English, HARD — government surfaces the regexes don't know ───────────
  { description: "NAJIZ COURT FILING FEE", type: "debit", expected: "GOVT_FEES", language: "en", hard: true },
  { description: "MUQEEM IQAMA RENEWAL X3 STAFF", type: "debit", expected: "GOVT_FEES", language: "en", hard: true },
  { description: "NWC WATER BILL SADAD 030", type: "debit", expected: "RENT_UTILITIES", language: "en" },

  // ── English, HARD — OCR-ish noise / abbreviation ─────────────────────────
  { description: "SEC ELEC 10023981 SADAD AUTO", type: "debit", expected: "RENT_UTILITIES", language: "en" },
  { description: "AC DUCT CLEANING AND SERVICE OFFICE HQ", type: "debit", expected: "REPAIRS", language: "en", hard: true },

  // ── English, HARD — the entity-vs-action trap (a NAME says who, not what) ─
  { description: "PAYMENT RECEIVED FROM STC FOR CONSULTING SERVICES", type: "credit", expected: "SERVICE_INCOME", language: "en", hard: true },

  // ── English, HARD — income-side paraphrase ───────────────────────────────
  { description: "TENANT PAYMENT WAREHOUSE BAY 3 SEP", type: "credit", expected: "RENTAL_INCOME", language: "en", hard: true },
  { description: "DIVIDEND CREDIT ALINMA FUND UNITS", type: "credit", expected: "INVESTMENT_INCOME", language: "en" },

  // ── English, HARD — restraint ────────────────────────────────────────────
  { description: "CHQ 000481 CLEARED", type: "debit", expected: null, language: "en", hard: true },
  { description: "ADJ ENTRY BR 012 REF NIL", type: "credit", expected: null, language: "en", hard: true },

  // ── Arabic, HARD — novel vendors / paraphrase ────────────────────────────
  { description: "", descriptionAr: "طلبات هنقرستيشن عشاء فريق العمل", type: "debit", expected: "FOOD_MEALS", language: "ar", hard: true },
  { description: "", descriptionAr: "مشتريات قهوة ومياه لبوفيه المكتب", type: "debit", expected: "FOOD_MEALS", language: "ar", hard: true },
  { description: "", descriptionAr: "اشتراك منصة سلة السنوي للمتجر الإلكتروني", type: "debit", expected: "IT_SOFTWARE", language: "ar", hard: true },
  { description: "", descriptionAr: "إعلانات تيك توك للحملة الجديدة", type: "debit", expected: "MARKETING", language: "ar" },
  { description: "", descriptionAr: "طباعة بروشورات للمعرض التجاري", type: "debit", expected: "MARKETING", language: "ar", hard: true },
  { description: "", descriptionAr: "شحنات أرامكس للعملاء سبتمبر", type: "debit", expected: "FUEL_TRANSPORT", language: "ar" },
  { description: "", descriptionAr: "مشاوير كريم للأعمال شهر أغسطس", type: "debit", expected: "FUEL_TRANSPORT", language: "ar" },
  { description: "", descriptionAr: "إقامة فندقية ليلتين لزيارة مورد جدة", type: "debit", expected: "TRAVEL", language: "ar" },
  { description: "", descriptionAr: "تجديد وثيقة تأمين أسطول المركبات التعاونية", type: "debit", expected: "INSURANCE", language: "ar" },
  { description: "", descriptionAr: "إصلاح تسرب مياه بدورة مياه المكتب", type: "debit", expected: "REPAIRS", language: "ar", hard: true },
  { description: "", descriptionAr: "شراء جهاز نقاط بيع جديد للفرع", type: "debit", expected: "FIXED_ASSETS", language: "ar", hard: true },
  { description: "", descriptionAr: "أحبار طابعات وورق تصوير من الشقري", type: "debit", expected: "OFFICE_SUPPLIES", language: "ar", hard: true },
  { description: "", descriptionAr: "أتعاب مراجعة القوائم المالية السنوية", type: "debit", expected: "PROFESSIONAL_FEES", language: "ar", hard: true },
  { description: "", descriptionAr: "عمولة حوالة دولية للمورد الصيني", type: "debit", expected: "BANK_CHARGES", language: "ar" },

  // ── Arabic, HARD — government surfaces ───────────────────────────────────
  { description: "", descriptionAr: "رسوم رفع دعوى عبر ناجز", type: "debit", expected: "GOVT_FEES", language: "ar", hard: true },
  { description: "", descriptionAr: "تجديد إقامات الموظفين عبر مقيم", type: "debit", expected: "GOVT_FEES", language: "ar", hard: true },
  { description: "", descriptionAr: "فاتورة شركة المياه الوطنية", type: "debit", expected: "RENT_UTILITIES", language: "ar" },

  // ── Arabic, HARD — income side (Arabic-Indic numerals included) ──────────
  { description: "", descriptionAr: "دفعة مستأجر مستودع الخير شهر ٩", type: "credit", expected: "RENTAL_INCOME", language: "ar", hard: true },
  { description: "", descriptionAr: "مستخلص رقم ٣ مشروع التشطيبات", type: "credit", expected: "SERVICE_INCOME", language: "ar", hard: true },
  { description: "", descriptionAr: "توزيعات أرباح صندوق الاستثمار", type: "credit", expected: "INVESTMENT_INCOME", language: "ar" },

  // ── Arabic, HARD — restraint ─────────────────────────────────────────────
  { description: "", descriptionAr: "حوالة واردة بدون تفاصيل", type: "credit", expected: null, language: "ar", hard: true },
  { description: "", descriptionAr: "قيد تسوية مرجع ٨٨٤", type: "debit", expected: null, language: "ar", hard: true },
  { description: "", descriptionAr: "مبلغ مرتجع غير محدد", type: "credit", expected: null, language: "ar", hard: true },

  // ── Mixed AR/EN (the common Saudi statement reality) ─────────────────────
  { description: "POS SPAN", descriptionAr: "مطاعم هرفي وجبات العاملين", type: "debit", expected: "FOOD_MEALS", language: "mixed" },
  { description: "SADAD 071", descriptionAr: "المؤسسة العامة للتأمينات الاجتماعية", type: "debit", expected: "GOSI_EXPENSE", language: "mixed", hard: true },
  { description: "OUTWARD TT", descriptionAr: "أتعاب استشارات هندسية", type: "debit", expected: "PROFESSIONAL_FEES", language: "mixed", hard: true },
  { description: "CARD PURCHASE", descriptionAr: "قطع غيار تكييف المكتب", type: "debit", expected: "REPAIRS", language: "mixed", hard: true },
  { description: "INWARD REMITTANCE", descriptionAr: "دفعة عقد التوريد الثاني", type: "credit", expected: "SALES", language: "mixed", hard: true },
  { description: "SADAD", descriptionAr: "تجديد رخصة البلدية للفرع", type: "debit", expected: "GOVT_FEES", language: "mixed", hard: true },
  { description: "POS", descriptionAr: "مكتبة جرير حبر طابعة", type: "debit", expected: "OFFICE_SUPPLIES", language: "mixed", hard: true },

  // ── SECOND ROUND (same day) — hard means MEASURED-hard ───────────────────
  // 🔴 The first expansion's `hard` flags were authored by GUESS, and the
  // guess was wrong 28 times: the engine's vendor vocabulary (Careem, Aramex,
  // Tawuniya, NWC, AWS, Salla, TikTok…) solved them at ≥0.65, so they never
  // reach the LLM and were padding the hard-only baseline — including SIX
  // cases from the ORIGINAL corpus. The flag is a claim about the engine, and
  // claims about the engine are checkable: `inspectCases.ts` prints every
  // hard-flagged case the engine solves; run it after ANY corpus edit and
  // reflag what it names. (Flag by measurement, never reword a case until the
  // engine fails — that would be authoring FROM the engine, the inversion the
  // header forbids.)
  //
  // These replacements carry no brand anchor at all: descriptive phrases a
  // statement or memo line actually uses when no known vendor name appears.
  { description: "MONTHLY WIFI FOR SHOWROOM BRANCH 2", type: "debit", expected: "TELECOM", language: "en", hard: true },
  { description: "PREPAID DATA SIMS FOR DELIVERY DRIVERS", type: "debit", expected: "TELECOM", language: "en", hard: true },
  { description: "NEW DELIVERY VAN DOWN PAYMENT SHOWROOM", type: "debit", expected: "FIXED_ASSETS", language: "en", hard: true },
  { description: "DRINKING WATER DISPENSER REFILLS MONTHLY", type: "debit", expected: "FOOD_MEALS", language: "en", hard: true },
  { description: "REFRESHMENTS FOR BOARD MEETING THURSDAY", type: "debit", expected: "FOOD_MEALS", language: "en", hard: true },
  { description: "SPONSOR BOOTH RETAIL EXPO EASTERN PROVINCE", type: "debit", expected: "MARKETING", language: "en", hard: true },
  { description: "SIGNBOARD REBRANDING FRONT FACADE", type: "debit", expected: "MARKETING", language: "en", hard: true },
  { description: "QUARTERLY PEST CONTROL WAREHOUSE", type: "debit", expected: "REPAIRS", language: "en", hard: true },
  { description: "WAREHOUSE FORKLIFT ANNUAL SERVICE", type: "debit", expected: "REPAIRS", language: "en", hard: true },
  { description: "TRANSLATION OF CONTRACTS SWORN TRANSLATOR", type: "debit", expected: "PROFESSIONAL_FEES", language: "en", hard: true },
  { description: "SETTLEMENT OF STAFF END OF SERVICE AWARD", type: "debit", expected: "SALARIES", language: "en", hard: true },
  { description: "PROGRESS PAYMENT FITOUT PROJECT PHASE 2", type: "credit", expected: "SERVICE_INCOME", language: "en", hard: true },
  { description: "PROFIT ON MURABAHA DEPOSIT Q3", type: "credit", expected: "INVESTMENT_INCOME", language: "en", hard: true },
  { description: "ONLINE STORE ORDERS PAYOUT WEEK 34", type: "credit", expected: "SALES", language: "en", hard: true },

  { description: "", descriptionAr: "اشتراك إنترنت فايبر لصالة العرض", type: "debit", expected: "TELECOM", language: "ar", hard: true },
  { description: "", descriptionAr: "شرائح بيانات مسبقة الدفع للسائقين", type: "debit", expected: "TELECOM", language: "ar", hard: true },
  { description: "", descriptionAr: "دفعة أولى لشراء فان توصيل جديد", type: "debit", expected: "FIXED_ASSETS", language: "ar", hard: true },
  { description: "", descriptionAr: "ضيافة اجتماع مجلس الإدارة", type: "debit", expected: "FOOD_MEALS", language: "ar", hard: true },
  { description: "", descriptionAr: "رعاية جناح بمعرض التجزئة", type: "debit", expected: "MARKETING", language: "ar", hard: true },
  { description: "", descriptionAr: "تجديد لوحة الواجهة بعد تغيير الهوية", type: "debit", expected: "MARKETING", language: "ar", hard: true },
  { description: "", descriptionAr: "مكافحة حشرات دورية للمستودع", type: "debit", expected: "REPAIRS", language: "ar", hard: true },
  { description: "", descriptionAr: "ترجمة عقود لدى مترجم معتمد", type: "debit", expected: "PROFESSIONAL_FEES", language: "ar", hard: true },
  { description: "", descriptionAr: "صرف مكافأة نهاية خدمة موظف", type: "debit", expected: "SALARIES", language: "ar" },
  { description: "", descriptionAr: "أرباح وديعة مرابحة", type: "credit", expected: "INVESTMENT_INCOME", language: "ar", hard: true },

  { description: "TT OUT", descriptionAr: "دفعة مقدمة لمعدات مطبخ المطعم", type: "debit", expected: "FIXED_ASSETS", language: "mixed", hard: true },
  { description: "CARD", descriptionAr: "عشاء ضيافة وفد المورد", type: "debit", expected: "FOOD_MEALS", language: "mixed", hard: true },

  // Mixed to the same ≥30-hard bar as en/ar (§12g names all three languages).
  // The EN half is the terse machine prefix a Saudi statement actually prints;
  // the memo is where the meaning lives.
  { description: "SADAD", descriptionAr: "مخالفة سرعة على مركبة الشركة", type: "debit", expected: "GOVT_FEES", language: "mixed", hard: true },
  { description: "TT OUT", descriptionAr: "دفعة محامي قضية تحصيل ديون", type: "debit", expected: "PROFESSIONAL_FEES", language: "mixed" },
  { description: "CARD", descriptionAr: "حجز تذاكر مؤتمر دبي للموظفين", type: "debit", expected: "TRAVEL", language: "mixed", hard: true },
  { description: "POS", descriptionAr: "وقود مولد الكهرباء للمستودع", type: "debit", expected: "FUEL_TRANSPORT", language: "mixed", hard: true },
  { description: "IB TRF", descriptionAr: "إيجار شقة سكن المهندسين", type: "debit", expected: "RENT_UTILITIES", language: "mixed" },
  { description: "ATM DEP", descriptionAr: "تحصيل نقدي من نقطة البيع فرع الدمام", type: "credit", expected: "SALES", language: "mixed", hard: true },
  { description: "CARD", descriptionAr: "أدوات تنظيف ومعقمات للمكتب", type: "debit", expected: "OFFICE_SUPPLIES", language: "mixed", hard: true },
  { description: "TT IN", descriptionAr: "دفعة عقد صيانة سنوي من العميل", type: "credit", expected: "SERVICE_INCOME", language: "mixed", hard: true },
  { description: "POS", descriptionAr: "هدايا نهاية العام للعملاء", type: "debit", expected: "MARKETING", language: "mixed", hard: true },
  { description: "CHEQUE", descriptionAr: "دفعة إيجار محل التجزئة الشهرية", type: "debit", expected: "RENT_UTILITIES", language: "mixed" },
  { description: "IB TRF", descriptionAr: "راتب شهر رمضان للمحاسب", type: "debit", expected: "SALARIES", language: "mixed" },
  { description: "CARD", descriptionAr: "تصميم هوية بصرية للعلامة التجارية", type: "debit", expected: "MARKETING", language: "mixed", hard: true },
  { description: "SADAD", descriptionAr: "تأشيرات عمل جديدة لعمالة وافدة", type: "debit", expected: "GOVT_FEES", language: "mixed", hard: true },
  { description: "TT OUT", descriptionAr: "قسط تمويل المعدات الشهري", type: "debit", expected: "LOANS", language: "mixed" },
  { description: "CARD", descriptionAr: "اشتراك برنامج إدارة المخزون الشهري", type: "debit", expected: "IT_SOFTWARE", language: "mixed", hard: true },
  { description: "POS", descriptionAr: "ضيافة قهوة لضيوف المعرض", type: "debit", expected: "FOOD_MEALS", language: "mixed", hard: true },
  { description: "SPAN", descriptionAr: "شحن طرود لعملاء المتجر الإلكتروني", type: "debit", expected: "FUEL_TRANSPORT", language: "mixed" },
  { description: "IB TRF", descriptionAr: "أقساط تأمين طبي للعائلات المرافقة", type: "debit", expected: "INSURANCE", language: "mixed" },
  { description: "ATM WD", descriptionAr: "مصروفات نثرية للفرع", type: "debit", expected: null, language: "mixed", hard: true },
  { description: "TT IN", descriptionAr: "استرداد تأمين مسترد من المؤجر", type: "credit", expected: null, language: "mixed", hard: true },
  { description: "POS", descriptionAr: "تجهيزات ركن الاستقبال الجديد", type: "debit", expected: "FIXED_ASSETS", language: "mixed", hard: true },
  { description: "SPAN", descriptionAr: "لوحات ترويجية لواجهة الفرع", type: "debit", expected: "MARKETING", language: "mixed", hard: true },
  { description: "TT IN", descriptionAr: "دفعة أعمال تركيب الأنظمة للعميل", type: "credit", expected: "SERVICE_INCOME", language: "mixed", hard: true },
  { description: "SADAD", descriptionAr: "تصديق شهادة منشأ للتصدير", type: "debit", expected: "GOVT_FEES", language: "mixed", hard: true },
  { description: "CARD", descriptionAr: "تجديد نطاق الموقع والاستضافة السحابية", type: "debit", expected: "IT_SOFTWARE", language: "mixed", hard: true },
  { description: "CARD", descriptionAr: "ورد وتنسيق افتتاح الفرع الجديد", type: "debit", expected: "MARKETING", language: "mixed", hard: true },
  { description: "TT OUT", descriptionAr: "سلفة مستردة لموظف المبيعات", type: "debit", expected: null, language: "mixed", hard: true },
];
