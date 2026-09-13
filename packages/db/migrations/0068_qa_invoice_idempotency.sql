-- QA fix (2026-09-04): invoice-create idempotency — a double-click / retry /
-- slow-network resend must not mint a duplicate draft (which then mints a
-- second ZATCA ICV on approval). The client sends one key per dialog open;
-- the partial unique index makes the duplicate INEXPRESSIBLE, and the
-- service resolves the collision to the first invoice.
ALTER TABLE "invoices" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_company_idempotency_unq" ON "invoices" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;
