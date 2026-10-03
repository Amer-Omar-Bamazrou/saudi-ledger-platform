/**
 * Phase 15 — the words a budget's states are shown in, in one place (the
 * Budgets list, the detail page, the Analytics card). Neutral words, never the
 * status palette: a variance is a judgment, not a state (CLAUDE.md §4).
 */
type T = (en: string, ar: string) => string;

export function versionStatusLabel(status: string, t: T): string {
  switch (status) {
    case "draft": return t("Draft", "مسودة");
    case "submitted": return t("Submitted", "مُقدَّمة للاعتماد");
    case "approved": return t("Approved", "معتمدة");
    case "superseded": return t("Superseded", "مُستبدَلة");
    default: return status;
  }
}

export function scenarioLabel(scenario: string, t: T): string {
  switch (scenario) {
    case "base": return t("Base", "أساسي");
    case "best_case": return t("Best case", "أفضل حالة");
    case "worst_case": return t("Worst case", "أسوأ حالة");
    default: return scenario;
  }
}

export function judgementLabel(favourable: boolean | null, t: T): string {
  if (favourable == null) return "—";
  return favourable ? t("Favourable", "ملائم") : t("Unfavourable", "غير ملائم");
}

/** A fiscal period's short name in the budget's own calendar (a Hijri budget shows Hijri months). */
export function periodLabel(p: { no: number; startDate: string }, calendar: string, lang: string): string {
  const month = new Intl.DateTimeFormat(lang === "ar" ? "ar-SA" : "en-GB", {
    month: "short",
    calendar: calendar === "hijri" ? "islamic-umalqura" : "gregory",
    timeZone: "UTC",
  }).format(new Date(`${p.startDate}T00:00:00Z`));
  return `${p.no} · ${month}`;
}
