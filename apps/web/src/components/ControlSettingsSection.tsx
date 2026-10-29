/**
 * 🔴 Phase 18 H-9 — Company settings → Controls (register §11.56; DR-19, DR-21,
 * DR-23, each DECIDED 2026-10-27 — owner accepted the stated recommendation).
 *
 * The company's control settings — one typed slot per control — and the
 * finding each slot drives. DR-21: a slot starts EMPTY and its control OFF; no
 * number is suggested or prefilled here, and an empty field is sent as null
 * (never `Number("")`, which is 0). DR-23's finding lists payments made soon
 * after a supplier's IBAN changed; it is the SERVER's list, shown as it comes.
 *
 * Neutral styling on purpose: a payment inside a window the tenant chose is a
 * judgment to look at, not a state (CLAUDE.md §4, the status palette).
 * A non-admin sees the slot and why it is not theirs to change.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCompanyControlSettings,
  useUpdateCompanyControlSettings,
  useGetPaymentAfterBankChangeFinding,
  getGetCompanyControlSettingsQueryKey,
  getGetPaymentAfterBankChangeFindingQueryKey,
} from "@workspace/api-client-react";
import { fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

export function ControlSettingsSection() {
  const { t } = useLanguage();
  const { isOrgAdmin } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const settings = useGetCompanyControlSettings();
  const finding = useGetPaymentAfterBankChangeFinding();
  const stored = settings.data?.bankChangePaymentWindowDays ?? null;
  const [days, setDays] = useState("");
  useEffect(() => setDays(stored == null ? "" : String(stored)), [stored]);

  const update = useUpdateCompanyControlSettings({
    mutation: {
      onSuccess: (s) => {
        qc.invalidateQueries({ queryKey: getGetCompanyControlSettingsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetPaymentAfterBankChangeFindingQueryKey() });
        toast({
          title: s.bankChangePaymentWindowDays == null
            ? t("Control switched off", "تم إيقاف الضابط")
            : t("Control saved", "تم حفظ الضابط"),
        });
      },
      onError: (e) => toast({ title: t("Not saved", "لم يُحفظ"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
    },
  });
  const send = (value: number | null) => update.mutate({ data: { bankChangePaymentWindowDays: value } });

  const f = finding.data;
  return (
    <Card className="border-border bg-card" data-testid="control-settings">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("Controls", "الضوابط")}</CardTitle>
        <CardDescription>
          {t(
            "Each control starts empty and switched off. Nothing is checked until an administrator sets its number.",
            "يبدأ كل ضابط فارغاً ومتوقفاً. لا يُفحص شيء حتى يحدد مسؤول النظام رقمه.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="control-bank-change-window">
            {t("Payment soon after a supplier's bank details change — window in days", "دفعة بعد تغيير البيانات البنكية للمورد بوقت قصير — المدة بالأيام")}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="control-bank-change-window"
              data-testid="control-window-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              className="w-28"
              value={days}
              disabled={!isOrgAdmin || update.isPending}
              onChange={(e) => setDays(e.target.value)}
            />
            {isOrgAdmin && (
              <>
                <Button type="button" size="sm" data-testid="control-window-save" disabled={update.isPending || days.trim() === ""}
                  onClick={() => send(Number(days))}>
                  {t("Save", "حفظ")}
                </Button>
                <Button type="button" size="sm" variant="outline" data-testid="control-window-clear" disabled={update.isPending || stored == null}
                  onClick={() => send(null)}>
                  {t("Switch off", "إيقاف")}
                </Button>
              </>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {isOrgAdmin
              ? t("1 to 365 days. Empty means off.", "من 1 إلى 365 يوماً. الفراغ يعني متوقف.")
              : t("Only an administrator can change this setting.", "لا يغيّر هذا الإعداد إلا مسؤول النظام.")}
          </p>
        </div>

        <div className="space-y-2" data-testid="control-finding" data-enabled={f ? String(f.enabled) : undefined}>
          {!f ? null : !f.enabled ? (
            <p className="text-sm text-muted-foreground" data-testid="control-finding-off">
              {t(
                "Off. Set a window to list payments made soon after a supplier's IBAN was changed.",
                "متوقف. حدّد مدة لعرض الدفعات التي تمت بعد تغيير رقم الآيبان للمورد بوقت قصير.",
              )}
            </p>
          ) : (
            <>
              <p className="text-sm">
                {t(
                  `Payments made on, or within ${f.windowDays} days after, a change of the supplier's IBAN`,
                  `الدفعات التي تمت في يوم تغيير رقم الآيبان للمورد أو خلال ${f.windowDays} يوماً بعده`,
                )}
              </p>
              {f.items.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="control-finding-none">{t("None found.", "لا توجد.")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground text-start">
                        <th className="py-1 text-start font-medium">{t("Supplier", "المورد")}</th>
                        <th className="py-1 text-start font-medium">{t("Payment", "الدفعة")}</th>
                        <th className="py-1 text-end font-medium">{t("Amount", "المبلغ")}</th>
                        <th className="py-1 text-start font-medium">{t("Paid on", "تاريخ الدفع")}</th>
                        <th className="py-1 text-start font-medium">{t("IBAN changed on", "تاريخ تغيير الآيبان")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.items.map((i) => (
                        <tr key={`${i.kind}-${i.paymentId}`} className="border-t border-border" data-testid={`control-finding-row-${i.kind}-${i.paymentId}`}>
                          <td className="py-1">{i.vendorName}</td>
                          <td className="py-1">{i.kind === "bill_payment" ? t("Bill payment", "دفعة فاتورة مورد") : t("Supplier payment", "دفعة لمورد")}</td>
                          <td className="py-1 text-end tabular-nums">{fmtNum(i.amount)}</td>
                          <td className="py-1 tabular-nums">{i.paidAt}</td>
                          <td className="py-1 tabular-nums">{i.changedOn}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
