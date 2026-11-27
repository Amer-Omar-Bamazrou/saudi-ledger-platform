/**
 * 🔴 19B (v4 §5.3) — DEFAULT DENY, ON BY DEFAULT (owner, 2026-11-26: "make it ON by default in code, so CI's API and
 * browser suites run with it"; restated from "prepared and off", the same day's earlier decision).
 *
 * The rule: a served field with NO class is removed for every non-admin and listed as `unclassified`.
 *
 *  - ON BY DEFAULT: the setting's default is `on`. `off` is still a value an operator may set; nothing sets it.
 *  - 🔴 THE TEST LANE'S DETECTION STAYS TOTAL: under NODE_ENV=test a response with an unclassified key is answered 500
 *    `field_unclassified`, by name, for EVERY role — default deny never hides a missing class from a test. A test that
 *    wants to see the enforcement itself asks for it (`__setDefaultDenyForTests(true)`).
 *  - OUTSIDE the test lane (the browser suite's server, production): the key is removed for a viewer, a bookkeeper and
 *    an accountant, listed, logged once — and written to the capture file when one is named, which is how the browser
 *    suite fails on anything default deny withheld (e2e/global-teardown.ts).
 *  - ON, a PLANTED unclassified key (the probe sees a known-present case): it is ABSENT from what a viewer, a bookkeeper
 *    and an accountant are served, listed `{ path, class: "unclassified", level: "none" }` in `X-Withheld`, and the
 *    classified fields beside it are untouched. On a route in neither table the whole body is withheld.
 *  - The ADMIN, and a request with no organization role (identity, onboarding, the operator surface), are never denied.
 *  - A fully classified response is served as the SAME object, on or off: default deny touches only what has no class.
 *
 * DB-free.
 */
process.env.PORT ??= "3263";
process.env.SESSION_SECRET ??= "default-deny-prepared-0000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { PERMISSION_MATRIX } from "@workspace/db";
import { loadEnv, resetEnvCache } from "@workspace/config";
import { primePermissionCache } from "../lib/rbac";
import { announceFieldClassCapture, classifyResponse, deciderFor, fieldClassSeam, WITHHELD_HEADER } from "../lib/fieldClasses/seam";
import { __setDefaultDenyForTests, defaultDeniesRole, defaultDenyOn } from "../lib/fieldClasses/defaultDeny";
import { OUTSIDE_CONTRACT_ROUTES } from "../lib/fieldClasses/outsideContract";

const PLANTED = "PLANTED-UNCLASSIFIED-77104";
const grants = new Set(PERMISSION_MATRIX.map((r) => `${r.role}:${r.resource}:${r.action}`));
const viewer = deciderFor("viewer", grants);
/** A real contract response (the report datasets list) with one key the contract does not declare. */
const withPlanted = () => ({ items: [{ name: "journal_lines", title: "Journal lines", titleAr: "سطور القيود", acts: ["run"], columns: [], filters: [] }], planted: PLANTED });
const classified = () => ({ items: [{ name: "journal_lines", title: "Journal lines", titleAr: "سطور القيود", acts: ["run"], columns: [], filters: [] }] });

function serve(role: string | undefined, url: string, body: unknown) {
  const out: { status: number; body: unknown; headers: Record<string, string> } = { status: 200, body: undefined, headers: {} };
  const req = { method: "GET", originalUrl: url, tenant: role ? { role } : undefined } as unknown as Request;
  const res = { statusCode: 200 } as unknown as Response;
  Object.assign(res, {
    status(code: number) { res.statusCode = code; out.status = code; return res; },
    setHeader(k: string, v: string) { out.headers[k] = v; return res; },
    json(b: unknown) { out.body = b; return res; },
  });
  fieldClassSeam(req, res, () => undefined);
  res.json(body);
  return out;
}

describe("19B — default deny, on by default", () => {
  afterEach(() => { __setDefaultDenyForTests(null); primePermissionCache(PERMISSION_MATRIX); });

  it("🔴 ON by default: the setting's default is on, and the switch reads it", () => {
    const { FIELD_DEFAULT_DENY: _unset, ...rest } = process.env;
    expect(_unset, "nothing sets it in this lane").toBeUndefined();
    try {
      resetEnvCache();
      expect(loadEnv(rest).FIELD_DEFAULT_DENY).toBe("on"); // unset: on
      resetEnvCache();
      expect(() => loadEnv({ ...rest, FIELD_DEFAULT_DENY: "yes" })).toThrow(/FIELD_DEFAULT_DENY/); // only off or on
      resetEnvCache();
      expect(loadEnv({ ...rest, FIELD_DEFAULT_DENY: "off" }).FIELD_DEFAULT_DENY).toBe("off");
      expect(defaultDenyOn()).toBe(false); // the switch reads the setting
    } finally {
      resetEnvCache();
    }
    expect(defaultDenyOn()).toBe(true); // and in this lane, as everywhere nothing sets it, it is on
  });

  it("🔴 who is denied: every organization role but the admin — never a request with no organization role", () => {
    expect(["viewer", "bookkeeper", "accountant", "admin", undefined].map((r) => defaultDeniesRole(r))).toEqual([true, true, true, false, false]);
  });

  it("🔴 the walk, with a planted key: served and reported when off; REMOVED and listed when on — the classified fields untouched", () => {
    const off = classifyResponse("GET", "/api/reports/datasets", 200, withPlanted(), viewer);
    expect(JSON.stringify(off.value)).toContain(PLANTED);
    expect(off.unclassified.length).toBe(1);
    expect(off.withheld).toEqual([]);

    const on = classifyResponse("GET", "/api/reports/datasets", 200, withPlanted(), viewer, true);
    expect(JSON.stringify(on.value)).not.toContain(PLANTED); // absence
    expect(on.value).toEqual(classified()); // presence: everything classified is still there, unchanged
    expect(on.withheld).toEqual([{ path: "planted", class: "unclassified", level: "none" }]);
    expect(on.unclassified).toEqual(off.unclassified); // still reported: the gap is closed for the reader, not hidden from us
  });

  it("🔴 a nested planted key, and a route in neither table", () => {
    const nested = { items: [{ ...classified().items[0]!, extra: PLANTED }] };
    const on = classifyResponse("GET", "/api/reports/datasets", 200, nested, viewer, true);
    expect(JSON.stringify(on.value)).not.toContain(PLANTED);
    expect(on.value).toEqual(classified());
    expect(on.withheld).toEqual([{ path: "items[].extra", class: "unclassified", level: "none" }]);

    const nowhere = classifyResponse("GET", "/api/no-such-route-anywhere", 200, { secret: PLANTED }, viewer, true);
    expect([nowhere.value, nowhere.withheld]).toEqual([null, [{ path: "$", class: "unclassified", level: "none" }]]);
    // and off, that route is served as it was (and reported)
    expect(JSON.stringify(classifyResponse("GET", "/api/no-such-route-anywhere", 200, { secret: PLANTED }, viewer).value)).toContain(PLANTED);
  });

  it("🔴 a route OUTSIDE the contract (classified by its own table): a planted key is removed and listed there too", () => {
    const key = Object.keys(OUTSIDE_CONTRACT_ROUTES).find((k) => k.startsWith("GET ") && !k.includes("{"))!;
    expect(key, "the outside-contract table has a GET route with no parameter").toBeTruthy();
    const url = `/api${key.slice(4)}`;
    const off = classifyResponse("GET", url, 200, { plantedOutside: PLANTED }, viewer);
    expect([JSON.stringify(off.value).includes(PLANTED), off.withheld, off.unclassified.length]).toEqual([true, [], 1]);
    const on = classifyResponse("GET", url, 200, { plantedOutside: PLANTED }, viewer, true);
    expect([on.value, on.withheld]).toEqual([{}, [{ path: "plantedOutside", class: "unclassified", level: "none" }]]);
  });

  it("🔴 a key whose value is undefined is NOT SERVED (JSON drops it): it is neither unclassified nor withheld — and a real key beside it still is (found by the browser suite's capture, 2026-11-27: `window: undefined` on the VAT adjustment rows)", () => {
    const body = () => ({ items: [{ ...classified().items[0]!, neverSent: undefined }], alsoNeverSent: undefined });
    for (const deny of [false, true]) {
      const r = classifyResponse("GET", "/api/reports/datasets", 200, body(), viewer, deny);
      expect([deny, r.unclassified, r.withheld]).toEqual([deny, [], []]);
      expect(JSON.stringify(r.value)).toBe(JSON.stringify(classified()));
    }
    // the probe still sees: a key that IS sent, beside them, is caught and removed
    const planted = classifyResponse("GET", "/api/reports/datasets", 200, { ...body(), planted: PLANTED }, viewer, true);
    expect([planted.unclassified.length, planted.withheld]).toEqual([1, [{ path: "planted", class: "unclassified", level: "none" }]]);
    expect(JSON.stringify(planted.value)).not.toContain(PLANTED);
    // null IS sent, and is still classified
    expect(classifyResponse("GET", "/api/reports/datasets", 200, { ...classified(), sentAsNull: null }, viewer).unclassified.length).toBe(1);
    // a route outside the contract: the same
    const key = Object.keys(OUTSIDE_CONTRACT_ROUTES).find((k) => k.startsWith("GET ") && !k.includes("{"))!;
    const outside = classifyResponse("GET", `/api${key.slice(4)}`, 200, { neverSent: undefined }, viewer, true);
    expect([outside.unclassified, outside.withheld]).toEqual([[], []]);
  });

  it("🔴 a fully classified response is the same object, on or off", () => {
    const body = classified();
    expect(classifyResponse("GET", "/api/reports/datasets", 200, body, viewer, true).value).toBe(body);
    expect(classifyResponse("GET", "/api/reports/datasets", 200, body, viewer).value).toBe(body);
  });

  it("🔴 through the seam, in the test lane: on by default, and an unclassified key is STILL a 500 by name for every role — a test never loses a field silently", () => {
    primePermissionCache(PERMISSION_MATRIX);
    expect([process.env.NODE_ENV, defaultDenyOn()]).toEqual(["test", true]);
    for (const role of ["viewer", "bookkeeper", "accountant", "admin", undefined]) {
      const res = serve(role, "/api/reports/datasets", withPlanted());
      expect([role, res.status, (res.body as { code: string }).code]).toEqual([role, 500, "field_unclassified"]);
      expect((res.body as { fields: string[] }).fields.length).toBe(1);
      expect(JSON.stringify(res.body)).not.toContain(PLANTED);
    }
  });

  it("🔴 through the seam, OUTSIDE the test lane (the browser suite's server, production): on by default, a non-admin is served without the key and told so; the admin is not denied; each denial is written to the capture file", () => {
    primePermissionCache(PERMISSION_MATRIX);
    const capture = join(mkdtempSync(join(tmpdir(), "default-deny-")), "capture.jsonl");
    const before = { NODE_ENV: process.env.NODE_ENV, FIELD_CLASS_CAPTURE_FILE: process.env.FIELD_CLASS_CAPTURE_FILE };
    process.env.NODE_ENV = "production";
    process.env.FIELD_CLASS_CAPTURE_FILE = capture;
    try {
      for (const role of ["viewer", "bookkeeper", "accountant"]) {
        const on = serve(role, "/api/reports/datasets", withPlanted());
        expect([role, on.status, on.body]).toEqual([role, 200, classified()]);
        expect(JSON.parse(on.headers[WITHHELD_HEADER]!)).toEqual([{ path: "planted", class: "unclassified", level: "none" }]);
      }
      // the admin, and a request with no organization role, are served the key (and it is reported in the log)
      for (const role of ["admin", undefined]) {
        const res = serve(role, "/api/reports/datasets", withPlanted());
        expect([role, res.status, JSON.stringify(res.body).includes(PLANTED), res.headers[WITHHELD_HEADER]]).toEqual([role, 200, true, undefined]);
      }
      const lines = readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const denied = lines.filter((l) => l.denied === true);
      expect(denied.map((l) => [l.role, l.route, l.fields.length])).toEqual(["viewer", "bookkeeper", "accountant"].map((r) => [r, "GET /reports/datasets", 1]));
      expect(JSON.stringify(lines)).not.toContain(PLANTED); // names, never values
      // a classified response writes nothing
      const n = lines.length;
      serve("viewer", "/api/reports/datasets", classified());
      expect(readFileSync(capture, "utf8").trim().split("\n").length).toBe(n);
    } finally {
      process.env.NODE_ENV = before.NODE_ENV;
      if (before.FIELD_CLASS_CAPTURE_FILE === undefined) delete process.env.FIELD_CLASS_CAPTURE_FILE; else process.env.FIELD_CLASS_CAPTURE_FILE = before.FIELD_CLASS_CAPTURE_FILE;
    }
  });

  it("🔴 the capture is shown to be ON: the server's start writes one `started` line, afresh — and nothing when no capture is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "default-deny-"));
    const capture = join(dir, "capture.jsonl");
    const before = process.env.FIELD_CLASS_CAPTURE_FILE;
    try {
      delete process.env.FIELD_CLASS_CAPTURE_FILE;
      announceFieldClassCapture();
      expect(existsSync(capture)).toBe(false);
      writeFileSync(capture, `${JSON.stringify({ denied: true, route: "left over from an earlier run" })}\n`);
      process.env.FIELD_CLASS_CAPTURE_FILE = capture;
      announceFieldClassCapture();
      expect(readFileSync(capture, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ started: true, pid: process.pid, defaultDeny: true }]);
    } finally {
      if (before === undefined) delete process.env.FIELD_CLASS_CAPTURE_FILE; else process.env.FIELD_CLASS_CAPTURE_FILE = before;
    }
  });

  it("🔴 a test that asks to see the enforcement gets it (the dry run's way): a viewer is served without the key and told so", () => {
    primePermissionCache(PERMISSION_MATRIX);
    __setDefaultDenyForTests(true);
    for (const role of ["viewer", "bookkeeper", "accountant"]) {
      const on = serve(role, "/api/reports/datasets", withPlanted());
      expect([role, on.status, on.body]).toEqual([role, 200, classified()]);
      expect(JSON.parse(on.headers[WITHHELD_HEADER]!)).toEqual([{ path: "planted", class: "unclassified", level: "none" }]);
    }
    // the admin, and a request with no organization role, are not denied: they are handled as with the switch off
    for (const role of ["admin", undefined]) {
      const res = serve(role, "/api/reports/datasets", withPlanted());
      expect([role, res.status, (res.body as { code: string }).code]).toEqual([role, 500, "field_unclassified"]);
      expect(res.headers[WITHHELD_HEADER]).toBeUndefined();
    }
    // and a classified response is served whole to everyone, with nothing listed
    const whole = serve("viewer", "/api/reports/datasets", classified());
    expect([whole.status, whole.body, whole.headers[WITHHELD_HEADER]]).toEqual([200, classified(), undefined]);
  });
});
