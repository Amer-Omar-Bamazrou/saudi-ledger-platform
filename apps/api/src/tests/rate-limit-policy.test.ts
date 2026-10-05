/**
 * Rate limiting — the pure parts: the client IP key, the account key, the
 * endpoint classifier, and the 429 contract's arithmetic. No database.
 *
 * The HTTP behaviour is `rate-limit-budget.test.ts` (authenticated) and
 * `rate-limit-login.test.ts` (pre-session); this file pins the functions they
 * key and classify with, including the BYPASSES each one exists to close.
 */
import { describe, expect, it } from "vitest";
import { accountKeyOf, clientIpKey, forwardedForIgnored, rateLimitedBody, retryAfterSecondsFrom } from "../lib/rateLimit";
import { BUDGET_POLICY, CLASS_RULES, classesOf, normalizedApiPath } from "../lib/requestBudget";

describe("the client IP key", () => {
  it("an IPv4 client is its address; the IPv4-mapped IPv6 form is the same client", () => {
    expect(clientIpKey("203.0.113.7")).toBe("ip:203.0.113.7");
    expect(clientIpKey("::ffff:203.0.113.7")).toBe("ip:203.0.113.7");
    expect(clientIpKey("::FFFF:203.0.113.7")).toBe("ip:203.0.113.7");
    expect(clientIpKey("203.0.113.8")).not.toBe(clientIpKey("203.0.113.7"));
  });

  it("🔴 an IPv6 client cannot mint fresh buckets by rotating addresses inside its own /56", () => {
    // The same subscriber's allocation, four different interface addresses.
    const a = clientIpKey("2001:db8:abcd:1200::1");
    expect(clientIpKey("2001:db8:abcd:1201::1")).toBe(a);
    expect(clientIpKey("2001:db8:abcd:12ff:ffff:ffff:ffff:ffff")).toBe(a);
    expect(clientIpKey("2001:0db8:abcd:1234:0:0:0:9")).toBe(a);
    expect(a).toBe("ip6:2001:db8:abcd:1200::/56");
    // …and a neighbouring /56 is a different client (the presence AND the absence).
    expect(clientIpKey("2001:db8:abcd:1300::1")).not.toBe(a);
    expect(clientIpKey("2001:db8:abce:1200::1")).not.toBe(a);
  });

  it("every IPv6 spelling of one address is one key (compressed, full, zone id, embedded IPv4, case)", () => {
    expect(clientIpKey("::1")).toBe("ip6:0:0:0:0::/56");
    expect(clientIpKey("0:0:0:0:0:0:0:1")).toBe("ip6:0:0:0:0::/56");
    expect(clientIpKey("fe80::1%eth0")).toBe(clientIpKey("fe80::2"));
    expect(clientIpKey("64:ff9b::192.0.2.33")).toBe("ip6:64:ff9b:0:0::/56");
    expect(clientIpKey("2001:DB8:ABCD:1200::1")).toBe("ip6:2001:db8:abcd:1200::/56");
    expect(clientIpKey("2001:db8::")).toBe("ip6:2001:db8:0:0::/56");
  });

  it("an IPv4-mapped address is its IPv4 client in every spelling — it does not share the ::/56 bucket", () => {
    expect(clientIpKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("ip:203.0.113.7");
    expect(clientIpKey("::ffff:cb00:7107")).toBe("ip:203.0.113.7");
    expect(clientIpKey("::ffff:cb00:7108")).not.toBe(clientIpKey("::1"));
  });

  it("no address, or not an address, is ONE shared bucket — never a free pass", () => {
    expect(clientIpKey(undefined)).toBe("ip:unknown");
    expect(clientIpKey("")).toBe("ip:unknown");
    expect(clientIpKey("not-an-ip")).toBe("ip:unknown");
  });
});

describe("the untrusted-proxy signal (C1)", () => {
  const req = (xff: string | undefined, trustProxy: unknown) =>
    ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, app: { get: () => trustProxy } }) as never;
  it("fires only when the header arrives AND no proxy is trusted", () => {
    expect(forwardedForIgnored(req("203.0.113.9", false))).toBe(true);
    expect(forwardedForIgnored(req("203.0.113.9", 1)), "TRUST_PROXY_HOPS set: the header is read, not ignored").toBe(false);
    expect(forwardedForIgnored(req(undefined, false)), "no header: nothing to say").toBe(false);
  });
});

describe("the account key", () => {
  it("🔴 case and surrounding space do not make a second account budget", () => {
    expect(accountKeyOf(" Victim@Example.COM ")).toBe(accountKeyOf("victim@example.com"));
    expect(accountKeyOf("other@example.com")).not.toBe(accountKeyOf("victim@example.com"));
  });

  it("🔴 the key is a digest: no email is stored, and no typed value (a NUL byte) can make the counter write fail", () => {
    expect(accountKeyOf("victim@example.com")).toMatch(/^acct:[0-9a-f]{64}$/);
    expect(accountKeyOf("victim@example.com")).not.toContain("victim");
    expect(accountKeyOf("\u0000evil@example.com")).toMatch(/^acct:[0-9a-f]{64}$/);
  });
});

describe("the endpoint classifier", () => {
  const req = (p: string) => normalizedApiPath({ baseUrl: "", path: p });

  it("🔴 normalises the way the ROUTER matches: case, a trailing slash, doubled slashes", () => {
    expect(req("/API/Reports/Trial-Balance/")).toBe("/api/reports/trial-balance");
    expect(req("/api//reports///trial-balance")).toBe("/api/reports/trial-balance");
    expect(normalizedApiPath({ baseUrl: "/api", path: "/Capture/" })).toBe("/api/capture");
    expect(req("/")).toBe("/");
  });

  it("every request is in the burst and general buckets; writes add the write bucket", () => {
    expect(classesOf("GET", "/api/customers")).toEqual(["burst", "general"]);
    expect(classesOf("POST", "/api/customers")).toEqual(["burst", "general", "write"]);
    expect(classesOf("PATCH", "/api/customers/1")).toEqual(["burst", "general", "write"]);
    expect(classesOf("DELETE", "/api/invoices/1")).toEqual(["burst", "general", "write"]);
  });

  it("the special classes, and that an export is an EXPORT, not merely a report", () => {
    expect(classesOf("GET", "/api/reports/trial-balance")).toContain("report");
    expect(classesOf("GET", "/api/analytics/trend")).toContain("report");
    expect(classesOf("GET", "/api/reports/export/trial-balance")).toEqual(["burst", "general", "export"]);
    expect(classesOf("GET", "/api/invoices/abc/document")).toContain("export");
    expect(classesOf("POST", "/api/capture")).toEqual(["burst", "general", "write", "upload"]);
    expect(classesOf("POST", "/api/ask")).toContain("ai");
    expect(classesOf("GET", "/api/ask")).toEqual(["burst", "general"]); // the history list calls no model
    expect(classesOf("POST", "/api/zatca/onboarding/renew")).toContain("zatca_otp");
    expect(classesOf("POST", "/api/operator/users/reset-password")).toContain("break_glass");
    expect(classesOf("PUT", "/api/migration/batches/b1/open-items")).toContain("bulk");
    expect(classesOf("PATCH", "/api/migration/batches/b1/open-items/7")).not.toContain("bulk"); // one row's decision
  });

  it("HEAD is a GET to the router, so it is one to the classifier (a report cannot be read for free by HEAD)", () => {
    expect(classesOf("HEAD", "/api/reports/trial-balance")).toContain("report");
  });

  it("every class rule names a class the policy defines", () => {
    for (const r of CLASS_RULES) expect(BUDGET_POLICY[r.cls], String(r.path)).toBeDefined();
  });
});

describe("the policy numbers", () => {
  it("every organization budget is at least its user budget, over the same window", () => {
    for (const [cls, p] of Object.entries(BUDGET_POLICY)) {
      const org = (p as { org?: { limit: number; windowMs: number } }).org;
      if (!org) continue;
      expect(org.limit, cls).toBeGreaterThanOrEqual(p.user.limit);
      expect(org.windowMs, cls).toBe(p.user.windowMs);
    }
  });
});

describe("the 429 contract", () => {
  it("Retry-After is whole seconds, rounded UP, and never 0", () => {
    expect(retryAfterSecondsFrom(0)).toBe(1);
    expect(retryAfterSecondsFrom(-500)).toBe(1);
    expect(retryAfterSecondsFrom(1)).toBe(1);
    expect(retryAfterSecondsFrom(1000)).toBe(1);
    expect(retryAfterSecondsFrom(1001)).toBe(2);
    expect(retryAfterSecondsFrom(899_200)).toBe(900);
  });

  it("the body: a stable code, the wait in seconds, and words that name no limit", () => {
    const b = rateLimitedBody(42);
    expect(b).toEqual({ code: "rate_limited", retryAfterSeconds: 42, error: expect.stringContaining("42 seconds") });
    expect(b.error).not.toMatch(/account|ip|user|organi[sz]ation/i);
  });
});
