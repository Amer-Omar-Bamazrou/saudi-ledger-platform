/** Universal draft/approval workflow (M10.2) — the generic seam every financial
 * entity reuses. See {@link approvable} for the contract and
 * {@link approval.service} for the state machine. */
export type { Approvable, ApprovalState, ApprovalActor } from "./approvable";
export { approvalService } from "./approval.service";
