/**
 * Metered AI calls (AI-1a) — the wrapper every production AI feature goes
 * through.
 *
 * One function per modality; each records an `ai_usage` row beside the call
 * it measures. 🔴 FAILURES ARE METERED TOO (`ok = false`, zero tokens): a
 * provider outage or a free-tier rate limit that vanished from the meter
 * would make the usage curve lie about what the feature attempted — and
 * measuring exactly those failures is half of what free-tier development is
 * for.
 *
 * Recording itself NEVER throws (the mailer rule: the caller already has its
 * result, and a metering hiccup must not turn a successful completion into an
 * error). A failed insert is logged and the completion still returns.
 */
import { db, aiUsageTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import type { AiProvider, AiChatRequest, AiVisionRequest, AiCompletion } from "./provider";

async function record(row: {
  operation: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  ok: boolean;
}): Promise<void> {
  try {
    await db.insert(aiUsageTable).values(row);
  } catch (err) {
    /**
     * 🔴 NOT `console.error`. This exact catch hid a total metering outage.
     *
     * `ai_usage.company_id` was NOT NULL with a GUC-derived default, so every
     * insert from the SCHEDULED findings run — which is org-wide and sets no
     * company — violated the constraint. The model calls succeeded, tokens
     * were spent, and not one row was recorded for any scheduled AI work. The
     * only trace was a `console.error` in a server log nobody reads, and the
     * usage curve simply omitted a whole class of consumption.
     *
     * Swallowing stays correct — the caller already has its completion, and a
     * metering hiccup must not turn a successful answer into an error. What
     * was wrong was swallowing QUIETLY. A structured `logger.error` carries
     * the operation and provider, goes wherever logs actually go, and can be
     * alerted on. **Silence is not a neutral outcome**, least of all on the
     * one number the business model rests on.
     */
    logger.error(
      { err, operation: row.operation, provider: row.provider, model: row.model },
      "[ai-usage] failed to record a usage row — THE METER IS MISSING THIS CALL " +
        "(the completion itself is unaffected)",
    );
  }
}

export async function meteredChat(
  provider: AiProvider,
  operation: string,
  req: AiChatRequest,
): Promise<AiCompletion> {
  const start = Date.now();
  try {
    const out = await provider.chat(req);
    await record({
      operation,
      provider: out.provider,
      model: out.model,
      promptTokens: out.promptTokens,
      completionTokens: out.completionTokens,
      latencyMs: out.latencyMs,
      ok: true,
    });
    return out;
  } catch (err) {
    await record({
      operation,
      provider: provider.name,
      model: req.model ?? "(configured)",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - start,
      ok: false,
    });
    throw err;
  }
}

export async function meteredVision(
  provider: AiProvider,
  operation: string,
  req: AiVisionRequest,
): Promise<AiCompletion> {
  const start = Date.now();
  try {
    const out = await provider.vision(req);
    await record({
      operation,
      provider: out.provider,
      model: out.model,
      promptTokens: out.promptTokens,
      completionTokens: out.completionTokens,
      latencyMs: out.latencyMs,
      ok: true,
    });
    return out;
  } catch (err) {
    await record({
      operation,
      provider: provider.name,
      model: req.model ?? "(configured)",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - start,
      ok: false,
    });
    throw err;
  }
}
