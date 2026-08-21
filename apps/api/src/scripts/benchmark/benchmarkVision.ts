/**
 * AI-1b — the receipt vision benchmark (`pnpm benchmark:vision`).
 *
 * Built BEFORE the corpus exists, on the owner's instruction, so the images
 * can be dropped in as they are photographed rather than the harness blocking
 * on them. 🔴 An empty corpus is a LOUD "NOT RUN", never a silent pass — a
 * benchmark that reports nothing measured as if it measured something is the
 * vacuous-probe disease.
 *
 * Corpus contract: docs/ai/receipt-benchmark/ (README there states the label
 * format and what to photograph). Images are the OWNER'S OWN receipts — no
 * tenant documents — which is what keeps the corpus legal on the free tier
 * under the §12b boundary.
 *
 * Scoring: per field (vendor / date / total / vat), per language, Arabic gate
 * stated as a verdict. `total`/`vat` compare to the halala; `date` exact;
 * `vendor` case-insensitive containment either way (a model printing
 * "Panda Retail Co" for "Panda" is reading, not failing).
 */
import "dotenv/config";
import { pool, sessionPool, beginTenantConnection } from "@workspace/db";
import { loadEnv } from "@workspace/config";
import { GroqProvider } from "../../services/ai/provider";
import { meteredVision } from "../../services/ai/metered";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dirname, "../../../../..");
const CORPUS = path.join(ROOT, "docs", "ai", "receipt-benchmark");

interface Label {
  file: string;
  vendor: string;
  date: string;
  total: number;
  vat: number | null;
  language: "ar" | "en" | "mixed";
  kind: string;
}

function readLabels(): Label[] {
  const csvPath = path.join(CORPUS, "labels.csv");
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const [header, ...rows] = lines;
  const cols = header.split(",").map((c) => c.trim());
  const idx = (name: string) => cols.indexOf(name);
  return rows.map((row) => {
    const f = row.split(",").map((c) => c.trim());
    return {
      file: f[idx("file")],
      vendor: f[idx("vendor")],
      date: f[idx("date")],
      total: Number(f[idx("total")]),
      vat: f[idx("vat")] ? Number(f[idx("vat")]) : null,
      language: (f[idx("language")] || "mixed") as Label["language"],
      kind: f[idx("kind")] || "other",
    };
  });
}

const MIME: Record<string, "image/jpeg" | "image/png" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const PROMPT = `Read this Saudi receipt or tax invoice. Extract exactly these fields and reply with JSON only:
{"vendor": "<seller name as printed>", "date": "YYYY-MM-DD", "total": <gross total as a number>, "vat": <VAT amount as a number, or null if not printed>}
If a field is unreadable, use null for it. Do not guess a value you cannot see.`;

interface FieldScore {
  vendor: boolean;
  date: boolean;
  total: boolean;
  vat: boolean;
}

function compare(label: Label, parsed: { vendor?: unknown; date?: unknown; total?: unknown; vat?: unknown }): FieldScore {
  const vendorGot = String(parsed.vendor ?? "").toLowerCase();
  const vendorWant = label.vendor.toLowerCase();
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.005;
  return {
    vendor: vendorGot.length > 0 && (vendorGot.includes(vendorWant) || vendorWant.includes(vendorGot)),
    date: String(parsed.date ?? "") === label.date,
    total: typeof parsed.total === "number" && near(parsed.total, label.total),
    vat:
      label.vat == null
        ? parsed.vat == null // 🔴 restraint scored: inventing a VAT the paper doesn't print is wrong
        : typeof parsed.vat === "number" && near(parsed.vat, label.vat),
  };
}

async function main() {
  const env = loadEnv();
  const labels = readLabels();
  const imagesDir = path.join(CORPUS, "images");
  const present = labels.filter((l) => fs.existsSync(path.join(imagesDir, l.file)));

  if (present.length === 0) {
    console.log(
      "\n🔴 VISION BENCHMARK NOT RUN — the corpus is empty.\n" +
        `   Drop labeled receipt photos into ${path.relative(ROOT, imagesDir)}/ per the README there.\n` +
        "   Nothing was measured; this is not a pass.\n",
    );
    await pool.end();
    await sessionPool.end();
    return;
  }
  if (present.length < labels.length) {
    console.log(`note: ${labels.length - present.length} label row(s) reference missing image files — skipped, not counted.`);
  }
  if (env.AI_PROVIDER !== "groq" || !env.GROQ_API_KEY) {
    console.log("\n🔴 VISION BENCHMARK NOT RUN: set AI_PROVIDER=groq and GROQ_API_KEY.\n");
    await pool.end();
    await sessionPool.end();
    return;
  }

  const modelsArg = process.argv.find((a) => a.startsWith("--models"));
  const models = modelsArg ? modelsArg.split("=")[1].split(",") : [env.GROQ_VISION_MODEL];

  const { rows } = await pool.query(
    `SELECT o.id AS org, c.id AS comp FROM organizations o JOIN companies c ON c.organization_id = o.id ORDER BY o.created_at ASC LIMIT 1`,
  );
  const scope = { organizationId: rows[0].org as string, companyId: rows[0].comp as string, role: "authenticated" };

  const report: Record<string, unknown>[] = [];
  for (const model of models) {
    const provider = new GroqProvider(env.GROQ_API_KEY!, env.GROQ_MODEL, model);
    const rowsOut: Array<{ label: Label; fields: FieldScore | null }> = [];
    let failures = 0;

    for (const label of present) {
      const file = path.join(imagesDir, label.file);
      const mime = MIME[path.extname(file).toLowerCase()];
      if (!mime) {
        console.log(`  skip ${label.file}: unsupported extension`);
        continue;
      }
      const imageBase64 = fs.readFileSync(file).toString("base64");
      const conn = await beginTenantConnection(scope);
      try {
        const out = await conn.run(() =>
          meteredVision(provider, "benchmark_vision", {
            prompt: PROMPT,
            maxTokens: 200,
            timeoutMs: 45_000,
            imageBase64,
            mimeType: mime,
            model,
          }),
        );
        await conn.commit();
        const m = out.text.match(/\{[\s\S]*\}/);
        const parsed = m ? (() => { try { return JSON.parse(m[0]); } catch { return null; } })() : null;
        rowsOut.push({ label, fields: parsed ? compare(label, parsed) : null });
      } catch {
        failures += 1;
        await conn.commit(); // keep the ok=false meter row
        rowsOut.push({ label, fields: null });
      }
      await new Promise((r) => setTimeout(r, 800)); // pace the free tier
    }

    console.log(`\n== Vision: ${model} — ${rowsOut.length} receipts, ${failures} provider failures ==`);
    const langs = ["ar", "en", "mixed"] as const;
    const perLang: Record<string, unknown> = {};
    for (const lang of langs) {
      const subset = rowsOut.filter((r) => r.label.language === lang);
      if (subset.length === 0) continue;
      const pct = (f: keyof FieldScore) =>
        Math.round((100 * subset.filter((r) => r.fields?.[f]).length) / subset.length);
      perLang[lang] = { n: subset.length, vendor: pct("vendor"), date: pct("date"), total: pct("total"), vat: pct("vat") };
      console.log(
        `  ${lang.padEnd(5)} n=${subset.length}  vendor ${pct("vendor")}%  date ${pct("date")}%  total ${pct("total")}%  vat ${pct("vat")}%`,
      );
    }
    const arTotal = (perLang["ar"] as { total?: number } | undefined)?.total;
    const enTotal = (perLang["en"] as { total?: number } | undefined)?.total;
    if (arTotal != null && enTotal != null) {
      const gap = enTotal - arTotal;
      console.log(
        gap > 15
          ? `  🔴 ARABIC GATE: FAILS for ${model} — total-extraction gap EN ${enTotal}% vs AR ${arTotal}%.`
          : `  ✅ Arabic gate holds for ${model} on this corpus (total-extraction gap ${gap} points).`,
      );
    } else {
      console.log("  (Arabic gate not judged: corpus lacks both an ar and an en subset)");
    }

    const usage = await pool.query(
      `SELECT count(*)::int AS calls, COALESCE(sum(prompt_tokens),0)::int AS pt, COALESCE(sum(completion_tokens),0)::int AS ct, COALESCE(avg(latency_ms),0)::int AS avg_ms
         FROM ai_usage WHERE operation = 'benchmark_vision' AND model = $1`,
      [model],
    );
    console.log(`  measured: ${usage.rows[0].calls} calls, ${usage.rows[0].pt}+${usage.rows[0].ct} tokens, avg ${usage.rows[0].avg_ms}ms`);
    report.push({ model, failures, perLang, usage: usage.rows[0] });
  }

  const outDir = path.join(ROOT, "docs", "ai", "benchmarks");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  fs.writeFileSync(path.join(outDir, `vision-${stamp}.json`), JSON.stringify({ corpusSize: present.length, report }, null, 2));
  console.log(`\nreport written: docs/ai/benchmarks/vision-${stamp}.json\n`);

  await pool.end();
  await sessionPool.end();
}

main().catch(async (err) => {
  console.error("[benchmark:vision] FAILED:", err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  await sessionPool.end().catch(() => {});
  process.exit(1);
});
