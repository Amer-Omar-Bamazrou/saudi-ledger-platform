"""
Saudi Bookkeeping Categorization Engine (Python version)

Fully deterministic rule-based engine. No external APIs.
Covers ZATCA VAT rules, Saudi merchant patterns (Arabic & English),
GOSI/government payments, Zakat-eligible asset detection.
"""

import re
from dataclasses import dataclass
from typing import Optional, List

# ─────────────────────────────────────────────────────────────────────────────
# Canonical category set  (mirrors the TypeScript version exactly)
# ─────────────────────────────────────────────────────────────────────────────

SEED_CATEGORIES = [
    # INCOME
    {"id": 1,  "name": "Sales Revenue",        "name_ar": "إيرادات المبيعات",         "type": "income",    "vat_applicable": True,  "zakat_relevant": False},
    {"id": 2,  "name": "Service Income",        "name_ar": "إيرادات الخدمات",          "type": "income",    "vat_applicable": True,  "zakat_relevant": False},
    {"id": 3,  "name": "Rental Income",         "name_ar": "إيرادات الإيجار",          "type": "income",    "vat_applicable": True,  "zakat_relevant": False},
    {"id": 4,  "name": "Investment Returns",    "name_ar": "عوائد الاستثمار",          "type": "income",    "vat_applicable": False, "zakat_relevant": True},
    {"id": 5,  "name": "Government Grants",     "name_ar": "المنح الحكومية",           "type": "income",    "vat_applicable": False, "zakat_relevant": False},
    {"id": 6,  "name": "Other Income",          "name_ar": "إيرادات أخرى",            "type": "income",    "vat_applicable": False, "zakat_relevant": False},
    # EXPENSES
    {"id": 7,  "name": "Salaries & Wages",      "name_ar": "الرواتب والأجور",          "type": "expense",   "vat_applicable": False, "zakat_relevant": False},
    {"id": 8,  "name": "Rent & Utilities",      "name_ar": "الإيجار والمرافق",         "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 9,  "name": "Telecommunications",    "name_ar": "الاتصالات",               "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 10, "name": "Fuel & Transportation", "name_ar": "الوقود والمواصلات",        "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 11, "name": "Food & Meals",          "name_ar": "الطعام والوجبات",          "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 12, "name": "Marketing & Advertising","name_ar": "التسويق والإعلان",        "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 13, "name": "Office Supplies",       "name_ar": "اللوازم المكتبية",         "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 14, "name": "Professional Services", "name_ar": "الخدمات المهنية",          "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 15, "name": "Bank Charges",          "name_ar": "الرسوم البنكية",           "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 16, "name": "Government Fees",       "name_ar": "الرسوم الحكومية",          "type": "expense",   "vat_applicable": False, "zakat_relevant": False},
    {"id": 17, "name": "Insurance",             "name_ar": "التأمين",                 "type": "expense",   "vat_applicable": False, "zakat_relevant": False},
    {"id": 18, "name": "Travel & Accommodation","name_ar": "السفر والإقامة",           "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 19, "name": "IT & Software",         "name_ar": "تقنية المعلومات والبرمجيات","type": "expense",  "vat_applicable": True,  "zakat_relevant": False},
    {"id": 20, "name": "Repairs & Maintenance", "name_ar": "الإصلاح والصيانة",        "type": "expense",   "vat_applicable": True,  "zakat_relevant": False},
    {"id": 21, "name": "Zakat Payment",         "name_ar": "الزكاة",                  "type": "expense",   "vat_applicable": False, "zakat_relevant": False},
    {"id": 22, "name": "VAT Payment",           "name_ar": "ضريبة القيمة المضافة",    "type": "expense",   "vat_applicable": False, "zakat_relevant": False},
    {"id": 23, "name": "Other Expenses",        "name_ar": "مصاريف أخرى",            "type": "expense",   "vat_applicable": False, "zakat_relevant": False},
    # ASSETS
    {"id": 24, "name": "Cash & Bank",           "name_ar": "النقد والبنك",             "type": "asset",     "vat_applicable": False, "zakat_relevant": True},
    {"id": 25, "name": "Accounts Receivable",   "name_ar": "الذمم المدينة",           "type": "asset",     "vat_applicable": False, "zakat_relevant": True},
    {"id": 26, "name": "Inventory",             "name_ar": "المخزون",                 "type": "asset",     "vat_applicable": False, "zakat_relevant": True},
    {"id": 27, "name": "Fixed Assets",          "name_ar": "الأصول الثابتة",          "type": "asset",     "vat_applicable": True,  "zakat_relevant": False},
    {"id": 28, "name": "Investments",           "name_ar": "الاستثمارات",             "type": "asset",     "vat_applicable": False, "zakat_relevant": True},
    # LIABILITIES
    {"id": 29, "name": "Accounts Payable",      "name_ar": "الذمم الدائنة",           "type": "liability", "vat_applicable": False, "zakat_relevant": False},
    {"id": 30, "name": "Loans & Financing",     "name_ar": "القروض والتمويل",          "type": "liability", "vat_applicable": False, "zakat_relevant": False},
]

CAT_MAP = {c["id"]: c for c in SEED_CATEGORIES}


@dataclass
class MatchResult:
    category_id: int
    category_name: str
    category_name_ar: str
    confidence: float
    matched_rule: str
    vat_applicable: bool
    is_zakat_relevant: bool
    suggested_vat_rate: Optional[float]  # 15.0, 0.0, or None


# ─────────────────────────────────────────────────────────────────────────────
# Rule definitions
# Each rule: (patterns, category_id, confidence, rule_name, vat_applicable,
#              is_zakat_relevant, suggested_vat_rate)
# ─────────────────────────────────────────────────────────────────────────────

_RULES: List[tuple] = [
    # GOVERNMENT / REGULATORY
    (
        [r"\bzakat\b", r"\bزكاة\b", r"\bGATZ\b", r"\bZATCA.*zakat\b"],
        21, 0.98, "Zakat payment to ZATCA", False, False, 0.0
    ),
    (
        [r"\bVAT.*remit\b", r"\bZATCA.*VAT\b", r"\bضريبة.*قيمة\b"],
        22, 0.98, "VAT remittance", False, False, 0.0
    ),
    (
        [r"\bMOC\b", r"\bMinistry.*Commerce\b", r"\bوزارة.*تجارة\b",
         r"\bCR\s*renew\b", r"\bcommercial.*register\b", r"\bSGRO\b",
         r"\bMOI\b", r"\bMunicipality\b", r"\bمجلس.*بلدي\b", r"\bأمانة\b",
         r"\bSABT\b", r"\bMOL\b", r"\bMinistry.*Labor\b", r"\bنطاقات\b",
         r"\bNitaqat\b", r"\bMOHR\b", r"\bMISAD\b", r"\bTAWEEN\b",
         r"\bBALADI\b", r"\bMunicipalBill\b", r"\bBALADIYAH\b", r"\bرخصة.*تجارية\b"],
        16, 0.95, "Government fee/ministry payment", False, False, 0.0
    ),
    # BANKING & CHARGES
    (
        [r"\bSNB\b", r"\bAl.?Rajhi\b", r"\bالراجحي\b", r"\bRiyad.*Bank\b",
         r"\bبنك.*الرياض\b", r"\bSAMBA\b", r"\bANB\b", r"\bArab.*National.*Bank\b",
         r"\bBSF\b", r"\bBanque.*Saudi.*Fransi\b", r"\bGIB\b", r"\bAlinma\b",
         r"\bأمانة.*بنك\b", r"\bSADIO\b", r"bank.*(charge|fee|commission)",
         r"transfer.*fee", r"wire.*fee", r"رسوم.*تحويل",
         r"\bSADAD\b", r"\bCLIQ\b", r"\bAPACS\b"],
        15, 0.90, "Saudi bank / bank charge", True, False, 15.0
    ),
    (
        [r"\bSTCPay\b", r"\bSTC.*Pay\b", r"\bUrpay\b", r"\bPayTabs\b",
         r"\bHyperPay\b", r"\bMyFatoorah\b", r"\bTamara\b", r"\bTabby\b",
         r"\bStc.*transfer\b", r"\bإيداع.*تحويل\b"],
        15, 0.88, "Saudi payment gateway / fintech", True, False, 15.0
    ),
    # TELECOM
    (
        [r"\bSTC\b(?!Pay)", r"\bAl.?Jawal\b", r"\bZain\b", r"\bMobily\b",
         r"\bموبايلي\b", r"\bVirgin.*Mobile.*Saudi\b", r"\blebaraKSA\b",
         r"\bتلفون.*خلوي\b", r"\bفاتورة.*هاتف\b", r"phone.*bill",
         r"internet.*bill", r"broadband", r"\bZain.*bill\b", r"\bdata.*plan\b"],
        9, 0.93, "Saudi telecom provider", True, False, 15.0
    ),
    # UTILITIES
    (
        [r"\bSEC\b", r"\bSaudi.*Electric\b", r"\bكهرباء\b", r"\bMADINATUL\b",
         r"electricity.*bill", r"\bSECO\b"],
        8, 0.96, "Saudi Electricity Company", True, False, 15.0
    ),
    (
        [r"\bNWC\b", r"\bNational.*Water\b", r"\bمياه\b", r"water.*bill", r"\bMANASEA\b"],
        8, 0.95, "National Water Company", True, False, 15.0
    ),
    # FUEL / TRANSPORT
    (
        [r"\bAramco\b", r"\bSABIC\b", r"\bPetro.?Rabigh\b", r"\bوقود\b",
         r"\bpetrol\b", r"\bfuel\b", r"\bgas.*station\b", r"\bمحطة.*بنزين\b",
         r"\bBADR.*fuel\b", r"\bNOMO.*fuel\b"],
        10, 0.90, "Fuel purchase", True, False, 15.0
    ),
    (
        [r"\bUber\b", r"\bCareem\b", r"\bكريم\b", r"\bJeeny\b", r"\bJahiz\b",
         r"\bINDRIVE\b", r"\btaxi\b", r"\bسيارة.*أجرة\b", r"\bSaptco\b",
         r"\bSAR.*Rail\b", r"\bHaramain\b", r"\bالحرمين.*سريع\b",
         r"flight.*ticket", r"airline", r"\bSaudia\b", r"\bFlyadeal\b", r"\bFlynas\b"],
        10, 0.88, "Transport / ride-hailing", True, False, 15.0
    ),
    (
        [r"\bAramex\b", r"\bDHL\b", r"\bFedEx\b", r"\bSMSA\b", r"\bNaqel\b",
         r"\bناقل\b", r"\bJ&T\b", r"\bZahid.*Express\b",
         r"shipping", r"courier", r"شحن", r"توصيل"],
        10, 0.87, "Shipping / courier", True, False, 15.0
    ),
    # FOOD
    (
        [r"\bHungerStation\b", r"\bجاهز\b", r"\bJahiz\b", r"\bMrsool\b",
         r"\bمرسول\b", r"\bToYou\b", r"\bMcd\b", r"\bMcDonald\b",
         r"\bKFC\b", r"\bBurger.*King\b", r"\bHardees\b", r"\bNando\b",
         r"\bPizza.*Hut\b", r"\bSubway\b", r"\bCinnabon\b", r"\bCold.*Stone\b",
         r"\bStarbucks\b", r"\bDunkin\b", r"\bTimHorton\b",
         r"\bAl-?Baik\b", r"\bالبيك\b", r"\bKudu\b", r"\bكودو\b",
         r"\bHerfy\b", r"\bهرفي\b", r"\brestaurant\b", r"\bمطعم\b",
         r"\bcafeteria\b", r"\bcafe\b", r"\bمقهى\b", r"\bبقالة\b",
         r"grocery", r"\bLuLu.*Hyper\b", r"\bCarrefour\b",
         r"\bAl.*Othaim\b", r"\bالعثيم\b", r"\bPanda.*Retail\b", r"\bبنده\b",
         r"\bDanube\b", r"\bالدانوب\b", r"supermarket", r"hypermarket"],
        11, 0.85, "Food / restaurant / grocery", True, False, 15.0
    ),
    # HOTELS
    (
        [r"\bHilton\b", r"\bHyatt\b", r"\bMarriott\b", r"\bSheraton\b",
         r"\bIntercontinental\b", r"\bCrowne.*Plaza\b", r"\bRadisson\b",
         r"\bRotana\b", r"\bروتانا\b", r"\bAccor\b", r"\bAirbnb\b",
         r"\bBooking\.com\b", r"\bAGODA\b",
         r"hotel", r"\bفندق\b", r"\bشقة.*مفروشة\b", r"\bapartment.*rent\b"],
        18, 0.90, "Hotel / accommodation", True, False, 15.0
    ),
    # IT / SOFTWARE
    (
        [r"\bMicrosoft\b", r"\bOffice.*365\b", r"\bAzure\b",
         r"\bGoogle.*Workspace\b", r"\bG.*Suite\b",
         r"\bAWS\b", r"\bAmazon.*Web.*Services\b",
         r"\bSlack\b", r"\bZoom\b", r"\bDropbox\b", r"\bAdobe\b",
         r"\bSAP\b", r"\bOracle\b", r"\bSalesforce\b", r"\bQuickBooks\b",
         r"\bFreshbooks\b", r"\bXero\b", r"\bNetSuite\b", r"\bHubSpot\b",
         r"\bMailchimp\b", r"\bGitHub\b", r"\bJira\b", r"\bAtlassian\b",
         r"\bNotion\b", r"\bAsana\b", r"\bClickUp\b", r"\bFigma\b",
         r"software.*license", r"\bsubscription\b", r"cloud.*service",
         r"SaaS", r"\bHosting\b", r"domain.*renew", r"\bServer\b"],
        19, 0.88, "IT / SaaS / software", True, False, 15.0
    ),
    # MARKETING
    (
        [r"\bGoogle.*Ads\b", r"\bFacebook.*Ads\b", r"\bMeta.*Ads\b",
         r"\bSnapchat.*Ads\b", r"\bTwitter.*Ads\b", r"\bX.*Ads\b",
         r"\bTikTok.*Ads\b", r"\bLinkedIn.*Ads\b",
         r"advertising", r"marketing", r"\bإعلان\b", r"\bتسويق\b", r"sponsored"],
        12, 0.90, "Digital / online advertising", True, False, 15.0
    ),
    # PROFESSIONAL SERVICES
    (
        [r"\baccounting\b", r"\baudit\b", r"\blegal.*fee\b", r"\bconsulting.*fee\b",
         r"\blaw.*firm\b", r"\bمحاسب\b", r"\bمدقق\b", r"\bمحامي\b", r"\bمستشار\b",
         r"\bDeloitte\b", r"\bPwC\b", r"\bErnst.*Young\b", r"\bKPMG\b",
         r"\bBaker.*McKenzie\b", r"\bAl-?Tamimi\b", r"\bfreelancer.*fee\b"],
        14, 0.87, "Professional / legal / consulting", True, False, 15.0
    ),
    # SALARIES
    (
        [r"\bsalary\b", r"\bpayroll\b", r"\bwage\b", r"\براتب\b", r"\bأجر\b",
         r"\bمكافأة\b", r"\bbonus\b", r"\bGOSI\b", r"\bTAMEEN\b",
         r"\bHRDF\b", r"\bHadaf\b", r"\bهدف\b", r"\bMusaned\b", r"\bمساند\b"],
        7, 0.92, "Salary / payroll / GOSI", False, False, 0.0
    ),
    # INSURANCE
    (
        [r"\bTawuniya\b", r"\bالتعاونية\b", r"\bAXA.*Cooperative\b",
         r"\bBupa.*Arabia\b", r"\bMedGulf\b", r"\binsurance\b", r"\bتأمين\b",
         r"\bwataniya.*insurance\b", r"\bAl.*Rajhi.*Takaful\b"],
        17, 0.93, "Insurance / Takaful", False, False, 0.0
    ),
    # RENT
    (
        [r"\bإيجار\b", r"\brent.*office\b", r"\boffice.*rent\b",
         r"\bshop.*rent\b", r"\bwarehouse.*rent\b", r"\bAqar\b",
         r"\bإيجار.*مكتب\b", r"\bإيجار.*محل\b", r"\bEjar\b", r"\bإيجار.*عقد\b"],
        8, 0.88, "Office / shop rent", True, False, 15.0
    ),
    # INVESTMENTS
    (
        [r"\bTadawul\b", r"\bتداول\b", r"\bSaudi.*Exchange\b",
         r"\bAlJazira.*Capital\b", r"\bFransi.*Capital\b", r"\bRiyad.*Capital\b",
         r"\bSNB.*Capital\b", r"\bstock.*purchase\b", r"\bsukuk\b", r"\bصكوك\b",
         r"\bdividend\b", r"\bأسهم\b", r"\bاستثمار\b",
         r"investment.*return", r"profit.*share"],
        4, 0.88, "Saudi investment / Tadawul", False, True, 0.0
    ),
    # FIXED ASSETS
    (
        [r"\bequipment.*purchase\b", r"\bMachinery\b", r"\bvehicle.*purchase\b",
         r"\bcar.*purchase\b", r"\bلاب.*توب\b", r"\blaptop.*purchase\b",
         r"\bcomputer.*purchase\b", r"\bprinter.*purchase\b",
         r"\bfurniture\b", r"\bأثاث\b", r"capital.*expenditure", r"\bCAPEX\b"],
        27, 0.83, "Fixed asset / capital purchase", True, False, 15.0
    ),
    # ISLAMIC FINANCING
    (
        [r"\bتمويل\b", r"\bmurabaha\b", r"\bIslamic.*finance\b",
         r"\bfinancing.*installment\b", r"\bقسط\b", r"\bloan.*repay\b"],
        30, 0.85, "Islamic financing / loan repayment", False, False, 0.0
    ),
]

# Compile all regex patterns once at import time
_COMPILED_RULES = [
    (
        [re.compile(p, re.IGNORECASE | re.UNICODE) for p in patterns],
        cat_id, confidence, rule_name, vat_ap, zakat_rel, vat_rate
    )
    for patterns, cat_id, confidence, rule_name, vat_ap, zakat_rel, vat_rate in _RULES
]


# ─────────────────────────────────────────────────────────────────────────────
# Engine
# ─────────────────────────────────────────────────────────────────────────────

def _is_salary_like(description: str, amount: float) -> bool:
    """Round-amount heuristic for unidentified payroll credits."""
    round_amount = (amount % 500 == 0) or (amount % 1000 == 0)
    salary_words = bool(re.search(r"transfer|تحويل|راتب|salary|payroll", description, re.I))
    return round_amount and salary_words and 1000 <= amount <= 50000


def categorize_transaction(
    description: str,
    amount: float,
    transaction_type: str,          # "debit" or "credit"
    description_ar: Optional[str] = None,
) -> MatchResult:
    """
    Classify a transaction using the deterministic rule engine.
    Always returns a result — worst case is the "Other" fallback.
    """
    combined = f"{description} {description_ar or ''}".strip()
    combined = combined.replace("\u200b", "").replace("\u00a0", " ")

    # Salary heuristic
    if transaction_type == "credit" and _is_salary_like(combined, amount):
        cat = CAT_MAP[7]
        return MatchResult(
            category_id=7,
            category_name=cat["name"],
            category_name_ar=cat["name_ar"],
            confidence=0.72,
            matched_rule="Amount-based salary heuristic",
            vat_applicable=False,
            is_zakat_relevant=False,
            suggested_vat_rate=0.0,
        )

    # Pattern matching
    best: Optional[MatchResult] = None
    for compiled_patterns, cat_id, confidence, rule_name, vat_ap, zakat_rel, vat_rate in _COMPILED_RULES:
        for pattern in compiled_patterns:
            if pattern.search(combined):
                if best is None or confidence > best.confidence:
                    cat = CAT_MAP[cat_id]
                    best = MatchResult(
                        category_id=cat_id,
                        category_name=cat["name"],
                        category_name_ar=cat["name_ar"],
                        confidence=confidence,
                        matched_rule=rule_name,
                        vat_applicable=vat_ap,
                        is_zakat_relevant=zakat_rel,
                        suggested_vat_rate=vat_rate,
                    )
                break  # matched this rule — no need to try more patterns in it

    if best:
        return best

    # Fallbacks
    if transaction_type == "credit":
        cat = CAT_MAP[6]
        return MatchResult(
            category_id=6,
            category_name=cat["name"],
            category_name_ar=cat["name_ar"],
            confidence=0.35,
            matched_rule="Fallback: unmatched credit transaction",
            vat_applicable=False,
            is_zakat_relevant=False,
            suggested_vat_rate=None,
        )
    cat = CAT_MAP[23]
    return MatchResult(
        category_id=23,
        category_name=cat["name"],
        category_name_ar=cat["name_ar"],
        confidence=0.30,
        matched_rule="Fallback: unmatched debit transaction",
        vat_applicable=False,
        is_zakat_relevant=False,
        suggested_vat_rate=None,
    )
