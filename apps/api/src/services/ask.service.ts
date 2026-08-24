/**
 * Grounded answers (AI-6a) — "ask your books," register A only.
 *
 * ── The register decision (owner, 2026-08-24) ──────────────────────────────
 * FACT + PROJECTION, no OPINION: the answer states figures the platform
 * computed and IF-THEN arithmetic under a STATED assumption — it never
 * advises, judges, or explains causes. "The CFO that shows its work and
 * never advises," chosen deliberately; the opinion register is QUEUED for
 * post-C10 (ai-6-proposal.md §0), and the fence question travels with it.
 *
 * ── Grounding: the model SELECTS, it never AUTHORS ─────────────────────────
 * The model's only powers are (1) picking ONE tool from a fixed menu of
 * EXISTING deterministic computations (Analytics + Finance Hub scope —
 * owner Q3) and (2) rendering that tool's output in words, both languages.
 * It never writes SQL, never sees raw tables, never invents a number — the
 * AI-3b verifier checks every numeric token and entity in the answer
 * against the tool's output.
 *
 * 🔴 THE ASSUMPTION RULE, MECHANICALLY ENFORCED (owner addition): a
 * projection's assumption is part of the TOOL'S OUTPUT, and the verifier
 * REJECTS an answer that uses the tool without carrying the assumption
 * sentence in BOTH languages — "an assumption a reader can skip is an
 * assumption they'll skip," so a skippable assumption is a rejected answer.
 *
 * ── Storage and refusal ────────────────────────────────────────────────────
 * Every exchange is a ROW (owner Q4) — refusals included; a REJECTED model
 * output is stored as a refusal WITHOUT the rejected text (unverified prose
 * is never persisted). Refusal is a feature: a question the tools cannot
 * answer gets "your books cannot answer that," never an improvisation.
 *
 * ── Availability ───────────────────────────────────────────────────────────
 * This surface IS the model — there is no deterministic floor for an
 * answer, so unavailability is an honest 503, and the UI hides the ask box
 * via /ask/status. Dark for real tenants until the Enterprise agreement by
 * the AI-1a boot boundary (ledger data reaches the model by construction).
 */
import { loadEnv } from "@workspace/config";
import { db, groundedAnswersTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { AppError, BadRequestError } from "../lib/errors";
import { logger } from "../lib/logger";
import { auditService } from "./audit.service";
import { GroqProvider } from "./ai/provider";
import { meteredChat } from "./ai/metered";
import { analyticsService } from "./analytics.service";
import { financeHubService } from "./financeHub.service";
import { reportsService } from "./reports.service";
import { verifyExplanation } from "./findings.explanationVerifier";

const TRAILING_MONTHS = 6;

export const RUNWAY_ASSUMPTION_EN = "holding the last six months constant";
export const RUNWAY_ASSUMPTION_AR = "بافتراض بقاء نمط الأشهر الستة الأخيرة على حاله";

interface ToolDef {
  description: string;
  args: Record<string, string>;
  run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** When set, the verifier requires BOTH sentences verbatim in the answer. */
  requiredAssumption?: { en: string; ar: string };
}

const ym = /^\d{4}-\d{2}$/;
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, re: RegExp, name: string): string => {
  if (typeof v !== "string" || !re.test(v)) throw new BadRequestError(`${name} is not in the expected format`);
  return v;
};

/** GL cash as at a date: the balance sheet's `cash`-class asset items. Single-source (post-A: the GL owns cash). */
async function glCash(asOf: string): Promise<{ cash: number; suspense: number; transferSuspense: number }> {
  const bs = await reportsService.balanceSheet(asOf);
  const cash = (bs.assets.items as Array<{ liquidityClass: string | null; amount: number }>)
    .filter((i) => i.liquidityClass === "cash")
    .reduce((s, i) => s + i.amount, 0);
  return {
    cash: Math.round(cash * 100) / 100,
    suspense: bs.assets.suspenseBalance,
    transferSuspense: bs.assets.transferSuspenseBalance,
  };
}

/**
 * The v1 tool menu — Analytics + Finance Hub computations (owner Q3: "those
 * are already the questions tenants ask"). `decompose` is deliberately
 * deferred (enum-argument complexity, an easy later add — logged here so
 * the omission is a decision, not an accident).
 */
export const ASK_TOOLS: Record<string, ToolDef> = {
  liquidity: {
    description: "Current/quick ratios, working capital, and any blockers withholding the liquidity claim, as of today.",
    args: {},
    run: () => financeHubService.liquidity() as Promise<Record<string, unknown>>,
  },
  books_status: {
    description: "How current the books are: pending review counts, unposted rows, last activity.",
    args: {},
    run: () => financeHubService.booksStatus() as Promise<Record<string, unknown>>,
  },
  tax_compliance: {
    description: "The VAT position figures and ZATCA status the Finance Hub reports.",
    args: {},
    run: () => financeHubService.taxCompliance() as Promise<Record<string, unknown>>,
  },
  trend: {
    description: "Liquidity and solvency positions per month end, for a YYYY-MM range.",
    args: { from: "YYYY-MM", to: "YYYY-MM" },
    run: async (a) => ({
      points: await analyticsService.trend(str(a.from, ym, "from"), str(a.to, ym, "to")),
    }),
  },
  receivables_bridge: {
    description: "Invoiced vs collected and the receivables bridge per period, for a YYYY-MM-DD range.",
    args: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" },
    run: async (a) => ({
      points: await analyticsService.receivablesBridge(str(a.from, ymd, "from"), str(a.to, ymd, "to")),
    }),
  },
  runway_projection: {
    description:
      "IF-THEN arithmetic: given an added monthly cost, when GL cash reaches zero at the trailing six-month average net cash movement. Use for affordability-shaped questions.",
    args: { addedMonthlyCost: "number >= 0" },
    requiredAssumption: { en: RUNWAY_ASSUMPTION_EN, ar: RUNWAY_ASSUMPTION_AR },
    run: async (a) => {
      const added = Number(a.addedMonthlyCost);
      if (!Number.isFinite(added) || added < 0) throw new BadRequestError("addedMonthlyCost must be a non-negative number");
      const today = new Date();
      const prior = new Date(today);
      prior.setUTCMonth(prior.getUTCMonth() - TRAILING_MONTHS);
      const [now, then] = await Promise.all([
        glCash(today.toISOString().slice(0, 10)),
        glCash(prior.toISOString().slice(0, 10)),
      ]);

      // 🔴 The liquidity-claim rule carries over (A, 2026-08-17): cash the
      // platform cannot classify blocks the CLAIM. A projection built on
      // blocked cash would assert what the hub itself withholds — so the
      // projection is WITHHELD with the blockers named, and the answer
      // states that fact instead of a number.
      const blockers: Array<{ code: string; amount: number }> = [];
      if (Math.abs(now.suspense) >= 0.01) blockers.push({ code: "suspense_balance", amount: now.suspense });
      if (Math.abs(now.transferSuspense) >= 0.01)
        blockers.push({ code: "undeclared_transfers", amount: now.transferSuspense });
      if (blockers.length > 0) {
        return { blocked: true, blockers, currentCash: now.cash };
      }

      const avgMonthlyNet = Math.round(((now.cash - then.cash) / TRAILING_MONTHS) * 100) / 100;
      const projectedMonthlyNet = Math.round((avgMonthlyNet - added) * 100) / 100;
      const monthsToZero =
        projectedMonthlyNet < 0 ? Math.round((now.cash / -projectedMonthlyNet) * 10) / 10 : null;
      return {
        blocked: false,
        currentCash: now.cash,
        trailingMonths: TRAILING_MONTHS,
        avgMonthlyNet,
        addedMonthlyCost: added,
        projectedMonthlyNet,
        /** NULL = the projected net is not negative: cash does not reach zero under the assumption. */
        monthsToZero,
        assumptionEn: RUNWAY_ASSUMPTION_EN,
        assumptionAr: RUNWAY_ASSUMPTION_AR,
      };
    },
  },
};

function selectionPrompt(question: string): string {
  const menu = Object.entries(ASK_TOOLS)
    .map(([name, t]) => `- ${name}: ${t.description} args: ${JSON.stringify(t.args)}`)
    .join("\n");
  return `You route a bookkeeping question to exactly ONE deterministic computation, or refuse.
If no tool can answer the question from the tenant's books, refuse — do not improvise.

Tools:
${menu}

Question: ${question}

Reply with JSON only: {"tool": "name", "args": {...}} or {"refuse": true, "reason": "..."}`;
}

function composePrompt(question: string, tool: string, result: Record<string, unknown>, def: ToolDef): string {
  const assumption = def.requiredAssumption
    ? `\n- The result rests on an assumption. Your answer MUST contain, verbatim, "${def.requiredAssumption.en}" in the English and "${def.requiredAssumption.ar}" in the Arabic — inside the sentence that states the projection, never as an aside.`
    : "";
  return `You are answering a Saudi business owner's question from their own books.

STRICT RULES:
- Use ONLY the numbers and names in the data below. Do not add context, infer causes, give advice or recommendations, or judge whether anything is good, bad, affordable or risky. State what the data says; the reader draws the conclusion.
- At most three sentences per language.${assumption}
- Reply with JSON only: {"en": "...", "ar": "..."}

Question: ${question}
Tool: ${tool}
Data: ${JSON.stringify(result)}`;
}

function judgeAnswerPrompt(result: Record<string, unknown>, en: string, ar: string): string {
  return `Below is the ONLY data available, and a two-language answer that must state data only — no advice, no recommendation, no judgment (e.g. "you can afford", "you should", "healthy", "risky"), no causes, nothing absent from the data.
List every such violation. An empty list means the answer stays within the data.

Data: ${JSON.stringify(result)}
Answer (en): ${en}
Answer (ar): ${ar}

Reply with JSON only: {"violations": ["..."]} or {"violations": []}`;
}

/** Parse the ANSWER, not the thinking (the AI-1b parser lesson). */
function extractJson(text: string): Record<string, unknown> | null {
  let t = text;
  const open = t.indexOf("<think>");
  if (open >= 0) {
    const close = t.indexOf("</think>");
    if (close < 0) return null;
    t = t.slice(0, open) + t.slice(close + "</think>".length);
  }
  const matches = t.match(/\{[\s\S]*\}/);
  if (!matches) return null;
  try {
    return JSON.parse(matches[0]);
  } catch {
    const inner = t.match(/\{[\s\S]*?\}/g);
    if (!inner) return null;
    try {
      return JSON.parse(inner[inner.length - 1]);
    } catch {
      return null;
    }
  }
}

export interface AskDeps {
  chat?: (prompt: string) => Promise<string>;
}

export interface AskResult {
  refused: boolean;
  refusalReason: string | null;
  toolUsed: string | null;
  answer: { en: string; ar: string } | null;
}

function providerChat(): ((prompt: string) => Promise<string>) | null {
  const env = loadEnv();
  if (env.AI_PROVIDER !== "groq" || !env.GROQ_API_KEY) return null;
  const provider = new GroqProvider(env.GROQ_API_KEY, env.GROQ_MODEL, env.GROQ_VISION_MODEL);
  return async (prompt: string) =>
    (await meteredChat(provider, "grounded_answer", { prompt, maxTokens: 400, timeoutMs: 30_000 })).text;
}

export const askService = {
  available(): boolean {
    const env = loadEnv();
    return env.AI_PROVIDER === "groq" && !!env.GROQ_API_KEY;
  },

  async list() {
    const rows = await db
      .select()
      .from(groundedAnswersTable)
      .orderBy(desc(groundedAnswersTable.createdAt), desc(groundedAnswersTable.id))
      .limit(50);
    return rows.map((r) => ({
      id: r.id,
      question: r.question,
      toolUsed: r.tool,
      answer: (r.answer as { en: string; ar: string } | null),
      refused: r.refused,
      refusalReason: r.refusalReason,
      createdAt: r.createdAt.toISOString(),
    }));
  },

  async ask(question: string, userId: number | null, deps: AskDeps = {}): Promise<AskResult> {
    const q = question.trim();
    if (!q || q.length > 500) throw new BadRequestError("A question of 1–500 characters is required.");

    const chat = deps.chat ?? providerChat();
    if (!chat) {
      // No deterministic floor exists for an ANSWER — unavailability is an
      // honest 503, not an improvised reply. Not stored: no exchange happened.
      throw new AppError(503, "The assistant is not enabled on this deployment.");
    }

    const store = async (row: {
      tool?: string | null;
      toolArgs?: Record<string, unknown> | null;
      answer?: { en: string; ar: string; toolResultDigest?: string } | null;
      refused: boolean;
      refusalReason?: string | null;
    }): Promise<AskResult> => {
      await db.insert(groundedAnswersTable).values({
        question: q,
        tool: row.tool ?? null,
        toolArgs: row.toolArgs ?? null,
        answer: row.answer ?? null,
        refused: row.refused,
        refusalReason: row.refusalReason ?? null,
        createdBy: userId,
      });
      await auditService.record({
        action: "create",
        entityType: "grounded_answer",
        entityId: "ask",
        after: { question: q, tool: row.tool ?? null, refused: row.refused, refusalReason: row.refusalReason ?? null },
      });
      return {
        refused: row.refused,
        refusalReason: row.refusalReason ?? null,
        toolUsed: row.tool ?? null,
        answer: row.answer ? { en: row.answer.en, ar: row.answer.ar } : null,
      };
    };

    // ── 1. Selection ─────────────────────────────────────────────────────────
    const selRaw = await chat(selectionPrompt(q));
    const sel = extractJson(selRaw);
    if (!sel) return store({ refused: true, refusalReason: "selection_unparseable" });
    if (sel.refuse === true || typeof sel.tool !== "string") {
      return store({ refused: true, refusalReason: "your_books_cannot_answer" });
    }
    const def = ASK_TOOLS[sel.tool];
    if (!def) return store({ refused: true, refusalReason: "unknown_tool" });
    const args = (sel.args ?? {}) as Record<string, unknown>;

    // ── 2. The deterministic computation ─────────────────────────────────────
    let result: Record<string, unknown>;
    try {
      result = await def.run(args);
    } catch (err) {
      logger.warn({ err, tool: sel.tool }, "ask: tool execution failed");
      return store({ tool: sel.tool, toolArgs: args, refused: true, refusalReason: "tool_failed" });
    }

    // ── 3. Composition ───────────────────────────────────────────────────────
    const ansRaw = await chat(composePrompt(q, sel.tool, result, def));
    const parsed = extractJson(ansRaw);
    const en = typeof parsed?.en === "string" ? parsed.en.trim() : "";
    const ar = typeof parsed?.ar === "string" ? parsed.ar.trim() : "";
    if (!en || !ar || en.length > 700 || ar.length > 700) {
      return store({ tool: sel.tool, toolArgs: args, refused: true, refusalReason: "answer_rejected:parse_failed" });
    }

    // ── 4. Verification — the AI-3b verifier over the TOOL RESULT ───────────
    let bad = verifyExplanation(en, result);
    if (bad.ok) bad = verifyExplanation(ar, result);
    if (!bad.ok) {
      // 🔴 Telemetry distinguishability travels here too: token + script +
      // normalized form, so invention and normalisation bugs stay separable.
      logger.warn(
        { tool: sel.tool, reason: bad.reason, token: bad.token, script: bad.script, normalized: bad.normalized },
        "ask: answer rejected — unverified prose is not stored",
      );
      return store({ tool: sel.tool, toolArgs: args, refused: true, refusalReason: `answer_rejected:${bad.reason}` });
    }

    // 🔴 The assumption rule — a skippable assumption is a rejected answer.
    if (def.requiredAssumption) {
      if (!en.toLowerCase().includes(def.requiredAssumption.en.toLowerCase()) || !ar.includes(def.requiredAssumption.ar)) {
        logger.warn({ tool: sel.tool }, "ask: answer rejected — projection without its stated assumption");
        return store({
          tool: sel.tool,
          toolArgs: args,
          refused: true,
          refusalReason: "answer_rejected:assumption_missing",
        });
      }
    }

    // ── 5. The judge — advice/causation is the OPINION register, which does not exist ──
    const judgeRaw = await chat(judgeAnswerPrompt(result, en, ar));
    const judged = extractJson(judgeRaw);
    const violations = Array.isArray(judged?.violations) ? judged.violations : null;
    if (violations === null) {
      return store({ tool: sel.tool, toolArgs: args, refused: true, refusalReason: "answer_rejected:judge_unparseable" });
    }
    if (violations.length > 0) {
      logger.warn({ tool: sel.tool, violations: violations.slice(0, 5) }, "ask: answer rejected — opinion/invention flagged");
      return store({ tool: sel.tool, toolArgs: args, refused: true, refusalReason: "answer_rejected:opinion_or_invention" });
    }

    return store({ tool: sel.tool, toolArgs: args, answer: { en, ar }, refused: false });
  },
};
