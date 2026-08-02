-- M11.1 · Security-audit log — the actor-centric identity/security trail, kept
-- SEPARATE from the tenant-scoped business `audit_logs`.
--
-- Deliberately DIFFERENT posture from the business tables:
--   * organization_id is NULLABLE (global events — user created, password reset —
--     carry no org; membership/verification events set it).
--   * NO Row-Level Security and NO grants to the app role (`authenticated`). This
--     table is written and read ONLY on the base/owner connection by the identity
--     layer (securityAuditService), which runs BEFORE resolveTenant. Granting the
--     app role nothing keeps it entirely off the RLS/tenant-scoped path — the app
--     role cannot even SELECT it (asserted by a DB boundary test). The owner
--     retains full control for legitimate retention/legal purposes.
--   * Append-only by construction: the service exposes only insert + read; there
--     is no update/delete code path.
CREATE TABLE "security_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" integer,
	"actor_email" varchar(320),
	"organization_id" uuid,
	"target_user_id" integer,
	"action" varchar(100) NOT NULL,
	"metadata" jsonb,
	"ip_address" varchar(45),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_audit_logs" ADD CONSTRAINT "security_audit_logs_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_audit_logs_org_idx" ON "security_audit_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "security_audit_logs_actor_idx" ON "security_audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "security_audit_logs_created_idx" ON "security_audit_logs" USING btree ("created_at");