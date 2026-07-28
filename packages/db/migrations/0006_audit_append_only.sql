-- M7 · Make audit_logs append-only for the application role.
--
-- The audit trail must be tamper-resistant: the app role (which every request
-- runs as, via SET LOCAL ROLE) may INSERT and SELECT audit rows but must never
-- UPDATE or DELETE them. Migration 0004 granted full DML on audit_logs; revoke
-- the mutating privileges here. The table owner (postgres) retains full control
-- for legitimate retention/legal deletion out-of-band.
REVOKE UPDATE, DELETE ON "audit_logs" FROM authenticated;
