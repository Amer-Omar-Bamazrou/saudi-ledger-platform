/**
 * LLM controller — hybrid (deterministic + Ollama) categorization endpoints.
 * No DB access (no repository); it orchestrates the categorization services only.
 * AI PROPOSES: these endpoints never write to the ledger. Behavior preserved
 * from pre-M6 (unexpected errors → generic 500 via the central errorHandler).
 */
import type { Request, Response } from "express";
import {
  LLM_MODEL,
  checkOllamaReachable,
  categorizeWithLlm,
} from "../services/categorization/llmCategorizer.js";
import { categorizeTransaction } from "../services/categorization/categorizer.js";
import { BadRequestError } from "../lib/errors";

export const llmController = {
  async status(_req: Request, res: Response) {
    const status = await checkOllamaReachable();
    res.json({
      activModel: LLM_MODEL,
      ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
      ...status,
      note:
        LLM_MODEL === "none"
          ? "LLM disabled. Set LLM_MODEL=llama3 or LLM_MODEL=qwen2.5 to enable."
          : `Using ${LLM_MODEL}. Deterministic engine is primary; LLM is invoked for confidence < 0.65.`,
    });
  },

  async categorize(req: Request, res: Response) {
    const { description, amount, type, descriptionAr } = req.body;
    if (!description || amount == null || !type) {
      throw new BadRequestError("description, amount, and type (debit|credit) are required");
    }
    const result = await categorizeWithLlm(
      String(description),
      Number(amount),
      type as "debit" | "credit",
      descriptionAr ?? null,
    );
    res.json(result);
  },

  async compare(req: Request, res: Response) {
    const items: any[] = req.body?.transactions ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestError("transactions array is required");
    }
    if (items.length > 50) {
      throw new BadRequestError("Maximum 50 transactions per compare request");
    }

    const results = await Promise.all(
      items.map(async (it) => {
        const det = categorizeTransaction(
          String(it.description),
          Number(it.amount),
          it.type as "debit" | "credit",
          it.descriptionAr ?? null,
        );
        const hybrid = await categorizeWithLlm(
          String(it.description),
          Number(it.amount),
          it.type as "debit" | "credit",
          it.descriptionAr ?? null,
        );
        return {
          input: { description: it.description, amount: Number(it.amount), type: it.type },
          deterministic: det
            ? { categoryName: det.categoryName, confidence: det.confidence, matchedRule: det.matchedRule }
            : null,
          hybrid: {
            categoryName: hybrid.categoryName,
            confidence: hybrid.confidence,
            source: hybrid.source,
            llmModel: hybrid.llmModel,
            matchedRule: hybrid.matchedRule,
          },
          agreement: det?.categoryId === hybrid.categoryId,
        };
      }),
    );

    const agreed = results.filter((r) => r.agreement).length;
    res.json({
      model: LLM_MODEL,
      total: results.length,
      agreed,
      disagreed: results.length - agreed,
      agreementRate: `${((agreed / results.length) * 100).toFixed(1)}%`,
      results,
    });
  },

  async demo(_req: Request, res: Response) {
    const DEMO_TRANSACTIONS = [
      { description: "STC mobile bill payment", amount: 299, type: "debit" as const },
      { description: "Al-Rajhi Bank transfer fee", amount: 15, type: "debit" as const },
      { description: "Customer payment - Invoice #1042", amount: 15000, type: "credit" as const },
      { description: "Aramco fuel - company vehicle", amount: 450, type: "debit" as const },
      { description: "Google Ads campaign - Q3", amount: 3200, type: "debit" as const },
      { description: "Hilton Riyadh hotel - team offsite", amount: 8750, type: "debit" as const },
      { description: "GOSI employee contribution July", amount: 9750, type: "debit" as const },
      { description: "Office rent - Al Olaya district", amount: 12500, type: "debit" as const },
      { description: "Unknown wire transfer received", amount: 5000, type: "credit" as const },
      { description: "خدمات استشارية - مكتب المحاسبة", amount: 7500, type: "debit" as const, descriptionAr: "خدمات استشارية" },
    ];

    const results = await Promise.all(
      DEMO_TRANSACTIONS.map(async (tx) => {
        const det = categorizeTransaction(tx.description, tx.amount, tx.type, (tx as any).descriptionAr ?? null);
        const hybrid = await categorizeWithLlm(tx.description, tx.amount, tx.type, (tx as any).descriptionAr ?? null);
        return {
          description: tx.description,
          amount: tx.amount,
          type: tx.type,
          deterministic: det
            ? { category: det.categoryName, confidence: +(det.confidence * 100).toFixed(1), rule: det.matchedRule }
            : { category: "No match", confidence: 0, rule: "none" },
          hybrid: {
            category: hybrid.categoryName,
            confidence: +(hybrid.confidence * 100).toFixed(1),
            source: hybrid.source,
            model: hybrid.llmModel ?? "n/a",
          },
          match: det?.categoryId === hybrid.categoryId,
        };
      }),
    );

    const agreed = results.filter((r) => r.match).length;
    res.json({
      activeModel: LLM_MODEL,
      note:
        LLM_MODEL === "none"
          ? "LLM disabled — all results from deterministic engine. Set LLM_MODEL=qwen2.5 or LLM_MODEL=llama3 to enable Ollama."
          : `Hybrid mode: deterministic first, ${LLM_MODEL} for low-confidence items.`,
      summary: { total: 10, agreed, disagreed: 10 - agreed },
      transactions: results,
    });
  },
};
