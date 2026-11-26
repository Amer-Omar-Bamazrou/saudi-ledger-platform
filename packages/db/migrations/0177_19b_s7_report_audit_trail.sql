-- 19B 19.18 — report audit entries carry their company and the id of the request that wrote them; the same request
-- cannot record the same act twice (the unique key below, where a request id is given). Additive: two nullable
-- columns and one partial index; rows already written are untouched and stay NULL.
ALTER TABLE "audit_logs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_request_event_unq" ON "audit_logs" USING btree ("organization_id","request_id","action","entity_type","entity_id") WHERE request_id is not null;