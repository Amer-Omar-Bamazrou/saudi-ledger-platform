/**
 * C13 — THE TRANSACTION SETTLES BEFORE THE RESPONSE GOES OUT.
 *
 * ── 🔴 WHAT THIS TEST IS FOR ───────────────────────────────────────────────
 * The old ordering committed in `res.on("finish")`: the client already held
 * its 2xx, so a failed commit meant a write reported as saved that never
 * persisted, and the success could not be un-sent. It was documented and
 * paged as critical — and **an alarm tells you a write was lost; it does not
 * prevent it**.
 *
 * So the assertions here are about ORDER and about the CORRECTED ANSWER, not
 * about an alert firing:
 *
 *   1. the commit resolves BEFORE any byte of the body is written;
 *   2. a FAILED commit turns a would-be 2xx into a 500 the client can act on;
 *   3. an error response ROLLS BACK, and rolls back before its body goes out;
 *   4. a failed ROLLBACK still sends the original (already unsuccessful) answer;
 *   5. a response that never writes (an aborted request) is not settled by
 *      this path at all — the caller's `close` net owns that case;
 *   6. re-entry is safe: `res.json` → `res.send` → `res.end` settles once.
 *
 * 🔴 The instrument is checked against the OLD behaviour at the end: a fake
 * that writes without settling must fail assertion 1, or the test proves
 * nothing about ordering.
 */
import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { commitBeforeResponse, COMMIT_FAILED_BODY, type CommitFailure } from "../lib/responseCommit";

/**
 * A response that records the ORDER of everything that happens to it. Minimal
 * on purpose: Express's real `res` calls `send` from `json` and `end` from
 * `send`, which this reproduces, because that re-entry is the thing most
 * likely to break the wrapper.
 */
function fakeRes(initialStatus = 200) {
  const events: string[] = [];
  const res = {
    statusCode: initialStatus,
    headersSent: false,
    body: undefined as unknown,
    /** Every payload that reached a write path, so absence is assertable. */
    written: [] as unknown[],
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      events.push("json");
      this.body = payload;
      this.written.push(payload);
      // Express: json → send → end
      return (this as unknown as Response).send(payload as never);
    },
    send(payload: unknown) {
      events.push("send");
      this.body = payload;
      return (this as unknown as Response).end();
    },
    end() {
      events.push("end");
      this.headersSent = true;
      return this;
    },
    write(_chunk: unknown) {
      events.push("write");
      this.headersSent = true;
      return true;
    },
    on() {
      return this;
    },
  };
  return { res: res as unknown as Response, events, raw: res };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("C13 — commit before the response goes out", () => {
  it("🔴 commits BEFORE the body is written, not after", async () => {
    const { res, events } = fakeRes(201);
    const settled: boolean[] = [];
    commitBeforeResponse(
      res,
      async (commit) => {
        events.push(commit ? "commit" : "rollback");
        settled.push(commit);
      },
      () => {},
    );

    res.json({ id: 1 });
    await flush();

    expect(settled).toEqual([true]);
    // The whole point: the commit event precedes every write event.
    expect(events[0]).toBe("commit");
    expect(events).toEqual(["commit", "json", "send", "end"]);
  });

  it("🔴 a FAILED commit turns a would-be 2xx into a 500 the client can act on", async () => {
    const { res, events, raw } = fakeRes(201);
    const failures: CommitFailure[] = [];
    commitBeforeResponse(
      res,
      async () => {
        events.push("commit-attempt");
        throw new Error("connection terminated unexpectedly");
      },
      (f) => failures.push(f),
    );

    res.json({ id: 1, invoiceNumber: "INV-1" });
    await flush();

    // 🔴 The SUCCESS payload never reached the client — that is the defect
    // closing. (The corrected 500 is itself sent through `res.json`, so the
    // meaningful assertion is about what was written, not which method ran.)
    expect(raw.written).not.toContainEqual({ id: 1, invoiceNumber: "INV-1" });
    expect(events[0]).toBe("commit-attempt");
    // What the client receives says so.
    expect(raw.statusCode).toBe(500);
    expect(raw.body).toEqual(COMMIT_FAILED_BODY);
    expect((raw.body as { code: string }).code).toBe("commit_failed");
    // Reported, and reported as the CORRECTABLE case.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.responseAlreadyStarted).toBe(false);
  });

  it("an error response ROLLS BACK, before its body goes out", async () => {
    const { res, events } = fakeRes(200);
    commitBeforeResponse(
      res,
      async (commit) => {
        events.push(commit ? "commit" : "rollback");
      },
      () => {},
    );

    res.status(409).json({ error: "conflict" });
    await flush();

    expect(events[0]).toBe("rollback");
    expect(events).toEqual(["rollback", "json", "send", "end"]);
  });

  it("a failed ROLLBACK still sends the original answer — it loses nothing that was promised", async () => {
    const { res, events, raw } = fakeRes(400);
    const failures: CommitFailure[] = [];
    commitBeforeResponse(
      res,
      async () => {
        throw new Error("rollback failed");
      },
      (f) => failures.push(f),
    );

    res.json({ error: "bad request" });
    await flush();

    expect(events).toEqual(["json", "send", "end"]);
    expect(raw.statusCode).toBe(400);
    expect(raw.body).toEqual({ error: "bad request" });
    // Not paged: nothing was promised to the user that a rollback could undo.
    expect(failures).toHaveLength(0);
  });

  it("🔴 the RESIDUAL case is reported as itself: a stream past its first chunk cannot be recalled", async () => {
    const { res, events } = fakeRes(200);
    const failures: CommitFailure[] = [];
    let attempt = 0;
    commitBeforeResponse(
      res,
      async () => {
        attempt += 1;
        events.push("settle");
        throw new Error("commit failed");
      },
      (f) => failures.push(f),
    );

    // Simulate a response already begun before the wrapper's first settle.
    (res as unknown as { headersSent: boolean }).headersSent = true;
    res.write("chunk");
    await flush();

    expect(attempt).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.responseAlreadyStarted).toBe(true);
    // The chunk still goes out — there is nothing else it can do.
    expect(events).toEqual(["settle", "write"]);
  });

  it("settles ONCE across json → send → end re-entry, and reports that it settled", async () => {
    const { res, events } = fakeRes(200);
    let settles = 0;
    const wasSettled = commitBeforeResponse(
      res,
      async () => {
        settles += 1;
        events.push("settle");
      },
      () => {},
    );

    expect(wasSettled()).toBe(false);
    res.json({ ok: true });
    expect(wasSettled()).toBe(true); // synchronously, so the `close` net stands down
    await flush();

    expect(settles).toBe(1);
    expect(events.filter((e) => e === "settle")).toHaveLength(1);
  });

  it("a response that never writes is NOT settled here — the caller's close net owns the abort", async () => {
    const { res } = fakeRes(200);
    let settles = 0;
    const wasSettled = commitBeforeResponse(
      res,
      async () => {
        settles += 1;
      },
      () => {},
    );

    await flush();
    expect(settles).toBe(0);
    expect(wasSettled()).toBe(false);
  });

  it("🔴 wraps only the methods that EXIST — a partial response object must not crash the request", async () => {
    /**
     * Found by the full suite immediately after this helper was written: a
     * middleware test's fake `res` carries `status`/`json`/`on` and nothing
     * else, and binding `send` threw — the outer catch in resolveTenant turned
     * that into a 500 and a `next()` that never ran. **A hardening step is
     * untested code added after the tests passed**; this is the case that
     * proves the hardening, so it is a test rather than a comment.
     */
    const events: string[] = [];
    // Typed explicitly: an object literal's methods infer `this` as `{}`, and
    // `vitest run` does not typecheck — which is how this file passed locally
    // and failed CI's `pnpm run typecheck`.
    interface PartialRes {
      statusCode: number;
      headersSent: boolean;
      body: unknown;
      status(c: number): PartialRes;
      json(payload: unknown): PartialRes;
      on(): PartialRes;
    }
    const partialRaw: PartialRes = {
      statusCode: 200,
      headersSent: false,
      body: undefined,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(payload: unknown) {
        events.push("json");
        this.body = payload;
        return this;
      },
      on() {
        return this;
      },
    };
    const partial = partialRaw as unknown as Response;

    expect(() =>
      commitBeforeResponse(
        partial,
        async () => {
          events.push("settle");
        },
        () => {},
      ),
    ).not.toThrow();

    partial.json({ ok: true });
    await flush();
    expect(events).toEqual(["settle", "json"]);
  });

  it("🔴 the instrument is not vacuous — an unwrapped response writes with NO settle, which is the old bug", async () => {
    const { res, events } = fakeRes(201);
    // Deliberately NOT wrapped: this is the behaviour C13 replaced.
    res.json({ id: 1 });
    await flush();
    expect(events).toEqual(["json", "send", "end"]);
    // Assertion 1's shape applied here fails, which is what makes it meaningful.
    expect(events[0]).not.toBe("commit");
  });
});
