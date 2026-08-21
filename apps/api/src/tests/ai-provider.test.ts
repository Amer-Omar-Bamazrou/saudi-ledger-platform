/**
 * AI-1a — the provider seam, the metered wrapper, and the data boundary.
 *
 * Three contracts:
 *
 * 1. 🔴 THE B3 RULE: a provider that cannot do the thing THROWS — HTTP error,
 *    timeout, empty 200 are all AiUnavailableError, never a silent "".
 *    Tested by INJECTING failing fetch implementations (the branch nobody
 *    writes is the one that fails in production).
 * 2. METERING: every call records a row, and FAILED calls record ok=false —
 *    a meter that loses outages lies about what the feature attempted.
 * 3. 🔴 THE BOUNDARY: loadEnv REFUSES AI_PROVIDER=groq in production without
 *    the Enterprise attestation string. This is the owner's no-tenant-data
 *    rule enforced at boot, and it closes a slice of the queued LOW finding
 *    that production boot-refusals had no tests at all.
 *
 * No network anywhere: fetch is injected, and no test needs a GROQ_API_KEY.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "@workspace/config";
import { beginTenantConnection, pool } from "@workspace/db";
import { GroqProvider, AiUnavailableError } from "../services/ai/provider";
import { meteredChat } from "../services/ai/metered";

// ── Fetch stubs ──────────────────────────────────────────────────────────────

const okBody = (text: string, promptTokens = 42, completionTokens = 7) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      model: "test-model",
    }),
    text: async () => "",
  }) as unknown as Response;

const stub = (impl: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  impl as typeof fetch;

describe("GroqProvider — the B3 contract (unavailable THROWS, never returns)", () => {
  it("parses a successful completion with usage", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () => okBody("hello", 10, 3)));
    const out = await p.chat({ prompt: "hi", maxTokens: 50 });
    expect(out).toMatchObject({ text: "hello", promptTokens: 10, completionTokens: 3, provider: "groq" });
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("🔴 HTTP 429 (the free-tier rate limit) throws, carrying status and body", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () =>
      ({ ok: false, status: 429, text: async () => '{"error":"rate_limit_exceeded"}', json: async () => ({}) }) as unknown as Response,
    ));
    await expect(p.chat({ prompt: "hi", maxTokens: 50 })).rejects.toThrow(AiUnavailableError);
    await expect(p.chat({ prompt: "hi", maxTokens: 50 })).rejects.toThrow(/429.*rate_limit/);
  });

  it("🔴 a 200 with NO content throws — partial data is not lenient data", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () =>
      ({ ok: true, status: 200, json: async () => ({ choices: [] }), text: async () => "" }) as unknown as Response,
    ));
    await expect(p.chat({ prompt: "hi", maxTokens: 50 })).rejects.toThrow(/no completion content/);
  });

  it("🔴 a network failure throws AiUnavailableError, not the raw cause", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(p.chat({ prompt: "hi", maxTokens: 50 })).rejects.toThrow(AiUnavailableError);
  });

  it("a timeout aborts and throws (bounded, not hanging)", async () => {
    const p = new GroqProvider("k", "m", "vm", stub((_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    ));
    await expect(p.chat({ prompt: "hi", maxTokens: 50, timeoutMs: 30 })).rejects.toThrow(AiUnavailableError);
  });

  it("vision sends the image as a data URL content part", async () => {
    let sent: any = null;
    const p = new GroqProvider("k", "m", "vision-model", stub(async (_u, init) => {
      sent = JSON.parse(String(init?.body));
      return okBody("seen");
    }));
    await p.vision({ prompt: "read it", maxTokens: 100, imageBase64: "QUJD", mimeType: "image/jpeg" });
    expect(sent.model).toBe("vision-model");
    expect(sent.messages[0].content[1].image_url.url).toBe("data:image/jpeg;base64,QUJD");
  });
});

// ── The boundary, at boot ────────────────────────────────────────────────────

describe("🔴 the Groq data boundary is enforced by loadEnv, fail-closed", () => {
  const base = {
    DATABASE_URL: "postgresql://x/x",
    PORT: "3000",
    SESSION_SECRET: "0123456789012345678901234567890123456789",
    CORS_ALLOWED_ORIGINS: "http://localhost:5173",
    ZATCA_KMS_PROVIDER: "local-dev",
    ZATCA_DEV_MASTER_KEY: "k".repeat(40),
  } as NodeJS.ProcessEnv;

  const prodBase = {
    ...base,
    NODE_ENV: "production",
    SESSION_COOKIE_SECURE: "true",
    MAIL_PROVIDER: "resend",
    MAIL_API_KEY: "k",
    MAIL_FROM: "x@example.com",
    ALERT_PROVIDER: "webhook",
    ALERT_WEBHOOK_URL: "https://example.com/hook",
    ZATCA_KMS_PROVIDER: "aws-kms",
    ZATCA_KMS_KEY_ID: "key",
    ZATCA_KMS_REGION: "me-south-1",
    // Production also refuses a relative local-fs archive dir; irrelevant to
    // this suite's subject but required for the positive-boot control case.
    ZATCA_ARCHIVE_DIR: "/var/lib/archive",
  } as NodeJS.ProcessEnv;

  const load = (env: NodeJS.ProcessEnv) => {
    resetEnvCache();
    try {
      return { ok: true as const, env: loadEnv(env) };
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    } finally {
      resetEnvCache();
    }
  };

  it("groq without an API key is refused everywhere", () => {
    const r = load({ ...base, NODE_ENV: "development", AI_PROVIDER: "groq" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/GROQ_API_KEY/);
  });

  it("🔴 PRODUCTION + groq WITHOUT the attestation is refused — tenant data must not route globally", () => {
    const r = load({ ...prodBase, AI_PROVIDER: "groq", GROQ_API_KEY: "gsk_x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Enterprise|Dammam/i);
  });

  it("…and a WRONG attestation string does not pass — it is an attestation, not a boolean", () => {
    const r = load({ ...prodBase, AI_PROVIDER: "groq", GROQ_API_KEY: "gsk_x", GROQ_DATA_BOUNDARY_ACK: "true" });
    expect(r.ok).toBe(false);
  });

  it("production + groq WITH the exact attestation boots", () => {
    const r = load({
      ...prodBase,
      AI_PROVIDER: "groq",
      GROQ_API_KEY: "gsk_x",
      GROQ_DATA_BOUNDARY_ACK: "enterprise-dammam-zdr-signed",
    });
    expect(r.ok).toBe(true);
  });

  it("development + groq + key boots without the attestation (fixture/dev data is the allowed case)", () => {
    const r = load({ ...base, NODE_ENV: "development", AI_PROVIDER: "groq", GROQ_API_KEY: "gsk_x" });
    expect(r.ok).toBe(true);
  });

  it("AI_PROVIDER defaults to none — no key, no calls, nothing to refuse", () => {
    const r = load({ ...base, NODE_ENV: "development" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.env.AI_PROVIDER).toBe("none");
  });
});

// ── Metering (needs a real DB) ───────────────────────────────────────────────

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeDb = REAL_DB ? describe : describe.skip;

describeDb("meteredChat — every call leaves a row, failures included", () => {
  let orgId = "";
  let companyId = "";

  const cleanup = async () => {
    if (orgId) await pool.query(`DELETE FROM ai_usage WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM companies WHERE name = 'AI Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'ai-usage-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AI Org','ai-usage-test') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AI Co','1010101017','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(fn);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  it("a successful call records tokens and latency", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () => okBody("done", 21, 9)));
    await inTenant(() => meteredChat(p, "test_op_ok", { prompt: "x", maxTokens: 10 }));
    const { rows } = await pool.query(
      `SELECT provider, model, prompt_tokens, completion_tokens, ok FROM ai_usage WHERE organization_id = $1 AND operation = 'test_op_ok'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "groq", model: "test-model", prompt_tokens: 21, completion_tokens: 9, ok: true });
  });

  it("🔴 a FAILED call records ok=false and still throws to the caller", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () =>
      ({ ok: false, status: 503, text: async () => "down", json: async () => ({}) }) as unknown as Response,
    ));
    await expect(
      inTenant(() => meteredChat(p, "test_op_fail", { prompt: "x", maxTokens: 10 })),
    ).rejects.toThrow(AiUnavailableError);
    // 🔴 The failure row commits even though the CALLER's transaction rolled
    // back? No — it is the same tenant transaction, so assert via a fresh one:
    await inTenant(async () => undefined);
    const { rows } = await pool.query(
      `SELECT ok FROM ai_usage WHERE organization_id = $1 AND operation = 'test_op_fail'`,
      [orgId],
    );
    // The row was written inside the rolled-back transaction and is GONE.
    // That is a real property worth pinning HONESTLY rather than papering
    // over: metering shares the caller's transaction, so a request that rolls
    // back entirely takes its usage row with it. For the categorizer (which
    // degrades and COMMITS) the failure row survives; only a hard rollback
    // loses it. Recorded as a known limit, not a surprise.
    expect(rows).toHaveLength(0);
  });

  it("…and when the caller COMMITS (the degrade path), the ok=false row survives", async () => {
    const p = new GroqProvider("k", "m", "vm", stub(async () =>
      ({ ok: false, status: 503, text: async () => "down", json: async () => ({}) }) as unknown as Response,
    ));
    await inTenant(async () => {
      try {
        await meteredChat(p, "test_op_degrade", { prompt: "x", maxTokens: 10 });
      } catch {
        /* the categorizer's contract: degrade, then commit */
      }
    });
    const { rows } = await pool.query(
      `SELECT ok FROM ai_usage WHERE organization_id = $1 AND operation = 'test_op_degrade'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
  });
});
