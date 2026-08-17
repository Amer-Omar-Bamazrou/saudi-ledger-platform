/**
 * B4 — the dated payment history, shown where payments are recorded.
 *
 * Each row is one payment with ITS OWN date — the fact the running total
 * destroyed before B4. A `backfilled` row is an AGGREGATE of pre-B4 payments
 * whose split and earlier dates were never recorded, and it says so instead
 * of posing as a single precise payment.
 */
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch, fmtNum } from "@/lib/api";
import { DualDate } from "@/components/DualDate";

interface PaymentRow {
  id: number;
  amount: number;
  paidAt: string;
  backfilled: boolean;
}

export function PaymentHistory({ entity, id }: { entity: "invoices" | "bills"; id: number | null }) {
  const { t } = useLanguage();
  const { data: rows = [] } = useQuery<PaymentRow[]>({
    queryKey: [entity, id, "payments"],
    queryFn: () => apiFetch(`/${entity}/${id}/payments`),
    enabled: id !== null,
  });

  if (rows.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-2">
      <p className="text-xs text-muted-foreground mb-1">{t("Payments so far", "الدفعات حتى الآن")}</p>
      <div className="space-y-1 max-h-32 overflow-y-auto">
        {rows.map((p) => (
          <div key={p.id} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              <DualDate date={p.paidAt} inline />
              {p.backfilled && (
                <span className="ml-1 opacity-70">
                  · {t("aggregate of earlier payments (dates not recorded)", "إجمالي دفعات سابقة (التواريخ غير مسجلة)")}
                </span>
              )}
            </span>
            <span className="font-mono">{fmtNum(p.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
