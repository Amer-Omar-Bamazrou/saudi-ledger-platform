ALTER TABLE "transactions" ADD COLUMN "settles_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "settles_bill_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_settles_invoice_id_invoices_id_fk" FOREIGN KEY ("settles_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_settles_bill_id_bills_id_fk" FOREIGN KEY ("settles_bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- M16.3 hand-written half — settlement-link integrity (design §3)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A row settles at most ONE document. Both links set at once would mean one
-- bank movement paid a customer invoice AND a vendor bill — nonsense the
-- service should never produce, pinned at the DB so a future code path cannot
-- produce it silently either.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_settles_one_document"
  CHECK (NOT ("settles_invoice_id" IS NOT NULL AND "settles_bill_id" IS NOT NULL));
