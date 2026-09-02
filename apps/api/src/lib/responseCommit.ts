/**
 * COMMIT BEFORE THE RESPONSE GOES OUT (C13).
 *
 * ── 🔴 THE DEFECT THIS CLOSES ──────────────────────────────────────────────
 * `lib/tenant.ts` used to commit the request's transaction in
 * `res.on("finish")` — which fires once the client ALREADY HOLDS its 2xx. A
 * commit that then failed left the user believing a write had happened when
 * nothing was persisted, and there is no way to un-send a success. It was
 * documented at the site, paged as critical, and production could not boot
 * unalerted — known and alarmed, not hidden. But **an alarm tells you a write
 * was lost; it does not prevent it**, and the trigger stopped being
 * hypothetical when a connection died mid-request on 2026-08-31.
 *
 * ── WHAT THIS DOES ────────────────────────────────────────────────────────
 * Wraps the response's output methods so that the FIRST one to be called
 * settles the transaction and only then writes:
 *
 *   handler calls res.json(x)
 *     → settle(commit = statusCode < 400)
 *       → resolved: the original res.json(x) runs, client gets its answer
 *       → rejected: nothing has been written yet, so the client is told the
 *         TRUTH — a 500 with `commit_failed` — instead of a success for a
 *         write that does not exist.
 *
 * The status code is read at the moment of the first write, so a handler that
 * did `res.status(201)` commits and a handler that did `res.status(409)` rolls
 * back. Errors therefore roll back BEFORE their body goes out too, which the
 * old ordering also got backwards.
 *
 * ── 🔴 WHY IT WRAPS FOUR METHODS AND WHY RE-ENTRY IS SAFE ─────────────────
 * `res.json` calls `res.send`, which calls `res.end`. All four wrappers share
 * one `settled` flag, so the outermost call settles and the inner calls pass
 * straight through to the originals. Wrapping only `end` would be too late for
 * `res.json`'s header work; wrapping only `json` would miss `send`, `end` and
 * streamed writes.
 *
 * ── THE RESIDUAL CASE, NAMED RATHER THAN HIDDEN ───────────────────────────
 * If a response has already begun (a stream that wrote a chunk, then a commit
 * failure on a later write), the answer cannot be recalled. That is the ONLY
 * remaining commit-after-response case, it keeps the original alert key, and
 * it is reported separately from the case we can now correct.
 */
import type { Response } from "express";

/** Settle the request's transaction. `commit: false` means roll back. */
export type SettleTransaction = (commit: boolean) => Promise<void>;

export interface CommitFailure {
  /** The rejection from COMMIT. */
  error: unknown;
  /**
   * True when the response had ALREADY started — the residual
   * commit-after-response case, which cannot be corrected from here.
   */
  responseAlreadyStarted: boolean;
}

/** The body sent when a commit fails and we can still tell the truth. */
export const COMMIT_FAILED_BODY = {
  error:
    "The change could not be saved. Nothing was written — please try again, and if it keeps happening tell your administrator.",
  code: "commit_failed",
} as const;

type AnyFn = (...args: never[]) => unknown;

/**
 * Make `res` settle `settle()` before it writes anything.
 *
 * `onFailure` is called only when a COMMIT rejects; it must never throw (a
 * failure in the alarm must not take down the thing it was watching).
 * Returns a function reporting whether the transaction was settled through
 * this path — the caller keeps its own `finish`/`close` net for responses that
 * never write at all (an aborted request).
 */
export function commitBeforeResponse(
  res: Response,
  settle: SettleTransaction,
  onFailure: (failure: CommitFailure) => void,
): () => boolean {
  let settled = false;

  const originalJson = res.json.bind(res);
  const originalStatus = res.status.bind(res);

  const wrap = <T extends AnyFn>(original: T, passthroughResult: (self: Response) => unknown) =>
    function (this: Response, ...args: never[]): unknown {
      if (settled) return (original as AnyFn).apply(this, args);
      settled = true;

      // Read the status the handler chose, at the moment it commits to writing.
      const wantCommit = this.statusCode < 400;
      const alreadyStarted = this.headersSent;

      settle(wantCommit).then(
        () => {
          (original as AnyFn).apply(this, args);
        },
        (error: unknown) => {
          // A failed ROLLBACK loses nothing the user was promised — send the
          // original (already unsuccessful) response.
          if (!wantCommit) {
            (original as AnyFn).apply(this, args);
            return;
          }
          onFailure({ error, responseAlreadyStarted: alreadyStarted });
          if (alreadyStarted) {
            // Cannot recall what the client already has. Finish the response;
            // the alarm carries the truth.
            (original as AnyFn).apply(this, args);
            return;
          }
          // 🔴 Nothing has gone out yet: replace the success with the truth.
          originalStatus(500);
          originalJson(COMMIT_FAILED_BODY);
        },
      );

      return passthroughResult(this);
    };

  /**
   * 🔴 Wrap only what is actually there. A real Express response has all four,
   * but this middleware must not CRASH a request over a response object that
   * does not — assuming a method exists because it usually does is how a
   * hardening step becomes the outage. (Found immediately: a middleware test's
   * fake `res` carries `status`/`json` only, and binding `send` threw, which
   * the outer catch turned into a 500 and a `next()` that never ran.)
   */
  const wrapIfPresent = (name: "json" | "send" | "end" | "write", result: (self: Response) => unknown) => {
    const original = (res as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") return;
    (res as unknown as Record<string, unknown>)[name] = wrap(
      (original as AnyFn).bind(res) as AnyFn,
      result,
    );
  };

  // `json`, `send` and `end` are chainable and return the response.
  wrapIfPresent("json", (self) => self);
  wrapIfPresent("send", (self) => self);
  wrapIfPresent("end", (self) => self);
  // `write` answers a backpressure boolean. Deferred writes report `true`:
  // there is no queued data to drain yet.
  wrapIfPresent("write", () => true);

  return () => settled;
}
