import { describe, expect, it } from "vitest";
import { createSubmitGuard } from "./singleSubmit";

describe("createSubmitGuard — one request per intent (QA 2026-10-04)", () => {
  it("🔴 a second submit while the first is in flight does not start; after it settles, the next one does", () => {
    const g = createSubmitGuard();
    const started: string[] = [];
    let settle: () => void = () => {};
    expect(g.run((release) => { started.push("first"); settle = release; })).toBe(true);
    expect(g.busy).toBe(true);
    // the double-click's second click — React has not re-rendered, `isPending` is still false
    expect(g.run(() => { started.push("second"); })).toBe(false);
    expect(started).toEqual(["first"]);
    settle();
    expect(g.busy).toBe(false);
    expect(g.run((release) => { started.push("third"); release(); })).toBe(true);
    expect(started).toEqual(["first", "third"]);
  });

  it("a start that throws re-arms the guard (a failed submit must not freeze the button)", () => {
    const g = createSubmitGuard();
    expect(() => g.run(() => { throw new Error("boom"); })).toThrow("boom");
    expect(g.busy).toBe(false);
  });

  it("releasing twice is harmless — it cannot release a LATER submit", () => {
    const g = createSubmitGuard();
    let first: () => void = () => {};
    g.run((release) => { first = release; });
    first();
    g.run(() => {}); // second submit in flight
    first();          // a late duplicate release of the first
    expect(g.busy).toBe(true);
  });
});
