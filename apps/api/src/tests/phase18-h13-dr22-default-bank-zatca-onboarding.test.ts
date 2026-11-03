/**
 * 🔴 Phase 18 H-13 — DR-22 (D-13), its second batch: a default-bank flip on the
 * company's OTHER accounts, and each ZATCA onboarding and renewal, are recorded
 * in the audit trail. DECIDED 2026-10-27 — owner accepted the stated
 * recommendation (register §11.64, the scoped D-4 statement, appended before
 * this file).
 *
 * 🔴 STAND-IN, named: the ZATCA provider (`resolveProvider`) is replaced by a
 * fake that returns a fixed outcome — the recording sits ABOVE the provider by
 * design (any provider's act is recorded the same way), so the provider is not
 * what is under test, and a real one would call ZATCA. What IS under test is
 * the route → controller → recording path, over HTTP, on the real database.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3263";
process.env.SESSION_SECRET ??= "phase18-h13-default-bank-zatca-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { defaultOnboardingEnvironment } from "../services/einvoice/onboarding/zatcaOnboardingClient";
import { g04Harness } from "./helpers/g04Harness";

type Check = { label: string; passed: boolean; errors: unknown[]; warnings: unknown[] };
type Outcome = { credentialRef: string | null; certificateExpiresAt: Date | null; activated: boolean; documentChecks?: Check[] };
const fake = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; otp: string }>,
  onboard: null as unknown as Outcome,
  renew: null as unknown as Outcome,
}));
vi.mock("../services/einvoice/zatca/zatcaDirectProvider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/einvoice/zatca/zatcaDirectProvider")>();
  return {
    ...orig,
    resolveProvider: () => ({
      onboard: async (input: { otp: string }) => { fake.calls.push({ kind: "onboard", otp: input.otp }); return fake.onboard; },
      renewCertificate: async (input: { otp: string }) => { fake.calls.push({ kind: "renew", otp: input.otp }); return fake.renew; },
    }),
  };
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H13AudPw1!";
const OTP = "H13-OTP-918273";
const check = (label: string, passed: boolean): Check => ({ label, passed, errors: passed ? [] : ["BR-KSA-H13"], warnings: [] });

describeMaybe("Phase 18 H-13 — DR-22: default-bank flips, ZATCA onboarding and renewal are recorded", () => {
  const h = g04Harness("p18h13aud");
  let orgId = "", companyId = "";
  const audits = async (entity: string) => (await pool.query(
    `SELECT action, entity_id, before_state, after_state FROM audit_logs WHERE organization_id = $1 AND entity_type = $2`, [orgId, entity])).rows;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "H13 Co", "399999999999963");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 making an account the default records the flag cleared on the OTHER account — on a create and on an update", async () => {
    const mk = async (name: string) => {
      const r = await h.api("admin", "POST", "/bank-accounts", { name, bankName: "SNB", currency: "SAR", isDefault: true });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as number;
    };
    const a = await mk("H13 Ops A"); // the first default: nothing else to clear
    const b = await mk("H13 Ops B"); // clears A
    expect((await h.api("admin", "PATCH", `/bank-accounts/${a}`, { isDefault: true })).status).toBe(200); // clears B
    const updates = (await audits("bank_account")).filter((r) => r.action === "update")
      .map((r) => [Number(r.entity_id), r.before_state?.isDefault, r.after_state?.isDefault])
      .sort((x, y) => Number(x[0]) - Number(y[0]) || String(x[1]).localeCompare(String(y[1])));
    // A cleared by B's create (true → false), A's own update (false → true), B cleared by A's update (true → false)
    expect(updates).toEqual([[a, false, true], [a, true, false], [b, true, false]].sort((x, y) => Number(x[0]) - Number(y[0]) || String(x[1]).localeCompare(String(y[1]))));
  });

  it("🔴 an onboarding is recorded — environment, outcome, expiry, documents passed and failed — and the OTP is stored nowhere", async () => {
    fake.onboard = { credentialRef: "cred-h13", certificateExpiresAt: new Date("2031-10-30T00:00:00Z"), activated: true,
      documentChecks: [check("a", true), check("b", true), check("c", true), check("d", true), check("e", true), check("f", false)] };
    const r = await h.api("admin", "POST", "/zatca/onboarding", { otp: OTP });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fake.calls, "the stand-in provider was reached").toEqual([{ kind: "onboard", otp: OTP }]);
    expect((await audits("zatca_credential")).map((x) => [x.action, x.entity_id, x.after_state])).toEqual([
      ["onboard", companyId, { environment: defaultOnboardingEnvironment(), activated: true, certificateExpiresAt: "2031-10-30T00:00:00.000Z", documentsPassed: 5, documentsFailed: 1 }],
    ]);
    const leaked = (await pool.query(`SELECT count(*)::int AS n FROM audit_logs a WHERE organization_id = $1 AND row_to_json(a)::text LIKE $2`, [orgId, `%${OTP}%`])).rows[0].n;
    expect(leaked).toBe(0);
  });

  it("🔴 a renewal is recorded the same way — its outcome included when it does not activate", async () => {
    fake.renew = { credentialRef: null, certificateExpiresAt: null, activated: false, documentChecks: [check("a", true), check("b", true), check("c", false)] };
    expect((await h.api("admin", "POST", "/zatca/onboarding/renew", { otp: OTP })).status).toBe(200);
    const renewals = (await audits("zatca_credential")).filter((x) => x.action === "renew").map((x) => [x.entity_id, x.after_state]);
    expect(renewals).toEqual([[companyId, { environment: defaultOnboardingEnvironment(), activated: false, certificateExpiresAt: null, documentsPassed: 2, documentsFailed: 1 }]]);
  });

  it("a request refused before the provider is reached records nothing", async () => {
    const before = (await audits("zatca_credential")).length;
    const calls = fake.calls.length;
    expect((await h.api("admin", "POST", "/zatca/onboarding", {})).status).toBe(400);
    expect([(await audits("zatca_credential")).length, fake.calls.length]).toEqual([before, calls]);
  });
});
