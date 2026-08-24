/**
 * Explanation generation (AI-3b) — the first model-touching feature in real
 * product code, held to the owner's two constraints (2026-08-24):
 *
 * 🔴 NO NEW FACTS. The model renders the finding's facts in words — it adds
 * no context, infers no causes, reaches for nothing outside the row ("where,
 * never why" at sentence level; the boundary that keeps this shippable
 * before C10). Enforced by generate-then-verify: the mechanical verifier
 * proves the numeric/entity class; a judge pass argues the qualitative
 * class; a rejection DISCARDS the output and logs it (owner Q2) — never a
 * retry loop.
 *
 * 🔴 DETERMINISTIC IS THE FLOOR. The explanation is an optional column; the
 * provider seam THROWS when unavailable (B3) and this layer catches — an
 * unavailable model degrades quality, never availability (the capture
 * posture). Nothing here can fail a findings run.
 *
 * 🔴 LOW-CONTEXT REFUSAL (owner Q3): a finding carrying too few facts gets
 * NO explanation attempt — "a two-fact explanation is where a fluent
 * sentence adds the most apparent value with the least real content." The
 * refusal is counted, so telemetry can say whether that judgment was wrong.
 *
 * 🔴 DATA BOUNDARY: generation sends finding FACTS to the provider. On the
 * free tier that is synthetic/dev-org data only — the boot attestation
 * (AI-1a) refuses AI_PROVIDER=groq in production, so this stays dark for
 * real tenants until the Enterprise agreement flips the config. No new flag
 * exists here on purpose.
 */
import { createHash } from "node:crypto";
import { loadEnv } from "@workspace/config";
import { logger } from "../lib/logger";
import { GroqProvider } from "./ai/provider";
import { meteredChat } from "./ai/metered";
import { findingsRepository } from "../repositories/findings.repository";
import { verifyExplanation } from "./findings.explanationVerifier";
import type { Finding } from "@workspace/db";

/** Below this many substantive facts, generation is refused (owner Q3). */
export const MIN_FACTS_FOR_EXPLANATION = 3;

/** Per-run generation cap. 🔴 Never silent: hitting it is logged with the drop count. */
const MAX_EXPLANATIONS_PER_RUN = 25;

export interface ExplainDeps {
  /** Injectable for tests; production wires the metered seam. */
  chat?: (prompt: string) => Promise<string>;
}

export interface ExplainResult {
  attempted: number;
  generated: number;
  refusedLowContext: number;
  rejected: Record<string, number>;
  unavailable: number;
  capped: number;
}

/** Stable hash of the facts an explanation was generated from — the staleness gate. */
export function factsHash(facts: Record<string, unknown>): string {
  const stable = JSON.stringify(facts, Object.keys(facts).sort());
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export function substantiveFactCount(facts: Record<string, unknown>): number {
  return Object.values(facts).filter((v) => v != null).length;
}

function generationPrompt(kind: string, facts: Record<string, unknown>): string {
  return `You are rendering a bookkeeping observation in plain words for a Saudi business owner.

STRICT RULES:
- Use ONLY the facts below. Do not add context, infer causes, assess risk, or mention anything not in the facts.
- At most two sentences per language. State what the facts say, nothing more.
- Reply with JSON only: {"en": "...", "ar": "..."} — natural English and natural Arabic.

Observation kind: ${kind}
Facts: ${JSON.stringify(facts)}`;
}

function judgePrompt(kind: string, facts: Record<string, unknown>, en: string, ar: string): string {
  return `Below are the ONLY facts available, and a two-language text that must not claim anything beyond them.
List every claim in the text that is NOT directly stated by the facts — causes, risks, advice, context, or any detail absent from the facts. An empty list means the text stays within the facts.

Facts (${kind}): ${JSON.stringify(facts)}
Text (en): ${en}
Text (ar): ${ar}

Reply with JSON only: {"invented": ["..."]} or {"invented": []}`;
}

/** Parse the ANSWER, not the thinking — the AI-1b parser lesson, locally applied. */
function extractJson(text: string): Record<string, unknown> | null {
  let t = text;
  const open = t.indexOf("<think>");
  if (open >= 0) {
    const close = t.indexOf("</think>");
    if (close < 0) return null; // truncated mid-think: no answer exists
    t = t.slice(0, open) + t.slice(close + "</think>".length);
  }
  const matches = t.match(/\{[\s\S]*?\}/g);
  if (!matches || matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1]);
  } catch {
    return null;
  }
}

export const findingsExplainService = {
  /** True when a stored explanation may render: it must match the CURRENT facts (staleness = invention by aging). */
  isCurrent(f: Pick<Finding, "explanation" | "facts">): boolean {
    const ex = f.explanation as { factsHash?: string } | null;
    return ex?.factsHash === factsHash(f.facts as Record<string, unknown>);
  },

  /**
   * Generate explanations for open findings that lack a current one.
   * Never throws — the caller is a findings run, and deterministic content
   * is the floor.
   */
  async explainOpenFindings(deps: ExplainDeps = {}): Promise<ExplainResult> {
    const result: ExplainResult = {
      attempted: 0,
      generated: 0,
      refusedLowContext: 0,
      rejected: {},
      unavailable: 0,
      capped: 0,
    };
    const reject = (findingId: number, reason: string, detail?: Record<string, unknown>) => {
      result.rejected[reason] = (result.rejected[reason] ?? 0) + 1;
      // 🔴 The telemetry condition: token + script + normalized form travel
      // with the reason, so "model invented a number" and "verifier couldn't
      // match a real number" are distinguishable in review.
      logger.warn({ findingId, reason, ...detail }, "finding explanation rejected — deterministic floor stands");
    };

    let chat = deps.chat;
    if (!chat) {
      const env = loadEnv();
      if (env.AI_PROVIDER !== "groq" || !env.GROQ_API_KEY) return result; // dark: no provider, no attempt
      const provider = new GroqProvider(env.GROQ_API_KEY, env.GROQ_MODEL, env.GROQ_VISION_MODEL);
      chat = async (prompt: string) =>
        (await meteredChat(provider, "finding_explanation", { prompt, maxTokens: 300, timeoutMs: 25_000 })).text;
    }

    const open = await findingsRepository.list({ status: "open" });
    const needing = open.filter((f) => !this.isCurrent(f));
    const batch = needing.slice(0, MAX_EXPLANATIONS_PER_RUN);
    if (needing.length > batch.length) {
      result.capped = needing.length - batch.length;
      logger.warn({ dropped: result.capped }, "explanation generation capped this run — remainder next run");
    }

    for (const f of batch) {
      const facts = f.facts as Record<string, unknown>;
      if (substantiveFactCount(facts) < MIN_FACTS_FOR_EXPLANATION) {
        result.refusedLowContext += 1;
        continue;
      }
      result.attempted += 1;
      try {
        const raw = await chat(generationPrompt(f.kind, facts));
        const parsed = extractJson(raw);
        const en = typeof parsed?.en === "string" ? parsed.en.trim() : "";
        const ar = typeof parsed?.ar === "string" ? parsed.ar.trim() : "";
        if (!en || !ar || en.length > 400 || ar.length > 400) {
          reject(f.id, "parse_failed", { enLength: en.length, arLength: ar.length });
          continue;
        }

        // Mechanical verification, both languages — the proven class.
        let bad = verifyExplanation(en, facts);
        if (bad.ok) bad = verifyExplanation(ar, facts);
        if (!bad.ok) {
          reject(f.id, bad.reason!, { token: bad.token, script: bad.script, normalized: bad.normalized });
          continue;
        }

        // The judge pass — the argued class (imperfect oracle, stated as such).
        const judgeRaw = await chat(judgePrompt(f.kind, facts, en, ar));
        const judged = extractJson(judgeRaw);
        const invented = Array.isArray(judged?.invented) ? judged.invented : null;
        if (invented === null) {
          reject(f.id, "judge_unparseable", {});
          continue;
        }
        if (invented.length > 0) {
          reject(f.id, "judge_flagged", { claims: invented.slice(0, 5) });
          continue;
        }

        await findingsRepository.storeExplanation(f.id, {
          en,
          ar,
          model: "chat",
          generatedAt: new Date().toISOString(),
          factsHash: factsHash(facts),
        });
        result.generated += 1;
      } catch (err) {
        // The seam THROWS when unavailable (B3) — recorded, never propagated:
        // an unavailable model degrades quality, not availability.
        result.unavailable += 1;
        logger.warn({ findingId: f.id, err }, "explanation unavailable — deterministic floor stands");
      }
    }
    return result;
  },
};
