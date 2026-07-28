/**
 * LLM routes — hybrid categorization (deterministic + optional Ollama).
 *   GET  /llm/status      → active model, reachability check
 *   POST /llm/categorize  → single transaction categorized by the hybrid engine
 *   POST /llm/compare     → deterministic vs LLM on <= 50 transactions
 *   GET  /llm/demo        → 10 sample transactions run through both engines
 */
import { Router } from "express";
import { llmController } from "../controllers/llm.controller";

const router = Router();

router.get("/status", llmController.status);
router.post("/categorize", llmController.categorize);
router.post("/compare", llmController.compare);
router.get("/demo", llmController.demo);

export default router;
