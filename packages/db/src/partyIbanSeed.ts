/**
 * 🔴 19B S3 (v4 §6.3 and §13.3; owner 2026-11-23): a raw-row seed gives a supplier or an employee an IBAN the way the
 * product does — a HELD change, requested by one member, then approved by another member who can approve bank details,
 * who writes the IBAN in the approval's own transaction. The demo seed (`scripts/src/demo-seed.mts`) calls this for its
 * suppliers, approved by its demo accountant: the normal path, not the fallback.
 *
 * Nothing is bypassed — no replica mode, no write the product does not also make. The database decides as it does for
 * the product (migration 0170): the request names the connection's declared actor; the approver must hold
 * `bank_detail:approve`, must not be the requester, and must not be linked to them (A1); the IBAN changes only beside a
 * request decided in that transaction by the acting approver. A refused approval throws, and the request it was for
 * stays recorded, pending — as a refused approval in the product leaves it.
 *
 * Two transactions, as in the product: the request in the requester's, the decision and the write in the approver's.
 * The caller owns `client` (an owner connection) and releases it.
 */
import type { PoolClient } from "pg";

export interface PartyIbanSeed {
  kind: "vendor_iban" | "employee_iban";
  organizationId: string;
  companyId: string;
  /** The supplier's or employee's id. */
  subjectId: number;
  /** Stored normalised (as the product stores it): upper case, no spaces. */
  iban: string;
  requestedBy: number;
  approvedBy: number;
  /** The IBAN came with the record — its first (the change-then-pay finding leaves such an IBAN out, v4 §13.2). */
  atCreation: boolean;
}

async function asActor<T>(client: PoolClient, userId: number, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(userId)]);
    const out = await work();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Requests the IBAN as `requestedBy`, then approves and writes it as `approvedBy`. Returns the request's id. */
export async function seedPartyIbanThroughHold(client: PoolClient, s: PartyIbanSeed): Promise<number> {
  const table = s.kind === "vendor_iban" ? "vendors" : "employees";
  const subject = s.kind === "vendor_iban" ? "vendor_id" : "employee_id";
  const requestId = await asActor(client, s.requestedBy, async () => {
    const found = await client.query(`SELECT iban FROM ${table} WHERE id = $1 AND organization_id = $2`, [s.subjectId, s.organizationId]);
    if (found.rowCount !== 1) throw new Error(`seedPartyIbanThroughHold: ${table} ${s.subjectId} is not in organization ${s.organizationId}`);
    const r = await client.query(
      `INSERT INTO bank_detail_change_requests (organization_id, company_id, kind, ${subject}, iban_before, iban_after, requested_by, at_creation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [s.organizationId, s.companyId, s.kind, s.subjectId, found.rows[0].iban ?? null, s.iban, s.requestedBy, s.atCreation],
    );
    return r.rows[0].id as number;
  });
  await asActor(client, s.approvedBy, async () => {
    await client.query(`UPDATE bank_detail_change_requests SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2`, [s.approvedBy, requestId]);
    await client.query(`UPDATE ${table} SET iban = $1 WHERE id = $2 AND organization_id = $3`, [s.iban, s.subjectId, s.organizationId]);
  });
  return requestId;
}
