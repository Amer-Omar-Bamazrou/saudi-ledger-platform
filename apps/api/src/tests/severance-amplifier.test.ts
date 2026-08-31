/**
 * THE GUARDRAIL-AS-AMPLIFIER SWEEP — every deliberate severance, checked.
 *
 * ── 🔴 THE SHAPE, WHICH IS WIDER THAN THE BUG THAT REVEALED IT ─────────────
 * A `idle_in_transaction_session_timeout` guardrail did exactly its job —
 * terminated a transaction held open too long — and **killed the API process**,
 * because `node-postgres` emitted `error` on the severed client and an `error`
 * event with no listener is fatal in Node. A defence designed to kill a
 * TRANSACTION was killing the SERVER.
 *
 * That amplifier sits behind *every* mechanism that works by severing
 * something: a timeout, an abort, a socket destroy, a backend termination, a
 * failover, a restart. The question to ask of each, and the reason this file
 * is a sweep rather than a regression test for one bug:
 *
 *   > When this deliberately terminates something, does an unhandled event on
 *   > the severed thing take down more than was intended?
 *
 * ── 🔴 AND THE SECOND TRAP, WHICH COST A WHOLE RUN ─────────────────────────
 * The standard advice for this in `pg` is `pool.on("error", …)`. It was
 * applied, and the next full browser run crashed **identically**: the pool
 * emits for clients sitting IDLE in it, while a client that is CHECKED OUT
 * emits on itself. **Standard advice applied without checking which case you
 * have is its own trap** — the fix looked right, was widely recommended, and
 * addressed the other half of the problem.
 *
 * ── WHAT THIS ASSERTS ──────────────────────────────────────────────────────
 * Structural, by design. The behavioural proof that the process survives a
 * terminated backend lives in `connection-loss-survival.test.ts`; this file
 * asserts that **no new severance point is introduced without a listener**,
 * because the next instance will not be in the file the last one was in.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..");
const DB_SRC = join(HERE, "../../../../packages/db/src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests" || name === "generated" || name === "node_modules") continue;
      walk(p, acc);
    } else if (name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const files = [...walk(API_SRC), ...walk(DB_SRC)];
const rel = (p: string) => p.replace(/\\/g, "/").replace(/^.*?(apps|packages)\//, "$1/");

describe("every deliberate severance is checked for the amplifier", () => {
  it("the sweep is not vacuous — it reads real source files", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
  });

  /**
   * 🔴 A CHECKED-OUT pg CLIENT MUST HAVE AN `error` LISTENER.
   *
   * `pool.connect()` hands back a client the caller owns until release. If its
   * connection dies in that window — the idle-in-transaction guardrail, a
   * restart, a failover — the client emits `error`, and nothing else is
   * listening on its behalf. `pool.on("error")` does NOT cover this case.
   */
  it("🔴 every `pool.connect()` attaches an error listener to the client", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("pool.connect()")) continue;
      // The listener may be attached directly or via a named shared handler;
      // both satisfy the property. What must not happen is no listener at all.
      const hasListener = /\bclient\.on\(\s*["']error["']/.test(src);
      if (!hasListener) offenders.push(rel(f));
    }
    expect(
      offenders,
      "A client is checked out of the pool with no `error` listener.\n" +
        "If its connection dies while checked out, Node treats the unhandled\n" +
        "`error` event as fatal and THE WHOLE API PROCESS EXITS. This has\n" +
        "happened: a 15s idle-in-transaction guardrail took the server down\n" +
        "with the transaction it was built to kill.\n" +
        "🔴 `pool.on(\"error\")` does not cover a checked-out client.",
    ).toEqual([]);
  });

  /**
   * Every Pool needs the idle-side handler too. Both halves are required and
   * neither substitutes for the other — which is the whole lesson.
   */
  it("🔴 every Pool constructed in the db package has an idle error listener", () => {
    const src = readFileSync(join(DB_SRC, "index.ts"), "utf8");
    const pools = [...src.matchAll(/export const (\w+)\s*=\s*new Pool\(/g)].map((m) => m[1]);
    expect(pools.length, "no pools found — the assertion below would be vacuous").toBeGreaterThan(0);
    for (const name of pools) {
      expect(
        new RegExp(`guardPool\\(${name}\\b|${name}\\.on\\(\\s*["']error["']`).test(src),
        `the pool \`${name}\` has no idle error handler`,
      ).toBe(true);
    }
  });

  /**
   * A socket the code destroys on purpose must have had an `error` listener
   * attached BEFORE the destroy path can run — a destroyed socket can still
   * emit, and on a `net.Socket` that is fatal too.
   */
  it("🔴 every socket destroyed on purpose has an error listener", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!/\bsocket\.destroy\(/.test(src)) continue;
      if (!/\bsocket\.on\(\s*["']error["']/.test(src)) offenders.push(rel(f));
    }
    expect(
      offenders,
      "A socket is destroyed deliberately with no `error` listener on it.",
    ).toEqual([]);
  });

  /**
   * 🔴 The one that is NOT mechanised, named so its absence is a decision.
   *
   * `AbortController` severance (the AI provider's request timeout) is safe by
   * construction: aborting a `fetch` REJECTS the promise, and a rejection has
   * a caller to handle it. There is no event emitter to leave unlistened, so
   * there is nothing here to assert — recorded because "we checked and there
   * was nothing to guard" is a different statement from "we did not look".
   */
  it("records the severance points that need no guard, so the sweep is reviewable", () => {
    const provider = readFileSync(join(API_SRC, "services/ai/provider.ts"), "utf8");
    // If this ever stops being an AbortController — a socket, a client, a
    // stream — the reasoning above expires and this test says so.
    expect(
      provider.includes("new AbortController()"),
      "the AI provider's timeout is no longer an AbortController; re-check whether " +
        "its severance now leaves an unlistened emitter",
    ).toBe(true);
  });
});
