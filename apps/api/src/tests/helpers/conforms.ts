/**
 * CONTRACT CONFORMANCE, as a one-line assertion — the report-contract-conformance
 * pattern (2026-09-01) shared, so a suite that already produces a response on
 * REAL ROWS can prove it parses under the generated `…Response` schema without
 * a second fixture. "A spec entry nobody has parsed a response against is a
 * claim, not a contract — conformance converts it" (CLAUDE.md §3).
 *
 * 🔴 It validates what goes over the WIRE, not the in-memory object: `res.json`
 * serialises Dates to ISO strings and drops undefined keys, and the contract
 * describes the response a client receives (a required key that is undefined
 * is MISSING after the round-trip, so it still fails). Zod objects strip
 * unknown keys silently, so a NEW field is not a failure — a missing required
 * field, a wrong type, or a null where the schema said string is.
 */
import { expect } from "vitest";

type ParseResult = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

export function expectConforms(schema: { safeParse: (v: unknown) => ParseResult }, value: unknown, label: string): void {
  const r = schema.safeParse(JSON.parse(JSON.stringify(value)));
  const why = r.success || !r.error ? "" : r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
  expect(r.success, `${label} does not conform to its generated schema:\n${why}`).toBe(true);
}
