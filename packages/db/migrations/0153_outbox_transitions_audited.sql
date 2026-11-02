-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-9 — DR-22, finished (memo §2b; register §11.106): every ZATCA
--    outbox TRANSITION is recorded in the audit trail, by the database.
--  · An AFTER UPDATE trigger on einvoice_documents, firing when `status` or
--    `ambiguous` changes, writes one audit_logs row: action `transition`,
--    entity `einvoice_document`. Before: status, ambiguous, attempt count.
--    After: those, ZATCA's status, the next attempt time, the claiming worker,
--    ZATCA's errors as returned, the invoice and the flow.
--  · NEVER the signed or cleared XML, a hash-chain value, or a credential.
--  · The user is the connection's declared actor (T1b's column default): none
--    for the worker, which runs outside any request.
--  · A trigger, not code: the outbox's four writers (claim, reclaim, accept,
--    fail) and any later one are recorded alike. Queuing the document (the
--    INSERT) is not recorded here — the invoice's approval already is.
-- New function and trigger; no existing row is read or changed. The pre-check
-- refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'einvoice_document_transition_audited') THEN
    RAISE EXCEPTION 'pre-check REFUSED: einvoice_document_transition_audited() already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'einvoice_documents_transition_audit_trg') THEN
    RAISE EXCEPTION 'pre-check REFUSED: einvoice_documents_transition_audit_trg already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: neither the function nor the trigger exists yet';
END $$;--> statement-breakpoint
CREATE FUNCTION einvoice_document_transition_audited() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (
    NEW.organization_id, 'transition', 'einvoice_document', NEW.id::text,
    jsonb_build_object('status', OLD.status, 'ambiguous', OLD.ambiguous, 'attemptCount', OLD.attempt_count),
    jsonb_build_object(
      'status', NEW.status, 'ambiguous', NEW.ambiguous, 'attemptCount', NEW.attempt_count,
      'zatcaStatus', NEW.zatca_status, 'nextAttemptAt', NEW.next_attempt_at, 'claimedBy', NEW.claimed_by,
      'errors', NEW.last_error, 'invoiceId', NEW.invoice_id, 'flow', NEW.flow
    )
  );
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER einvoice_documents_transition_audit_trg
  AFTER UPDATE OF status, ambiguous ON "einvoice_documents"
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.ambiguous IS DISTINCT FROM NEW.ambiguous)
  EXECUTE FUNCTION einvoice_document_transition_audited();
