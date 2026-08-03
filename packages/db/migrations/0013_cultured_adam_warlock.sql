-- M11.4 · Verification document metadata (bytes live in a private Supabase Storage bucket).
-- Owner-only identity-layer table: NO RLS and NO app-role grants (the /onboarding +
-- /operator surfaces read/write it on the base connection before resolveTenant). The
-- RLS app role cannot touch it — a DB boundary test asserts this. All document I/O
-- is brokered through the API; the service-role key never reaches the browser.
CREATE TABLE "verification_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" varchar(30) NOT NULL,
	"storage_path" varchar(512) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_documents_org_idx" ON "verification_documents" USING btree ("organization_id");