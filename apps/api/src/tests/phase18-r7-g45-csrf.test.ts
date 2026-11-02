/**
 * 🔴 Phase 18 R-7 — G45, memo §2d (register §11.102): a CSRF check on every
 * POST, PUT, PATCH and DELETE.
 *
 *   Sec-Fetch-Site present → only `same-origin` passes;
 *   absent → Origin must equal a configured application origin EXACTLY;
 *   Origin absent too → the Referer's origin must;
 *   none of the three, or a malformed value → refused.
 *
 * The app on a real port; every request goes to an AUTHENTICATED route with no
 * session, so a request the check lets through reaches the route and is told
 * 401, and one it refuses is told 403 `csrf_refused` — the two are never the
 * same answer. Every refusal sits beside a control that passes.
 *
 * The configured application origins are `CORS_ALLOWED_ORIGINS` (§11.102);
 * this file sets it, so the expected origin is known.
 */
process.env.PORT ??= "3217";
process.env.SESSION_SECRET ??= "r7-g45-csrf-check-000000000000000001";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "@workspace/config";
import { g04Harness } from "./helpers/g04Harness";

const APP = "http://localhost:5173";
const ROUTE = "/vendors";

describe("Phase 18 R-7 (G45) — a CSRF check on every unsafe request", () => {
  const h = g04Harness("r7csrf");

  /** One request with exactly these headers (no cookie): the status and the refusal code, if any. */
  async function send(method: string, headers: Record<string, string>, path = ROUTE) {
    const res = await fetch(`${h.state.base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "GET" ? undefined : JSON.stringify({ name: "R7 probe" }),
    });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, code: body?.code as string | undefined, body };
  }
  const refused = { status: 403, code: "csrf_refused" };
  const passed = (r: { status: number; code?: string }) => r.status === 401 && r.code !== "csrf_refused";
  const verdict = (r: { status: number; code?: string }) => (r.status === 403 && r.code === "csrf_refused" ? "refused" : passed(r) ? "passed" : `other:${r.status}:${r.code}`);

  beforeAll(async () => { await h.start(); }, 60_000);
  afterAll(async () => { await h.stop(); });

  describe("Sec-Fetch-Site present: only same-origin passes", () => {
    it("control — `same-origin` passes, and reaches the route (401, no session)", async () => {
      expect(verdict(await send("POST", { "sec-fetch-site": "same-origin" }))).toBe("passed");
    });
    for (const value of ["same-site", "cross-site", "none", "something-else"]) {
      it(`🔴 \`${value}\` is refused (403 csrf_refused) — even with an exact Origin beside it`, async () => {
        const r = await send("POST", { "sec-fetch-site": value, origin: APP });
        expect({ status: r.status, code: r.code }).toEqual(refused);
        expect(typeof r.body?.errorAr).toBe("string");
      });
    }
  });

  describe("Sec-Fetch-Site absent: the Origin must be the application's, exactly", () => {
    it("control — the exact Origin passes", async () => {
      expect(verdict(await send("POST", { origin: APP }))).toBe("passed");
    });
    const lookalikes: Array<[string, string]> = [
      ["a suffix", "http://localhost:5173.evil.test"],
      ["a subdomain", "http://evil.localhost:5173"],
      ["another port", "http://localhost:51730"],
      ["another scheme", "https://localhost:5173"],
      ["another host", "http://evil.test"],
    ];
    for (const [what, origin] of lookalikes) {
      it(`🔴 a lookalike Origin — ${what} (${origin}) — is refused`, async () => {
        const r = await send("POST", { origin });
        expect({ status: r.status, code: r.code }).toEqual(refused);
      });
    }
    for (const [what, origin] of [["a path", `${APP}/x`], ["the opaque `null`", "null"], ["garbage", "not a url"]] as const) {
      it(`🔴 a malformed Origin — ${what} — is refused, never treated as absent (the exact Referer beside it does not rescue it)`, async () => {
        const r = await send("POST", { origin, referer: `${APP}/vendors` });
        expect({ status: r.status, code: r.code }).toEqual(refused);
      });
    }
  });

  describe("Origin absent too: the Referer's origin must be the application's", () => {
    it("control — a same-origin Referer with a path passes", async () => {
      expect(verdict(await send("POST", { referer: `${APP}/vendors/12?tab=bills` }))).toBe("passed");
    });
    for (const referer of ["http://localhost:5173.evil.test/vendors", "http://evil.test/?u=http://localhost:5173", "not a url"]) {
      it(`🔴 a Referer that is not the application's (${referer}) is refused`, async () => {
        const r = await send("POST", { referer });
        expect({ status: r.status, code: r.code }).toEqual(refused);
      });
    }
  });

  describe("none of the three: refused, on every unsafe method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      it(`🔴 ${method} with no Sec-Fetch-Site, no Origin and no Referer is refused`, async () => {
        const r = await send(method, {}, method === "POST" ? ROUTE : `${ROUTE}/1`);
        expect({ status: r.status, code: r.code }).toEqual(refused);
      });
    }
    it("control — a GET with no headers is not checked (it reaches the route: 401)", async () => {
      expect(verdict(await send("GET", {}))).toBe("passed");
    });
  });

  describe("the configured application origins are exact origins (boot)", () => {
    const withOrigins = (value: string) => {
      resetEnvCache();
      try { return loadEnv({ ...process.env, CORS_ALLOWED_ORIGINS: value }) && "accepted"; }
      catch (e) { return /CORS_ALLOWED_ORIGINS/.test(String(e)) ? "refused" : `other:${String(e).slice(0, 80)}`; }
      finally { resetEnvCache(); }
    };
    it("control — exact origins boot", () => {
      expect(withOrigins("http://localhost:5173,https://app.example.sa")).toBe("accepted");
    });
    it("🔴 an origin with a path, or a trailing slash, refuses the boot (it could never equal an Origin header)", () => {
      expect([withOrigins("https://app.example.sa/app"), withOrigins("https://app.example.sa/")]).toEqual(["refused", "refused"]);
    });
  });
});
