/**
 * 🔴 Phase 18 R-5 — G43, memo §2c (register §11.95): `LLM_MODEL` and
 * `OLLAMA_URL` are validated config in `@workspace/config`; in production the
 * legacy local-model path is refused at boot exactly as `AI_PROVIDER=groq` is
 * (C6), and `/llm/*` answers deterministic-only there.
 *
 * No database. Part A asserts each boot refusal from a KNOWN-GOOD production
 * env with exactly one variable flipped (the `env-boot-refusal` pattern). Part
 * B asserts the route guard on the controller itself: `loadEnv` is wrapped so
 * the test chooses what the CONFIG says, `process.env` is set to disagree (the
 * reader must be the config), and a fake Ollama stands in for `fetch` so a
 * second opinion that is sent is seen and one that is not is proven absent.
 *
 * Pool note: vitest runs each file in its own fork; process.env is restored
 * after every test regardless.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ override: {} as Record<string, unknown> }));
vi.mock("@workspace/config", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@workspace/config")>();
  return {
    ...orig,
    loadEnv: (source?: NodeJS.ProcessEnv) => ({ ...orig.loadEnv(source), ...seam.override }),
  };
});

import { loadEnv, resetEnvCache } from "@workspace/config";
import { llmController } from "../controllers/llm.controller";
import { SEED_CATEGORIES } from "../services/categorization/categorizer";

const ORIGINAL = { ...process.env };

/** A minimal env that a production boot ACCEPTS — every refusal case flips one variable from it. */
function goodProductionEnv(): void {
  process.env.NODE_ENV = "production";
  process.env.PORT = "3000";
  process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/x";
  process.env.SESSION_SECRET = "s".repeat(64);
  process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com";
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
  delete process.env.LLM_MODEL;
  delete process.env.OLLAMA_URL;
}

describe("Phase 18 R-5 (G43) — A: the legacy LLM path is config, refused at boot in production as AI_PROVIDER=groq is", () => {
  beforeEach(() => {
    seam.override = {};
    goodProductionEnv();
    resetEnvCache();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    resetEnvCache();
  });

  it("the baseline production env BOOTS with the legacy path off — LLM_MODEL defaults to none, OLLAMA_URL to unset", () => {
    const env = loadEnv();
    expect([env.LLM_MODEL, env.OLLAMA_URL]).toEqual(["none", undefined]);
  });

  it("🔴 LLM_MODEL other than none is refused in production — the local-model path has no data-boundary agreement to attest", () => {
    process.env.LLM_MODEL = "llama3";
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/LLM_MODEL.*refused in production/s);
  });

  it("🔴 OLLAMA_URL set in production is refused — a backend declared where nothing may call it", () => {
    process.env.OLLAMA_URL = "http://ollama.internal:11434";
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/OLLAMA_URL.*refused in production/s);
  });

  it("outside production both are accepted and read back as config", () => {
    process.env.NODE_ENV = "test";
    process.env.LLM_MODEL = "qwen2.5";
    process.env.OLLAMA_URL = "http://ollama.test:11434";
    resetEnvCache();
    const env = loadEnv();
    expect([env.LLM_MODEL, env.OLLAMA_URL]).toEqual(["qwen2.5", "http://ollama.test:11434"]);
  });

  it("a malformed OLLAMA_URL is refused in ANY environment", () => {
    process.env.NODE_ENV = "test";
    process.env.OLLAMA_URL = "not a url";
    resetEnvCache();
    expect(() => loadEnv()).toThrowError(/OLLAMA_URL/);
  });
});

describe("Phase 18 R-5 (G43) — B: /llm/* reads the config, and answers deterministic-only in production", () => {
  // a description no deterministic rule matches, so the hybrid engine would ask for a second opinion
  const UNMATCHED = { description: "qzx-7731", amount: 42, type: "debit" };
  const fakeOllama = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ response: JSON.stringify({ categoryId: SEED_CATEGORIES[0].id, confidence: 0.9 }) }),
  }));
  const call = async (fn: (req: never, res: never) => Promise<void>, body: unknown = {}) => {
    const res = { json: vi.fn() };
    await fn({ body } as never, res as never);
    return res.json.mock.calls[0][0] as Record<string, unknown>;
  };
  const configured = { AI_PROVIDER: "none", LLM_MODEL: "llama3", OLLAMA_URL: "http://ollama.test:11434" };

  beforeEach(() => {
    vi.stubGlobal("fetch", fakeOllama);
    fakeOllama.mockClear();
    // the ENVIRONMENT disagrees with the config on purpose: the reader must be the config
    process.env.LLM_MODEL = "none";
    process.env.OLLAMA_URL = "http://wrong.env.example:1";
    resetEnvCache();
  });
  afterEach(() => {
    seam.override = {};
    process.env = { ...ORIGINAL };
    resetEnvCache();
  });
  afterAll(() => vi.unstubAllGlobals());

  it("planted positive (test env): the config names the model and the URL — the second opinion is sent there and answered", async () => {
    seam.override = { NODE_ENV: "test", ...configured };
    const out = await call(llmController.categorize, UNMATCHED);
    expect([out.source, out.llmModel]).toEqual(["llm", "llama3"]);
    expect(fakeOllama).toHaveBeenCalledTimes(1);
    const [url, init] = fakeOllama.mock.calls[0];
    expect(url).toBe("http://ollama.test:11434/api/generate");
    expect(JSON.parse(String(init?.body)).model).toBe("llama3");
    const status = await call(llmController.status);
    expect([status.llmBackendConfigured, status.mode, status.reachable]).toEqual([true, "hybrid", true]);
  });

  it("OLLAMA_URL unset: the local default applies — never the environment's value", async () => {
    seam.override = { NODE_ENV: "test", ...configured, OLLAMA_URL: undefined };
    await call(llmController.categorize, UNMATCHED);
    expect(fakeOllama.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/generate");
  });

  it("🔴 production: categorize answers deterministic-only and no second opinion is sent", async () => {
    seam.override = { NODE_ENV: "production", ...configured };
    const out = await call(llmController.categorize, UNMATCHED);
    expect(out.source).toBe("deterministic");
    expect(fakeOllama).not.toHaveBeenCalled();
  });

  it("🔴 production: compare and demo run the deterministic engine only", async () => {
    seam.override = { NODE_ENV: "production", ...configured };
    const compare = await call(llmController.compare, { transactions: [UNMATCHED, { ...UNMATCHED, description: "qzx-7732" }] });
    const results = compare.results as Array<{ hybrid: { source: string } }>;
    expect(results.map((r) => r.hybrid.source)).toEqual(["deterministic", "deterministic"]);
    expect(compare.model).toBe("none");
    const demo = await call(llmController.demo);
    const txs = demo.transactions as Array<{ hybrid: { source: string } }>;
    expect(txs.length).toBe(10);
    expect(new Set(txs.map((t) => t.hybrid.source))).toEqual(new Set(["deterministic"]));
    expect(demo.activeModel).toBe("none");
    expect(fakeOllama).not.toHaveBeenCalled();
  });

  it("🔴 production: status reports deterministic-only, no backend, and sends no probe", async () => {
    seam.override = { NODE_ENV: "production", ...configured };
    const status = await call(llmController.status);
    expect([status.activModel, status.llmBackendConfigured, status.reachable, status.mode]).toEqual([
      "none", false, false, "deterministic-only",
    ]);
    expect(fakeOllama).not.toHaveBeenCalled();
  });

  it("test env with no backend configured: deterministic, and status says so", async () => {
    seam.override = { NODE_ENV: "test", AI_PROVIDER: "none", LLM_MODEL: "none", OLLAMA_URL: undefined };
    const out = await call(llmController.categorize, UNMATCHED);
    expect(out.source).toBe("deterministic");
    const status = await call(llmController.status);
    expect([status.llmBackendConfigured, status.mode, status.reachable]).toEqual([false, "deterministic", false]);
    expect(fakeOllama).not.toHaveBeenCalled();
  });
});
