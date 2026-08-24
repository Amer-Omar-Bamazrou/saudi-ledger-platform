/**
 * The production boot refusals (audit 2026-08-20, LOW: "the production
 * boot-refusal has no test — loadEnv refusing MAIL_PROVIDER=none /
 * ALERT_PROVIDER=none in production is what B1/B2 lean on, and
 * packages/config has no test files").
 *
 * Lives in the API suite rather than packages/config because the PACKAGE has
 * no test infrastructure and the BEHAVIOR is what was untested — the same
 * loadEnv this process boots with. Each refusal is asserted from a
 * KNOWN-GOOD production env with exactly one variable flipped, so a failure
 * names the refusal that broke rather than a pile of unrelated issues.
 *
 * Pool note: vitest runs each file in its own fork, so mutating process.env
 * here cannot leak into parallel suites; it is still restored after each
 * test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "@workspace/config";

const ORIGINAL = { ...process.env };

/** A minimal env that a production boot ACCEPTS — the baseline every refusal case flips one var from. */
function goodProductionEnv(): void {
  process.env.NODE_ENV = "production";
  process.env.PORT = "3000";
  process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/x";
  process.env.SESSION_SECRET = "s".repeat(64);
  process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com";
  // local-fs archiving in production demands an ABSOLUTE dir (its own refusal).
  process.env.ZATCA_ARCHIVE_DIR = "/var/lib/zatca-archive";
  process.env.MAIL_PROVIDER = "resend";
  process.env.MAIL_API_KEY = "re_test_key";
  process.env.MAIL_FROM = "Saudi Ledger <no-reply@example.com>";
  process.env.ALERT_PROVIDER = "webhook";
  process.env.ALERT_WEBHOOK_URL = "https://hooks.example/alerts";
  process.env.ZATCA_KMS_PROVIDER = "aws-kms";
  process.env.ZATCA_KMS_KEY_ID = "arn:aws:kms:me-south-1:000000000000:key/test";
  delete process.env.ZATCA_DEV_MASTER_KEY;
  process.env.SESSION_COOKIE_SECURE = "true";
  process.env.AI_PROVIDER = "none";
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_DATA_BOUNDARY_ACK;
  process.env.DEMO_MODE = "false";
}

describe("loadEnv — the production boot refusals B1/B2/C1/AI-1a lean on", () => {
  beforeEach(() => {
    goodProductionEnv();
    resetEnvCache();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    resetEnvCache();
  });

  it("the baseline production env BOOTS — so each refusal below is the flipped variable, not noise", () => {
    expect(() => loadEnv()).not.toThrow();
  });

  it("🔴 B1: MAIL_PROVIDER=none is refused in production — an alarm delivered to nobody", () => {
    process.env.MAIL_PROVIDER = "none";
    delete process.env.MAIL_API_KEY;
    delete process.env.MAIL_FROM;
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/MAIL_PROVIDER/);
  });

  it("🔴 B2: ALERT_PROVIDER=none is refused in production", () => {
    process.env.ALERT_PROVIDER = "none";
    delete process.env.ALERT_WEBHOOK_URL;
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/ALERT_PROVIDER/);
  });

  it("a configured mail provider without its credentials is refused in ANY environment", () => {
    process.env.NODE_ENV = "test";
    delete process.env.MAIL_API_KEY;
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/MAIL_API_KEY and MAIL_FROM/);
  });

  it("🔴 the local-dev key wrapper is refused in production — fake cryptography must not boot", () => {
    process.env.ZATCA_KMS_PROVIDER = "local-dev";
    process.env.ZATCA_DEV_MASTER_KEY = "a".repeat(64);
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/local-dev.*refused in production/s);
  });

  it("🔴 C1: SESSION_COOKIE_SECURE=false is refused in production", () => {
    process.env.SESSION_COOKIE_SECURE = "false";
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/SESSION_COOKIE_SECURE/);
  });

  it("🔴 AI-1a: groq in production is refused without the exact attestation — and a WRONG string does not pass", () => {
    process.env.AI_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "gsk_test";
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/Enterprise agreement/);

    process.env.GROQ_DATA_BOUNDARY_ACK = "enterprise-dammam-zdr"; // close, and not the attestation
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/Enterprise agreement/);

    process.env.GROQ_DATA_BOUNDARY_ACK = "enterprise-dammam-zdr-signed";
    resetEnvCache();
    expect(() => loadEnv()).not.toThrow();
  });
});
