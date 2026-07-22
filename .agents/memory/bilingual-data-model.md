---
name: Bilingual Data Model
description: Full EN/AR schema migration, language toggle, Arabic script detection, and report wiring decisions
---

## Migration (completed July 2026)
- Single `BEGIN/COMMIT` SQL against live DB: backfill sentinel + NOT NULL + DEFAULT on vendors, customers, products, employees (name_ar + job_title_ar), fixed_assets, invoice_items.description_ar; ADD COLUMN name_ar on budgets.
- Backup at `/tmp/pre_bilingual_migration_20260720_081734.dump` (67 KB) taken before run.
- Sentinel value: `(not yet translated)` — used as NOT NULL default for all Arabic fields.

## Drizzle Schema
- All 7 schema files updated: `text("name_ar").notNull().default("(not yet translated)")`.
- `budgets.ts` was the only file that needed ADD COLUMN (others already had nullable name_ar columns).

## LanguageContext
- File: `artifacts/bookkeeping/src/contexts/LanguageContext.tsx`
- `useLanguage()` exposes `{ lang, setLang, t, n, isAr }`.
- `n(en, ar)` — picks ar if lang=ar AND ar is non-empty AND ar ≠ sentinel; else falls back to en.
- `t(en, ar)` — picks UI label by lang.
- Persisted to `localStorage("ksa_lang")`. Sets `document.documentElement.dir` + `lang` on change.
- Wrapped around `<AuthProvider>` inside `<WouterRouter>` in App.tsx.

## Language Toggle
- In Layout.tsx sidebar footer — button labeled `ع` (→ switch to AR) or `EN` (→ switch to EN).
- Active language highlighted with `border-primary/50 text-primary bg-primary/10`.

## Arabic Script Detection Utility
- File: `artifacts/bookkeeping/src/lib/arabicUtils.ts`
- `arabicFieldStatus(value)` → "needs-translation" | "wrong-script" | "ok".
- "wrong-script": value is non-empty, non-sentinel, but < 10% Arabic chars in U+0600–U+06FF.
- Applied in Vendors.tsx and Customers.tsx list-view table cells for the nameAr column.
- Customer row 1 (`name_ar = "amr mr"`) correctly triggers "wrong-script" badge.

## Receipt Parser Arabic Detection
- `ParsedReceipt` now has `vendorNameAr?: string`.
- `arabicRatio()` helper inside `receiptParser.ts` — counts U+0600–U+06FF chars.
- ≥70% Arabic → whole line is Arabic name (vendorNameAr); looks for English line separately.
- 10–69% Arabic → split bilingual line by script boundary.
- < 10% Arabic → purely English, vendorNameAr undefined.
- ScanReview.tsx passes `nameAr: fields.vendorNameAr` when creating a new vendor from a scan.

## Report Name Resolution
**API (reports.ts):**
- Trial Balance: rows now include `nameAr` (from catMap lookup).
- Income Statement / Balance Sheet: already had nameAr before this session.
- General Ledger: movements now include `accountNameAr`; response includes `accountNameAr`.
- AR Aging: items include `customerNameAr`.
- AP Aging: items include `vendorNameAr`.

**Frontend:**
- TrialBalance.tsx: `n(row.name, row.nameAr)` — also hides Arabic subtitle in AR mode to avoid duplication.
- IncomeStatement.tsx: `n(r.name, r.nameAr)` / `n(e.name, e.nameAr)`.
- BalanceSheet.tsx: `Section` component calls `useLanguage()` + uses `n(r.name, r.nameAr)`.
- GeneralLedger.tsx: `n(data.accountName, data.accountNameAr)` in stat card.
- AgingReports.tsx: `nameArKey` companion to `nameKey`; uses `n(item[nameKey], item[nameArKey])`.

**Why:**
Hooks must be called at top of component, not inside JSX or callbacks. TrialBalance and GeneralLedger had violations fixed by hoisting `const { n, lang } = useLanguage()` to component body.

## Budgets Form
- Added `nameAr: ""` to emptyForm + Arabic input with `dir="rtl"` + "needs Arabic translation" badge in table.
- DB column added via migration; schema file updated.
