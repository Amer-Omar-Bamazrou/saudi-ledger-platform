-- ═══════════════════════════════════════════════════════════════════════════
-- G04 (pre-Phase-18 hardening, owner-approved 2026-10-07): A REFERENCE FROM A
-- TENANT ROW TO ANOTHER TENANT ROW CARRIES THE ORGANIZATION IN ITS KEY.
-- Record: docs/security-g04-tenant-keys.md.
--
-- Postgres checks a foreign key OUTSIDE row-level security. So the plain key
-- `journal_entry_lines.account_id → categories.id` accepted ANOTHER tenant's
-- account — the manual journal wrote it, approved it and POSTED it — and failed
-- a missing id as a raw 23503, an existence oracle. Keyed WITH the organization,
-- `(organization_id, account_id) → categories (organization_id, id)`, the
-- database compares the tenant itself, for every writer under RLS or not, and a
-- foreign id and a missing id become the same failure.
--
-- Six references, the ones the G04 investigation proved (or that the posting
-- seam could carry):
--   journal_entry_lines.account_id   → categories   (organization)
--   journal_entry_lines.customer_id  → customers    (organization)
--   journal_entry_lines.vendor_id    → vendors      (organization)
--   invoice_items.product_id         → products     (organization)
--   fixed_assets.custodian_user_id   → organization_memberships — the custodian
--       holds a membership IN THE ASSET'S ORGANIZATION (any status: whether an
--       inactive member may stay custodian is an open owner decision); it
--       replaces the plain key to `users`
--   bills.capitalises_asset_id       → fixed_assets (organization AND company;
--       it had no key at all)
-- Accounts, customers, vendors and products stay ORGANIZATION-level: every
-- company of the organization references them, exactly as before.
--
-- 🔴 THIS MIGRATION REPAIRS, REWRITES AND DELETES NOTHING. It first counts the
-- rows that would violate each new key and REFUSES TO APPLY, naming the counts,
-- if any exist — such a row needs an owner's decision, never a migration's.
-- Each key is then added NOT VALID and VALIDATED in the same transaction, so no
-- key is left checking only new rows.
--
-- `categories` gains a constraint, not a column, so `seed_org_chart_of_accounts()`
-- (which copies template columns by name) needs no redefinition here.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  jel_account  bigint;
  jel_customer bigint;
  jel_vendor   bigint;
  item_product bigint;
  custodian    bigint;
  capitalises  bigint;
BEGIN
  SELECT count(*) INTO jel_account FROM journal_entry_lines l
   WHERE l.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.organization_id = l.organization_id AND c.id = l.account_id);
  SELECT count(*) INTO jel_customer FROM journal_entry_lines l
   WHERE l.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.organization_id = l.organization_id AND c.id = l.customer_id);
  SELECT count(*) INTO jel_vendor FROM journal_entry_lines l
   WHERE l.vendor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vendors v WHERE v.organization_id = l.organization_id AND v.id = l.vendor_id);
  SELECT count(*) INTO item_product FROM invoice_items i
   WHERE i.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.organization_id = i.organization_id AND p.id = i.product_id);
  SELECT count(*) INTO custodian FROM fixed_assets a
   WHERE a.custodian_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id = a.organization_id AND m.user_id = a.custodian_user_id);
  SELECT count(*) INTO capitalises FROM bills b
   WHERE b.capitalises_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fixed_assets a WHERE a.organization_id = b.organization_id AND a.company_id = b.company_id AND a.id = b.capitalises_asset_id);
  IF jel_account + jel_customer + jel_vendor + item_product + custodian + capitalises > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format(
        '0122 refuses to apply: rows reference a row outside their organization (or a missing one) — '
        'journal_entry_lines.account_id %s, .customer_id %s, .vendor_id %s; invoice_items.product_id %s; '
        'fixed_assets.custodian_user_id (no membership in the asset''s organization) %s; '
        'bills.capitalises_asset_id (not an asset of the bill''s own company) %s.',
        jel_account, jel_customer, jel_vendor, item_product, custodian, capitalises),
      HINT = 'Nothing was changed. This migration repairs and deletes nothing; each row needs an owner''s decision (docs/security-g04-tenant-keys.md).';
  END IF;
END $$;
--> statement-breakpoint

-- ── The targets: (organization_id, id) is unique because id already is. ──────
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_org_company_id_unq" UNIQUE("organization_id","company_id","id");--> statement-breakpoint

-- ── The plain keys the composite ones replace (same column, same ON DELETE). ──
-- `jel_customer_fk` / `jel_vendor_fk` were written by hand in 0066 and never
-- declared in the schema; they go the same way.
ALTER TABLE "journal_entry_lines" DROP CONSTRAINT "journal_entry_lines_account_id_categories_id_fk";--> statement-breakpoint
ALTER TABLE "journal_entry_lines" DROP CONSTRAINT "jel_customer_fk";--> statement-breakpoint
ALTER TABLE "journal_entry_lines" DROP CONSTRAINT "jel_vendor_fk";--> statement-breakpoint
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_product_id_products_id_fk";--> statement-breakpoint
-- The custodian's plain key to `users` (a platform identity with no tenant key)
-- is REPLACED by the membership key: a membership's user exists by the
-- membership's own key, so a missing user and another tenant's are one failure.
ALTER TABLE "fixed_assets" DROP CONSTRAINT "fixed_assets_custodian_user_id_users_id_fk";--> statement-breakpoint

-- ── The tenant-keyed references. ─────────────────────────────────────────────
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_tenant_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."categories"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_customer_tenant_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_vendor_tenant_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
-- 🔴 SET NULL with a COLUMN LIST: deleting a product clears product_id only. A
-- plain SET NULL would null organization_id too, and the delete would fail.
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_product_tenant_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE SET NULL ("product_id") ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_custodian_member_fk" FOREIGN KEY ("custodian_user_id","organization_id") REFERENCES "public"."organization_memberships"("user_id","organization_id") ON DELETE SET NULL ("custodian_user_id") ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_capitalises_asset_tenant_fk" FOREIGN KEY ("organization_id","company_id","capitalises_asset_id") REFERENCES "public"."fixed_assets"("organization_id","company_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint

-- ── Validated now: no key is left checking only new rows. ────────────────────
ALTER TABLE "journal_entry_lines" VALIDATE CONSTRAINT "journal_entry_lines_account_tenant_fk";--> statement-breakpoint
ALTER TABLE "journal_entry_lines" VALIDATE CONSTRAINT "journal_entry_lines_customer_tenant_fk";--> statement-breakpoint
ALTER TABLE "journal_entry_lines" VALIDATE CONSTRAINT "journal_entry_lines_vendor_tenant_fk";--> statement-breakpoint
ALTER TABLE "invoice_items" VALIDATE CONSTRAINT "invoice_items_product_tenant_fk";--> statement-breakpoint
ALTER TABLE "fixed_assets" VALIDATE CONSTRAINT "fixed_assets_custodian_member_fk";--> statement-breakpoint
ALTER TABLE "bills" VALIDATE CONSTRAINT "bills_capitalises_asset_tenant_fk";
