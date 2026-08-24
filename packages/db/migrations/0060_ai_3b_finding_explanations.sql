-- ═══════════════════════════════════════════════════════════════════════════
-- AI-3b — the explanation column: model phrasing OF the facts, never beside
-- them in authority.
--
-- Owner constraints (2026-08-24): an explanation may not introduce a fact
-- the finding doesn't carry ("where, never why" at sentence level — the
-- boundary that keeps this shippable before C10), and the deterministic
-- content is the FLOOR — an unavailable model degrades quality, never
-- availability. Hence: one nullable jsonb column
--   { en, ar, model, generatedAt, factsHash }
-- and nothing else. `factsHash` is the staleness gate: the API returns the
-- explanation ONLY while the hash matches the current facts — a facts
-- refresh silently withholds it (an explanation stating numbers no longer
-- true would be invention by aging).
--
-- Values-only column ADD on `findings` (not a template/category table — the
-- org-seed trigger rule is not engaged).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "explanation" jsonb;--> statement-breakpoint
