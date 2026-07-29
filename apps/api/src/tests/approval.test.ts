/**
 * approvalService — generic state-machine unit tests (M10.2/M10.3), DB-free.
 *
 * Drives the REAL {@link approvalService} through a FAKE in-memory `Approvable`
 * adapter — no journal entries, no bills, no database, no tenant context. That
 * is the point: it proves the engine is entity-agnostic (any entity implementing
 * the contract gets the same transitions, guards, and audit calls), which is
 * exactly what the entity milestones rely on.
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

import { approvalService, type Approvable, type ApprovalActor, type ApprovalState } from "../services/approval";

interface FakeRow {
  id: number;
  state: ApprovalState;
}

/** A minimal in-memory entity implementing the FULL Approvable contract. */
function makeAdapter(rows: FakeRow[]) {
  const store = new Map<number, FakeRow>(rows.map((r) => [r.id, { ...r }]));
  const onApprove = vi.fn(async (e: FakeRow, actor: ApprovalActor) => {
    e.state = "approved";
    return { id: e.id, state: e.state, approvedBy: actor.userId };
  });
  const onSubmit = vi.fn(async (e: FakeRow) => {
    e.state = "submitted";
    return { id: e.id, state: e.state };
  });
  const onSendBack = vi.fn(async (e: FakeRow, _actor: ApprovalActor, note?: string) => {
    e.state = "draft";
    return { id: e.id, state: e.state, note };
  });
  const hardDelete = vi.fn(async (e: FakeRow) => {
    store.delete(e.id);
  });
  const adapter: Approvable<FakeRow, Record<string, unknown>> = {
    entityType: "fake_record",
    load: async (id) => store.get(id) ?? null,
    state: (e) => e.state,
    onApprove,
    onSubmit,
    onSendBack,
    snapshot: (e) => ({ id: e.id, state: e.state }),
    hardDelete,
  };
  return { adapter, store, onApprove, onSubmit, onSendBack, hardDelete };
}

const actor: ApprovalActor = { userId: 42 };

beforeEach(() => {
  recordMock.mockClear();
});

describe("approvalService.submit", () => {
  it("moves a draft into the queue and audits `submit`", async () => {
    const { adapter, store } = makeAdapter([{ id: 1, state: "draft" }]);
    const out = await approvalService.submit(adapter, 1, actor);
    expect(store.get(1)!.state).toBe("submitted");
    expect(out).toMatchObject({ id: 1, state: "submitted" });
    expect((recordMock.mock.calls[0][0] as any).action).toBe("submit");
  });

  it("rejects submitting a non-draft (409)", async () => {
    const { adapter, onSubmit } = makeAdapter([{ id: 1, state: "submitted" }]);
    await expect(approvalService.submit(adapter, 1, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects submit when the adapter does not support it (409)", async () => {
    const base = makeAdapter([{ id: 1, state: "draft" }]).adapter;
    const noSubmit: Approvable<any, any> = { ...base, onSubmit: undefined };
    await expect(approvalService.submit(noSubmit, 1, actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("approvalService.sendBack", () => {
  it("returns a submitted record to draft with the note and audits `send_back`", async () => {
    const { adapter, store, onSendBack } = makeAdapter([{ id: 2, state: "submitted" }]);
    const out = await approvalService.sendBack(adapter, 2, actor, "fix the VAT");
    expect(store.get(2)!.state).toBe("draft");
    expect(out).toMatchObject({ id: 2, state: "draft", note: "fix the VAT" });
    expect(onSendBack.mock.calls[0][2]).toBe("fix the VAT");
    expect((recordMock.mock.calls[0][0] as any).action).toBe("send_back");
  });

  it("rejects sending back a non-submitted record (409)", async () => {
    const { adapter } = makeAdapter([{ id: 2, state: "draft" }]);
    await expect(approvalService.sendBack(adapter, 2, actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("approvalService.approve", () => {
  it("approves straight from draft (self-approve on create) and audits `approve`", async () => {
    const { adapter, store, onApprove } = makeAdapter([{ id: 3, state: "draft" }]);
    const out = await approvalService.approve(adapter, 3, actor);
    expect(onApprove).toHaveBeenCalledOnce();
    expect(store.get(3)!.state).toBe("approved");
    expect(out).toEqual({ id: 3, state: "approved", approvedBy: 42 });
    const audited = recordMock.mock.calls[0][0] as any;
    expect(audited.action).toBe("approve");
    expect(audited.before).toEqual({ id: 3, state: "draft" });
    expect(audited.after).toEqual({ id: 3, state: "approved", approvedBy: 42 });
  });

  it("approves from the submitted queue too", async () => {
    const { adapter, store } = makeAdapter([{ id: 4, state: "submitted" }]);
    await approvalService.approve(adapter, 4, actor);
    expect(store.get(4)!.state).toBe("approved");
  });

  it("rejects re-approving an approved record (409) and does not re-fire or audit", async () => {
    const { adapter, onApprove } = makeAdapter([{ id: 5, state: "approved" }]);
    await expect(approvalService.approve(adapter, 5, actor)).rejects.toMatchObject({ statusCode: 409 });
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
  it("hard-deletes a draft and audits `reject` (no after state)", async () => {
    const { adapter, store, hardDelete } = makeAdapter([{ id: 6, state: "draft" }]);
    await approvalService.reject(adapter, 6, actor);
    expect(hardDelete).toHaveBeenCalledOnce();
    expect(store.has(6)).toBe(false);
    const audited = recordMock.mock.calls[0][0] as any;
    expect(audited.action).toBe("reject");
    expect(audited.before).toEqual({ id: 6, state: "draft" });
    expect(audited.after).toBeUndefined();
  });

  it("hard-deletes a submitted record too", async () => {
    const { adapter, store, hardDelete } = makeAdapter([{ id: 7, state: "submitted" }]);
    await approvalService.reject(adapter, 7, actor);
    expect(hardDelete).toHaveBeenCalledOnce();
    expect(store.has(7)).toBe(false);
  });

  it("refuses to reject an approved record (409) and leaves it intact", async () => {
    const { adapter, store, hardDelete } = makeAdapter([{ id: 8, state: "approved" }]);
    await expect(approvalService.reject(adapter, 8, actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(hardDelete).not.toHaveBeenCalled();
    expect(store.has(8)).toBe(true);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("404s when the record does not exist", async () => {
    const { adapter } = makeAdapter([]);
    await expect(approvalService.reject(adapter, 55, actor)).rejects.toMatchObject({ statusCode: 404 });
  });
});
