/**
 * 🔴 19B S3 (v4 §6.3, D2): a supplier's or an employee's IBAN is HELD at entry and on every change until an accountant
 * or admin who did not enter it approves it. A fixture that needs the IBAN IN PLACE goes through that hold the way the
 * product does — this approves every held supplier and employee IBAN of the approver's company, AS that approver, over
 * HTTP — rather than writing the column directly (the database refuses that: party_iban_hold, 0170).
 */
type Api = (who: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

const CHANGES = "/companies/current/bank-detail-changes";

export async function approveHeldIbans(h: { api: Api }, approver: string): Promise<number> {
  const list = await h.api(approver, "GET", CHANGES);
  if (list.status !== 200) throw new Error(`approveHeldIbans: listing as ${approver} answered ${list.status}`);
  let approved = 0;
  for (const c of list.body.items as { id: number; kind: string; status: string }[]) {
    if (c.status !== "pending" || (c.kind !== "vendor_iban" && c.kind !== "employee_iban")) continue;
    const r = await h.api(approver, "PUT", `${CHANGES}/${c.id}/decision`, { decision: "approve" });
    if (r.status !== 200) throw new Error(`approveHeldIbans: ${approver} could not approve request ${c.id}: ${r.status} ${JSON.stringify(r.body)}`);
    approved += 1;
  }
  return approved;
}
