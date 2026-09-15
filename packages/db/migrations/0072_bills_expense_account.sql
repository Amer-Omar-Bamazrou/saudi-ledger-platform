-- THE EXPENSE ACCOUNT LIVES ON THE BILL (2026-09-15, workflow audit W2 G1).
-- It used to exist only in the post request's body, so a bill approved from
-- the Approvals queue (which sends no body) always posted to Purchases.
-- Nullable: the seeded default applies when neither the bill nor the body
-- names an account. Set-null on account delete keeps the bill postable.
ALTER TABLE "bills" ADD COLUMN "expense_account_id" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_expense_account_id_categories_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;