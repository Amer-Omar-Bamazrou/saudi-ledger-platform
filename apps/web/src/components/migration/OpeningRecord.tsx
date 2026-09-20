/**
 * Batch 1C, Issue 1 carry-over (2026-09-20): how an OPENING receivable is
 * told apart from a tax invoice Saudi Ledger issued, everywhere an invoice
 * row appears. A migrated balance has no hash, ICV or QR and never will; it
 * is collectible through D-4 like any receivable, but it is not a tax
 * invoice, so no tax-invoice document and no credit note is offered on it.
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { Badge } from "@/components/ui/badge";
import { Archive } from "lucide-react";

export const OPENING_RECORD_TEXT = {
  en: "Historical record from the previous system — not a tax invoice issued by Saudi Ledger.",
  ar: "سجل تاريخي من النظام السابق — ليس فاتورة ضريبية صادرة من Saudi Ledger.",
} as const;

export function OpeningRecordBadge() {
  const { t } = useLanguage();
  return (
    <Badge variant="outline" className="ms-2 text-[10px] gap-1 align-middle whitespace-nowrap" title={t(OPENING_RECORD_TEXT.en, OPENING_RECORD_TEXT.ar)} data-testid="opening-record-badge">
      <Archive className="w-3 h-3" />{t("Opening balance", "رصيد افتتاحي")}
    </Badge>
  );
}

/** The non-actionable explanation shown where a tax invoice's document buttons would be. */
export function OpeningRecordNote() {
  const { t } = useLanguage();
  return (
    <span className="text-[11px] text-muted-foreground inline-block leading-tight min-w-[12rem] max-w-[18rem]" data-testid="opening-record-note">
      {t(OPENING_RECORD_TEXT.en, OPENING_RECORD_TEXT.ar)}
    </span>
  );
}
