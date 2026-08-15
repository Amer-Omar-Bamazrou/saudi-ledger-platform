/**
 * Saudi Bookkeeping Categorization Engine
 *
 * A fully deterministic, rule-based categorization engine for Saudi Arabian
 * financial transactions. No external APIs required. Rules are derived from:
 *  - ZATCA (Zakat, Tax and Customs Authority) VAT guidelines
 *  - Common Saudi merchant names in English and Arabic
 *  - GAZT category conventions
 */

export interface CategorizationMatch {
  /**
   * 🔴 A STABLE SYSTEM CODE, resolved against the tenant's own chart at use —
   * NEVER a raw category id (M15).
   *
   * The engine used to return ids from its own hardcoded list (1–30) while the
   * real `categories` table used serial ids. Nothing forced the two spaces to
   * agree, so they diverged, and the FK rejected every auto-categorized row:
   * the default upload path imported NOTHING. One identity space now — the same
   * `system_code` M13 established — and a test asserts every code this engine
   * can emit exists in the seeded template, so they cannot drift apart again.
   */
  systemCode: string;
  categoryName: string;
  categoryNameAr: string;
  confidence: number; // 0.0 – 1.0
  matchedRule: string;
  vatApplicable: boolean;
  suggestedVatRate: number | null; // 15 for standard, 0 for exempt, null for unknown
  /**
   * M16.2 — set to "transfer" when this movement is money between the
   * business's own pockets (ATM withdrawal, own-account move, credit-card
   * settlement). A transfer carries NO category and NO VAT: the classification
   * IS the kind, and consumers must branch on it BEFORE touching systemCode
   * (which is a display label for transfers, never resolved against the chart).
   */
  kind?: "transfer";
  /**
   * 🔴 Flaw #6 — whether VAT was actually CHARGED on this payment, which is a
   * different fact from what the supply is (`systemCode` → treatment).
   *
   * Set to `reverse_charge` for known foreign digital suppliers: the supply is
   * standard-rated, but an Irish/Luxembourg entity charges no KSA VAT and the
   * BUYER self-accounts. Extracting 15% from those payments is what invented
   * 450.00 of input VAT on one Google Ads charge in the live SME run.
   *
   * ⚠️ This is an ASSUMPTION, not a verified fact per supplier — several large
   * platforms have since registered in KSA and DO charge VAT. It is surfaced
   * as overridable in review for exactly that reason (queue C9).
   */
  vatBasis?: "charged" | "reverse_charge" | "supplier_unregistered";
}

export interface SeedCategory {
  /** Kept for stable ordering only. NEVER used for resolution — see systemCode. */
  id: number;
  /** The identity. Must exist in `system_account_templates` (test-enforced). */
  systemCode: string;
  name: string;
  nameAr: string;
  type: "income" | "expense" | "asset" | "liability" | "equity";
  vatApplicable: boolean;
  description?: string;
}

// ─────────────────────────────────────────────
// Canonical Saudi bookkeeping category set
// ─────────────────────────────────────────────
export const SEED_CATEGORIES: SeedCategory[] = [
  // INCOME
  {
    id: 1,
    systemCode: "SALES",
    name: "Sales Revenue",
    nameAr: "إيرادات المبيعات",
    type: "income",
    vatApplicable: true,
    description: "Revenue from sale of goods or services",
  },
  {
    id: 2,
    systemCode: "SERVICE_INCOME",
    name: "Service Income",
    nameAr: "إيرادات الخدمات",
    type: "income",
    vatApplicable: true,
    description: "Income from professional or consulting services",
  },
  {
    id: 3,
    systemCode: "RENTAL_INCOME",
    name: "Rental Income",
    nameAr: "إيرادات الإيجار",
    type: "income",
    vatApplicable: true,
    description: "Income from property rentals",
  },
  {
    id: 4,
    systemCode: "INVESTMENT_INCOME",
    name: "Investment Returns",
    nameAr: "عوائد الاستثمار",
    type: "income",
    vatApplicable: false,
    description: "Dividends, profit shares, investment gains",
  },
  {
    id: 5,
    systemCode: "GOVT_GRANTS",
    name: "Government Grants",
    nameAr: "المنح الحكومية",
    type: "income",
    vatApplicable: false,
    description: "Grants from Saudi government bodies",
  },
  {
    id: 6,
    systemCode: "OTHER_INCOME",
    name: "Other Income",
    nameAr: "إيرادات أخرى",
    type: "income",
    vatApplicable: false,
    description: "Miscellaneous income",
  },

  // EXPENSES
  {
    id: 7,
    systemCode: "SALARIES",
    name: "Salaries & Wages",
    nameAr: "الرواتب والأجور",
    type: "expense",
    vatApplicable: false,
    description: "Employee salaries, wages, bonuses",
  },
  {
    // 🔴 Added when the GOSI rule (#7) silently did nothing: see the
    // rule-coverage guard in `categorization-m15.test.ts`. A rule whose
    // `systemCode` is absent from THIS list is skipped by `if (!cat) continue`
    // in the matcher — the code can be valid, seeded in the chart, and present
    // in `allEngineCodes()`, and the rule still never fires.
    id: 31,
    systemCode: "GOSI_EXPENSE",
    name: "GOSI / Social Insurance",
    nameAr: "التأمينات الاجتماعية",
    type: "expense",
    vatApplicable: false,
    description: "Employer social-insurance (GOSI) contributions",
  },
  {
    id: 8,
    systemCode: "RENT_UTILITIES",
    name: "Rent & Utilities",
    nameAr: "الإيجار والمرافق",
    type: "expense",
    vatApplicable: true,
    description: "Office/shop rent, electricity, water, internet",
  },
  {
    id: 9,
    systemCode: "TELECOM",
    name: "Telecommunications",
    nameAr: "الاتصالات",
    type: "expense",
    vatApplicable: true,
    description: "Mobile, internet, telephone bills",
  },
  {
    id: 10,
    systemCode: "FUEL_TRANSPORT",
    name: "Fuel & Transportation",
    nameAr: "الوقود والمواصلات",
    type: "expense",
    vatApplicable: true,
    description: "Vehicle fuel, taxis, delivery costs",
  },
  {
    id: 11,
    systemCode: "FOOD_MEALS",
    name: "Food & Meals",
    nameAr: "الطعام والوجبات",
    type: "expense",
    vatApplicable: true,
    description: "Business meals, restaurant visits, catering",
  },
  {
    id: 12,
    systemCode: "MARKETING",
    name: "Marketing & Advertising",
    nameAr: "التسويق والإعلان",
    type: "expense",
    vatApplicable: true,
    description: "Digital ads, print, promotions",
  },
  {
    id: 13,
    systemCode: "OFFICE_SUPPLIES",
    name: "Office Supplies",
    nameAr: "اللوازم المكتبية",
    type: "expense",
    vatApplicable: true,
    description: "Stationery, printing, office consumables",
  },
  {
    id: 14,
    systemCode: "PROFESSIONAL_FEES",
    name: "Professional Services",
    nameAr: "الخدمات المهنية",
    type: "expense",
    vatApplicable: true,
    description: "Legal, accounting, consulting fees",
  },
  {
    id: 15,
    systemCode: "BANK_CHARGES",
    name: "Bank Charges",
    nameAr: "الرسوم البنكية",
    type: "expense",
    vatApplicable: true,
    description: "Bank fees, transfer charges, SADAD fees",
  },
  {
    id: 16,
    systemCode: "GOVT_FEES",
    name: "Government Fees",
    nameAr: "الرسوم الحكومية",
    type: "expense",
    vatApplicable: false,
    description: "Ministry of Commerce, MOI, municipality fees",
  },
  {
    id: 17,
    systemCode: "INSURANCE",
    name: "Insurance",
    nameAr: "التأمين",
    type: "expense",
    vatApplicable: false,
    description: "Business insurance premiums (exempt from VAT)",
  },
  {
    id: 18,
    systemCode: "TRAVEL",
    name: "Travel & Accommodation",
    nameAr: "السفر والإقامة",
    type: "expense",
    vatApplicable: true,
    description: "Business travel, hotels, airline tickets",
  },
  {
    id: 19,
    systemCode: "IT_SOFTWARE",
    name: "IT & Software",
    nameAr: "تقنية المعلومات والبرمجيات",
    type: "expense",
    vatApplicable: true,
    description: "SaaS subscriptions, hardware, IT services",
  },
  {
    id: 20,
    systemCode: "REPAIRS",
    name: "Repairs & Maintenance",
    nameAr: "الإصلاح والصيانة",
    type: "expense",
    vatApplicable: true,
    description: "Building, equipment, vehicle maintenance",
  },
  {
    id: 21,
    systemCode: "ZAKAT_PAYMENT",
    name: "Zakat Payment",
    nameAr: "الزكاة",
    type: "expense",
    vatApplicable: false,
    description: "Annual Zakat obligation payment to GAZT/ZATCA",
  },
  {
    id: 22,
    systemCode: "VAT_PAYMENT",
    name: "VAT Payment",
    nameAr: "ضريبة القيمة المضافة",
    type: "expense",
    vatApplicable: false,
    description: "VAT remittance to ZATCA",
  },
  {
    id: 23,
    systemCode: "OTHER_EXPENSES",
    name: "Other Expenses",
    nameAr: "مصاريف أخرى",
    type: "expense",
    vatApplicable: false,
    description: "Miscellaneous uncategorized expenses",
  },

  // ASSETS
  {
    id: 24,
    systemCode: "CASH",
    name: "Cash & Bank",
    nameAr: "النقد والبنك",
    type: "asset",
    vatApplicable: false,
    description: "Bank account balances and cash on hand",
  },
  {
    id: 25,
    systemCode: "AR",
    name: "Accounts Receivable",
    nameAr: "الذمم المدينة",
    type: "asset",
    vatApplicable: false,
    description: "Amounts owed by customers",
  },
  {
    id: 26,
    systemCode: "INVENTORY",
    name: "Inventory",
    nameAr: "المخزون",
    type: "asset",
    vatApplicable: false,
    description: "Stock of goods for sale",
  },
  {
    id: 27,
    systemCode: "FIXED_ASSETS",
    name: "Fixed Assets",
    nameAr: "الأصول الثابتة",
    type: "asset",
    vatApplicable: true,
    description: "Equipment, vehicles, property purchases",
  },
  {
    id: 28,
    systemCode: "INVESTMENTS",
    name: "Investments",
    nameAr: "الاستثمارات",
    type: "asset",
    vatApplicable: false,
    description: "Shares, sukuk, real estate investments",
  },

  // LIABILITIES
  {
    id: 29,
    systemCode: "AP",
    name: "Accounts Payable",
    nameAr: "الذمم الدائنة",
    type: "liability",
    vatApplicable: false,
    description: "Amounts owed to suppliers",
  },
  {
    id: 30,
    systemCode: "LOANS",
    name: "Loans & Financing",
    nameAr: "القروض والتمويل",
    type: "liability",
    vatApplicable: false,
    description: "Bank loans, murabaha, Islamic financing",
  },
];

// ─────────────────────────────────────────────
// Categorization rule engine
// ─────────────────────────────────────────────

interface CategorizationRule {
  patterns: RegExp[];
  systemCode: string;
  confidence: number;
  ruleName: string;
  vatApplicable: boolean;
  suggestedVatRate: number | null;
}

/**
 * M16.2 — transfer detection (design Q2). A SEPARATE list, deliberately outside
 * `CATEGORIZATION_RULES`: `allEngineCodes()` derives from that list and every
 * code there must resolve to a chart category — a transfer resolves to nothing,
 * because the classification is the KIND, not a category.
 *
 * Every pattern requires an own-money signal. Bank and gateway names are NOT
 * signals (they say who processed it); "TRANSFER" alone is not a signal (it
 * could be a supplier payment).
 */
const TRANSFER_RULES: Array<{ patterns: RegExp[]; confidence: number; ruleName: string }> = [
  {
    patterns: [/atm.*(withdrawal|cash)/i, /cash\s*withdrawal/i, /سحب\s*نقدي/, /سحب\s*صراف/],
    confidence: 0.92,
    ruleName: "ATM / cash withdrawal",
  },
  {
    patterns: [
      /own\s*account/i,
      /between\s*(own|my)\s*accounts/i,
      /internal\s*transfer/i,
      /account\s*to\s*account/i,
      /تحويل\s*بين\s*حساب/,
      /تحويل\s*داخلي/,
    ],
    confidence: 0.9,
    ruleName: "Own-account transfer",
  },
  {
    patterns: [/credit\s*card\s*(payment|settlement|bill)/i, /سداد\s*بطاقة/],
    confidence: 0.85,
    ruleName: "Credit-card settlement",
  },
];

const CATEGORIZATION_RULES: CategorizationRule[] = [
  // ── GOVERNMENT & REGULATORY ──────────────────────────────────────────
  {
    patterns: [
      /\bzakat\b/i,
      /زكاة/,
      /\bGATZ\b/i,
      /\bZATCA.*zakat\b/i,
    ],
    systemCode: "ZAKAT_PAYMENT",
    confidence: 0.98,
    ruleName: "Zakat payment to ZATCA",
    vatApplicable: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [/\bVAT.*remit\b/i, /\bZATCA.*VAT\b/i, /ضريبة.*قيمة/],
    systemCode: "VAT_PAYMENT",
    confidence: 0.98,
    ruleName: "VAT remittance",
    vatApplicable: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [
      /\bMOC\b/,
      /\bMinistry.*Commerce\b/i,
      /وزارة.*تجارة/,
      /\bCR\s*renew\b/i,
      /\bcommercial.*register\b/i,
      /\bSGRO\b/i,
      /\bMOI\b/,
      /\bMunicipality\b/i,
      /مجلس.*بلدي/,
      /أمانة/,
      /\bSABT\b/i,
      /\bMOL\b/,
      /\bMinistry.*Labor\b/i,
      /نطاقات/,
      /\bNitaqat\b/i,
      /\bMOHR\b/i,
      /\bMISAD\b/i,
      /\bTAWEEN\b/i,
    ],
    systemCode: "GOVT_FEES",
    confidence: 0.95,
    ruleName: "Government fee/ministry payment",
    vatApplicable: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [
      /\bBALADI\b/i,
      /\bMunicipalBill\b/i,
      /\bBALADIYAH\b/i,
      /رخصة.*تجارية/,
    ],
    systemCode: "GOVT_FEES",
    confidence: 0.93,
    ruleName: "Municipal license fee",
    vatApplicable: false,
    suggestedVatRate: 0,
  },

  // ── BANKING & FINANCIAL CHARGES ───────────────────────────────────────
  //
  // 🔴 M16.2 — A FEE-WORD IS REQUIRED. This rule used to match BARE BANK NAMES
  // (\bANB\b, \bAl.?Rajhi\b, \bSADAD\b, …) at 0.90 — but a bank's name in a
  // descriptor says WHO PROCESSED the movement, not what it was. Almost every
  // transfer, withdrawal and SADAD bill payment names a bank, so the rule
  // confidently booked cash movements as fee expenses carrying phantom VAT.
  // The live-path verification caught it: "ATM CASH WITHDRAWAL - ANB…" →
  // Bank Charges 0.90 + SAR 260.87 of input VAT that does not exist, swept
  // into the accepted figures by bulk accept. A bank CHARGE is the fee line
  // the bank writes — charge/fee/commission/رسوم/عمولة — and only that.
  {
    patterns: [
      /bank.*(charge|fee|commission)/i,
      /(SNB|Al.?Rajhi|الراجحي|Riyad.*Bank|SAMBA|ANB|BSF|GIB|Alinma|SAIB).*(charge|fee|commission)/i,
      /transfer.*fee/i,
      /wire.*fee/i,
      /\bATM.*fee/i,
      /(account|maintenance|service).*fee/i,
      /\bSADAD.*(fee|رسوم)/i,
      /رسوم.*(تحويل|بنكية|خدمة|حساب|إدارية)/,
      /عمولة/,
    ],
    systemCode: "BANK_CHARGES",
    confidence: 0.9,
    ruleName: "Bank fee/charge (fee-word required)",
    vatApplicable: true,
    suggestedVatRate: 15,
  },
  // Same correction for fintech: a bare gateway name (STCPay, Tamara, Tabby…)
  // is most often the SETTLEMENT DEPOSIT of card sales — money arriving, i.e.
  // revenue, the exact opposite of a fee expense. Only the gateway's FEE line
  // is a bank charge.
  {
    patterns: [
      /(STC.?Pay|Urpay|PayTabs|HyperPay|MyFatoorah|Tamara|Tabby|Geidea|mada).*(charge|fee|commission|رسوم|عمولة)/i,
    ],
    systemCode: "BANK_CHARGES",
    confidence: 0.88,
    ruleName: "Payment-gateway fee (fee-word required)",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── TELECOMMUNICATIONS ────────────────────────────────────────────────
  {
    patterns: [
      /\bSTC\b(?!Pay)/i,
      /\bAl.?Jawal\b/i,
      /\bZain\b/i,
      /\bMobily\b/i,
      /موبايلي/,
      /\bVirgin.*Mobile.*Saudi\b/i,
      /\blebaraKSA\b/i,
      /تلفون.*خلوي/,
      /فاتورة.*هاتف/,
      /phone.*bill/i,
      /internet.*bill/i,
      /broadband/i,
      /\bZain.*bill\b/i,
      /\bdata.*plan\b/i,
    ],
    systemCode: "TELECOM",
    confidence: 0.93,
    ruleName: "Saudi telecom provider",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── UTILITIES ────────────────────────────────────────────────────────
  {
    patterns: [
      /\bSEC\b/,
      /\bSaudi.*Electric\b/i,
      /كهرباء/,
      /\bMADINATUL\b/i,
      /electricity.*bill/i,
      /\bSECO\b/i,
    ],
    systemCode: "RENT_UTILITIES",
    confidence: 0.96,
    ruleName: "Saudi Electricity Company",
    vatApplicable: true,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bNWC\b/,
      /\bNational.*Water\b/i,
      /مياه/,
      /water.*bill/i,
      /\bMANASEA\b/i,
    ],
    systemCode: "RENT_UTILITIES",
    confidence: 0.95,
    ruleName: "National Water Company",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── FUEL & TRANSPORT ──────────────────────────────────────────────────
  {
    patterns: [
      /\bAramco\b/i,
      /\bSABIC\b/i,
      /\bPetro.?Rabigh\b/i,
      /وقود/,
      /\bpetrol\b/i,
      /\bfuel\b/i,
      /\bgas.*station\b/i,
      /محطة.*بنزين/,
      /\bBADR.*fuel\b/i,
      /\bNOMO.*fuel\b/i,
      /\bDhahran.*fuel\b/i,
    ],
    systemCode: "FUEL_TRANSPORT",
    confidence: 0.9,
    ruleName: "Fuel purchase",
    vatApplicable: true,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bUber\b/i,
      /\bCareem\b/i,
      /كريم/,
      /\bJeeny\b/i,
      /\bJahiz\b/i,
      /\bINDRIVE\b/i,
      /\btaxi\b/i,
      /سيارة.*أجرة/,
      /\bSaptco\b/i,
      /\bNHRC.*transport\b/i,
      /\bSAR.*express\b/i,
      /\bSAR.*Rail\b/i,
      /\bHaramain\b/i,
      /الحرمين.*سريع/,
      /flight.*ticket/i,
      /airline/i,
      /\bSaudia\b/i,
      /\bFlyadeal\b/i,
      /\bFlynas\b/i,
    ],
    systemCode: "FUEL_TRANSPORT",
    confidence: 0.88,
    ruleName: "Transport / ride-hailing",
    vatApplicable: true,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bAramex\b/i,
      /\bDHL\b/i,
      /\bFedEx\b/i,
      /\bSMSA\b/i,
      /\bNaqel\b/i,
      /ناقل/,
      /\bJ&T\b/i,
      /\bZahid.*Express\b/i,
      /shipping/i,
      /courier/i,
      /شحن/,
      /توصيل/,
    ],
    systemCode: "FUEL_TRANSPORT",
    confidence: 0.87,
    ruleName: "Shipping / courier",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── FOOD & RESTAURANTS ────────────────────────────────────────────────
  {
    patterns: [
      /\bHungerStation\b/i,
      /جاهز/,
      /\bJahiz\b/i,
      /\bMrsool\b/i,
      /مرسول/,
      /\bToYou\b/i,
      /\bCareems.*food\b/i,
      /\bJahez\b/i,
      /\bMcd\b/i,
      /\bMcDonald\b/i,
      /\bKFC\b/i,
      /\bBurger.*King\b/i,
      /\bHardees\b/i,
      /\bNando\b/i,
      /\bPizza.*Hut\b/i,
      /\bSubway\b/i,
      /\bCinnabon\b/i,
      /\bCold.*Stone\b/i,
      /\bStarbucks\b/i,
      /\bDunkin\b/i,
      /\bTimHorton\b/i,
      /\bAl-?Baik\b/i,
      /البيك/,
      /\bKudu\b/i,
      /كودو/,
      /\bHerfy\b/i,
      /هرفي/,
      /\bRing.*Road\b/i,
      /\bNaif.*bakery\b/i,
      /\brestaurant\b/i,
      /مطعم/,
      /\bcafeteria\b/i,
      /\bcafe\b/i,
      /مقهى/,
      /بقالة/,
      /grocery/i,
      /\bLuLu.*Hyper\b/i,
      /\bCarrefour\b/i,
      /\bAl.*Othaim\b/i,
      /العثيم/,
      /\bPanda.*Retail\b/i,
      /بنده/,
      /\bFarm.*Superstores\b/i,
      /أسواق.*المزرعة/,
      /\bDanube\b/i,
      /الدانوب/,
      /supermarket/i,
      /hypermarket/i,
    ],
    systemCode: "FOOD_MEALS",
    confidence: 0.85,
    ruleName: "Food / restaurant / grocery",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── HOTELS & ACCOMMODATION ────────────────────────────────────────────
  {
    patterns: [
      /\bHilton\b/i,
      /\bHyatt\b/i,
      /\bMarriott\b/i,
      /\bSheraton\b/i,
      /\bIntercontinental\b/i,
      /\bCrowne.*Plaza\b/i,
      /\bRadisson\b/i,
      /\bRotana\b/i,
      /روتانا/,
      /\bAccor\b/i,
      /\bAirbnb\b/i,
      /\bBooking\.com\b/i,
      /\bAGODA\b/i,
      /hotel/i,
      /فندق/,
      /شقة.*مفروشة/,
      /\bapartment.*rent\b/i,
    ],
    systemCode: "TRAVEL",
    confidence: 0.9,
    ruleName: "Hotel / accommodation",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── IT / SOFTWARE / SUBSCRIPTIONS ─────────────────────────────────────
  {
    patterns: [
      /\bMicrosoft\b/i,
      /\bOffice.*365\b/i,
      /\bAzure\b/i,
      /\bGoogle.*Workspace\b/i,
      /\bG.*Suite\b/i,
      /\bAWS\b/i,
      /\bAmazon.*Web.*Services\b/i,
      /\bSlack\b/i,
      /\bZoom\b/i,
      /\bDropbox\b/i,
      /\bAdobe\b/i,
      /\bSAP\b/i,
      /\bOracle\b/i,
      /\bSalesforce\b/i,
      /\bQuickBooks\b/i,
      /\bFreshbooks\b/i,
      /\bXero\b/i,
      /\bNetSuite\b/i,
      /\bHubSpot\b/i,
      /\bMailchimp\b/i,
      /\bGitHub\b/i,
      /\bJira\b/i,
      /\bAtlassian\b/i,
      /\bNotion\b/i,
      /\bAsana\b/i,
      /\bClickUp\b/i,
      /\bFigma\b/i,
      /software.*license/i,
      /\bsubscription\b/i,
      /cloud.*service/i,
      /SaaS/i,
      /\bHosting\b/i,
      /domain.*renew/i,
      /\bServer\b/i,
    ],
    systemCode: "IT_SOFTWARE",
    confidence: 0.88,
    ruleName: "IT / SaaS / software",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── MARKETING & ADVERTISING ───────────────────────────────────────────
  {
    patterns: [
      /\bGoogle.*Ads\b/i,
      /\bFacebook.*Ads\b/i,
      /\bMeta.*Ads\b/i,
      /\bSnapchat.*Ads\b/i,
      /\bTwitter.*Ads\b/i,
      /\bX.*Ads\b/i,
      /\bTikTok.*Ads\b/i,
      /\bLinkedIn.*Ads\b/i,
      /\bTwitter.*Promote\b/i,
      /advertising/i,
      /marketing/i,
      /إعلان/,
      /تسويق/,
      /sponsored/i,
    ],
    systemCode: "MARKETING",
    confidence: 0.9,
    ruleName: "Digital / online advertising",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── PROFESSIONAL SERVICES ─────────────────────────────────────────────
  {
    patterns: [
      /\baccounting\b/i,
      /\baudit\b/i,
      /\blegal.*fee\b/i,
      /\bconsulting.*fee\b/i,
      /\blaw.*firm\b/i,
      /محاسب/,
      /مدقق/,
      /محامي/,
      /مستشار/,
      /\bDeloitte\b/i,
      /\bPwC\b/i,
      /\bErnst.*Young\b/i,
      /\bKPMG\b/i,
      /\bBaker.*McKenzie\b/i,
      /\bAl-?Tamimi\b/i,
      /\bfreelancer.*fee\b/i,
    ],
    systemCode: "PROFESSIONAL_FEES",
    confidence: 0.87,
    ruleName: "Professional / legal / consulting services",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── SOCIAL INSURANCE (GOSI) ───────────────────────────────────────────
  //
  // Listed BEFORE salaries deliberately: `GOSI` used to sit inside the salary
  // rule, so an employer's social-insurance contribution was booked to
  // "Salaries and Wages Expense". Both are expense/'O', so no tax figure moved
  // — but GOSI_EXPENSE exists as its own code precisely because Saudi
  // employers report and reconcile the contribution separately from payroll,
  // and a per-category report that hides it inside salaries cannot be checked
  // against a GOSI statement.
  {
    // The Arabic patterns name SOCIAL insurance specifically. A bare
    // "تأمينات" would also sit inside commercial-insurance text, and since
    // Arabic patterns are substring matches (see the note on word boundaries
    // below) that would quietly steal every insurance premium.
    patterns: [/\bGOSI\b/i, /\bTAMEEN\b/i, /التأمينات\s*الاجتماعية/, /تأمينات\s*اجتماعية/],
    systemCode: "GOSI_EXPENSE",
    // Above INSURANCE deliberately: "التأمينات الاجتماعية" is unambiguous, and
    // the matcher keeps the HIGHEST-confidence rule rather than the first.
    confidence: 0.95,
    ruleName: "GOSI / social insurance contribution",
    vatApplicable: false,
    suggestedVatRate: 0,
  },

  // ── SALARIES & HR ─────────────────────────────────────────────────────
  {
    patterns: [
      /\bsalary\b/i,
      /\bpayroll\b/i,
      /\bwage\b/i,
      /راتب|رواتب/,
      /أجر/,
      /مكافأة/,
      /\bbonus\b/i,
      /\bHRDF\b/i,
      /\bHadaf\b/i,
      /هدف/,
      /\bMusaned\b/i,
      /مساند/,
    ],
    systemCode: "SALARIES",
    confidence: 0.92,
    ruleName: "Salary / payroll",
    vatApplicable: false,
    suggestedVatRate: 0,
  },

  // ── INSURANCE ─────────────────────────────────────────────────────────
  {
    patterns: [
      /\bTawuniya\b/i,
      /التعاونية/,
      /\bAXA.*Cooperative\b/i,
      /\bBupa.*Arabia\b/i,
      /\bMedGulf\b/i,
      /\binsurance\b/i,
      /تأمين/,
      /\bwataniya.*insurance\b/i,
      /\bAl.*Rajhi.*Takaful\b/i,
    ],
    systemCode: "INSURANCE",
    confidence: 0.93,
    ruleName: "Insurance / Takaful",
    vatApplicable: false,
    suggestedVatRate: 0,
  },

  // ── REAL ESTATE / RENT ────────────────────────────────────────────────
  {
    patterns: [
      /إيجار/,
      /\brent.*office\b/i,
      /\boffice.*rent\b/i,
      /\bshop.*rent\b/i,
      /\bwarehouse.*rent\b/i,
      /\bAqar\b/i,
      /إيجار.*مكتب/,
      /إيجار.*محل/,
      /\bEjar\b/i,
      /إيجار.*عقد/,
    ],
    systemCode: "RENT_UTILITIES",
    confidence: 0.88,
    ruleName: "Office / shop rent",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── INVESTMENTS ───────────────────────────────────────────────────────
  {
    patterns: [
      /\bTadawul\b/i,
      /تداول/,
      /\bSaudi.*Exchange\b/i,
      /\bAlJazira.*Capital\b/i,
      /\bFransi.*Capital\b/i,
      /\bRiyad.*Capital\b/i,
      /\bSNB.*Capital\b/i,
      /\bstock.*purchase\b/i,
      /\bsukuk\b/i,
      /صكوك/,
      /\bdividend\b/i,
      /أسهم/,
      /استثمار/,
      /investment.*return/i,
      /profit.*share/i,
    ],
    systemCode: "INVESTMENT_INCOME",
    confidence: 0.88,
    ruleName: "Saudi investment / Tadawul",
    vatApplicable: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [
      /تمويل/,
      /\bmurabaha\b/i,
      /\bIslamic.*finance\b/i,
      /\bfinancing.*installment\b/i,
      /قسط/,
      /\bloan.*repay\b/i,
    ],
    systemCode: "LOANS",
    confidence: 0.85,
    ruleName: "Islamic financing / loan repayment",
    vatApplicable: false,
    suggestedVatRate: 0,
  },

  // ── FIXED ASSETS ──────────────────────────────────────────────────────
  {
    patterns: [
      /\bequipment.*purchase\b/i,
      /\bMachinery\b/i,
      /\bvehicle.*purchase\b/i,
      /\bcar.*purchase\b/i,
      /لاب.*توب/,
      /\blaptop.*purchase\b/i,
      /\bcomputer.*purchase\b/i,
      /\bprinter.*purchase\b/i,
      /\bfurniture\b/i,
      /أثاث/,
      /capital.*expenditure/i,
      /\bCAPEX\b/i,
    ],
    systemCode: "FIXED_ASSETS",
    confidence: 0.83,
    ruleName: "Fixed asset / capital purchase",
    vatApplicable: true,
    suggestedVatRate: 15,
  },

  // ── AMOUNT-BASED HEURISTICS ────────────────────────────────────────────
];

/**
 * Every system code this engine can emit — rules, heuristic and all.
 *
 * The forcing function's other half: `categorizer-chart.test.ts` asserts each of
 * these exists in `system_account_templates`, so the engine and the seeded chart
 * cannot drift apart without the build failing. Consumers use it to resolve all
 * codes in one pass.
 */
export function allEngineCodes(): string[] {
  const codes = new Set<string>(CATEGORIZATION_RULES.map((r) => r.systemCode));
  codes.add("SALARIES"); // the amount-based heuristic
  return [...codes];
}

// Salary pattern: regular round amounts from unknown payors
function isSalaryLike(description: string, amount: number): boolean {
  const roundAmount = amount % 500 === 0 || amount % 1000 === 0;
  // 🔴 M15: "transfer|تحويل" was REMOVED from the word list. It made every
  // round-amount transfer a salary — including supplier payments ("TRANSFER TO
  // ALMARAI") and bare "TRANSFER" lines, which are genuinely unknown. Only
  // words that actually mean payroll count; a transfer with no salary word is
  // the engine's problem to NOT answer.
  const salaryWords = /راتب|رواتب|salary|salaries|payroll|wage/i.test(description);
  return roundAmount && salaryWords && amount >= 1000 && amount <= 50000;
}

// ─────────────────────────────────────────────
// Main engine function
// ─────────────────────────────────────────────

/**
 * Foreign digital suppliers that bill a Saudi business from outside the
 * Kingdom and therefore charge NO KSA VAT — the buyer self-accounts under the
 * reverse-charge mechanism.
 *
 * These are the recurring subscriptions almost every SME has, which is why
 * they dominated the phantom-VAT total: ads, cloud, and SaaS.
 *
 * ⚠️ DELIBERATELY A GUESS, and marked as one. Several of these have since
 * registered for KSA VAT for some product lines, and the invoice — not the
 * bank line — is what settles it. The engine flags the likelihood; the human
 * confirms it in review.
 */
const FOREIGN_DIGITAL_SUPPLIERS: RegExp[] = [
  /google/i,
  /meta\s+platforms/i,
  /facebook/i,
  /instagram\s+ads/i,
  /(^|[^A-Za-z])AWS([^A-Za-z]|$)/,
  /amazon\s+web\s+services/i,
  /microsoft/i,
  /azure/i,
  /office\s*365/i,
  /apple.*(services|icloud|store)/i,
  /linkedin/i,
  /zoom/i,
  /adobe/i,
  /slack/i,
  /atlassian/i,
  /github/i,
  /canva/i,
  /shopify/i,
  /digitalocean/i,
  /cloudflare/i,
  /notion/i,
  /figma/i,
  /openai/i,
  /anthropic/i,
  /tiktok\s+ads/i,
  /snap(chat)?\s+ads/i,
  /namecheap/i,
  /godaddy/i,
];

/** Does this description look like a foreign supplier that charges no KSA VAT? */
export function looksForeignDigitalSupplier(text: string): boolean {
  return FOREIGN_DIGITAL_SUPPLIERS.some((p) => p.test(text));
}

/**
 * 🔴 WHY NO ARABIC PATTERN USES `\b` (found by the SME statement run).
 *
 * `\b` is an ASCII word boundary: it asserts a transition between `[A-Za-z0-9_]`
 * and anything else. Arabic letters are NOT word characters to the regex
 * engine, so between a space and "ر" there is no boundary at all — which means
 * `/راتب/` is **false on "راتب سبتمبر"** while `/راتب/` is true.
 *
 * Sixty Arabic patterns in this file were written that way and had NEVER
 * matched: salaries, rent, utilities, Zakat, VAT, insurance — the entire
 * Arabic half of a bilingual categorisation engine was inert, silently, in a
 * product whose customers' bank statements are frequently Arabic. Nothing
 * failed; rows simply came back uncategorised and looked like honest
 * "I don't know" answers.
 *
 * Substring matching is also the RIGHT semantics for Arabic here, not a
 * concession: the definite article and prepositions attach to the word
 * ("الرواتب", "للرواتب"), so a boundary-anchored match would miss the common
 * forms even if `\b` worked. Pinned by the Arabic cases in
 * `ingest-correctness.test.ts`.
 */
export function categorizeTransaction(
  description: string,
  amount: number,
  transactionType: "debit" | "credit",
  descriptionAr?: string | null
): CategorizationMatch | null {
  const combinedText = [description, descriptionAr ?? ""].join(" ");
  const normalizedText = combinedText.normalize("NFKC");

  // ── M16.2: TRANSFERS FIRST — before any category rule can claim the row ───
  //
  // An ATM withdrawal, an own-account move or a credit-card settlement is
  // money changing pockets, not income or expense. Pre-M16.2 the withdrawal
  // reached the bank-name rule and was booked as a Bank Charges EXPENSE with
  // extracted VAT — an active wrong tax figure on the default path. Checked
  // first so no category rule (however confident) can claim an asset movement.
  //
  // 🔴 A bare "TRANSFER" is deliberately NOT here: with no own-account signal
  // it could equally be a supplier payment. It stays NULL (unknown) — leniency
  // never means guessing (the M15 rule).
  for (const rule of TRANSFER_RULES) {
    if (rule.patterns.some((p) => p.test(normalizedText))) {
      return {
        kind: "transfer",
        systemCode: "TRANSFER", // display label only — never resolved to a category
        categoryName: "Internal Transfer",
        categoryNameAr: "تحويل داخلي",
        confidence: rule.confidence,
        matchedRule: rule.ruleName,
        vatApplicable: false,
        suggestedVatRate: 0,
      };
    }
  }

  // ── Salary heuristic — DEBITS ONLY (M15 fix) ──────────────────────────────
  // This fired on CREDITS: money coming IN. For a business account payroll is a
  // DEBIT, and an inbound round transfer is overwhelmingly a customer payment.
  // The adversarial statement run proved it: a SAR 34,500 customer receipt
  // ("INCOMING TRANSFER - CUSTOMER PAYMENT INV-…") was booked as Salaries &
  // Wages — revenue recorded as payroll expense, the worst misclassification in
  // the set.
  if (transactionType === "debit" && isSalaryLike(normalizedText, amount)) {
    return {
      systemCode: "SALARIES",
      categoryName: "Salaries & Wages",
      categoryNameAr: "الرواتب والأجور",
      confidence: 0.72,
      matchedRule: "Amount-based salary heuristic",
      vatApplicable: false,
      suggestedVatRate: 0,
    };
  }

  // Income detection for credits without specific match
  // Run pattern rules first
  let bestMatch: (CategorizationMatch & { ruleIdx: number }) | null = null;

  for (let i = 0; i < CATEGORIZATION_RULES.length; i++) {
    const rule = CATEGORIZATION_RULES[i];
    for (const pattern of rule.patterns) {
      if (pattern.test(normalizedText)) {
        const cat = SEED_CATEGORIES.find((c) => c.systemCode === rule.systemCode);
        if (!cat) continue;
        if (!bestMatch || rule.confidence > bestMatch.confidence) {
          bestMatch = {
            systemCode: rule.systemCode,
            categoryName: cat.name,
            categoryNameAr: cat.nameAr,
            confidence: rule.confidence,
            matchedRule: rule.ruleName,
            vatApplicable: rule.vatApplicable,
            suggestedVatRate: rule.suggestedVatRate,
            ruleIdx: i,
          };
        }
        break; // one pattern matched — no need to test more patterns in this rule
      }
    }
  }

  if (bestMatch) {
    const { ruleIdx: _, ...match } = bestMatch;
    // Flaw #6: a standard-rated supply from a foreign digital supplier carries
    // NO KSA VAT on the payment — the buyer self-accounts. Stamped here so
    // every consumer (upload, the Categorize page) gets it without repeating
    // the rule, and so extraction can refuse without guessing.
    if (looksForeignDigitalSupplier(normalizedText)) {
      return { ...match, vatBasis: "reverse_charge" as const };
    }
    return match;
  }

  // ── 🔴 NO FALLBACK. An unmatched transaction returns NULL (M15). ──────────
  //
  // This engine used to route every unmatched debit to "Other Expenses" (0.30)
  // and every unmatched credit to "Other Income" (0.35) — so it was INCAPABLE of
  // saying "I don't know", and a guess wore the same shape as a 0.98 match.
  // In the adversarial statement run that turned a ZERO-RATED export sale into
  // unclassified "Other Income" (vanishing from the VAT return), a payment
  // REVERSAL into income, and a bare "TRANSFER" into a confident-looking entry.
  //
  // NULL means: leave the transaction uncategorized, where the Categorize page
  // surfaces it for a human. A wrong answer wearing a right answer's shape is
  // worse than no answer — the truncation lesson, applied to classification.
  return null;
}
