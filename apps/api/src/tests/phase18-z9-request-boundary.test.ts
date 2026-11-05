/**
 * 🔴 Phase 18 final round (owner, 2026-11-05): "Refuse a NUL in any string field, and an out-of-range id in any path,
 * with a 4xx refusal like #297's. The test must send both to every route that takes a body or an id, listed from the
 * router the way tests/route-reachability.test.ts does, not to a sample." Register §11.150.
 *
 * The list is read from the route files, so a route added later is covered without anyone remembering to add it, and a
 * route whose shape the reader cannot parse fails the count below instead of being skipped. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3221";
process.env.SESSION_SECRET ??= "z9-request-boundary-00000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { appOriginHeader } from "./helpers/appOrigin";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Z9RequestBoundaryPw1!";

const ROUTES_DIR = join(__dirname, "..", "routes");
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Route = { method: string; path: string; file: string };

/** Every route the router serves, read from routes/index.ts and followed through every mount. */
function listRoutes(): { routes: Route[]; declared: number; files: string[] } {
  const routes: Route[] = [];
  const seen = new Set<string>();
  let declared = 0;

  const walkFile = (file: string, prefix: string) => {
    const src = readFileSync(file, "utf8");
    if (!seen.has(file)) {
      seen.add(file);
      // A separate, deliberately simple count of what the file declares: if the reader below misses a shape, the two differ.
      declared += [...src.matchAll(/^\s*\w+\.(?:get|post|put|patch|delete)\(\s*["'`]\//gm)].length;
    }
    const imports = new Map<string, string>();
    for (const m of src.matchAll(/^import\s+(\w+)\s+from\s+["'](\.[^"']+)["']/gm)) {
      imports.set(m[1], join(dirname(file), m[2].replace(/\.js$/, "") + ".ts"));
    }
    const routers = [...src.matchAll(/const\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*Router\(/g)].map((m) => m[1]);

    const walkRouter = (name: string, at: string) => {
      for (const m of src.matchAll(new RegExp(`\\b${name}\\.(${METHODS.join("|")})\\(\\s*["'\`]([^"'\`]*)["'\`]`, "g"))) {
        routes.push({ method: m[1].toUpperCase(), path: `${at}${m[2] === "/" ? "" : m[2]}`, file });
      }
      for (const m of src.matchAll(new RegExp(`\\b${name}\\.use\\(\\s*["'\`]([^"'\`]+)["'\`]([\\s\\S]*?)\\);`, "g"))) {
        const last = [...m[2].matchAll(/\b([A-Za-z_]\w*)\b/g)].map((x) => x[1]).filter((id) => imports.has(id) || routers.includes(id)).pop();
        if (!last) continue;
        if (imports.has(last)) walkFile(imports.get(last)!, `${at}${m[1]}`);
        else if (last !== name) walkRouter(last, `${at}${m[1]}`);
      }
    };

    const exported = src.match(/export default (\w+)/)?.[1] ?? "router";
    walkRouter(exported, prefix);
  };

  walkFile(join(ROUTES_DIR, "index.ts"), "");
  return { routes, declared, files: [...seen] };
}

/** Sessions end on some routes, so the routes that act on the session itself go last on code that does not refuse them. */
const lastOf = (r: Route) => (r.path.startsWith("/auth") ? 1 : 0);

describeMaybe("the request boundary refuses what the database cannot hold, on every route", () => {
  const h = g04Harness("z9ref");
  const { routes, declared, files } = listRoutes();
  const ordered = [...routes].sort((a, b) => lastOf(a) - lastOf(b));
  const withBody = ordered.filter((r) => r.method !== "GET");
  const withParam = ordered.filter((r) => r.path.includes(":"));

  let orgId = "";
  let vendorId = 0;
  let cookie = "";
  let operatorCookie = "";
  let sweeperCookie = "";

  /** A request whose bytes are exactly these, on the admin's session. */
  const send = async (method: string, path: string, opts: { body?: string | Buffer; type?: string; anonymous?: boolean; as?: string } = {}) => {
    const res = await fetch(`${h.state.base}${path}`, {
      method,
      headers: {
        ...appOriginHeader(),
        ...(opts.type ? { "content-type": opts.type } : {}),
        ...(opts.anonymous ? {} : { cookie: opts.as ?? cookie }),
      },
      body: opts.body,
    });
    const text = await res.text();
    let json: { code?: string; field?: string; error?: string } = {};
    try { json = JSON.parse(text); } catch { /* not JSON: the assertion below prints the status */ }
    return { status: res.status, code: json.code, field: json.field, text };
  };

  const json = (value: unknown) => ({ body: JSON.stringify(value), type: "application/json" });

  /** Every param of a route in turn set to `bad`, the others to a harmless in-range id. */
  const urlsWith = (path: string, bad: string): string[] => {
    const count = [...path.matchAll(/:\w+/g)].length;
    return Array.from({ length: count }, (_, i) => {
      let n = -1;
      return path.replace(/:\w+/g, () => { n += 1; return n === i ? bad : "1"; });
    });
  };

  const vendorCount = async () =>
    (await pool.query(`SELECT count(*)::int AS n FROM vendors WHERE organization_id = $1`, [orgId])).rows[0].n as number;

  const sessionOf = async (who: string): Promise<string> => {
    const login = await fetch(`${h.state.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...appOriginHeader() },
      body: JSON.stringify({ email: h.email(who), password: PW }),
    });
    expect(login.status).toBe(200);
    return (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="))!.split(";")[0]!;
  };
  const signIn = async () => { cookie = await sessionOf("admin"); };

  // On code that does not refuse at the boundary, a request can reach POST /auth/logout and end the session. Each check
  // starts signed in, so that what it measures is the route and not a session an earlier check ended.
  beforeEach(async () => {
    if ((await send("GET", "/auth/me")).status === 401) await signIn();
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("main");
    await h.mkCompany(orgId, "Z9 Co", "300000000000003");
    await h.mkUser("admin", PW, orgId, "admin");
    // The sweep below reaches the routes, so it spends a request budget: its own user's, so that the other checks keep theirs.
    await h.mkUser("sweeper", PW, orgId, "admin");
    const operatorId = await h.mkUser("operator", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [operatorId]);
    await h.start();
    await signIn();
    operatorCookie = await sessionOf("operator");
    sweeperCookie = await sessionOf("sweeper");
    const vendor = await send("POST", "/vendors", json({ name: "Z9 Supplier", residency: "resident" }));
    expect(vendor.status, vendor.text).toBe(201);
    vendorId = JSON.parse(vendor.text).id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  describe("the list is the router, not a sample", () => {
    it("🔴 the reader found every route the files declare", () => {
      expect(routes.length, "the reader lost a route shape").toBeGreaterThanOrEqual(declared);
      expect(routes.length).toBeGreaterThan(400);
      expect(withBody.length).toBeGreaterThan(150);
      expect(withParam.length).toBeGreaterThan(150);
    });

    it("🔴 it can see routes known to be there, at the depth they are mounted", () => {
      const has = (method: string, path: string) => routes.some((r) => r.method === method && r.path === path);
      expect(has("POST", "/supplier-payments")).toBe(true);
      expect(has("POST", "/auth/login")).toBe(true);
      expect(has("GET", "/vendors/:id")).toBe(true);
      expect(has("POST", "/vendors")).toBe(true);
      expect(has("GET", "/reports/export/:report")).toBe(true);
      expect(has("PUT", "/treasury/settings")).toBe(true);
      expect(has("POST", "/zatca/onboarding/renew")).toBe(true);
      expect(has("GET", "/invitations/:token")).toBe(true);
    });
  });

  describe("a NUL in any string field", () => {
    it("🔴 every route that takes a body refuses it with 400, naming the field", async () => {
      const wrong: string[] = [];
      for (const r of withBody) {
        const path = r.path.replace(/:\w+/g, "1");
        const res = await send(r.method, path, json({ name: "z9\u0000", note: "fine" }));
        const isLogin = r.method === "POST" && r.path === "/auth/login";
        const ok = isLogin
          ? [400, 401].includes(res.status)
          : res.status === 400 && res.code === "nul_in_text" && res.field === "name";
        if (!ok) wrong.push(`${r.method} ${r.path} -> ${res.status} ${res.code ?? ""}`);
      }
      expect(wrong, `${wrong.length} of ${withBody.length} routes`).toEqual([]);
    }, 300_000);

    it.each([
      ["nested in an object", { a: { b: { c: "x\u0000" } } }, "a.b.c"],
      ["in an array", { lines: [{ description: "ok" }, { description: "x\u0000" }] }, "lines.1.description"],
      ["in a plain array", { tags: ["ok", "x\u0000"] }, "tags.1"],
      ["in a key", { "bad\u0000key": "ok" }, "badkey"],
    ])("🔴 %s", async (_name, body, field) => {
      const before = await vendorCount();
      const r = await send("POST", "/vendors", json(body));
      expect(r.status, r.text).toBe(400);
      expect([r.code, r.field]).toEqual(["nul_in_text", field]);
      expect(await vendorCount()).toBe(before);
    });

    it("🔴 a form-encoded body too", async () => {
      const r = await send("POST", "/vendors", { body: "name=z9%00&residency=resident", type: "application/x-www-form-urlencoded" });
      expect(r.status, r.text).toBe(400);
      expect(r.code).toBe("nul_in_text");
    });

    it("🔴 before anything else: nothing is written, and it needs no session to say so", async () => {
      const before = await vendorCount();
      const r = await send("POST", "/vendors", { ...json({ name: "z9\u0000", residency: "resident" }), anonymous: true });
      expect(r.status, r.text).toBe(400);
      expect(await vendorCount()).toBe(before);
    });

    it("🔴 a very deep body is refused or accepted, never a crash", async () => {
      const deep = `${"[".repeat(20_000)}"x\\u0000"${"]".repeat(20_000)}`;
      const r = await send("POST", "/vendors", { body: deep, type: "application/json" });
      expect(r.status, r.text.slice(0, 200)).toBe(400);
    });

    it("🔴 sign-in stays with its limiter and #297's guard: a NUL there is 400 or 401, and signs nobody in", async () => {
      const r = await send("POST", "/auth/login", { ...json({ email: `${h.email("admin")}\u0000`, password: PW }), anonymous: true });
      expect([400, 401], r.text).toContain(r.status);
      expect(r.text).not.toContain(h.email("admin"));
    });

    it("🔴 the same request without the NUL is accepted (the refusal is about the NUL, not the request)", async () => {
      const before = await vendorCount();
      const r = await send("POST", "/vendors", json({ name: "مورد 50%00 \\0 ok", residency: "resident" }));
      expect(r.status, r.text).toBe(201);
      expect(await vendorCount()).toBe(before + 1);
      expect(JSON.parse(r.text).name).toBe("مورد 50%00 \\0 ok");
    });
  });

  describe("a multipart body, parsed later than the others", () => {
    const boundary = "z9boundary";
    /** The field each upload route reads its one file from; any other file field fails the parse before it can be checked. */
    const FILE_FIELD: Record<string, string> = { "POST /capture": "document", "POST /onboarding/documents": "file", "PUT /companies/current/logo": "file" };
    const multipart = (fileField: string, fieldValue: string, fileName: string) =>
      Buffer.from(
        [
          `--${boundary}`, `Content-Disposition: form-data; name="type"`, ``, fieldValue,
          `--${boundary}`, `Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"`, `Content-Type: application/pdf`, ``, `%PDF-1.4 z9`,
          `--${boundary}--`, ``,
        ].join("\r\n"),
        "latin1",
      );

    const uploads = routes.filter((r) => `${r.method} ${r.path}` in FILE_FIELD);

    it("🔴 the list holds every upload route: all three, and no route file parses a multipart body elsewhere", () => {
      expect(uploads.length).toBe(3);
      const calls = files.map((f) => (readFileSync(f, "utf8").match(/uploadSingle\(\w+, "/g) ?? []).length).reduce((x, y) => x + y, 0);
      expect(calls, "a new upload route: add it above").toBe(uploads.length);
    });

    it("🔴 every upload route refuses a NUL in a text field", async () => {
      const wrong: string[] = [];
      for (const r of uploads) {
        const res = await send(r.method, r.path, { body: multipart(FILE_FIELD[`${r.method} ${r.path}`]!, "z9\u0000", "z9.pdf"), type: `multipart/form-data; boundary=${boundary}` });
        if (res.status !== 400 || res.code !== "nul_in_text") wrong.push(`${r.method} ${r.path} -> ${res.status} ${res.text.slice(0, 120)}`);
      }
      expect(wrong).toEqual([]);
    });

    it("🔴 every upload route refuses a NUL in the file's name, raw (the parser's own refusal) or escaped (ours)", async () => {
      const wrong: string[] = [];
      for (const r of uploads) {
        const field = FILE_FIELD[`${r.method} ${r.path}`]!;
        const raw = await send(r.method, r.path, { body: multipart(field, "other", "z9\u0000.pdf"), type: `multipart/form-data; boundary=${boundary}` });
        if (raw.status !== 400) wrong.push(`raw ${r.method} ${r.path} -> ${raw.status} ${raw.text.slice(0, 120)}`);
        const escaped = await send(r.method, r.path, {
          body: Buffer.from(multipart(field, "other", "z9.pdf").toString("latin1").replace(`filename="z9.pdf"`, `filename*=UTF-8''z9%00.pdf`), "latin1"),
          type: `multipart/form-data; boundary=${boundary}`,
        });
        if (escaped.status !== 400 || escaped.code !== "nul_in_text") wrong.push(`escaped ${r.method} ${r.path} -> ${escaped.status} ${escaped.text.slice(0, 120)}`);
      }
      expect(wrong).toEqual([]);
    });
  });

  describe("an id in a path that no integer column could hold", () => {
    it.each(["99999999999", "2147483648", "-2147483649", "1e20", "1.5", "Infinity", "%39%39%39%39%39%39%39%39%39%39%39"])(
      "🔴 every route that takes one refuses %s with 400, in every position",
      async (bad) => {
        const wrong: string[] = [];
        let sent = 0;
        for (const r of withParam) {
          for (const path of urlsWith(r.path, bad)) {
            sent += 1;
            const res = await send(r.method, path, r.method === "GET" ? {} : json({}));
            if (res.status !== 400 || res.code !== "invalid_id_in_path") wrong.push(`${r.method} ${path} -> ${res.status} ${res.code ?? ""}`);
          }
        }
        expect(sent).toBeGreaterThanOrEqual(withParam.length);
        expect(wrong, `${wrong.length} of ${sent} requests`).toEqual([]);
      },
      300_000,
    );

    it("🔴 a NUL in a path or query is refused on every route", async () => {
      const wrong: string[] = [];
      for (const r of withParam) {
        for (const path of urlsWith(r.path, "z9%00")) {
          const res = await send(r.method, path, r.method === "GET" ? {} : json({}));
          if (res.status !== 400 || res.code !== "nul_in_url") wrong.push(`${r.method} ${path} -> ${res.status}`);
        }
      }
      for (const r of ordered.filter((x) => x.method === "GET")) {
        const res = await send("GET", `${r.path.replace(/:\w+/g, "1")}?q=z9%00`);
        if (res.status !== 400 || res.code !== "nul_in_url") wrong.push(`GET ${r.path}?q -> ${res.status}`);
      }
      expect(wrong).toEqual([]);
    }, 300_000);

    it("🔴 a value that cannot be an id at all answers no route with a 500, in every position, as admin and as operator", async () => {
      const wrong: string[] = [];
      let limited = 0;
      let sent = 0;
      for (const r of withParam) {
        for (const path of urlsWith(r.path, "abc")) {
          sent += 1;
          const res = await send(r.method, path, { ...(r.method === "GET" ? {} : json({})), as: r.path.startsWith("/operator") ? operatorCookie : sweeperCookie });
          if (res.status === 429) limited += 1;
          if (res.status >= 500) wrong.push(`${r.method} ${path} -> ${res.status}`);
        }
      }
      expect(wrong, `${wrong.length} of ${sent} requests`).toEqual([]);
      // A 429 is not a 500, so too many would hide a route: the sweep must fit inside the request budget.
      expect(limited, "requests the budget refused before the route saw them").toBeLessThan(25);
    }, 300_000);

    it.each(["1", "0", "-1", "abc", "00000000-0000-0000-0000-00000000000g"])("🔴 a UUID-keyed path refuses %s, even where it is a fine integer", async (bad) => {
      const orgPaths = [["GET", `/orgs/${bad}/members`], ["GET", `/orgs/${orgId}/invitations`, "keep"], ["DELETE", `/orgs/${orgId}/invitations/${bad}`], ["GET", `/onboarding/documents/${bad}`], ["GET", `/capture/${bad}`], ["GET", `/capture/${bad}/image`], ["POST", `/capture/${bad}/discard`], ["GET", `/recurring/${bad}/runs`], ["POST", `/recurring/${bad}/pause`], ["POST", `/recurring/${bad}/resume`], ["DELETE", `/recurring/${bad}`]] as const;
      for (const [method, path, keep] of orgPaths) {
        const r = await send(method, path, method === "GET" ? {} : json({}));
        if (keep) expect(r.status, `${path} ${r.text}`).toBe(200);
        else expect([r.status, r.code], `${method} ${path} ${r.text}`).toEqual([400, "invalid_id_in_path"]);
      }
      for (const path of [`/operator/applications/${bad}`, `/operator/applications/${orgId}/documents/${bad}`]) {
        const r = await send("GET", path, { as: operatorCookie });
        expect([r.status, r.code], `${path} ${r.text}`).toEqual([400, "invalid_id_in_path"]);
      }
    });

    it("🔴 a real UUID in the same paths is not refused: it reads as the route's own answer", async () => {
      const unknown = "00000000-0000-4000-8000-000000000000";
      for (const path of [`/capture/${unknown}`, `/recurring/${unknown}/runs`, `/onboarding/documents/${unknown}`]) {
        const r = await send("GET", path);
        expect(r.code, `${path} ${r.text}`).not.toBe("invalid_id_in_path");
        expect(r.status, `${path} ${r.text}`).toBeLessThan(500);
      }
      expect((await send("GET", `/operator/applications/${orgId}`, { as: operatorCookie })).status).toBe(200);
    });

    it("🔴 the largest id an integer column can hold is not refused here: it is simply not found", async () => {
      const r = await send("GET", "/vendors/2147483647");
      expect(r.status, r.text).toBe(404);
    });

    it("🔴 a real id still works, and nothing else in a path is mistaken for an id", async () => {
      expect((await send("GET", `/vendors/${vendorId}`)).status).toBe(200);
      expect((await send("GET", `/orgs/${orgId}/members`)).status).toBe(200);
      const report = await send("GET", "/reports/trial-balance");
      expect(report.code).not.toBe("invalid_id_in_path");
      const period = await send("GET", "/period-locks/2026-11");
      expect(period.code).not.toBe("invalid_id_in_path");
    });

    it("🔴 a value that is merely not a positive id stays with the route, as before", async () => {
      expect((await send("GET", "/vendors/abc")).status).toBe(400);
      expect((await send("GET", "/vendors/0")).status).toBe(400);
      expect((await send("GET", "/vendors/-1")).status).toBe(400);
    });

    it("🔴 a malformed path escape is refused on every route, in every position (the router's own decode error reached the error handler as a 500)", async () => {
      const wrong: string[] = [];
      for (const r of withParam) {
        for (const path of urlsWith(r.path, "%E0%A4%A")) {
          const res = await send(r.method, path, r.method === "GET" ? {} : json({}));
          if (res.status !== 400 || res.code !== "malformed_path") wrong.push(`${r.method} ${path} -> ${res.status}`);
        }
      }
      expect(wrong).toEqual([]);
    }, 300_000);
  });
});
