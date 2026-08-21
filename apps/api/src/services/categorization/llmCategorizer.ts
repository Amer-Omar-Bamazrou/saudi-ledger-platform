/**
 * LLM Categorization Layer — Part 6
 *
 * Architecture:
 *  1. Deterministic rule engine runs first (categorizer.ts).
 *  2. If confidence >= LOW_CONFIDENCE_THRESHOLD (0.65) → return deterministic result immediately.
 *  3. If confidence < threshold OR no match → call LLM for a second opinion.
 *  4. LLM response is parsed and validated; on any error the deterministic result is used as-is.
 *
 * Supported backends (set LLM_MODEL env var):
 *  - "none"     → LLM disabled; deterministic only (default when Ollama not available)
 *  - "llama3"   → Meta Llama 3 via Ollama at localhost:11434
 *  - "qwen2.5"  → Alibaba Qwen 2.5 via Ollama at localhost:11434 (same API, different model tag)
 *
 * Degrades gracefully: any network error, timeout, or malformed response falls back to
 * the deterministic result without throwing.
 */

import { categorizeTransaction, SEED_CATEGORIES, type CategorizationMatch } from "./categorizer.js";
import { resolveAiProvider } from "../ai/provider";
import { meteredChat } from "../ai/metered";

// ── Configuration ─────────────────────────────────────────────────────────────

/** Which model is active. Set LLM_MODEL=llama3 or LLM_MODEL=qwen2.5 to enable. */
export const LLM_MODEL: string = process.env.LLM_MODEL ?? "none";

/** Confidence below which the LLM is invoked as a second opinion. */
const LOW_CONFIDENCE_THRESHOLD = 0.65;

/** Ollama base URL. Override with OLLAMA_URL env var for remote instances. */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/** Request timeout for Ollama (ms). Keep short to avoid blocking the response. */
const OLLAMA_TIMEOUT_MS = 8000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LlmCategorizationResult extends CategorizationMatch {
  source: "deterministic" | "llm" | "llm-fallback";
  llmModel?: string;
  llmRawResponse?: string;
}

// ── Ollama HTTP call ──────────────────────────────────────────────────────────

async function callOllama(model: string, prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    return data.response ?? null;
  } catch {
    return null; // network error, timeout, Ollama not running → degrade gracefully
  } finally {
    clearTimeout(timeout);
  }
}

/** Check whether the configured Ollama model is reachable. */
export async function checkOllamaReachable(model: string = LLM_MODEL): Promise<{
  reachable: boolean;
  model: string;
  latencyMs?: number;
}> {
  if (model === "none") return { reachable: false, model };
  const start = Date.now();
  const res = await callOllama(model, "Reply with only the word: OK");
  const latencyMs = Date.now() - start;
  return { reachable: res !== null, model, latencyMs };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildCategorizationPrompt(
  description: string,
  amount: number,
  transactionType: "debit" | "credit",
  deterministicResult: CategorizationMatch | null
): string {
  const categoryList = SEED_CATEGORIES
    .map(c => `  ${c.id}: ${c.name} (${c.type})`)
    .join("\n");

  const deterministicHint = deterministicResult
    ? `The rule engine tentatively suggested: "${deterministicResult.categoryName}" (confidence ${(deterministicResult.confidence * 100).toFixed(0)}%). If you agree, use the same category id.`
    : "The rule engine found no match.";

  return `You are a Saudi Arabian bookkeeping assistant. Classify the following bank transaction into exactly ONE category from the list below.

Transaction:
  Description: ${description}
  Amount: SAR ${amount.toFixed(2)}
  Type: ${transactionType === "credit" ? "INCOME (money received)" : "EXPENSE (money paid out)"}

${deterministicHint}

Available categories (id: name):
${categoryList}

Respond with a JSON object only, no explanation. Example:
{"categoryId": 10, "confidence": 0.82, "reasoning": "one sentence"}

JSON:`;
}

// ── LLM response parser ───────────────────────────────────────────────────────

function parseLlmResponse(raw: string): { categoryId: number; confidence: number } | null {
  try {
    // Extract first JSON object from the response (model may add trailing text)
    const match = raw.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const categoryId = Number(parsed.categoryId);
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.7)));
    if (!Number.isInteger(categoryId) || categoryId < 1) return null;
    const cat = SEED_CATEGORIES.find(c => c.id === categoryId);
    if (!cat) return null;
    return { categoryId, confidence };
  } catch {
    return null;
  }
}

// ── Second-opinion dispatch (AI-1a) ──────────────────────────────────────────

/**
 * Route the second opinion: the provider seam when configured (metered,
 * AI_PROVIDER=groq), else the legacy local Ollama path. Returns null on any
 * failure — the caller's contract is "degrade to deterministic", and the
 * seam's AiUnavailableError is converted to that same null HERE, at the one
 * boundary where degradation is the declared policy.
 */
async function callSecondOpinion(prompt: string): Promise<string | null> {
  const provider = resolveAiProvider();
  if (provider) {
    try {
      const out = await meteredChat(provider, "categorize_second_opinion", {
        prompt,
        maxTokens: 200,
        timeoutMs: 8000,
      });
      return out.text;
    } catch {
      return null; // unavailable → deterministic result stands (llm-fallback)
    }
  }
  if (LLM_MODEL !== "none") return callOllama(LLM_MODEL, prompt);
  return null;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Categorize a transaction with the hybrid engine.
 * Always returns a result (never throws); falls back to deterministic on any LLM failure.
 */
export async function categorizeWithLlm(
  description: string,
  amount: number,
  transactionType: "debit" | "credit",
  descriptionAr?: string | null
): Promise<LlmCategorizationResult> {
  // Step 1: Deterministic engine
  const det = categorizeTransaction(description, amount, transactionType, descriptionAr);

  // Step 2: Skip LLM if disabled or deterministic confidence is high enough.
  // Two independent switches, deliberately: the legacy local path
  // (LLM_MODEL/Ollama) and the provider seam (AI_PROVIDER/Groq, AI-1a). The
  // LLM runs when EITHER is configured; the deterministic engine stays the
  // brain in every case.
  const seamProvider = resolveAiProvider();
  const llmEnabled = LLM_MODEL !== "none" || seamProvider !== null;
  if (!llmEnabled || (det && det.confidence >= LOW_CONFIDENCE_THRESHOLD)) {
    return {
      ...(det ?? deterministicFallback(transactionType)),
      source: "deterministic",
    };
  }

  // Step 3: Call LLM
  const prompt = buildCategorizationPrompt(description, amount, transactionType, det);
  const raw = await callSecondOpinion(prompt);

  if (!raw) {
    // Ollama unreachable — degrade to deterministic
    return {
      ...(det ?? deterministicFallback(transactionType)),
      source: "llm-fallback",
      llmModel: seamProvider ? "groq" : LLM_MODEL,
    };
  }

  // Step 4: Parse LLM response
  const parsed = parseLlmResponse(raw);
  if (!parsed) {
    return {
      ...(det ?? deterministicFallback(transactionType)),
      source: "llm-fallback",
      llmModel: LLM_MODEL,
      llmRawResponse: raw.slice(0, 200),
    };
  }

  const cat = SEED_CATEGORIES.find(c => c.id === parsed.categoryId)!;
  // M15: downstream is system-code based; the numeric id exists only inside the
  // LLM prompt/response loop, mapped here at the boundary.
  return {
    systemCode: cat.systemCode,
    categoryName: cat.name,
    categoryNameAr: cat.nameAr,
    confidence: parsed.confidence,
    matchedRule: `LLM (${LLM_MODEL})`,
    vatApplicable: cat.vatApplicable,
    suggestedVatRate: cat.vatApplicable ? 15 : 0,
    source: "llm",
    llmModel: LLM_MODEL,
    llmRawResponse: raw.slice(0, 300),
  };
}

function deterministicFallback(type: "debit" | "credit"): CategorizationMatch {
  // M15: kept ONLY inside the LLM comparison harness — the production engine no
  // longer falls back (it returns null and the row goes to review). At 0.3 this
  // sits below AUTO_ASSIGN_CONFIDENCE, so even here it can never assign.
  return type === "credit"
    ? { systemCode: "OTHER_INCOME", categoryName: "Other Income", categoryNameAr: "إيرادات أخرى", confidence: 0.3, matchedRule: "Fallback", vatApplicable: false, suggestedVatRate: null }
    : { systemCode: "OTHER_EXPENSES", categoryName: "Other Expenses", categoryNameAr: "مصاريف أخرى", confidence: 0.3, matchedRule: "Fallback", vatApplicable: false, suggestedVatRate: null };
}
