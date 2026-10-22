-- 🔴 G36-KEY (Phase 18, authorisation §2.10 / plan B-G36-KEY) — the bill-payment idempotency key.
--
-- `PaymentInput.idempotencyKey` is promised by the spec ("unique per company; the same key twice records
-- one payment") and was never read by the bill pay path: the same key twice recorded two payments
-- (reproduced, Batch 4B). Two nullable columns, a partial unique index per company, and a CHECK pairing a
-- key with its request fingerprint.
--
-- Forward-only. PRE-CHECK: none is needed, and that is stated rather than omitted — both columns are new,
-- so they are NULL on every existing row; the index covers only non-NULL keys and the CHECK admits NULL,
-- so no existing row can violate either. Nothing is back-filled. ROLLBACK: revert the code; the columns
-- stay, unused (a payment made without a key is unchanged in every respect).
--
-- Numbering: the plan pencilled this as 0123; DR-45 (II) took 0123 first (drizzle applies by `when`).
ALTER TABLE "bill_payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_payments_idempotency_unq" ON "bill_payments" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_idempotency_key_chk" CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 120 AND request_fingerprint IS NOT NULL));