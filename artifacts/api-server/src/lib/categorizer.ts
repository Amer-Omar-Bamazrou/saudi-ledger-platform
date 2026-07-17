/**
 * Saudi Bookkeeping Categorization Engine
 *
 * A fully deterministic, rule-based categorization engine for Saudi Arabian
 * financial transactions. No external APIs required. Rules are derived from:
 *  - ZATCA (Zakat, Tax and Customs Authority) VAT guidelines
 *  - Common Saudi merchant names in English and Arabic
 *  - GAZT category conventions
 *  - Standard Zakat-eligible asset classes per Hanbali fiqh
 */

export interface CategorizationMatch {
  categoryId: number;
  categoryName: string;
  categoryNameAr: string;
  confidence: number; // 0.0 – 1.0
  matchedRule: string;
  vatApplicable: boolean;
  isZakatRelevant: boolean;
  suggestedVatRate: number | null; // 15 for standard, 0 for exempt, null for unknown
}

export interface SeedCategory {
  id: number;
  name: string;
  nameAr: string;
  type: "income" | "expense" | "asset" | "liability" | "equity";
  vatApplicable: boolean;
  zakatRelevant: boolean;
  description?: string;
}

// ─────────────────────────────────────────────
// Canonical Saudi bookkeeping category set
// ─────────────────────────────────────────────
export const SEED_CATEGORIES: SeedCategory[] = [
  // INCOME
  {
    id: 1,
    name: "Sales Revenue",
    nameAr: "إيرادات المبيعات",
    type: "income",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Revenue from sale of goods or services",
  },
  {
    id: 2,
    name: "Service Income",
    nameAr: "إيرادات الخدمات",
    type: "income",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Income from professional or consulting services",
  },
  {
    id: 3,
    name: "Rental Income",
    nameAr: "إيرادات الإيجار",
    type: "income",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Income from property rentals",
  },
  {
    id: 4,
    name: "Investment Returns",
    nameAr: "عوائد الاستثمار",
    type: "income",
    vatApplicable: false,
    zakatRelevant: true,
    description: "Dividends, profit shares, investment gains",
  },
  {
    id: 5,
    name: "Government Grants",
    nameAr: "المنح الحكومية",
    type: "income",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Grants from Saudi government bodies",
  },
  {
    id: 6,
    name: "Other Income",
    nameAr: "إيرادات أخرى",
    type: "income",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Miscellaneous income",
  },

  // EXPENSES
  {
    id: 7,
    name: "Salaries & Wages",
    nameAr: "الرواتب والأجور",
    type: "expense",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Employee salaries, wages, bonuses",
  },
  {
    id: 8,
    name: "Rent & Utilities",
    nameAr: "الإيجار والمرافق",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Office/shop rent, electricity, water, internet",
  },
  {
    id: 9,
    name: "Telecommunications",
    nameAr: "الاتصالات",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Mobile, internet, telephone bills",
  },
  {
    id: 10,
    name: "Fuel & Transportation",
    nameAr: "الوقود والمواصلات",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Vehicle fuel, taxis, delivery costs",
  },
  {
    id: 11,
    name: "Food & Meals",
    nameAr: "الطعام والوجبات",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Business meals, restaurant visits, catering",
  },
  {
    id: 12,
    name: "Marketing & Advertising",
    nameAr: "التسويق والإعلان",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Digital ads, print, promotions",
  },
  {
    id: 13,
    name: "Office Supplies",
    nameAr: "اللوازم المكتبية",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Stationery, printing, office consumables",
  },
  {
    id: 14,
    name: "Professional Services",
    nameAr: "الخدمات المهنية",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Legal, accounting, consulting fees",
  },
  {
    id: 15,
    name: "Bank Charges",
    nameAr: "الرسوم البنكية",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Bank fees, transfer charges, SADAD fees",
  },
  {
    id: 16,
    name: "Government Fees",
    nameAr: "الرسوم الحكومية",
    type: "expense",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Ministry of Commerce, MOI, municipality fees",
  },
  {
    id: 17,
    name: "Insurance",
    nameAr: "التأمين",
    type: "expense",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Business insurance premiums (exempt from VAT)",
  },
  {
    id: 18,
    name: "Travel & Accommodation",
    nameAr: "السفر والإقامة",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Business travel, hotels, airline tickets",
  },
  {
    id: 19,
    name: "IT & Software",
    nameAr: "تقنية المعلومات والبرمجيات",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "SaaS subscriptions, hardware, IT services",
  },
  {
    id: 20,
    name: "Repairs & Maintenance",
    nameAr: "الإصلاح والصيانة",
    type: "expense",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Building, equipment, vehicle maintenance",
  },
  {
    id: 21,
    name: "Zakat Payment",
    nameAr: "الزكاة",
    type: "expense",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Annual Zakat obligation payment to GAZT/ZATCA",
  },
  {
    id: 22,
    name: "VAT Payment",
    nameAr: "ضريبة القيمة المضافة",
    type: "expense",
    vatApplicable: false,
    zakatRelevant: false,
    description: "VAT remittance to ZATCA",
  },
  {
    id: 23,
    name: "Other Expenses",
    nameAr: "مصاريف أخرى",
    type: "expense",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Miscellaneous uncategorized expenses",
  },

  // ASSETS
  {
    id: 24,
    name: "Cash & Bank",
    nameAr: "النقد والبنك",
    type: "asset",
    vatApplicable: false,
    zakatRelevant: true,
    description: "Bank account balances and cash on hand",
  },
  {
    id: 25,
    name: "Accounts Receivable",
    nameAr: "الذمم المدينة",
    type: "asset",
    vatApplicable: false,
    zakatRelevant: true,
    description: "Amounts owed by customers",
  },
  {
    id: 26,
    name: "Inventory",
    nameAr: "المخزون",
    type: "asset",
    vatApplicable: false,
    zakatRelevant: true,
    description: "Stock of goods for sale",
  },
  {
    id: 27,
    name: "Fixed Assets",
    nameAr: "الأصول الثابتة",
    type: "asset",
    vatApplicable: true,
    zakatRelevant: false,
    description: "Equipment, vehicles, property purchases",
  },
  {
    id: 28,
    name: "Investments",
    nameAr: "الاستثمارات",
    type: "asset",
    vatApplicable: false,
    zakatRelevant: true,
    description: "Shares, sukuk, real estate investments",
  },

  // LIABILITIES
  {
    id: 29,
    name: "Accounts Payable",
    nameAr: "الذمم الدائنة",
    type: "liability",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Amounts owed to suppliers",
  },
  {
    id: 30,
    name: "Loans & Financing",
    nameAr: "القروض والتمويل",
    type: "liability",
    vatApplicable: false,
    zakatRelevant: false,
    description: "Bank loans, murabaha, Islamic financing",
  },
];

// ─────────────────────────────────────────────
// Categorization rule engine
// ─────────────────────────────────────────────

interface CategorizationRule {
  patterns: RegExp[];
  categoryId: number;
  confidence: number;
  ruleName: string;
  vatApplicable: boolean;
  isZakatRelevant: boolean;
  suggestedVatRate: number | null;
}

const CATEGORIZATION_RULES: CategorizationRule[] = [
  // ── GOVERNMENT & REGULATORY ──────────────────────────────────────────
  {
    patterns: [
      /\bzakat\b/i,
      /\bزكاة\b/,
      /\bGATZ\b/i,
      /\bZATCA.*zakat\b/i,
    ],
    categoryId: 21,
    confidence: 0.98,
    ruleName: "Zakat payment to ZATCA",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [/\bVAT.*remit\b/i, /\bZATCA.*VAT\b/i, /\bضريبة.*قيمة\b/],
    categoryId: 22,
    confidence: 0.98,
    ruleName: "VAT remittance",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [
      /\bMOC\b/,
      /\bMinistry.*Commerce\b/i,
      /\bوزارة.*تجارة\b/,
      /\bCR\s*renew\b/i,
      /\bcommercial.*register\b/i,
      /\bSGRO\b/i,
      /\bMOI\b/,
      /\bMunicipality\b/i,
      /\bمجلس.*بلدي\b/,
      /\bأمانة\b/,
      /\bSABT\b/i,
      /\bMOL\b/,
      /\bMinistry.*Labor\b/i,
      /\bنطاقات\b/,
      /\bNitaqat\b/i,
      /\bMOHR\b/i,
      /\bMISAD\b/i,
      /\bTAWEEN\b/i,
    ],
    categoryId: 16,
    confidence: 0.95,
    ruleName: "Government fee/ministry payment",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },
  {
    patterns: [
      /\bBALADI\b/i,
      /\bMunicipalBill\b/i,
      /\bBALADIYAH\b/i,
      /\bرخصة.*تجارية\b/,
    ],
    categoryId: 16,
    confidence: 0.93,
    ruleName: "Municipal license fee",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },

  // ── BANKING & FINANCIAL CHARGES ───────────────────────────────────────
  {
    patterns: [
      /\bSNB\b/,
      /\bAl.?Rajhi\b/i,
      /\bالراجحي\b/,
      /\bRiyad.*Bank\b/i,
      /\bبنك.*الرياض\b/,
      /\bSAMBA\b/i,
      /\bANB\b/,
      /\bArab.*National.*Bank\b/i,
      /\bBSF\b/,
      /\bBanque.*Saudi.*Fransi\b/i,
      /\bGIB\b/,
      /\bAlinma\b/i,
      /\bأمانة.*بنك\b/,
      /\bSADIO\b/i,
      /bank.*(charge|fee|commission)/i,
      /transfer.*fee/i,
      /wire.*fee/i,
      /رسوم.*تحويل/,
      /\bSADAD\b/i,
      /\bCLIQ\b/i,
      /\bAPACS\b/i,
    ],
    categoryId: 15,
    confidence: 0.9,
    ruleName: "Saudi bank / bank charge",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bSTCPay\b/i,
      /\bSTC.*Pay\b/i,
      /\bUrpay\b/i,
      /\bPayTabs\b/i,
      /\bHyperPay\b/i,
      /\bMyFatoorah\b/i,
      /\bTamara\b/i,
      /\bTabby\b/i,
      /\bStc.*transfer\b/i,
      /\bإيداع.*تحويل\b/,
    ],
    categoryId: 15,
    confidence: 0.88,
    ruleName: "Saudi payment gateway / fintech",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── TELECOMMUNICATIONS ────────────────────────────────────────────────
  {
    patterns: [
      /\bSTC\b(?!Pay)/i,
      /\bAl.?Jawal\b/i,
      /\bZain\b/i,
      /\bMobily\b/i,
      /\bموبايلي\b/,
      /\bVirgin.*Mobile.*Saudi\b/i,
      /\blebaraKSA\b/i,
      /\bتلفون.*خلوي\b/,
      /\bفاتورة.*هاتف\b/,
      /phone.*bill/i,
      /internet.*bill/i,
      /broadband/i,
      /\bZain.*bill\b/i,
      /\bdata.*plan\b/i,
    ],
    categoryId: 9,
    confidence: 0.93,
    ruleName: "Saudi telecom provider",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── UTILITIES ────────────────────────────────────────────────────────
  {
    patterns: [
      /\bSEC\b/,
      /\bSaudi.*Electric\b/i,
      /\bكهرباء\b/,
      /\bMADINATUL\b/i,
      /electricity.*bill/i,
      /\bSECO\b/i,
    ],
    categoryId: 8,
    confidence: 0.96,
    ruleName: "Saudi Electricity Company",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bNWC\b/,
      /\bNational.*Water\b/i,
      /\bمياه\b/,
      /water.*bill/i,
      /\bMANASEA\b/i,
    ],
    categoryId: 8,
    confidence: 0.95,
    ruleName: "National Water Company",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── FUEL & TRANSPORT ──────────────────────────────────────────────────
  {
    patterns: [
      /\bAramco\b/i,
      /\bSABIC\b/i,
      /\bPetro.?Rabigh\b/i,
      /\bوقود\b/,
      /\bpetrol\b/i,
      /\bfuel\b/i,
      /\bgas.*station\b/i,
      /\bمحطة.*بنزين\b/,
      /\bBADR.*fuel\b/i,
      /\bNOMO.*fuel\b/i,
      /\bDhahran.*fuel\b/i,
    ],
    categoryId: 10,
    confidence: 0.9,
    ruleName: "Fuel purchase",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bUber\b/i,
      /\bCareem\b/i,
      /\bكريم\b/,
      /\bJeeny\b/i,
      /\bJahiz\b/i,
      /\bINDRIVE\b/i,
      /\btaxi\b/i,
      /\bسيارة.*أجرة\b/,
      /\bSaptco\b/i,
      /\bNHRC.*transport\b/i,
      /\bSAR.*express\b/i,
      /\bSAR.*Rail\b/i,
      /\bHaramain\b/i,
      /\bالحرمين.*سريع\b/,
      /flight.*ticket/i,
      /airline/i,
      /\bSaudia\b/i,
      /\bFlyadeal\b/i,
      /\bFlynas\b/i,
    ],
    categoryId: 10,
    confidence: 0.88,
    ruleName: "Transport / ride-hailing",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },
  {
    patterns: [
      /\bAramex\b/i,
      /\bDHL\b/i,
      /\bFedEx\b/i,
      /\bSMSA\b/i,
      /\bNaqel\b/i,
      /\bناقل\b/,
      /\bJ&T\b/i,
      /\bZahid.*Express\b/i,
      /shipping/i,
      /courier/i,
      /شحن/,
      /توصيل/,
    ],
    categoryId: 10,
    confidence: 0.87,
    ruleName: "Shipping / courier",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── FOOD & RESTAURANTS ────────────────────────────────────────────────
  {
    patterns: [
      /\bHungerStation\b/i,
      /\bجاهز\b/,
      /\bJahiz\b/i,
      /\bMrsool\b/i,
      /\bمرسول\b/,
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
      /\bالبيك\b/,
      /\bKudu\b/i,
      /\bكودو\b/,
      /\bHerfy\b/i,
      /\bهرفي\b/,
      /\bRing.*Road\b/i,
      /\bNaif.*bakery\b/i,
      /\brestaurant\b/i,
      /\bمطعم\b/,
      /\bcafeteria\b/i,
      /\bcafe\b/i,
      /\bمقهى\b/,
      /\bبقالة\b/,
      /grocery/i,
      /\bLuLu.*Hyper\b/i,
      /\bCarrefour\b/i,
      /\bAl.*Othaim\b/i,
      /\bالعثيم\b/,
      /\bPanda.*Retail\b/i,
      /\bبنده\b/,
      /\bFarm.*Superstores\b/i,
      /\bأسواق.*المزرعة\b/,
      /\bDanube\b/i,
      /\bالدانوب\b/,
      /supermarket/i,
      /hypermarket/i,
    ],
    categoryId: 11,
    confidence: 0.85,
    ruleName: "Food / restaurant / grocery",
    vatApplicable: true,
    isZakatRelevant: false,
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
      /\bروتانا\b/,
      /\bAccor\b/i,
      /\bAirbnb\b/i,
      /\bBooking\.com\b/i,
      /\bAGODA\b/i,
      /hotel/i,
      /\bفندق\b/,
      /\bشقة.*مفروشة\b/,
      /\bapartment.*rent\b/i,
    ],
    categoryId: 18,
    confidence: 0.9,
    ruleName: "Hotel / accommodation",
    vatApplicable: true,
    isZakatRelevant: false,
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
    categoryId: 19,
    confidence: 0.88,
    ruleName: "IT / SaaS / software",
    vatApplicable: true,
    isZakatRelevant: false,
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
      /\bإعلان\b/,
      /\bتسويق\b/,
      /sponsored/i,
    ],
    categoryId: 12,
    confidence: 0.9,
    ruleName: "Digital / online advertising",
    vatApplicable: true,
    isZakatRelevant: false,
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
      /\bمحاسب\b/,
      /\bمدقق\b/,
      /\bمحامي\b/,
      /\bمستشار\b/,
      /\bDeloitte\b/i,
      /\bPwC\b/i,
      /\bErnst.*Young\b/i,
      /\bKPMG\b/i,
      /\bBaker.*McKenzie\b/i,
      /\bAl-?Tamimi\b/i,
      /\bfreelancer.*fee\b/i,
    ],
    categoryId: 14,
    confidence: 0.87,
    ruleName: "Professional / legal / consulting services",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── SALARIES & HR ─────────────────────────────────────────────────────
  {
    patterns: [
      /\bsalary\b/i,
      /\bpayroll\b/i,
      /\bwage\b/i,
      /\براتب\b/,
      /\bأجر\b/,
      /\bمكافأة\b/,
      /\bbonus\b/i,
      /\bGOSI\b/i,
      /\bTAMEEN\b/i,
      /\bHRDF\b/i,
      /\bHadaf\b/i,
      /\bهدف\b/,
      /\bMusaned\b/i,
      /\bمساند\b/,
    ],
    categoryId: 7,
    confidence: 0.92,
    ruleName: "Salary / payroll / GOSI",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },

  // ── INSURANCE ─────────────────────────────────────────────────────────
  {
    patterns: [
      /\bTawuniya\b/i,
      /\bالتعاونية\b/,
      /\bAXA.*Cooperative\b/i,
      /\bBupa.*Arabia\b/i,
      /\bMedGulf\b/i,
      /\binsurance\b/i,
      /\bتأمين\b/,
      /\bwataniya.*insurance\b/i,
      /\bAl.*Rajhi.*Takaful\b/i,
    ],
    categoryId: 17,
    confidence: 0.93,
    ruleName: "Insurance / Takaful",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },

  // ── REAL ESTATE / RENT ────────────────────────────────────────────────
  {
    patterns: [
      /\bإيجار\b/,
      /\brent.*office\b/i,
      /\boffice.*rent\b/i,
      /\bshop.*rent\b/i,
      /\bwarehouse.*rent\b/i,
      /\bAqar\b/i,
      /\bإيجار.*مكتب\b/,
      /\bإيجار.*محل\b/,
      /\bEjar\b/i,
      /\bإيجار.*عقد\b/,
    ],
    categoryId: 8,
    confidence: 0.88,
    ruleName: "Office / shop rent",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── INVESTMENTS ───────────────────────────────────────────────────────
  {
    patterns: [
      /\bTadawul\b/i,
      /\bتداول\b/,
      /\bSaudi.*Exchange\b/i,
      /\bAlJazira.*Capital\b/i,
      /\bFransi.*Capital\b/i,
      /\bRiyad.*Capital\b/i,
      /\bSNB.*Capital\b/i,
      /\bstock.*purchase\b/i,
      /\bsukuk\b/i,
      /\bصكوك\b/,
      /\bdividend\b/i,
      /\bأسهم\b/,
      /\bاستثمار\b/,
      /investment.*return/i,
      /profit.*share/i,
    ],
    categoryId: 4,
    confidence: 0.88,
    ruleName: "Saudi investment / Tadawul",
    vatApplicable: false,
    isZakatRelevant: true,
    suggestedVatRate: 0,
  },
  {
    patterns: [
      /\bتمويل\b/,
      /\bmurabaha\b/i,
      /\bIslamic.*finance\b/i,
      /\bfinancing.*installment\b/i,
      /\bقسط\b/,
      /\bloan.*repay\b/i,
    ],
    categoryId: 30,
    confidence: 0.85,
    ruleName: "Islamic financing / loan repayment",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: 0,
  },

  // ── FIXED ASSETS ──────────────────────────────────────────────────────
  {
    patterns: [
      /\bequipment.*purchase\b/i,
      /\bMachinery\b/i,
      /\bvehicle.*purchase\b/i,
      /\bcar.*purchase\b/i,
      /\bلاب.*توب\b/,
      /\blaptop.*purchase\b/i,
      /\bcomputer.*purchase\b/i,
      /\bprinter.*purchase\b/i,
      /\bfurniture\b/i,
      /\bأثاث\b/,
      /capital.*expenditure/i,
      /\bCAPEX\b/i,
    ],
    categoryId: 27,
    confidence: 0.83,
    ruleName: "Fixed asset / capital purchase",
    vatApplicable: true,
    isZakatRelevant: false,
    suggestedVatRate: 15,
  },

  // ── AMOUNT-BASED HEURISTICS ────────────────────────────────────────────
];

// Salary pattern: regular round amounts from unknown payors
function isSalaryLike(description: string, amount: number): boolean {
  const roundAmount = amount % 500 === 0 || amount % 1000 === 0;
  const salaryWords =
    /transfer|تحويل|راتب|salary|payroll/i.test(description);
  return roundAmount && salaryWords && amount >= 1000 && amount <= 50000;
}

// ─────────────────────────────────────────────
// Main engine function
// ─────────────────────────────────────────────

export function categorizeTransaction(
  description: string,
  amount: number,
  transactionType: "debit" | "credit",
  descriptionAr?: string | null
): CategorizationMatch | null {
  const combinedText = [description, descriptionAr ?? ""].join(" ");
  const normalizedText = combinedText.normalize("NFKC");

  // Salary heuristic (debit credits of round amounts)
  if (transactionType === "credit" && isSalaryLike(normalizedText, amount)) {
    return {
      categoryId: 7,
      categoryName: "Salaries & Wages",
      categoryNameAr: "الرواتب والأجور",
      confidence: 0.72,
      matchedRule: "Amount-based salary heuristic",
      vatApplicable: false,
      isZakatRelevant: false,
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
        const cat = SEED_CATEGORIES.find((c) => c.id === rule.categoryId);
        if (!cat) continue;
        if (!bestMatch || rule.confidence > bestMatch.confidence) {
          bestMatch = {
            categoryId: rule.categoryId,
            categoryName: cat.name,
            categoryNameAr: cat.nameAr,
            confidence: rule.confidence,
            matchedRule: rule.ruleName,
            vatApplicable: rule.vatApplicable,
            isZakatRelevant: rule.isZakatRelevant,
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
    return match;
  }

  // Fallback: if credit with no match → "Other Income"
  if (transactionType === "credit") {
    return {
      categoryId: 6,
      categoryName: "Other Income",
      categoryNameAr: "إيرادات أخرى",
      confidence: 0.35,
      matchedRule: "Fallback: unmatched credit transaction",
      vatApplicable: false,
      isZakatRelevant: false,
      suggestedVatRate: null,
    };
  }

  // Fallback: debit with no match → "Other Expenses"
  return {
    categoryId: 23,
    categoryName: "Other Expenses",
    categoryNameAr: "مصاريف أخرى",
    confidence: 0.3,
    matchedRule: "Fallback: unmatched debit transaction",
    vatApplicable: false,
    isZakatRelevant: false,
    suggestedVatRate: null,
  };
}
