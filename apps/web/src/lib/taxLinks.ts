/**
 * QA-16 (2026-10-04) — where an obligations row's figure is answered, scoped
 * to the ROW: the WHT month, the VAT period, the approved computation that
 * dates a Zakat or income-tax balance. The rows used to link to each tax's
 * front page, which then answered a broader question than the row asked.
 * Each destination reads the scope from the URL (WithholdingTax, VatReport).
 */
import type { TaxObligation } from "@workspace/api-client-react";

/** Where the row's figure is answered — scoped to the row (the month, the period, the computation), never the tax's front page. */
export function hrefOf(o: Pick<TaxObligation, "kind" | "source">): string {
  if (o.kind === "wht") return o.source.period ? `/tax/withholding?tab=return&period=${encodeURIComponent(o.source.period)}` : "/tax/withholding";
  if (o.kind === "zakat" || o.kind === "income_tax") {
    if (o.source.computationId != null) return `/tax/computations/${o.source.computationId}`;
    return o.kind === "zakat" ? "/zakat" : "/tax/income-tax";
  }
  return o.source.from && o.source.to ? `/vat?from=${o.source.from.slice(0, 7)}&to=${o.source.to.slice(0, 7)}` : "/vat";
}
