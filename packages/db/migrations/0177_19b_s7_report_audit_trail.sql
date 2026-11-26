-- 19B 19.18 — a report audit entry carries the id of the request that wrote it; the same request cannot record the
-- same act twice (the unique key below, where a request id is given). Additive: one nullable column and one partial
-- index; rows already written are untouched and stay NULL. The trail stays organization-wide (no company column).
ALTER TABLE "audit_logs" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_request_event_unq" ON "audit_logs" USING btree ("organization_id","request_id","action","entity_type","entity_id") WHERE request_id is not null;