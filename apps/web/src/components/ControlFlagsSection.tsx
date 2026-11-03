/**
 * 🔴 Phase 18 R-11a — DR-14's control flags (register §11.111): Company settings → where one person did both
 * halves of something a second person usually does.
 *
 * A flag never blocks anything; this is where the approvers (admin, accountant — the only roles the server lets
 * read them) see them, newest first, with the true total. The section appears once there is a flag to show (an
 * empty block does not print its emptiness, CLAUDE.md §3), and only to the roles that can read it.
 */
import { useState } from "react";
import { useListControlFlags, type ControlFlag } from "@workspace/api-client-react";
import { fmtDate } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

const PAGE = 20;

export function ControlFlagsSection() {
  const { user } = useAuth();
  const canRead = user?.organizationRole === "admin" || user?.organizationRole === "accountant";
  if (!canRead) return null;
  return <ControlFlagsList />;
}

function ControlFlagsList() {
  const { t, lang } = useLanguage();
  const [limit, setLimit] = useState(PAGE);
  const list = useListControlFlags({ limit, offset: 0 });

  const kindLabel = (k: ControlFlag["kind"]) => {
    switch (k) {
      case "self_approval":
        return t("Approved a document they made", "اعتمد مستندًا أعدّه بنفسه");
      case "pair_approve_pay":
        return t("Approved a bill and paid it", "اعتمد فاتورة مورد ثم دفعها");
      case "pair_post_reverse":
        return t("Posted a journal entry and reversed it", "رحّل قيدًا ثم عكسه");
      case "pair_complete_reopen":
        return t("Completed a bank reconciliation and reopened it", "أتمّ تسوية بنكية ثم أعاد فتحها");
      case "pair_commit_reverse":
        return t("Committed a migration and reversed it", "اعتمد ترحيل بيانات ثم عكسه");
      case "pair_remit_file":
        return t("Remitted withholding tax and filed its return", "سدّد ضريبة الاستقطاع ثم قدّم إقرارها");
    }
  };
  const documentLabel = (f: ControlFlag) => {
    const name: Record<string, [string, string]> = {
      journal_entry: ["Journal entry", "قيد يومية"],
      bill: ["Bill", "فاتورة مورد"],
      invoice: ["Invoice", "فاتورة"],
      payroll_run: ["Payroll run", "مسير رواتب"],
      quotation: ["Quotation", "عرض سعر"],
      purchase_order: ["Purchase order", "أمر شراء"],
      budget_version: ["Budget version", "نسخة موازنة"],
      tax_computation_version: ["Zakat or income-tax computation", "احتساب زكاة أو ضريبة دخل"],
      wht_treaty_relief: ["Treaty relief", "إعفاء بموجب اتفاقية"],
      scheduled_payment: ["Payment plan", "خطة دفع"],
      bank_reconciliation: ["Bank reconciliation", "تسوية بنكية"],
      migration_batch: ["Migration", "ترحيل بيانات"],
      wht_return: ["Withholding-tax return", "إقرار ضريبة الاستقطاع"],
    };
    const [en, ar] = name[f.entityType] ?? [f.entityType, f.entityType];
    return `${t(en, ar)} ${f.reference ?? `#${f.entityId}`}`;
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  if (total === 0) return null;
  return (
    <Card className="border-border bg-card" data-testid="control-flags">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t("Control flags", "تنبيهات الرقابة")} <span className="text-muted-foreground font-normal" data-testid="control-flags-total">({total})</span>
        </CardTitle>
        <CardDescription>
          {t(
            "Where one person did both halves of something a second person usually does. A flag never blocks anything; it is recorded for review.",
            "حيث قام شخص واحد بخطوتين يقوم بهما عادةً شخصان. التنبيه لا يمنع أي إجراء، وإنما يُسجَّل للمراجعة.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y divide-border">
          {items.map((f) => (
            <li key={f.id} className="py-2 space-y-0.5" data-testid={`control-flag-${f.id}`} data-kind={f.kind}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{kindLabel(f.kind)}</span>
                <span className="text-xs text-muted-foreground">{fmtDate(f.createdAt, lang)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {f.actorName ?? `#${f.actorUserId}`} · {documentLabel(f)}
              </p>
            </li>
          ))}
        </ul>
        {items.length < total && (
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[11px] text-muted-foreground">
              {t(`Showing ${items.length} of ${total}.`, `يُعرض ${items.length} من ${total}.`)}
            </span>
            <Button type="button" size="sm" variant="outline" data-testid="control-flags-more" onClick={() => setLimit(limit + PAGE)}>
              {t("Show more", "عرض المزيد")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
