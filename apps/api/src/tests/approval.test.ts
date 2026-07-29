/**
 * approvalService — generic state-machine unit tests (M10.2), DB-free.
 *
 * Drives the REAL {@link approvalService} through a FAKE in-memory `Approvable`
 * adapter — no journal entries, no database, no tenant context. That is the
 * point: it proves the engine is entity-agnostic (any entity that implements the
 * contract gets the same transitions, guards, and audit calls), which is exactly
 * what M10.3–M10.5 rely on when they add invoices/bills/payments/payroll.
 *
 * The audit service is mocked so the state machine can run outside a request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordMock = vi.fn(async (_input: unknown) => {});
vi.mock("../services/audit.service", () => ({
  auditService: {
    record: (input: unknown) => recordMock(input),
    created: vi.fn(),
    updated: vi.fn(),
    deleted: vi.fn(),
  },
}));

import { approvalService, type Approvable, type ApprovalActor } from "../services/approval";

interface FakeRow {
  id: number;
  state: "pending" | "approved";
}

/** A minimal in-memory entity implementing the Approvable contract. */
function makeAdapter(rows: FakeRow[]) {
  const store = new Map<number, FakeRow>(rows.map((r) => [r.id, { ...r }]));
  const onApprove = vi.fn(async (e: FakeRow, actor: ApprovalActor) => {
    e.state = "approved";
    return { id: e.id, state: e.state, approvedBy: actor.userId };
  });
  const hardDelete = vi.fn(async (e: FakeRow) => {
    store.delete(e.id);
  });
  const adapter: Approvable<FakeRow, { id: number; state: string; approvedBy?: number | null }> = {
    entityType: "fake_record",
    load: async (id) => store.get(id) ?? null,
    status: (e) => e.state,
    onApprove,
    snapshot: (e) => ({ id: e.id, state: e.state }),
    hardDelete,
  };
  return { adapter, store, onApprove, hardDelete };
}

const actor: ApprovalActor = { userId: 42 };

beforeEach(() => {
  recordMock.mockClear();
});

describe("approvalService.approve", () => {
  it("fires the entity's on-approve action and records an `approve` audit entry", async () => {
    const { adapter, store, onApprove } = makeAdapter([{ id: 1, state: "pending" }]);

    const out = await approvalService.approve(adapter, 1, actor);

    expect(onApprove).toHaveBeenCalledOnce();
    expect(store.get(1)!.state).toBe("approved");
    expect(out).toEqual({ id: 1, state: "approved", approvedBy: 42 });

    expect(recordMock).toHaveBeenCalledOnce();
    const audited = recordMock.mock.calls[0][0] as any;
    expect(audited.action).toBe("approve");
    expect(audited.entityType).toBe("fake_record");
    expect(audited.entityId).toBe(1);
    expect(audited.before).toEqual({ id: 1, state: "pending" });
    expect(audited.after).toEqual({ id: 1, state: "approved", approvedBy: 42 });
  });

  it("passes the actor through to the on-approve action", async () => {
    const { adapter, onApprove } = makeAdapter([{ id: 7, state: "pending" }]);
    await approvalService.approve(adapter, 7, { userId: 99 });
    expect(onApprove.mock.calls[0][1]).toEqual({ userId: 99 });
  });

  it("rejects re-approving an already-approved record (409) and does not re-fire or audit", async () => {
    const { adapter, onApprove } = makeAdapter([{ id: 2, state: "approved" }]);
    await expect(approvalService.approve(adapter, 2, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(onApprove).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("404s when the record does not exist", async () => {
    const { adapter } = makeAdapter([]);
    await expect(approvalService.approve(adapter, 123, actor)).rejects.toMatchObject({ statusCode: 404 });
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("approvalService.reject", () => {
  it("hard-deletes a pending draft and records a `reject` audit entry (no after state)", async () => {
    const { adapter, store, hardDelete } = makeAdapter([{ id: 3, state: "pending" }]);

    await approvalService.reject(adapter, 3, actor);

    expect(hardDelete).toHaveBeenCalledOnce();
    expect(store.has(3)).toBe(false);

    expect(recordMock).toHaveBeenCalledOnce();
    const audited = recordMock.mock.calls[0][0] as any;
    expect(audited.action).toBe("reject");
    expect(audited.entityType).toBe("fake_record");
    expect(audited.entityId).toBe(3);
    expect(audited.before).toEqual({ id: 3, state: "pending" });
    expect(audited.after).toBeUndefined();
  });

  it("refuses to reject an approved record (409) and leaves it intact", async () => {
    const { adapter, store, hardDelete } = makeAdapter([{ id: 4, state: "approved" }]);
    await expect(approvalService.reject(adapter, 4, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(hardDelete).not.toHaveBeenCalled();
    expect(store.has(4)).toBe(true);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("404s when the record does not exist", async () => {
    const { adapter } = makeAdapter([]);
    await expect(approvalService.reject(adapter, 55, actor)).rejects.toMatchObject({ statusCode: 404 });
  });
});
