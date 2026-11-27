/**
 * 🔴 19B — the browser suite's verdict on the server's capture of unclassified fields (e2e/fieldClassCapture.ts):
 * it fails on anything default deny withheld, by name, and never reads "nothing" from a capture that was off.
 */
import { describe, expect, it } from "vitest";
import { judgeCapture } from "../../e2e/fieldClassCapture";

const started = JSON.stringify({ started: true, pid: 1, defaultDeny: true });
const denied = JSON.stringify({ denied: true, route: "GET /reports/datasets", role: "viewer", status: 200, fields: ["listReportDatasets#200.planted"] });
const served = JSON.stringify({ route: "GET /products", status: 200, fields: ["items[].surprise"], keyPaths: ["items[].surprise"] });

describe("19B — the browser suite fails on anything default deny withheld", () => {
  it("🔴 the capture on and nothing met: the run passes, and says it measured", () => {
    expect(judgeCapture(`${started}\n`, true)).toEqual({ ok: true, measured: true, note: expect.stringContaining("nothing unclassified") });
  });

  it("🔴 a field withheld from a non-admin fails the run, naming the role, the route and the field", () => {
    const v = judgeCapture(`${started}\n${denied}\n${denied}\n`, true);
    expect(v.ok).toBe(false);
    const error = (v as { error: string }).error;
    expect(error).toContain("WITHHELD from viewer — GET /reports/datasets: listReportDatasets#200.planted");
    expect(error).toContain("1 response(s)"); // the same line twice is one finding
  });

  it("🔴 a field served unclassified to the admin fails the run too: it is the same missing class", () => {
    const v = judgeCapture(`${started}\n${served}\n`, false);
    expect(v.ok).toBe(false);
    expect((v as { error: string }).error).toContain("served unclassified to the admin or a request with no organization role — GET /products: items[].surprise");
  });

  it("🔴 a capture that was never on is not a result: in CI it fails the run; locally it is said and not counted as measured", () => {
    for (const text of [null, "", `${denied.replace('"denied":true,', "")}\n`]) {
      const ci = judgeCapture(text, true);
      expect([text, ci.ok]).toEqual([text, false]);
      expect((ci as { error: string }).error).toContain("says nothing about what was withheld");
      expect(judgeCapture(text, false)).toEqual({ ok: true, measured: false, note: expect.stringContaining("was not measured here") });
    }
  });
});
