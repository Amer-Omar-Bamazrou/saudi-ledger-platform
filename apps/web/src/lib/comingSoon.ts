/**
 * COMING SOON — what does not exist yet, and WHAT EACH ONE IS WAITING ON.
 *
 * ── 🔴 THE RULE (owner, 2026-08-31) ────────────────────────────────────────
 * Every Coming Soon page names what it is waiting on, and names it
 * specifically. Where the blocker is not build effort — a contract, a
 * registration, an advisor's answer, a legal question, an undesigned decision —
 * the page says which, by name.
 *
 * **Why it is a rule and not a nicety:** *"Not built" invites someone to build
 * it; "waiting on a contract" tells them why they must not.* A generic
 * placeholder is an open invitation to spend effort on something that cannot
 * ship, and the person most likely to accept that invitation is a future
 * contributor with time and no context — which is exactly who a placeholder is
 * written for. The blocker's name is the part that does the work.
 *
 * ── 🔴 THE COROLLARY, WHICH IS WHY `whenCleared` IS A REQUIRED FIELD ───────
 * When the blocker clears, the page's own text says so, so the placeholder
 * BECOMES THE WORK ORDER. A page reading "waiting on the Groq Enterprise
 * agreement" is a queue item the day that agreement is signed. That only works
 * if the page states what happens next in enough detail to act on, which a
 * type can require and a convention cannot — so it is a field, not a habit.
 *
 * ── 🔴 A THIRD CLASS THE SPEC DID NOT HAVE: THE PAGE, NOT THE FEATURE ──────
 * Some of these are not unbuilt features at all. Debit notes post correctly
 * today; transfers have posted to the GL since 2026-08-17. What is missing is a
 * SCREEN. `capabilityLive` says so on the page, because "coming soon" over a
 * working capability is the reverse of the claimed-but-unreachable disease —
 * and someone told the truth about the screen would build the screen, not the
 * ledger machinery that already works.
 */

/** Who or what clears a blocker. `ownerAction` = only the owner can clear it. */
export interface Blocker {
  name: string;
  nameAr: string;
  /** The specific act that clears it — never "when it is ready". */
  clearedBy: string;
  clearedByAr: string;
  ownerAction?: boolean;
}

export const BLOCKERS = {
  /** Ordinary build effort. The honest default — and the only one that invites work. */
  build: {
    name: "Build effort — nothing external is in the way",
    nameAr: "جهد التطوير — لا يوجد عائق خارجي",
    clearedBy: "It is on the roadmap and not yet scheduled. Nothing blocks it but time.",
    clearedByAr: "مُدرج في خطة التطوير ولم يُجدوَل بعد. لا يعيقه سوى الوقت.",
  },
  groq: {
    name: "The Groq Enterprise agreement",
    nameAr: "اتفاقية Groq Enterprise",
    clearedBy: "The owner negotiating and signing it (Dammam pinning + contractual zero data retention).",
    clearedByAr: "توقيع المالك للاتفاقية (استضافة في الدمام + عدم الاحتفاظ بالبيانات تعاقديًا).",
    ownerAction: true,
  },
  entity: {
    name: "A registered Saudi company entity with an active ZATCA VAT registration and ERAD credentials",
    nameAr: "منشأة سعودية مسجَّلة مع تسجيل ضريبي فعّال لدى هيئة الزكاة والضريبة وبيانات اعتماد إراد",
    clearedBy: "The owner registering the entity. It is not a technical step, and nothing else unblocks it.",
    clearedByAr: "تسجيل المالك للمنشأة. ليست خطوة تقنية، ولا يوجد بديل يرفع هذا العائق.",
    ownerAction: true,
  },
  cr: {
    name: "The Saudi commercial registration (CR)",
    nameAr: "السجل التجاري السعودي",
    clearedBy:
      "The same entity registration. Signing with a SAMA-licensed provider almost certainly requires a CR — conversations stay useful without it, signatures do not.",
    clearedByAr:
      "نفس تسجيل المنشأة. التوقيع مع مزوّد مرخَّص من ساما يتطلب سجلًا تجاريًا — المحادثات مفيدة بدونه، أما التوقيع فلا.",
    ownerAction: true,
  },
  advisorBlockC: {
    name: "Advisor Block C — the Zakat base computation",
    nameAr: "الكتلة C لدى المستشار — احتساب وعاء الزكاة",
    clearedBy:
      "An accountant answering the tax-content questions. The MECHANISM is decided; the tax content has never been checked against the Zakat Collection Regulations.",
    clearedByAr:
      "إجابة محاسب معتمد على أسئلة المحتوى الضريبي. الآلية محسومة؛ أما المحتوى الضريبي فلم يُراجع مقابل لائحة جباية الزكاة.",
    ownerAction: true,
  },
  advisorBlockE: {
    name: "Advisor Block E — the chart-of-accounts restructure",
    nameAr: "الكتلة E لدى المستشار — إعادة هيكلة دليل الحسابات",
    clearedBy: "The advisor's answer on the account structure, which gates the design this depends on.",
    clearedByAr: "إجابة المستشار بشأن هيكل الحسابات، وهي تحكم التصميم الذي يعتمد عليه هذا.",
    ownerAction: true,
  },
  pdpl: {
    name: "Advisor Block C8 — PDPL (Saudi data protection)",
    nameAr: "الكتلة C8 لدى المستشار — نظام حماية البيانات الشخصية",
    clearedBy:
      "A legal answer on retention and erasure. 🔴 Do not build ahead of it: an export surface decided wrongly is harder to withdraw than to delay.",
    clearedByAr:
      "إجابة قانونية بشأن الاحتفاظ بالبيانات والحق في المحو. 🔴 لا يُبنى قبل ورودها: سحب واجهة تصدير بُنيت على قرار خاطئ أصعب من تأجيلها.",
    ownerAction: true,
  },
  r1Billing: {
    name: "R1 — billing is undesigned",
    nameAr: "R1 — الفوترة والاشتراكات غير مصمَّمة",
    clearedBy:
      "Three decisions nobody has taken: the provider (a Stripe-class processor or a Saudi PSP), the plan shape, and what a plan actually gates.",
    clearedByAr:
      "ثلاثة قرارات لم تُتخذ بعد: مزوّد الدفع، وشكل الباقات، وما الذي تقيّده كل باقة فعليًا.",
    ownerAction: true,
  },
  mailProvider: {
    name: "A mail provider and a verified sending domain",
    nameAr: "مزوّد بريد ونطاق إرسال موثَّق",
    clearedBy:
      "Choosing a provider and verifying the domain (MAIL_PROVIDER / MAIL_API_KEY / MAIL_FROM). The mailer code is finished; only the wiring is missing.",
    clearedByAr:
      "اختيار المزوّد وتوثيق النطاق. شيفرة البريد مكتملة؛ الناقص هو الربط فقط.",
    ownerAction: true,
  },
  productDecision: {
    name: "An open product decision",
    nameAr: "قرار مُنتَج مفتوح",
    clearedBy: "The owner choosing between the options on the table. The build is small either way; the choice is not.",
    clearedByAr: "اختيار المالك بين البدائل المطروحة. البناء صغير في الحالتين؛ القرار ليس كذلك.",
    ownerAction: true,
  },
  /** 🔴 Not "not yet" — cannot be derived from what we store. */
  notDerivable: {
    name: "Data we do not keep",
    nameAr: "بيانات غير محفوظة لدينا",
    clearedBy:
      "A schema change that records the missing fact going forward. 🔴 It could not be back-filled — history that was never captured cannot be recovered.",
    clearedByAr:
      "تغيير في المخطط يسجّل الحقيقة الناقصة مستقبلًا. 🔴 لا يمكن استرجاع تاريخ لم يُسجَّل أصلًا.",
  },
  inventory: {
    name: "Inventory and cost tracking, which do not exist",
    nameAr: "المخزون وتتبع التكلفة، وهما غير موجودين",
    clearedBy: "Products carrying cost. That follows the chart-of-accounts work, which waits on advisor Block E.",
    clearedByAr: "أن تحمل المنتجات تكلفة. وهذا يتبع أعمال دليل الحسابات المرتبطة بالكتلة E.",
  },
} as const satisfies Record<string, Blocker>;

export type BlockerId = keyof typeof BLOCKERS;

export interface ComingSoonEntry {
  /** URL segment: `/coming-soon/<slug>`. */
  slug: string;
  title: string;
  titleAr: string;
  /** What it will do when it exists. Concrete enough to be worth waiting for. */
  summary: string;
  summaryAr: string;
  blocker: BlockerId;
  /** 🔴 The work order: what happens the day the blocker clears. Required. */
  whenCleared: string;
  whenClearedAr: string;
  /**
   * Set when the CAPABILITY already works and only the screen is missing —
   * so nobody rebuilds machinery that is live and correct.
   */
  capabilityLive?: string;
  capabilityLiveAr?: string;
}

export const COMING_SOON: readonly ComingSoonEntry[] = [
  // ── FINANCE ──────────────────────────────────────────────────────────────
  {
    slug: "coa-tree-view",
    title: "Chart of Accounts — tree view",
    titleAr: "دليل الحسابات — العرض الشجري",
    summary: "The chart of accounts as a hierarchy you can expand and collapse, rather than one flat list.",
    summaryAr: "دليل الحسابات كهيكل شجري قابل للتوسيع والطي، بدلًا من قائمة مسطّحة واحدة.",
    blocker: "advisorBlockE",
    whenCleared: "Build the hierarchy from the restructure design (design-chart-of-accounts-structure.md), then this view on top of it.",
    whenClearedAr: "بناء الهيكل الشجري وفق تصميم إعادة الهيكلة، ثم هذا العرض فوقه.",
  },
  {
    slug: "coa-import",
    title: "Import accounts",
    titleAr: "استيراد الحسابات",
    summary: "Bring an existing chart of accounts in from a spreadsheet instead of entering it account by account.",
    summaryAr: "استيراد دليل حسابات قائم من ملف جدولي بدلًا من إدخاله حسابًا حسابًا.",
    blocker: "advisorBlockE",
    whenCleared: "Designed already (chart-of-accounts design §6). Build it once the account structure is settled — importing into a structure about to change would import the wrong shape.",
    whenClearedAr: "التصميم جاهز. يُبنى بعد استقرار هيكل الحسابات — الاستيراد إلى هيكل على وشك التغيّر يستورد الشكل الخطأ.",
  },
  {
    slug: "coa-settings",
    title: "Chart of Accounts settings",
    titleAr: "إعدادات دليل الحسابات",
    summary: "Account numbering, default accounts, and account types.",
    summaryAr: "ترقيم الحسابات، والحسابات الافتراضية، وأنواع الحسابات.",
    blocker: "advisorBlockE",
    whenCleared: "Part of the same restructure. 🔴 Note there are no update or delete routes for accounts today — this needs those built first, not just a screen.",
    whenClearedAr: "جزء من إعادة الهيكلة نفسها. 🔴 لا توجد اليوم مسارات تعديل أو حذف للحسابات — يلزم بناؤها أولًا، لا الشاشة فقط.",
  },
  {
    slug: "cost-centers",
    title: "Cost centres and projects",
    titleAr: "مراكز التكلفة والمشاريع",
    summary: "Tag journal entries to a cost centre or project, and report profitability by each.",
    summaryAr: "ربط قيود اليومية بمركز تكلفة أو مشروع، وإصدار تقارير الربحية لكل منها.",
    blocker: "build",
    whenCleared: "Designed (chart-of-accounts design §7), including the decision that the cost centre lives on the journal entry HEADER. Zero code exists today.",
    whenClearedAr: "مُصمَّم بالفعل، بما في ذلك قرار وضع مركز التكلفة في ترويسة القيد. لا توجد شيفرة اليوم.",
  },

  // ── SALES ────────────────────────────────────────────────────────────────
  {
    slug: "debit-notes",
    title: "Debit notes",
    titleAr: "إشعارات المدين",
    summary: "A standalone page for debit notes — issuing them, listing them, and reading their history.",
    summaryAr: "صفحة مستقلة لإشعارات المدين — إصدارها وعرضها ومراجعة سجلها.",
    blocker: "build",
    whenCleared: "Rebuild the PAGE. Nothing in the accounting needs writing.",
    whenClearedAr: "إعادة بناء الصفحة فقط. لا شيء في المحاسبة يحتاج إلى كتابة.",
    capabilityLive:
      "🔴 Debit notes already work. The capability is live and correct — a debit note posts like an invoice, not like a credit note — and only the standalone page was removed on 2026-08-20. This is a page to rebuild, not a feature to invent.",
    capabilityLiveAr:
      "🔴 إشعارات المدين تعمل بالفعل. القدرة حيّة وصحيحة — يُرحَّل إشعار المدين كفاتورة لا كإشعار دائن — وقد أُزيلت الصفحة المستقلة فقط بتاريخ 2026-08-20. هذه صفحة يُعاد بناؤها، لا ميزة تُخترع.",
  },
  {
    slug: "invoice-templates",
    title: "Invoice templates",
    titleAr: "قوالب الفواتير",
    summary: "Saved invoice shapes — the usual lines, terms and VAT treatment — so a repeat invoice starts filled in.",
    summaryAr: "قوالب محفوظة للفواتير — البنود والشروط والمعالجة الضريبية المعتادة — لتبدأ الفاتورة المتكررة معبّأة.",
    blocker: "build",
    whenCleared: "On the roadmap. (The `template` hits in the codebase are `system_account_templates` — an unrelated thing.)",
    whenClearedAr: "مُدرج في خطة التطوير. (ما يظهر في الشيفرة باسم القوالب يخص قوالب الحسابات النظامية، وهو أمر مختلف.)",
  },
  {
    slug: "quotation-templates",
    title: "Quotation templates",
    titleAr: "قوالب عروض الأسعار",
    summary: "Saved quotation shapes, the same idea as invoice templates.",
    summaryAr: "قوالب محفوظة لعروض الأسعار، بالفكرة نفسها المتّبعة في قوالب الفواتير.",
    blocker: "build",
    whenCleared: "On the roadmap, and follows invoice templates.",
    whenClearedAr: "مُدرج في خطة التطوير، ويأتي بعد قوالب الفواتير.",
  },
  {
    slug: "customer-groups",
    title: "Customer groups",
    titleAr: "مجموعات العملاء",
    summary: "Group customers to price, report and chase them together.",
    summaryAr: "تجميع العملاء للتسعير وإعداد التقارير والمتابعة كمجموعة واحدة.",
    blocker: "build",
    whenCleared: "On the roadmap, and genuinely unblocked. Decide first what a group is FOR — pricing, reporting, or collections — because those imply different data, and a group that means all three means none of them.",
    whenClearedAr: "مُدرج في خطة التطوير وغير معوَّق فعلًا. يُحدَّد أولًا الغرض من المجموعة — التسعير أم التقارير أم التحصيل — لأن لكل غرض بيانات مختلفة، والمجموعة التي تعني الثلاثة معًا لا تعني شيئًا.",
  },
  {
    slug: "sales-by-product",
    title: "Sales by product",
    titleAr: "المبيعات حسب المنتج",
    summary: "Revenue and margin per product or service.",
    summaryAr: "الإيرادات وهامش الربح لكل منتج أو خدمة.",
    blocker: "inventory",
    whenCleared: "Revenue per product is available today; MARGIN is not, because products carry no cost. Build it after cost tracking, or it reports half the answer as if it were the whole one.",
    whenClearedAr: "الإيراد لكل منتج متاح اليوم؛ أما الهامش فلا، لأن المنتجات لا تحمل تكلفة. يُبنى بعد تتبع التكلفة، وإلا عرض نصف الإجابة وكأنها كاملة.",
  },

  // ── PURCHASES ────────────────────────────────────────────────────────────
  {
    slug: "po-templates",
    title: "Purchase order templates",
    titleAr: "قوالب أوامر الشراء",
    summary: "Saved purchase-order shapes for repeat ordering.",
    summaryAr: "قوالب محفوظة لأوامر الشراء المتكررة.",
    blocker: "build",
    whenCleared: "On the roadmap, alongside the other template work.",
    whenClearedAr: "مُدرج في خطة التطوير، مع بقية أعمال القوالب.",
  },
  {
    slug: "vendor-statements",
    title: "Vendor statements",
    titleAr: "كشوف حساب الموردين",
    summary: "A vendor's full account — bills, payments and running balance over a period.",
    summaryAr: "حساب المورد كاملًا — الفواتير والمدفوعات والرصيد الجاري خلال فترة.",
    blocker: "build",
    whenCleared: "🔴 A deliberate asymmetry today: the customer equivalent (`/reports/customer-ledger`) exists and this does not. `VendorDetail.tsx` records that in a comment and omits the button rather than linking to nothing. Build the vendor mirror of the customer ledger.",
    whenClearedAr: "🔴 عدم تماثل مقصود اليوم: النظير الخاص بالعملاء موجود وهذا غير موجود. تُبنى النسخة المقابلة لكشف حساب العميل.",
  },
  {
    slug: "purchases-by-vendor",
    title: "Purchases by vendor",
    titleAr: "المشتريات حسب المورد",
    summary: "What each vendor was billed and paid over a period.",
    summaryAr: "ما صدر عن كل مورد من فواتير وما دُفع له خلال فترة.",
    blocker: "build",
    whenCleared: "The vendor-side equivalent of the customer ledger; the same build as vendor statements.",
    whenClearedAr: "النظير الخاص بالموردين لكشف حساب العميل؛ وهو البناء نفسه لكشوف حساب الموردين.",
  },
  {
    slug: "purchases-by-product",
    title: "Purchases by product",
    titleAr: "المشتريات حسب المنتج",
    summary: "What was bought, in what quantity, at what price.",
    summaryAr: "ما تم شراؤه، وبأي كمية، وبأي سعر.",
    blocker: "inventory",
    whenCleared: "Follows inventory, like its sales counterpart.",
    whenClearedAr: "يتبع المخزون، مثل نظيره في المبيعات.",
  },

  // ── BANKING ──────────────────────────────────────────────────────────────
  {
    slug: "bank-account-detail",
    title: "Bank account detail",
    titleAr: "تفاصيل الحساب البنكي",
    summary: "One account's full picture — balance history, its transactions, and its reconciliation state.",
    summaryAr: "الصورة الكاملة لحساب واحد — تاريخ الرصيد، ومعاملاته، وحالة تسويته.",
    blocker: "build",
    whenCleared: "The list and create pages exist; this is the per-account page underneath them.",
    whenClearedAr: "صفحتا القائمة والإنشاء موجودتان؛ هذه هي صفحة الحساب المفرد تحتهما.",
  },
  {
    slug: "bank-statement-register",
    title: "Bank statement register",
    titleAr: "سجل كشوف الحسابات البنكية",
    summary: "Every statement ever imported, when, by whom, and what it produced.",
    summaryAr: "كل كشف تم استيراده، ومتى، وبواسطة من، وما نتج عنه.",
    blocker: "build",
    whenCleared: "Import works (`/upload`) and review works (`/review`); what is missing is the register of past imports.",
    whenClearedAr: "الاستيراد يعمل والمراجعة تعمل؛ الناقص هو سجل عمليات الاستيراد السابقة.",
  },
  {
    slug: "transfers",
    title: "Transfers",
    titleAr: "التحويلات",
    summary: "Money moved between your own accounts, and to and from outside — as a place, rather than rows mixed into the transaction list.",
    summaryAr: "الأموال المنقولة بين حساباتك، ومن الخارج وإليه — كصفحة مستقلة بدلًا من صفوف مبعثرة داخل قائمة المعاملات.",
    blocker: "build",
    whenCleared: "Build the PAGE and its create flow. The posting rules are settled and live.",
    whenClearedAr: "بناء الصفحة ومسار الإنشاء. قواعد الترحيل محسومة وتعمل.",
    capabilityLive:
      "🔴 Transfers already work and have posted to the general ledger since 2026-08-17 — cash against transfer clearing, with no P&L, tax or budget line, ever. They are visible today inside Transactions. What is missing is a page of their own.",
    capabilityLiveAr:
      "🔴 التحويلات تعمل بالفعل وتُرحَّل إلى دفتر الأستاذ منذ 2026-08-17 — دون أي أثر على الأرباح والخسائر أو الضريبة أو الموازنة إطلاقًا. وهي ظاهرة اليوم ضمن المعاملات. الناقص صفحة مستقلة لها.",
  },
  {
    slug: "transfer-reports",
    title: "Transfer reports",
    titleAr: "تقارير التحويلات",
    summary: "Transfers summarised by account, direction and period.",
    summaryAr: "ملخّص التحويلات حسب الحساب والاتجاه والفترة.",
    blocker: "build",
    whenCleared: "Follows the transfers page — a report needs the place it reports on.",
    whenClearedAr: "يأتي بعد صفحة التحويلات — التقرير يحتاج إلى الصفحة التي يصفها.",
  },
  {
    slug: "live-bank-feeds",
    title: "Live bank feeds",
    titleAr: "الربط المباشر مع البنوك",
    summary: "Transactions arriving from your bank automatically, instead of a statement you export and upload.",
    summaryAr: "وصول المعاملات من بنكك تلقائيًا، بدلًا من كشف تصدّره وترفعه.",
    blocker: "cr",
    whenCleared: "Sign with a SAMA-licensed open-banking provider, then build the connector against their API. Conversations with providers are useful now; signatures are not possible.",
    whenClearedAr: "التوقيع مع مزوّد مرخَّص من ساما، ثم بناء الموصّل مقابل واجهته البرمجية. المحادثات مع المزوّدين مفيدة الآن؛ أما التوقيع فغير ممكن.",
  },

  // ── TAX ──────────────────────────────────────────────────────────────────
  {
    slug: "zatca-production-submission",
    title: "ZATCA production submission",
    titleAr: "الإرسال الفعلي إلى هيئة الزكاة والضريبة والجمارك",
    summary: "Clearing and reporting real invoices to ZATCA, rather than validating their construction against the sandbox.",
    summaryAr: "تصفية وإبلاغ الفواتير الحقيقية للهيئة، بدلًا من التحقق من بنائها مقابل البيئة التجريبية.",
    blocker: "entity",
    whenCleared: "Run M12.7 (simulation) and then M12.9 (production pilot), in that order. No rework is expected — the sandbox exercises the same API surface. 🔴 Do not mock simulation to 'finish' M12, and do not onboard a real tenant before both have run.",
    whenClearedAr: "تنفيذ M12.7 (المحاكاة) ثم M12.9 (التشغيل التجريبي)، بهذا الترتيب. لا يُتوقع إعادة عمل. 🔴 لا تُحاكَ المرحلة التجريبية لإنهاء M12 صوريًا، ولا يُضاف عميل حقيقي قبل تنفيذهما.",
    capabilityLive:
      "🔴 The document construction is built and verified against the live ZATCA sandbox — the CSR, the signing curve, the XAdES properties, all nine QR tags and six compliance documents. What has never happened, in any environment, is a submission on the production path.",
    capabilityLiveAr:
      "🔴 بناء المستندات مكتمل ومتحقَّق منه مقابل البيئة التجريبية الحيّة للهيئة. ما لم يحدث قط، في أي بيئة، هو الإرسال عبر المسار الفعلي.",
  },
  {
    slug: "zakat-calculation",
    title: "Zakat calculation",
    titleAr: "احتساب الزكاة",
    summary: "The Zakat working paper: the base, the adjustments, and the amount due.",
    summaryAr: "ورقة عمل الزكاة: الوعاء، والتسويات، والمبلغ المستحق.",
    blocker: "advisorBlockC",
    whenCleared: "🔴 Ask the minimum-base question FIRST — it is the only one that changes architecture rather than arithmetic. If a rule ties the base to adjusted net profit, the income statement becomes a computed INPUT with its own adjustments and audit trail.",
    whenClearedAr: "🔴 يُطرح سؤال الحد الأدنى للوعاء أولًا — فهو الوحيد الذي يغيّر البنية لا الحساب. فإن ربطت القاعدةُ الوعاءَ بصافي الربح المعدَّل، تصبح قائمة الدخل مُدخلًا محسوبًا له تسوياته وسجل تدقيقه.",
  },
  {
    slug: "zakat-base",
    title: "Zakat base",
    titleAr: "وعاء الزكاة",
    summary: "What counts toward the base, what is deducted, and why each line is treated as it is.",
    summaryAr: "ما يدخل في الوعاء، وما يُخصم منه، وسبب معالجة كل بند على نحوه.",
    blocker: "advisorBlockC",
    whenCleared: "Open with the advisor: exact base composition and qualifying provisions, the Gregorian divisor (354 vs 354.367) and rounding, and whether nisab has any role in corporate Zakat.",
    whenClearedAr: "مفتوح مع المستشار: تركيب الوعاء بدقة والمخصصات المؤهلة، والمقسوم الميلادي والتقريب، ودور النصاب في زكاة الشركات إن وُجد.",
  },
  {
    slug: "zakat-reports",
    title: "Zakat reports",
    titleAr: "تقارير الزكاة",
    summary: "The Zakat position over time, and the filing history.",
    summaryAr: "مركز الزكاة عبر الزمن، وسجل الإقرارات.",
    blocker: "advisorBlockC",
    whenCleared: "Follows the calculation — a report on a figure nobody has verified would spread an unverified number, not explain it.",
    whenClearedAr: "يأتي بعد الاحتساب — تقرير عن رقم غير متحقَّق منه ينشر الخطأ ولا يشرحه.",
  },
  {
    slug: "zakat-settings",
    title: "Zakat settings",
    titleAr: "إعدادات الزكاة",
    summary: "The fiscal basis, the ownership declaration, and the treatment choices the calculation depends on.",
    summaryAr: "الأساس المالي، وإقرار الملكية، وخيارات المعالجة التي يعتمد عليها الاحتساب.",
    blocker: "advisorBlockC",
    whenCleared: "Also open: whether declining mixed or foreign ownership is the right posture for a first version.",
    whenClearedAr: "ومفتوح أيضًا: هل رفض الملكية المختلطة أو الأجنبية هو الموقف الصحيح للإصدار الأول.",
  },
  {
    slug: "withholding-tax",
    title: "Withholding tax",
    titleAr: "ضريبة الاستقطاع",
    summary: "Withholding on payments to non-residents: the rates, the amounts withheld, and the return.",
    summaryAr: "الاستقطاع على المدفوعات لغير المقيمين: النسب، والمبالغ المستقطعة، والإقرار.",
    blocker: "build",
    whenCleared: "Zero code today. 🔴 Scope the tax content with the advisor before building — the same mistake as Zakat is available here for free.",
    whenClearedAr: "لا توجد شيفرة اليوم. 🔴 يُحدَّد المحتوى الضريبي مع المستشار قبل البناء — الخطأ نفسه الذي وقع في الزكاة متاح هنا بلا عناء.",
  },

  // ── REPORTS ──────────────────────────────────────────────────────────────
  {
    slug: "aging-trends",
    title: "Aging trends",
    titleAr: "اتجاهات أعمار الذمم",
    summary: "How the overdue split moved over time, rather than where it stands today.",
    summaryAr: "كيف تحرّك توزيع المتأخرات عبر الزمن، لا أين يقف اليوم.",
    blocker: "notDerivable",
    whenCleared: "🔴 This one is not merely unbuilt — it CANNOT be derived from what we store. Payment dates are not kept per instalment, so a historical overdue split has no source. Building it needs a schema change that records the fact from now on, and even then the history before that change stays unknowable.",
    whenClearedAr: "🔴 هذا ليس غير مبنيّ فحسب — بل لا يمكن اشتقاقه مما نحفظه. تواريخ السداد غير محفوظة لكل قسط، فلا مصدر لتوزيع تاريخي للمتأخرات. ويتطلب بناؤه تغييرًا في المخطط يسجّل ذلك مستقبلًا، ويبقى ما قبله مجهولًا.",
  },
  {
    slug: "custom-reports",
    title: "Custom reports",
    titleAr: "التقارير المخصّصة",
    summary: "Build a report by choosing its columns, filters and grouping — then save and schedule it.",
    summaryAr: "بناء تقرير باختيار أعمدته ومرشحاته وتجميعه — ثم حفظه وجدولته.",
    blocker: "build",
    whenCleared: "Zero code. A report builder is a large piece of work; treat it as its own milestone, not an extension of the reports hub.",
    whenClearedAr: "لا توجد شيفرة. مُنشئ التقارير عمل كبير؛ يُعامَل كمرحلة مستقلة لا كامتداد لمركز التقارير.",
  },

  // ── AI & AUTOMATION ──────────────────────────────────────────────────────
  {
    slug: "ai-assistant",
    title: "AI assistant",
    titleAr: "المساعد الذكي",
    summary: "Ask questions about your own books and get answers grounded in your ledger, with the figures it used shown.",
    summaryAr: "طرح أسئلة عن دفاترك والحصول على إجابات مستندة إلى قيودك، مع عرض الأرقام المستخدمة.",
    blocker: "groq",
    whenCleared: "🔴 Flip the boot boundary and the feature is there. Nothing needs writing — verify the Dammam pinning and zero-retention terms are actually in force, then enable it.",
    whenClearedAr: "🔴 يُفتح حدّ الإقلاع فتظهر الميزة. لا شيء يحتاج إلى كتابة — يُتحقَّق من سريان شرطي الاستضافة في الدمام وعدم الاحتفاظ بالبيانات، ثم تُفعَّل.",
    capabilityLive:
      "🔴 This is built. AI-6a — grounded answers that show their work and never advise — is finished, tested, and DARK BY CONSTRUCTION: the boot boundary refuses to send tenant data to Groq until the Enterprise agreement is signed. The free tier routes globally, and development is not an exception to that.",
    capabilityLiveAr:
      "🔴 هذه الميزة مبنية بالفعل. إجابات مستندة إلى الأدلة تعرض مصادرها ولا تقدّم استشارة، مكتملة ومختبَرة، ومعطَّلة بحكم البناء: يرفض حدّ الإقلاع إرسال بيانات المستأجرين إلى Groq قبل توقيع الاتفاقية.",
  },
  {
    slug: "vision-model",
    title: "Vision model",
    titleAr: "نموذج الرؤية",
    summary: "Reading a photographed receipt or invoice directly, where the QR code and OCR fall short.",
    summaryAr: "قراءة صورة الإيصال أو الفاتورة مباشرة، حيث يقصُر رمز الاستجابة السريعة والتعرّف الضوئي.",
    blocker: "groq",
    whenCleared: "Two things, both owner actions: the Groq agreement, AND an Arabic-acceptable vision model confirmed available in the Dammam region. Collecting the receipt corpus is useful now and needs neither.",
    whenClearedAr: "أمران، كلاهما من مهام المالك: اتفاقية Groq، والتأكد من توفّر نموذج رؤية مقبول للعربية في منطقة الدمام. أما تجميع مجموعة الإيصالات فمفيد الآن ولا يحتاج إلى أيٍّ منهما.",
  },
  {
    slug: "recurring-journal-entries",
    title: "Recurring journal entries",
    titleAr: "قيود اليومية المتكررة",
    summary: "A journal entry on a schedule — the accrual or allocation you post every month.",
    summaryAr: "قيد يومية وفق جدول زمني — الاستحقاق أو التوزيع الذي تُرحّله كل شهر.",
    blocker: "build",
    whenCleared: "Recurring invoices and bills exist and generate DRAFTS ONLY, by design. Extend the same engine, and keep the drafts-only rule: consent to a rule in January is not consent to what it produces in November.",
    whenClearedAr: "الفواتير المتكررة موجودة وتنتج مسودات فقط، عن قصد. يُوسَّع المحرك نفسه مع الإبقاء على قاعدة المسودات: الموافقة على قاعدة في يناير ليست موافقة على ما تنتجه في نوفمبر.",
  },

  // ── INTEGRATIONS ─────────────────────────────────────────────────────────
  {
    slug: "myfatoorah",
    title: "MyFatoorah",
    titleAr: "ماي فاتورة",
    summary: "Accepting a customer payment against an invoice through a Saudi payment gateway.",
    summaryAr: "قبول دفعة من العميل مقابل فاتورة عبر بوابة دفع سعودية.",
    blocker: "cr",
    whenCleared: "🔴 UNCOSTED. Get the pricing before committing to it — the previous estimate turned out to describe a different feature entirely.",
    whenClearedAr: "🔴 التكلفة غير محسوبة. يجب معرفة التسعير قبل الالتزام — التقدير السابق تبيّن أنه يصف ميزة أخرى تمامًا.",
  },
  {
    slug: "sifi",
    title: "SiFi",
    titleAr: "سيفي",
    summary: "Corporate cards, expense management and vendor payments — money going OUT.",
    summaryAr: "بطاقات الشركات وإدارة المصروفات ومدفوعات الموردين — الأموال الخارجة.",
    blocker: "cr",
    whenCleared: "Sits beside bank connectivity (A2), not beside the payment gateways.",
    whenClearedAr: "يقع بجانب الربط البنكي، لا بجانب بوابات الدفع.",
    capabilityLive:
      "🔴 SiFi is NOT a payment gateway (owner correction, 2026-08-30). It is a SAMA-licensed EMI doing spend management, so the integration is OUTBOUND — it does not accept a customer payment against an invoice. Filing it with MyFatoorah would repeat the exact error this note exists to correct.",
    capabilityLiveAr:
      "🔴 سيفي ليست بوابة دفع (تصحيح من المالك بتاريخ 2026-08-30). هي مؤسسة نقد إلكتروني مرخَّصة من ساما تعمل في إدارة الإنفاق، فالتكامل صادر — ولا يقبل دفعة من عميل مقابل فاتورة.",
  },
  {
    slug: "email-providers",
    title: "Email delivery",
    titleAr: "إرسال البريد الإلكتروني",
    summary: "Sending invoices, reminders and alerts by email, with a verified sending domain.",
    summaryAr: "إرسال الفواتير والتذكيرات والتنبيهات بالبريد الإلكتروني عبر نطاق إرسال موثَّق.",
    blocker: "mailProvider",
    whenCleared: "The closest of these to real: the mailer is finished and tested. Choose a provider, verify the domain, set the three variables, and confirm one test message actually arrives. 🔴 An unwired alarm is precisely what the alerting work exists to prevent.",
    whenClearedAr: "الأقرب إلى الجاهزية: البريد مكتمل ومختبَر. يُختار المزوّد ويُوثَّق النطاق وتُضبط المتغيرات الثلاثة، ثم يُتأكَّد من وصول رسالة اختبار فعليًا. 🔴 التنبيه غير الموصول هو بالضبط ما وُجد نظام التنبيه لمنعه.",
  },

  // ── SETTINGS ─────────────────────────────────────────────────────────────
  {
    slug: "multi-currency",
    title: "Multi-currency",
    titleAr: "تعدد العملات",
    summary: "Invoicing and reporting in more than one currency, with exchange rates and revaluation.",
    summaryAr: "الفوترة وإعداد التقارير بأكثر من عملة، مع أسعار الصرف وإعادة التقييم.",
    blocker: "build",
    whenCleared: "🔴 Single currency is ENFORCED at the write boundary today, deliberately — not merely assumed. This is a real milestone with real accounting consequences (revaluation, realised and unrealised differences), not a settings toggle.",
    whenClearedAr: "🔴 العملة الواحدة مفروضة اليوم عند حدّ الكتابة عن قصد، لا مفترضة فحسب. وهذه مرحلة حقيقية بتبعات محاسبية حقيقية، لا مجرد مفتاح في الإعدادات.",
  },
  {
    slug: "password-reset",
    title: "Password reset",
    titleAr: "إعادة تعيين كلمة المرور",
    summary: "Recovering an account whose password has been lost.",
    summaryAr: "استعادة حساب فُقدت كلمة مروره.",
    blocker: "productDecision",
    whenCleared:
      "🔴 Rank 1 in the pre-production queue, and a DECISION not a build. Option A: self-service email reset — a moderate build, no new privilege, and a close template already exists in the invitation flow. Option B: operator reset — a small build that creates a standing cross-tenant takeover path, the exact shape of a security finding already fixed once. Option C: both. The owner chooses; the build follows in days either way.",
    whenClearedAr:
      "🔴 الأولوية الأولى في قائمة ما قبل الإنتاج، وهي قرار لا بناء. الخيار أ: إعادة تعيين ذاتية عبر البريد. الخيار ب: إعادة تعيين عبر مشغّل المنصة، وهي بناء صغير لكنه ينشئ مسار استيلاء دائم عبر المستأجرين. الخيار ج: كلاهما.",
    capabilityLive:
      "Changing a password you KNOW works today, at `/change-password`. What does not exist is recovery when it is forgotten.",
    capabilityLiveAr: "تغيير كلمة مرور تعرفها يعمل اليوم. غير الموجود هو الاستعادة عند نسيانها.",
  },
  {
    slug: "two-factor",
    title: "Two-factor authentication",
    titleAr: "التحقق بخطوتين",
    summary: "A second factor at sign-in, beyond the password.",
    summaryAr: "عامل تحقق ثانٍ عند تسجيل الدخول، إضافة إلى كلمة المرور.",
    blocker: "build",
    whenCleared: "Zero code. Sequence it after password recovery — a second factor with no recovery path locks people out permanently.",
    whenClearedAr: "لا توجد شيفرة. يُنفَّذ بعد استعادة كلمة المرور — عامل ثانٍ بلا مسار استعادة يحبس المستخدمين خارج حساباتهم نهائيًا.",
  },
  {
    slug: "session-management",
    title: "Session management",
    titleAr: "إدارة الجلسات",
    summary: "Seeing where you are signed in, and signing other devices out.",
    summaryAr: "معرفة أجهزة تسجيل دخولك، وإنهاء جلسات الأجهزة الأخرى.",
    blocker: "build",
    whenCleared: "Sessions are stored in Postgres already, so the data exists; what is missing is the surface and the revoke path.",
    whenClearedAr: "الجلسات مخزَّنة في قاعدة البيانات فعلًا، فالبيانات موجودة؛ الناقص هو الواجهة ومسار الإبطال.",
  },
  {
    slug: "ip-restrictions",
    title: "IP restrictions",
    titleAr: "تقييد عناوين IP",
    summary: "Limiting sign-in to known networks.",
    summaryAr: "قصر تسجيل الدخول على شبكات معروفة.",
    blocker: "build",
    whenCleared: "🔴 Depends on the proxy-count question being settled first (TRUST_PROXY_HOPS). A wrong hop count makes the client IP spoofable, and an IP allowlist built on a spoofable address is worse than none — it grants confidence it cannot support.",
    whenClearedAr: "🔴 يعتمد على حسم عدد الوسائط أولًا. فعدد خاطئ يجعل عنوان العميل قابلًا للانتحال، وقائمة سماح مبنية على عنوان قابل للانتحال أسوأ من عدمها.",
  },
  {
    slug: "notification-preferences",
    title: "Notification preferences",
    titleAr: "تفضيلات الإشعارات",
    summary: "Choosing what you are told about, and how.",
    summaryAr: "اختيار ما تُبلَّغ به، وكيف.",
    blocker: "mailProvider",
    whenCleared: "Preferences over a channel that cannot deliver would be a setting with no effect. Wire email first.",
    whenClearedAr: "تفضيلات فوق قناة لا تستطيع التسليم إعدادٌ بلا أثر. يُربط البريد أولًا.",
  },
  {
    slug: "dashboard-layout",
    title: "Dashboard layout",
    titleAr: "تخطيط لوحة التحكم",
    summary: "Arranging the dashboard around what you look at most.",
    summaryAr: "ترتيب لوحة التحكم حول ما تنظر إليه أكثر.",
    blocker: "build",
    whenCleared: "On the roadmap. Needs a per-user store for the arrangement, which nothing else needs yet — so the first piece of work is where that lives, not the drag-and-drop.",
    whenClearedAr: "مُدرج في خطة التطوير. يحتاج إلى مخزن لكل مستخدم يحفظ الترتيب، وهو ما لا تحتاجه أي ميزة أخرى بعد — فأول عمل مطلوب هو تحديد مكان حفظه، لا السحب والإفلات.",
  },
  {
    slug: "keyboard-shortcuts",
    title: "Keyboard shortcuts",
    titleAr: "اختصارات لوحة المفاتيح",
    summary: "Driving the common paths without the mouse.",
    summaryAr: "استخدام المسارات الشائعة دون الفأرة.",
    blocker: "build",
    whenCleared: "On the roadmap. 🔴 Whatever is chosen must work in both directions — a shortcut layout that assumes left-to-right is a bug in Arabic.",
    whenClearedAr: "مُدرج في خطة التطوير. 🔴 يجب أن يعمل في الاتجاهين — تخطيط اختصارات يفترض الكتابة من اليسار خللٌ في العربية.",
  },
  {
    slug: "data-export",
    title: "Data export",
    titleAr: "تصدير البيانات",
    summary: "Taking your data out of the platform in a portable form.",
    summaryAr: "إخراج بياناتك من المنصة بصيغة قابلة للنقل.",
    blocker: "pdpl",
    whenCleared: "🔴 Do NOT build ahead of the advisor. Export is entangled with erasure, and the questions are open: whether inbound third-party captures may be made erasable-with-audit without touching the ZATCA guarantee on documents we issued — two classes that today carry the identical no-delete promise.",
    whenClearedAr: "🔴 لا يُبنى قبل إجابة المستشار. التصدير متشابك مع المحو، والأسئلة مفتوحة: هل يمكن جعل المستندات الواردة من أطراف ثالثة قابلة للمحو مع التدقيق دون المساس بضمان الهيئة للمستندات التي أصدرناها.",
  },
  {
    slug: "billing-subscription",
    title: "Billing and subscription",
    titleAr: "الفوترة والاشتراك",
    summary: "Your plan, what it costs, and the invoices for it.",
    summaryAr: "باقتك، وتكلفتها، وفواتيرها.",
    blocker: "r1Billing",
    whenCleared: "🔴 R1 — the single most consequential gap in the platform: no billing means no revenue, whatever else works. For customer number one an off-platform invoice suffices; it stops sufficing quickly. AI usage is already metered, so the measurement half exists.",
    whenClearedAr: "🔴 R1 — أهم فجوة في المنصة: لا فوترة يعني لا إيراد، مهما عمل كل شيء آخر. للعميل الأول تكفي فاتورة خارج المنصة؛ لكنها تتوقف عن الكفاية سريعًا.",
  },
  {
    slug: "system-administration",
    title: "System",
    titleAr: "النظام",
    summary: "API keys, webhooks, a health check and system logs.",
    summaryAr: "مفاتيح الواجهة البرمجية، وخطّافات الويب، وفحص الصحة، وسجلات النظام.",
    blocker: "build",
    whenCleared: "A health endpoint exists (`/api/healthz`) with no surface; the rest is zero code. 🔴 API keys in particular are a security design, not a screen — a key is a credential that bypasses the session boundary every guard is built on.",
    whenClearedAr: "توجد نقطة فحص صحة بلا واجهة؛ والباقي بلا شيفرة. 🔴 مفاتيح الواجهة البرمجية تحديدًا تصميم أمني لا شاشة — فالمفتاح بيانات اعتماد تتجاوز حدّ الجلسة الذي تقوم عليه كل الحراسات.",
  },
  {
    slug: "my-profile",
    title: "My profile",
    titleAr: "ملفي الشخصي",
    summary: "Your own name, contact details and personal settings.",
    summaryAr: "اسمك وبيانات التواصل وإعداداتك الشخصية.",
    blocker: "build",
    whenCleared: "Zero code. Small, and genuinely unblocked.",
    whenClearedAr: "لا توجد شيفرة. صغير وغير معوَّق فعلًا.",
  },
  {
    slug: "assignments",
    title: "Assignments",
    titleAr: "المهام المسندة",
    summary: "Work assigned to you specifically, as opposed to everything awaiting anyone.",
    summaryAr: "العمل المسند إليك تحديدًا، لا كل ما ينتظر أي شخص.",
    blocker: "build",
    whenCleared: "Approvals exist and show what awaits ANYONE with the authority. Per-person assignment is a different model and needs deciding before building.",
    whenClearedAr: "الموافقات موجودة وتعرض ما ينتظر أي شخص لديه الصلاحية. أما الإسناد لشخص بعينه فنموذج مختلف يحتاج قرارًا قبل البناء.",
  },
];

const BY_SLUG = new Map(COMING_SOON.map(e => [e.slug, e]));

export function comingSoonEntry(slug: string): ComingSoonEntry | undefined {
  return BY_SLUG.get(slug);
}

export function comingSoonHref(slug: string): string {
  return `/coming-soon/${slug}`;
}
