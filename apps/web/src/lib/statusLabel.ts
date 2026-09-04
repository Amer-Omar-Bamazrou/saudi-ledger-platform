/**
 * 🔴 QA fix (2026-09-04): document-status labels in Arabic.
 *
 * Status badges rendered the raw English enum (`draft`, `sent`, `received`…)
 * even in the Arabic UI — jarring on an otherwise-Arabic screen. One shared
 * map so the invoice, bill, quotation and PO pages all read the same, and a
 * new status can only be added in one place. Unknown values fall back to the
 * raw string rather than throwing — a badge is not the place to fail.
 */
const STATUS_AR: Record<string, string> = {
  draft: "مسودة",
  submitted: "بانتظار الاعتماد",
  sent: "صادرة",
  received: "مستلمة",
  approved: "معتمدة",
  paid: "مدفوعة",
  overdue: "متأخرة",
  rejected: "مرفوضة",
  converted: "محوّلة",
  expired: "منتهية",
};

export function statusLabel(status: string, lang: "en" | "ar"): string {
  if (lang !== "ar") return status;
  return STATUS_AR[status] ?? status;
}
