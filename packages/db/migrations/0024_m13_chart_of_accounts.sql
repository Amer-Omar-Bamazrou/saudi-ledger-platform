ALTER TABLE "categories" ADD COLUMN "system_code" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_system_code_unq" ON "categories" USING btree ("organization_id","system_code");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M13 — seed the system chart of accounts, and BACKFILL every existing org
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 THIS MUST RUN FOR EXISTING ORGANIZATIONS, not only new ones.
--
-- Before M13 `categories` was empty in live databases and NOTHING ever created
-- a row — not the seed, not signup, not org creation. So every current tenant
-- has zero accounts. A seed that fired only at org creation would leave all of
-- them unresolvable, and the fail-closed posting path would then reject their
-- very next invoice. This block is what makes the fail-closed guard unreachable
-- in normal operation rather than a landmine.
--
-- Idempotent via `categories_org_system_code_unq`: safe to re-run, and safe if
-- `seedChartOfAccounts()` has already run for some orgs.
--
-- ⚠️ These values DUPLICATE `packages/db/src/chartOfAccounts.ts` — SQL cannot
-- call TypeScript. `chart-of-accounts.test.ts` asserts the database and the TS
-- definition agree, so the duplication cannot drift silently.
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant)
SELECT o.id, a.name, a.name_ar, a.type, a.code, true, a.vat_applicable, false
  FROM organizations o
 CROSS JOIN (VALUES
  ('AR', 'Accounts Receivable', 'الذمم المدينة', 'asset', false),
  ('CASH', 'Cash and Bank', 'النقد والبنك', 'asset', false),
  ('VAT_INPUT', 'Input VAT Receivable', 'ضريبة القيمة المضافة على المشتريات', 'asset', false),
  ('AP', 'Accounts Payable', 'الذمم الدائنة', 'liability', false),
  ('VAT_OUTPUT', 'VAT Payable', 'ضريبة القيمة المضافة المستحقة', 'liability', false),
  ('SALARIES_PAYABLE', 'Salaries Payable', 'الرواتب المستحقة', 'liability', false),
  ('GOSI_PAYABLE', 'GOSI Payable', 'التأمينات الاجتماعية المستحقة', 'liability', false),
  ('SALES', 'Sales Revenue', 'إيرادات المبيعات', 'income', true),
  ('PURCHASES', 'Purchases', 'المشتريات', 'expense', true),
  ('SALARIES', 'Salaries and Wages Expense', 'مصروف الرواتب والأجور', 'expense', false),
  ('GOSI_EXPENSE', 'GOSI Expense - Employer', 'مصروف التأمينات - حصة صاحب العمل', 'expense', false)) AS a(code, name, name_ar, type, vat_applicable)
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M13 — backfill account_id on every pre-existing GL line
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every automated GL line ever written has account_id = NULL, which is why the
-- income statement filed Sales Revenue CREDITS as negative expenses.
--
-- Deterministic: the account names below are a CLOSED SET emitted by our own
-- posting code, not user input. A hand-typed manual-JE line whose name happens
-- to match is mapped too — correct, because it means the same account.
--
-- 🔴 HISTORICAL STATEMENTS CHANGE HERE. Revenue and expense figures on past
-- income statements will move; NET PROFIT WILL NOT. Same bottom line, different
-- composition. This corrects a display defect; it does not restate results.
--
-- Lines matching no known name keep account_id = NULL and stay unclassified,
-- exactly as today.
UPDATE "journal_entry_lines" l
   SET account_id = c.id
  FROM "categories" c, (VALUES
  ('Accounts Receivable', 'AR'),
  ('Cash and Bank', 'CASH'),
  ('Cash', 'CASH'),
  ('Input VAT Receivable', 'VAT_INPUT'),
  ('Accounts Payable', 'AP'),
  ('VAT Payable', 'VAT_OUTPUT'),
  ('Salaries Payable', 'SALARIES_PAYABLE'),
  ('GOSI Payable', 'GOSI_PAYABLE'),
  ('Sales Revenue', 'SALES'),
  ('Purchases', 'PURCHASES'),
  ('Office Expense', 'PURCHASES'),
  ('Salaries and Wages Expense', 'SALARIES'),
  ('GOSI Expense - Employer', 'GOSI_EXPENSE')) AS m(legacy_name, code)
 WHERE l.account_id IS NULL
   AND l.account_name = m.legacy_name
   AND c.organization_id = l.organization_id
   AND c.system_code = m.code;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M13 — protect system accounts in the DATABASE, not by convention
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The posting path resolves by `system_code` and every financial statement
-- buckets by `type`. Deleting a system account, clearing its code, or changing
-- its type would break classification for the whole organization — and the
-- posting path would then fail closed on the tenant's next invoice.
--
-- There is no category update/delete ENDPOINT today, so this guards against the
-- future route rather than a present hole. That is deliberate: the same
-- discipline as `audit_logs` and `einvoice_archive` — enforce it where it cannot
-- be bypassed, so a later feature cannot quietly reintroduce the problem.
--
-- `name` and `name_ar` stay freely editable. The CODE is the identity; the name
-- is a label, and tenants must be able to rename and translate their accounts.
CREATE OR REPLACE FUNCTION protect_system_categories() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'Cannot delete system account % (%). The posting path and every financial statement depend on it.', OLD.name, OLD.system_code
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_system THEN
    IF NEW.type IS DISTINCT FROM OLD.type THEN
      RAISE EXCEPTION 'Cannot change the type of system account % (% -> %). Financial statements bucket by type.', OLD.system_code, OLD.type, NEW.type
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.system_code IS DISTINCT FROM OLD.system_code THEN
      RAISE EXCEPTION 'Cannot change the system_code of a system account (% -> %).', OLD.system_code, NEW.system_code
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
      RAISE EXCEPTION 'Cannot un-flag a system account (%).', OLD.system_code
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS protect_system_categories_trg ON "categories";--> statement-breakpoint
CREATE TRIGGER protect_system_categories_trg
  BEFORE UPDATE OR DELETE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION protect_system_categories();
