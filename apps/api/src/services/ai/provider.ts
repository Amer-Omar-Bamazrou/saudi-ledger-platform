/**
 * The AI provider seam (AI-1a) — the reversibility hedge the hosting decision
 * depends on.
 *
 * design-ai-layer §12a: Groq was chosen WITH the seam as the thing that keeps
 * the choice reversible. This module is that seam: callers speak
 * {@link AiProvider}, and swapping vendors (or pointing at the Enterprise
 * Dammam endpoint when it exists) is a config change, not a refactor — the
 * same hedge `KeyWrapper`, `ArchiveStore`, the mailer and the alerter carry.
 *
 * ── 🔴 The B3 rule is the design ────────────────────────────────────────────
 * A provider that cannot do the thing THROWS {@link AiUnavailableError} — an
 * HTTP error, a timeout, an unparseable reply are all "unavailable", never a
 * silent empty answer. CALLERS decide what degradation means for them (the
 * categorizer falls back to its deterministic result; a benchmark aborts
 * loudly). A no-op reporting success is a false statement the caller builds
 * on; a throw is merely a gap.
 *
 * ── 🔴 The data boundary lives one level up ─────────────────────────────────
 * `loadEnv` REFUSES AI_PROVIDER=groq in production without the Enterprise
 * attestation (see packages/config). This module deliberately has no opinion
 * about WHAT is sent — the boot gate is the guard, because a per-call guard
 * would need to classify payloads and would drift. Free-tier calls carry
 * synthetic and dev-org data only (owner boundary, 2026-08-21).
 *
 * Dependency-free REST, like the mailer and alerter: Groq speaks the
 * OpenAI-compatible chat/completions surface, which plain `fetch` covers.
 */
import { loadEnv } from "@workspace/config";

export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause2?: unknown,
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export interface AiChatRequest {
  prompt: string;
  /** Hard cap on the completion. Callers state it; no silent unbounded calls. */
  maxTokens: number;
  timeoutMs?: number;
  /** Override the configured text model (benchmarks compare models). */
  model?: string;
  /**
   * Reasoning-effort control for reasoning models (gpt-oss, qwen-think).
   * 🔴 Without it, a reasoning model can spend the ENTIRE maxTokens budget
   * thinking and return 200 with empty content — which the provider then
   * throws as unavailable. That made gpt-oss (the spec's own candidate)
   * unmeasurable: 19/21 benchmark calls empty even at 500 tokens. Sent as
   * `reasoning_effort` only when set; non-reasoning models ignore it.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

export interface AiVisionRequest extends AiChatRequest {
  /** Base64 image payload, no data: prefix. */
  imageBase64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export interface AiCompletion {
  text: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface AiProvider {
  readonly name: string;
  chat(req: AiChatRequest): Promise<AiCompletion>;
  vision(req: AiVisionRequest): Promise<AiCompletion>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Groq's OpenAI-compatible endpoint. */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

type GroqMessageContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export class GroqProvider implements AiProvider {
  readonly name = "groq";

  constructor(
    private readonly apiKey: string,
    private readonly textModel: string,
    private readonly visionModel: string,
    /** Injectable for tests — the branch nobody writes is the one that fails. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  chat(req: AiChatRequest): Promise<AiCompletion> {
    return this.complete(req.model ?? this.textModel, req.prompt, req);
  }

  vision(req: AiVisionRequest): Promise<AiCompletion> {
    const content: GroqMessageContent = [
      { type: "text", text: req.prompt },
      { type: "image_url", image_url: { url: `data:${req.mimeType};base64,${req.imageBase64}` } },
    ];
    return this.complete(req.model ?? this.visionModel, content, req);
  }

  private async complete(
    model: string,
    content: GroqMessageContent,
    req: AiChatRequest,
  ): Promise<AiCompletion> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      const res = await this.fetchImpl(GROQ_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
          messages: [{ role: "user", content }],
        }),
      });

      if (!res.ok) {
        // The body names the reason (rate limit, bad model, auth) — the C2
        // lesson: a bare status sends the diagnoser down the wrong path.
        // 🔴 Truncated AND stripped of anything echo-shaped: error bodies can
        // quote the request; nothing from Groq's response is ever logged
        // verbatim beyond this bounded slice.
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new AiUnavailableError(`groq ${model}: HTTP ${res.status}: ${body}`);
      }

      const data = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      } | null;

      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        // "Partial data is not lenient data": a 200 with no content is not an
        // answer, and returning "" would be returning part of a value as the
        // whole value.
        throw new AiUnavailableError(`groq ${model}: 200 with no completion content`);
      }

      return {
        text,
        model: data?.model ?? model,
        provider: this.name,
        promptTokens: Number(data?.usage?.prompt_tokens ?? 0),
        completionTokens: Number(data?.usage?.completion_tokens ?? 0),
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      // AbortError, DNS failure, TLS error — all one honest category.
      throw new AiUnavailableError(
        `groq ${model}: ${err instanceof Error ? err.name : "request failed"} after ${Date.now() - start}ms`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolve the configured provider, or `null` when AI is off.
 *
 * `null` — not a stub provider that throws, and not one that pretends. A
 * caller that gets `null` KNOWS AI is off and takes its deterministic path
 * without paying a failed network call to find out.
 */
export function resolveAiProvider(): AiProvider | null {
  const env = loadEnv();
  if (env.AI_PROVIDER === "none") return null;
  // AI_PROVIDER=groq without a key is refused at boot (config superRefine),
  // so the non-null assertion here is guarded one level up.
  return new GroqProvider(env.GROQ_API_KEY!, env.GROQ_MODEL, env.GROQ_VISION_MODEL);
}
