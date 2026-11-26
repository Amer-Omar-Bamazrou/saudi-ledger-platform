/**
 * 🔴 19B S6 (v4 §9, D7) — A STORED COPY'S CONTENT, AND ITS HASH.
 *
 * A copy is what ONE recipient was allowed to see at delivery: the columns they were decided, the rows with only the
 * cells they may read, and the list of what was withheld. Its SHA-256 is taken over a CANONICAL form — keys sorted at
 * every level — so the hash does not depend on the order a store hands the keys back in (jsonb does not keep it).
 */
import { createHash } from "node:crypto";

export interface DeliveryColumn { key: string; label: string; labelAr: string; kind: string; class: string; level: string; conditional: string | null; filterable: boolean; sortable: boolean }
export interface DeliveryWithheld { path: string; class: string; level: string; rows: number | null }
export interface DeliveryContent {
  dataset: string;
  columns: DeliveryColumn[];
  rows: Record<string, unknown>[];
  total: number;
  withheld: DeliveryWithheld[];
  /** 19.12 — a grouped report's subtotals, as this recipient was given them. Absent on a report that is not grouped. */
  grouped?: DeliveryGrouped;
}
export interface DeliveryTotals { count: number; totals: { column: string; total: number }[]; mixedCurrency: boolean }
export interface DeliveryGrouped { groupedBy: string; groups: (DeliveryTotals & { key: string | null; label: string | null })[]; grandTotal: DeliveryTotals | null }

/** JSON with every object's keys in sorted order; arrays keep their order. `undefined` is dropped, as JSON drops it. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export const contentSha256 = (content: unknown): string => createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
