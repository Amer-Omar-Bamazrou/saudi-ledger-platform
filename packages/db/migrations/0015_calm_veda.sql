-- M11.7 · Organization invitations.
--
-- Owner-only identity-layer table: NO RLS and NO grants to the app role. The
-- /orgs/:orgId/invitations endpoints and the PUBLIC token-authenticated accept
-- endpoint all run on the base connection before resolveTenant.
--
-- Only the SHA-256 of the token is stored (token_hash) — the raw token exists
-- solely in the invite link, so a DB leak yields no usable invites.
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" varchar(50) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"invited_by_user_id" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"accepted_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_invitations_org_idx" ON "organization_invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations" USING btree ("email");--> statement-breakpoint
-- At most ONE live invitation per (organization, email). A partial index is used
-- so that revoked/expired/accepted rows are retained as history and do not block
-- re-inviting the same person. (Drizzle cannot express a partial unique index,
-- so it is declared here by hand.)
CREATE UNIQUE INDEX "organization_invitations_pending_unq"
  ON "organization_invitations" ("organization_id", "email")
  WHERE "status" = 'pending';
