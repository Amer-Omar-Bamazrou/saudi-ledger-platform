/**
 * 🔴 Phase 18 audit (2026-11-11), finding A29 — a request the client abandoned is logged as what it is, and a real
 * failure stays loud.
 *
 * When the client goes away before a response is written, `resolveTenant`'s close handler ROLLS BACK the request's
 * tenant transaction (nothing half-commits). The handler is still running; its next statement is refused by the ended
 * handle (`TenantTransactionEndedError`, Phase 18's CRITICAL fix: it must never run on a released connection). That
 * refusal reached the error boundary as a drizzle "Failed query", logged at ERROR with a stack and answered 500 to a
 * closed socket — 52–63 times in every browser run (four main runs, 234 records, every one an aborted GET). Expected
 * refusals logged like real failures hide the real ones.
 *
 * Presence, absence, movement: the refusal on a request whose transaction was rolled back on close is logged at info
 * and nothing is sent; the SAME refusal on a request that was not rolled back on close (a handler using an ended
 * handle on a live request — the bug the handle exists to catch) stays an ERROR and a 500; any other error on an
 * abandoned request stays an ERROR. The close handler marks the request only when it rolls back.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { TenantTransactionEndedError } from "@workspace/db";
import { errorHandler } from "../middleware/errorHandler";
import * as tenant from "../lib/tenant";
import * as reports from "../controllers/reports.controller";

const fakeReq = () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req: { method: "GET", path: "/treasury/dashboard", log } as unknown as Request, log };
};
const fakeRes = (rolledBackOnClose: boolean) => {
  const res = { headersSent: false, locals: rolledBackOnClose ? { tenantRolledBackOnClose: true } : {}, status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
/** As drizzle hands it on: a "Failed query" whose cause is the handle's refusal. */
const failedQuery = () => Object.assign(new Error('Failed query: select "id" from "journal_entry_lines"'), { cause: new TenantTransactionEndedError() });
const next = vi.fn() as unknown as NextFunction;

describe("Phase 18 audit A29 — the error boundary tells an abandoned request's refused statement from a real failure", () => {
  it("🔴 rolled back on close + the ended handle's refusal: logged at info, nothing sent", () => {
    const { req, log } = fakeReq();
    const res = fakeRes(true);
    errorHandler(failedQuery(), req, res as unknown as Response, next);
    expect(log.error, "not an error: the client went away and the rollback is by design").not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(res.status, "nothing is sent to a closed connection").not.toHaveBeenCalled();
  });

  it("🔴 the refusal un-wrapped (not via drizzle) is the same case", () => {
    const { req, log } = fakeReq();
    const res = fakeRes(true);
    errorHandler(new TenantTransactionEndedError(), req, res as unknown as Response, next);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("🔴 the SAME refusal on a request NOT rolled back on close stays an ERROR and a 500 — that one is a bug", () => {
    const { req, log } = fakeReq();
    const res = fakeRes(false);
    errorHandler(failedQuery(), req, res as unknown as Response, next);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("any other error on an abandoned request stays an ERROR", () => {
    const { req, log } = fakeReq();
    const res = fakeRes(true);
    errorHandler(new Error("something else broke"), req, res as unknown as Response, next);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("🔴 the close handler marks the request — and rolls back — only when nothing settled it", async () => {
    type CloseSeam = (res: Response, settled: () => boolean, rollBack: () => Promise<void>, log: { error: (...a: unknown[]) => void }) => void;
    const rollBackUnsettledOnClose = (tenant as unknown as Record<string, unknown>).rollBackUnsettledOnClose as CloseSeam;
    expect(typeof rollBackUnsettledOnClose, "resolveTenant's close handler is a named, testable seam").toBe("function");
    for (const settled of [false, true]) {
      const res = Object.assign(new EventEmitter(), { locals: {} as Record<string, unknown> });
      const rollBack = vi.fn(() => Promise.resolve());
      rollBackUnsettledOnClose(res as unknown as Response, () => settled, rollBack, { error: vi.fn() });
      res.emit("close");
      await Promise.resolve();
      expect(res.locals.tenantRolledBackOnClose, `settled=${settled}`).toBe(settled ? undefined : true);
      expect(rollBack).toHaveBeenCalledTimes(settled ? 0 : 1);
    }
  });
});

describe("Phase 18 audit A29 — the reports controller's own catch hands an abandoned request's refusal to the boundary", () => {
  // Found by #333's live check: 43 refusals went to info, 7 stayed failed queries — every one under /api/reports,
  // whose wrapper (`withReportError`) logs untyped errors itself and never reaches the error boundary.
  type Wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
  const wrap = () => (reports as unknown as Record<string, unknown>).withReportError as Wrap;

  it("🔴 rolled back on close + the ended handle's refusal: passed to the boundary, not logged here", async () => {
    expect(typeof wrap(), "the reports wrapper is a named, testable seam").toBe("function");
    const { req, log } = fakeReq();
    const res = fakeRes(true);
    const nextFn = vi.fn();
    const err = failedQuery();
    await wrap()(async () => { throw err; })(req, res as unknown as Response, nextFn as unknown as NextFunction);
    expect(log.error).not.toHaveBeenCalled();
    expect(nextFn).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("the same refusal on a request NOT rolled back on close is still an ERROR and a 500 — now at the central boundary", async () => {
    // The error-handling work package (2026-11-17): the reports wrapper no longer answers failures itself (it sent
    // `String(err)` to the browser); it forwards every one to errorHandler. A29's property is unchanged and held where
    // it now lives: on a LIVE request the ended handle's refusal is a bug — logged at ERROR, answered 500.
    expect(typeof wrap()).toBe("function");
    const { req, log } = fakeReq();
    const res = fakeRes(false);
    const nextFn = vi.fn();
    const err = failedQuery();
    await wrap()(async () => { throw err; })(req, res as unknown as Response, nextFn as unknown as NextFunction);
    expect(nextFn).toHaveBeenCalledWith(err);
    errorHandler(nextFn.mock.calls[0]![0], req, res as unknown as Response, next);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
