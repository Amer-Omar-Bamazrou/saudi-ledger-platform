-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-8 — G37/G40, memo §2e (register §11.104): idempotency keys on
--    allocate, credit-note apply and refund, customer and supplier side, by
--    #217's one implementation (lib/idempotency): the key and a request
--    fingerprint on the effect row, a CHECK pairing them, a partial unique
--    index per COMPANY and OPERATION.
--  · supplier_payment_allocations, supplier_refunds: the key (dropped in 0098)
--    and the fingerprint, new; their CHECKs bind at once (every row is NULL).
--  · payment_allocations, customer_refunds: the fingerprint, new; their CHECKs
--    are added NOT VALID — keyed rows recorded before carry no fingerprint and
--    are NOT repaired (data repair is a memo stop). The CHECK binds every row
--    written from now; such a prior is refused by the service, never replayed.
--  · Operation scope: the two shared tables' unique indexes become
--    (company_id, <a credit note's application?>, idempotency_key). The new
--    customer index is created BEFORE the old one is dropped, so uniqueness
--    never lapses; it is less strict than the old one, so it cannot fail.
-- No existing row is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND ((table_name IN ('supplier_payment_allocations', 'supplier_refunds') AND column_name IN ('idempotency_key', 'request_fingerprint'))
                OR (table_name IN ('payment_allocations', 'customer_refunds') AND column_name = 'request_fingerprint'))) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a column 0152 adds already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname IN ('payment_allocations_idempotency_op_unq', 'supplier_payment_allocations_idempotency_op_unq', 'supplier_refunds_idempotency_unq')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: an index 0152 creates already exists; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'payment_allocations_idempotency_unq') THEN
    RAISE EXCEPTION 'pre-check REFUSED: payment_allocations_idempotency_unq (the index 0152 replaces) is missing; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: none of 0152''s objects exist yet; the index it replaces does';
END $$;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_idempotency_op_unq" ON "payment_allocations" USING btree ("company_id",(credit_note_id IS NOT NULL),"idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
DROP INDEX "payment_allocations_idempotency_unq";--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_allocations_idempotency_op_unq" ON "supplier_payment_allocations" USING btree ("company_id",(supplier_credit_note_id IS NOT NULL),"idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_refunds_idempotency_unq" ON "supplier_refunds" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_idempotency_key_chk" CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 120 AND request_fingerprint IS NOT NULL));--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_idempotency_key_chk" CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 120 AND request_fingerprint IS NOT NULL));--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_idempotency_key_chk" CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 120 AND request_fingerprint IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_idempotency_key_chk" CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 120 AND request_fingerprint IS NOT NULL)) NOT VALID;
