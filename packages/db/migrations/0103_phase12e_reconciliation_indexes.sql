-- PHASE 12E — the reconciliation reads name a cash line's document by its
-- entry (payments, refunds, bill and supplier payments): one index each, so
-- that lookup is not a sequential scan per cash line. Found by the full
-- browser run at volume. Record: phase-12 decision pack §7.
CREATE INDEX "supplier_payments_entry_idx" ON "supplier_payments" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "supplier_refunds_entry_idx" ON "supplier_refunds" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "bill_payments_entry_idx" ON "bill_payments" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "customer_refunds_entry_idx" ON "customer_refunds" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "payments_entry_idx" ON "payments" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "payments_source_transaction_idx" ON "payments" USING btree ("source_transaction_id");