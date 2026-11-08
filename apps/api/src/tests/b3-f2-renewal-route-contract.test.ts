/**
 * 🔴 Carry-over Batch 3, F-2 (the owner, 2026-11-07): `POST /zatca/onboarding/renew` enters the CONTRACT, so the
 * renewal screen calls it through the generated client. A spec entry nobody has parsed a response against is a claim,
 * not a contract (CLAUDE.md §3), so this parses the route's real responses against the GENERATED schema:
 *  - a renewal that activates (a new expiry) and one that does not (no new certificate: the expiry is null);
 *  - a role that is not admin is refused 403 `requires_approval_authority`, and the provider is never reached.
 *
 * 🔴 STAND-IN, named: the ZATCA provider (`resolveProvider`) is a fake returning a fixed outcome, as in
 * phase18-h13-dr22: a real one would call ZATCA. Under test is the route → controller → response shape, over HTTP,
 * on the real database. Renewal against ZATCA itself is exercised only against the sandbox (the onboarding flow).
 */
process.env.PORT ??= "3291";
process.env.SESSION_SECRET ??= "b3-f2-renewal-route-contract-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RenewZatcaCertificateResponse } from "@workspace/api-zod";
import { g04Harness } from "./helpers/g04Harness";

type Check = { label: string; passed: boolean; errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> };
type Outcome = { credentialRef: string | null; certificateExpiresAt: Date | null; activated: boolean; documentChecks?: Check[] };
const fake = vi.hoisted(() => ({ calls: [] as string[], renew: null as unknown as Outcome }));
vi.mock("../services/einvoice/zatca/zatcaDirectProvider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/einvoice/zatca/zatcaDirectProvider")>();
  return {
    ...orig,
    resolveProvider: () => ({
      onboard: async () => { throw new Error("onboarding is not under test here"); },
      renewCertificate: async (input: { otp: string }) => { fake.calls.push(input.otp); return fake.renew; },
    }),
  };
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "B3F2RenewalPw1!";
const check = (label: string, passed: boolean): Check => ({ label, passed, errors: passed ? [] : [{ code: "BR-KSA-B3", message: "a planted failure" }], warnings: [] });

describeMaybe("Batch 3 F-2 — the renewal route answers in its contract", () => {
  const h = g04Harness("b3f2renew");

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "B3 F2 Co", "399999999999963");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    expect(await h.login("accountant", h.email("accountant"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a renewal that ACTIVATES answers in the generated schema, with the new expiry", async () => {
    fake.renew = { credentialRef: "cred-b3", certificateExpiresAt: new Date("2031-11-08T00:00:00Z"), activated: true, documentChecks: ["a", "b", "c", "d", "e", "f"].map((l) => check(l, true)) };
    const r = await h.api("admin", "POST", "/zatca/onboarding/renew", { otp: "B3-OTP-1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const parsed = RenewZatcaCertificateResponse.safeParse(r.body);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(r.body).toMatchObject({ activated: true, certificateExpiresAt: "2031-11-08T00:00:00.000Z" });
    expect(r.body.complianceDocuments).toHaveLength(6);
    expect(fake.calls).toEqual(["B3-OTP-1"]);
  });

  it("🔴 a renewal that does NOT activate answers in the same schema: no new certificate, so no expiry, and the failing document named", async () => {
    fake.renew = { credentialRef: null, certificateExpiresAt: null, activated: false, documentChecks: [check("a", true), check("b", false)] };
    const r = await h.api("admin", "POST", "/zatca/onboarding/renew", { otp: "B3-OTP-2" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const parsed = RenewZatcaCertificateResponse.safeParse(r.body);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(r.body).toMatchObject({ activated: false, certificateExpiresAt: null });
    expect(r.body.complianceDocuments[1]).toMatchObject({ label: "b", passed: false, errors: [{ code: "BR-KSA-B3" }] });
  });

  it("🔴 an ACCOUNTANT is refused 403 `requires_approval_authority` — the provider is never reached", async () => {
    const before = fake.calls.length;
    const r = await h.api("accountant", "POST", "/zatca/onboarding/renew", { otp: "B3-OTP-3" });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.code).toBe("requires_approval_authority");
    expect(fake.calls.length, "nothing reached the provider").toBe(before);
  });
});
