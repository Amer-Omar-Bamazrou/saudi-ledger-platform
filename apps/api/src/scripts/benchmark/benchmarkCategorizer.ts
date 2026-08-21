/**
 * AI-1b — the categorizer Arabic benchmark (`pnpm benchmark:categorizer`).
 *
 * Measures, on the labeled synthetic corpus (`categorizerCases.ts`):
 *   1. the DETERMINISTIC engine alone — the baseline the LLM must beat on the
 *      hard cases without degrading the easy ones;
 *   2. the hybrid path (deterministic + LLM second opinion via the seam);
 * with 🔴 Arabic and English SCORED SEPARATELY — the §2a hard gate. A model
 * with strong English and weak Arabic FAILS regardless of its blended score.
 *
 * Also reports MEASURED token consumption per case from the `ai_usage` meter
 * (the benchmark is a consumer of the meter, not just a writer through it),
 * which turns the spec's "estimated cost" into an observed figure.
 *
 * Run:  GROQ_API_KEY=... AI_PROVIDER=groq pnpm --filter @workspace/api-server run benchmark:categorizer
 *       [--models m1,m2]   compare specific Groq models (default: configured GROQ_MODEL)
 *
 * Without a key it exits LOUDLY as NOT-RUN (never a silent pass) after
 * printing the deterministic baseline, which needs no network.
 */
import "dotenv/config";
import { pool, sessionPool, beginTenantConnection } from "@workspace/db";
import { loadEnv } from "@workspace/config";
import { categorizeTransaction } from "../../services/categorization/categorizer";
import { GroqProvider } from "../../services/ai/provider";
import { meteredChat } from "../../services/ai/metered";
import { BENCHMARK_CASES, type BenchmarkCase } from "./categorizerCases";
import { SEED_CATEGORIES } from "../../services/categorization/categorizer";
import * as fs from "node:fs";
import * as path from "node:path";

const LOW_CONFIDENCE_THRESHOLD = 0.65;

interface Verdict {
  case_: BenchmarkCase;
  deterministic: string | null;
  hybrid: string | null;
}

function prompt(c: BenchmarkCase, detHint: string | null): string {
  const categoryList = SEED_CATEGORIES.map((x) => `  ${x.systemCode}: ${x.name}`).join("\n");
  return `You are a Saudi Arabian bookkeeping assistant. Classify this bank transaction into exactly ONE category code from the list, or the literal string NONE if no category clearly applies (an unclear transaction must go to human review, not be guessed).

Description: ${c.description || "(none)"}
Arabic description: ${c.descriptionAr || "(none)"}
Type: ${c.type === "credit" ? "money received" : "money paid out"}
${detHint ? `A rule engine tentatively suggested: ${detHint}` : "The rule engine found no match."}

Category codes:
${categoryList}

Reply with JSON only: {"code": "SALES"} or {"code": "NONE"}`;
}

function parse(text: string): string | null {
  const m = text.match(/\{[^}]*\}/);
  if (!m) return null;
  try {
    const code = String(JSON.parse(m[0]).code ?? "");
    if (code === "NONE") return null;
    return SEED_CATEGORIES.some((x) => x.systemCode === code) ? code : null;
  } catch {
    return null;
  }
}

function score(verdicts: Verdict[], pick: (v: Verdict) => string | null, lang?: string, hardOnly?: boolean) {
  const subset = verdicts.filter(
    (v) => (!lang || v.case_.language === lang) && (!hardOnly || v.case_.hard === true),
  );
  const correct = subset.filter((v) => pick(v) === v.case_.expected).length;
  return { correct, total: subset.length, pct: subset.length ? Math.round((100 * correct) / subset.length) : 0 };
}

async function main() {
  const env = loadEnv();
  const modelsArg = process.argv.find((a) => a.startsWith("--models"));
  const models = modelsArg ? modelsArg.split("=")[1].split(",") : [env.GROQ_MODEL];

  // ── Deterministic baseline (no network, always runs) ─────────────────────
  const detVerdicts: Verdict[] = BENCHMARK_CASES.map((c) => ({
    case_: c,
    deterministic: categorizeTransaction(c.description, 100, c.type, c.descriptionAr)?.systemCode ?? null,
    hybrid: null,
  }));

  console.log("\n== Deterministic engine (baseline, no LLM) ==");
  for (const lang of ["en", "ar", "mixed"] as const) {
    const all = score(detVerdicts, (v) => v.deterministic, lang);
    const hard = score(detVerdicts, (v) => v.deterministic, lang, true);
    console.log(`  ${lang.padEnd(5)} ${all.correct}/${all.total} (${all.pct}%)   hard-only: ${hard.correct}/${hard.total} (${hard.pct}%)`);
  }

  if (env.AI_PROVIDER !== "groq" || !env.GROQ_API_KEY) {
    // 🔴 LOUD not-run — a benchmark that silently reports only the baseline
    // would read as "the model was measured" when it was not.
    console.log(
      "\n🔴 LLM BENCHMARK NOT RUN: set AI_PROVIDER=groq and GROQ_API_KEY in apps/api/.env.\n" +
        "   The deterministic baseline above involved no model call.\n",
    );
    await pool.end();
    await sessionPool.end();
    return;
  }

  // A benchmark run is metered like everything else; it needs a tenant scope.
  // The dev org qualifies under the owner's boundary (fixture/dev data only).
  const { rows } = await pool.query(
    `SELECT o.id AS org, c.id AS comp FROM organizations o JOIN companies c ON c.organization_id = o.id ORDER BY o.created_at ASC LIMIT 1`,
  );
  const scope = { organizationId: rows[0].org as string, companyId: rows[0].comp as string, role: "authenticated" };

  const results: Record<string, unknown>[] = [];
  for (const model of models) {
    const provider = new GroqProvider(env.GROQ_API_KEY!, model, env.GROQ_VISION_MODEL);
    const verdicts: Verdict[] = [];
    let failures = 0;
    let successes = 0;
    let firstFailure: string | null = null;

    for (const c of BENCHMARK_CASES) {
      const det = categorizeTransaction(c.description, 100, c.type, c.descriptionAr);
      let hybrid: string | null = det?.systemCode ?? null;
      if (!det || det.confidence < LOW_CONFIDENCE_THRESHOLD) {
        const conn = await beginTenantConnection(scope);
        try {
          const out = await conn.run(() =>
            meteredChat(provider, "benchmark_categorizer", {
              prompt: prompt(c, det ? det.systemCode : null),
              maxTokens: 60,
              timeoutMs: 25_000,
              model,
            }),
          );
          hybrid = parse(out.text) ?? (det?.systemCode ?? null);
          successes += 1;
          await conn.commit();
        } catch (err) {
          failures += 1;
          // 🔴 The first run of this benchmark swallowed every reason and
          // printed a vacuous gate verdict over 21 failures. The reason is
          // kept and the verdict below is gated on successes > 0.
          if (!firstFailure) firstFailure = err instanceof Error ? err.message.slice(0, 300) : String(err);
          hybrid = det?.systemCode ?? null; // the degrade contract, same as production
          await conn.commit(); // commit so the ok=false meter row survives
        }
      }
      verdicts.push({ case_: c, deterministic: det?.systemCode ?? null, hybrid });
      // Free tier is rate-limited; pace rather than burst.
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log(`
== Hybrid (deterministic + ${model}) : ${successes} model calls ok, ${failures} failed ==`);
    if (firstFailure) console.log(`  first failure: ${firstFailure}`);
    const perLang: Record<string, unknown> = {};
    for (const lang of ["en", "ar", "mixed"] as const) {
      const all = score(verdicts, (v) => v.hybrid, lang);
      const hard = score(verdicts, (v) => v.hybrid, lang, true);
      perLang[lang] = { all, hard };
      console.log(`  ${lang.padEnd(5)} ${all.correct}/${all.total} (${all.pct}%)   hard-only: ${hard.correct}/${hard.total} (${hard.pct}%)`);
    }
    // 🔴 The §2a gate, stated as a verdict — but ONLY over real model output.
    // The first run printed "✅ gate holds" over 21 failed calls: it was
    // comparing deterministic-vs-deterministic, a verdict about nothing. A
    // gate that judges zero evidence must say NOT JUDGED, loudly.
    const arHard = score(verdicts, (v) => v.hybrid, "ar", true);
    const enHard = score(verdicts, (v) => v.hybrid, "en", true);
    const gap = enHard.pct - arHard.pct;
    if (successes === 0) {
      console.log(`  🔴 ARABIC GATE: NOT JUDGED for ${model} — every model call failed; the scores above are the deterministic engine wearing a hybrid label.`);
    } else {
      console.log(
        gap > 15
          ? `  🔴 ARABIC GATE: FAILS for ${model} — hard-case gap EN ${enHard.pct}% vs AR ${arHard.pct}% (${gap} points). An English-strong/Arabic-poor model fails regardless of blended score.`
          : `  ✅ Arabic gate holds for ${model} on this corpus (hard-case gap ${gap} points, ${successes} model calls).`,
      );
    }

    // Measured consumption from the meter — the benchmark CONSUMES ai_usage.
    const usage = await pool.query(
      `SELECT count(*)::int AS calls, COALESCE(sum(prompt_tokens),0)::int AS pt, COALESCE(sum(completion_tokens),0)::int AS ct,
              COALESCE(avg(latency_ms),0)::int AS avg_ms, count(*) FILTER (WHERE NOT ok)::int AS failed
         FROM ai_usage WHERE operation = 'benchmark_categorizer' AND model = $1`,
      [model],
    );
    console.log(
      `  measured: ${usage.rows[0].calls} calls, ${usage.rows[0].pt} prompt + ${usage.rows[0].ct} completion tokens, avg ${usage.rows[0].avg_ms}ms, ${usage.rows[0].failed} failed`,
    );
    results.push({ model, successes, failures, firstFailure, perLang, usage: usage.rows[0], arabicGateGapPoints: successes > 0 ? gap : null });
  }

  const outDir = path.join(import.meta.dirname, "../../../../..", "docs", "ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const outFile = path.join(outDir, `categorizer-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ corpusSize: BENCHMARK_CASES.length, results }, null, 2));
  console.log(`\nreport written: ${outFile}\n`);

  await pool.end();
  await sessionPool.end();
}

main().catch(async (err) => {
  console.error("[benchmark] FAILED:", err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  await sessionPool.end().catch(() => {});
  process.exit(1);
});
