/**
 * 🔴 Phase 18 G4b — WHT owner decisions 17 and 18 (2026-10-27). RECORDS ONLY.
 *
 *  - 17: an over-withheld amount is pursued by a REFUND CLAIM — the six-item
 *    evidence checklist, the five-year clock (Law Art. 65(c), shown as 31
 *    December of the overpaid tax year + 5), and its steps: submitted, then
 *    refunded or refused. Nothing posts, and no month is reversed later.
 *  - 18: an INSTALMENT REQUEST under Resolution 1117 (WHT months up to 2026-05)
 *    counts only once ZATCA's WRITTEN acceptance is recorded.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListWhtRefundClaims, useCreateWhtRefundClaim, useAddWhtRefundClaimEvent, getListWhtRefundClaimsQueryKey,
  useListWhtInstalmentRequests, useCreateWhtInstalmentRequest, useAddWhtInstalmentRequestEvent, getListWhtInstalmentRequestsQueryKey,
  useListVendors, type WhtRefundChecklist,
} from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";
import { fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

type T = (en: string, ar: string) => string;
const ITEMS = ["contractAndInvoice", "correctCategoryAndRate", "originalStatementAndReceipt", "reconciliation", "whoBoreTheExcess", "beneficiaryAuthorisation"] as const;
function itemLabel(k: (typeof ITEMS)[number], t: T) {
  switch (k) {
    case "contractAndInvoice": return t("Contract and invoice", "العقد والفاتورة");
    case "correctCategoryAndRate": return t("The correct WHT category and rate", "فئة الاستقطاع ونسبته الصحيحتان");
    case "originalStatementAndReceipt": return t("The original statement and the payment receipt", "الإقرار الأصلي وإيصال السداد");
    case "reconciliation": return t("A reconciliation", "مطابقة");
    case "whoBoreTheExcess": return t("Who bore the excess", "من تحمّل الزيادة");
    case "beneficiaryAuthorisation": return t("The beneficiary's authorisation (where relevant)", "تفويض المستفيد (عند الاقتضاء)");
  }
}
const stateLabel = (s: string, t: T) => ({ open: t("Open", "مفتوحة"), submitted: t("Submitted", "مقدّمة"), refunded: t("Refunded", "مستردة"), refused: t("Refused", "مرفوضة"), requested: t("Requested — does not count yet", "مطلوبة — لا تُحتسب بعد"), accepted: t("Accepted in writing — counts", "مقبولة كتابةً — تُحتسب") } as Record<string, string>)[s] ?? s;

export function WhtClaims({ canRecord }: { canRecord: boolean }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fail = (e: unknown) => toast({ title: t("Not recorded", "لم يُسجَّل"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
  const claims = useListWhtRefundClaims();
  const requests = useListWhtInstalmentRequests();
  const vendors = useListVendors({ limit: 200 });
  const refreshClaims = () => qc.invalidateQueries({ queryKey: getListWhtRefundClaimsQueryKey() });
  const refreshRequests = () => qc.invalidateQueries({ queryKey: getListWhtInstalmentRequestsQueryKey() });

  const none = { held: false, note: "" };
  const emptyChecklist: WhtRefundChecklist = {
    contractAndInvoice: none, correctCategoryAndRate: none, originalStatementAndReceipt: none,
    reconciliation: none, whoBoreTheExcess: none, beneficiaryAuthorisation: none,
  };
  const [c, setC] = useState({ period: "", vendorId: "", overpaidTaxYear: "", excessAmount: "", borneBy: "", reason: "", checklist: emptyChecklist });
  const createClaim = useCreateWhtRefundClaim({ mutation: { onSuccess: () => { refreshClaims(); setC({ ...c, period: "", excessAmount: "", reason: "", checklist: emptyChecklist }); toast({ title: t("Refund claim recorded", "سُجّلت مطالبة الاسترداد") }); }, onError: fail } });
  const claimEvent = useAddWhtRefundClaimEvent({ mutation: { onSuccess: () => refreshClaims(), onError: fail } });

  const [r, setR] = useState({ periodFrom: "", periodTo: "", principal: "", requestedOn: businessToday(), reference: "" });
  const createRequest = useCreateWhtInstalmentRequest({ mutation: { onSuccess: () => { refreshRequests(); setR({ ...r, periodFrom: "", periodTo: "", principal: "", reference: "" }); toast({ title: t("Instalment request recorded", "سُجّل طلب التقسيط") }); }, onError: fail } });
  const requestEvent = useAddWhtInstalmentRequestEvent({ mutation: { onSuccess: () => refreshRequests(), onError: fail } });
  const [acceptRef, setAcceptRef] = useState<Record<number, string>>({});

  return (
    <div className="space-y-4" data-testid="wht-claims">
      <div className="rounded border border-border p-3 space-y-2 text-sm" data-testid="wht-refund-claims">
        <p className="font-medium">{t("Refund claims for over-withheld tax", "مطالبات استرداد الضريبة المستقطعة بالزيادة")}</p>
        <p className="text-xs text-muted-foreground">{t("A record only: nothing is posted and no later month is reversed. The claim's deadline is shown as 31 December of the overpaid tax year + 5 (Income Tax Law Art. 65(c)).", "سجلّ فقط: لا يُرحَّل شيء ولا يُعكس أي شهر لاحق. ويظهر موعد المطالبة في 31 ديسمبر من سنة الزيادة + 5 (المادة 65(ج) من نظام ضريبة الدخل).")}</p>
        <ul className="space-y-1 text-xs">
          {(claims.data?.items ?? []).map((x) => (
            <li key={x.id} className="rounded border border-border/60 p-2" data-testid={`wht-refund-claim-${x.id}`}>
              <span className="font-mono" dir="ltr">{x.period}</span> · <span className="font-mono" dir="ltr">{fmtNum(x.excessAmount)}</span> · {stateLabel(x.state, t)} · {t("evidence", "الأدلة")} {x.evidenceHeld}/{x.evidenceItems} · {t("deadline", "الموعد")} <span dir="ltr">{x.deadline}</span>{x.pastDeadline ? ` · ${t("past its deadline", "تجاوز موعده")}` : ""}
              {canRecord && x.state === "open" && <Button size="sm" variant="outline" className="h-6 text-xs ms-2" onClick={() => claimEvent.mutate({ id: x.id, data: { kind: "submitted", onDate: businessToday() } })} data-testid={`wht-refund-claim-submit-${x.id}`}>{t("Record as submitted today", "تسجيلها مقدّمة اليوم")}</Button>}
            </li>
          ))}
        </ul>
        {canRecord && (
          <div className="grid gap-2 sm:grid-cols-3" data-testid="wht-refund-claim-form">
            <div><Label className="text-xs">{t("WHT month", "شهر الاستقطاع")}</Label><Input type="month" value={c.period} onChange={(e) => setC({ ...c, period: e.target.value })} /></div>
            <div><Label className="text-xs">{t("Supplier", "المورد")}</Label>
              <Select value={c.vendorId || "unset"} onValueChange={(v) => setC({ ...c, vendorId: v === "unset" ? "" : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="unset">{t("— Choose —", "— اختر —")}</SelectItem>{(vendors.data?.items ?? []).map((v) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><Label className="text-xs">{t("Overpaid tax year", "سنة الزيادة")}</Label><Input dir="ltr" value={c.overpaidTaxYear} onChange={(e) => setC({ ...c, overpaidTaxYear: e.target.value })} /></div>
            <div><Label className="text-xs">{t("Excess withheld", "المبلغ الزائد")}</Label><Input dir="ltr" type="number" step="0.01" value={c.excessAmount} onChange={(e) => setC({ ...c, excessAmount: e.target.value })} /></div>
            <div><Label className="text-xs">{t("Who bore the excess", "من تحمّل الزيادة")}</Label>
              <Select value={c.borneBy || "unset"} onValueChange={(v) => setC({ ...c, borneBy: v === "unset" ? "" : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="unset">{t("— Choose —", "— اختر —")}</SelectItem><SelectItem value="beneficiary">{t("The supplier (withheld from it)", "المورد (استُقطعت منه)")}</SelectItem><SelectItem value="payer">{t("We bore it", "تحمّلناها نحن")}</SelectItem></SelectContent>
              </Select></div>
            <div><Label className="text-xs">{t("Why it was over-withheld", "سبب الزيادة")}</Label><Input value={c.reason} onChange={(e) => setC({ ...c, reason: e.target.value })} /></div>
            <div className="sm:col-span-3 grid gap-1 sm:grid-cols-2">
              {ITEMS.map((k) => (
                <label key={k} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={c.checklist[k].held} onChange={(e) => setC({ ...c, checklist: { ...c.checklist, [k]: { ...c.checklist[k], held: e.target.checked } } })} />{itemLabel(k, t)}</label>
              ))}
            </div>
            <Button size="sm" disabled={createClaim.isPending || !c.period || !c.vendorId || !c.overpaidTaxYear || !c.excessAmount || !c.borneBy || !c.reason.trim()}
              onClick={() => createClaim.mutate({ data: { period: c.period, vendorId: Number(c.vendorId), overpaidTaxYear: Number(c.overpaidTaxYear), excessAmount: Number(c.excessAmount), borneBy: c.borneBy as "payer" | "beneficiary", reason: c.reason.trim(), checklist: c.checklist } })}>
              {t("Record the refund claim", "تسجيل مطالبة الاسترداد")}
            </Button>
          </div>
        )}
      </div>

      <div className="rounded border border-border p-3 space-y-2 text-sm" data-testid="wht-instalment-requests">
        <p className="font-medium">{t("Instalment requests (Resolution 1117)", "طلبات التقسيط (القرار 1117)")}</p>
        <p className="text-xs text-muted-foreground">{t("For WHT months up to May 2026 (returns due before 1 July 2026). Regulations Art. 65(1)(c) normally excludes withheld tax from instalments: a plan counts only once ZATCA's written acceptance is recorded.", "لأشهر الاستقطاع حتى مايو 2026 (الإقرارات المستحقة قبل 1 يوليو 2026). تستثني المادة 65(1)(ج) من اللائحة عادةً الضريبة المستقطعة من التقسيط: لا تُحتسب الخطة إلا بعد تسجيل قبول الهيئة الكتابي.")}</p>
        <ul className="space-y-1 text-xs">
          {(requests.data?.items ?? []).map((x) => (
            <li key={x.id} className="rounded border border-border/60 p-2" data-testid={`wht-instalment-request-${x.id}`}>
              <span className="font-mono" dir="ltr">{x.periodFrom}–{x.periodTo}</span> · <span className="font-mono" dir="ltr">{fmtNum(x.principal)}</span> · {stateLabel(x.state, t)}
              {canRecord && x.state === "requested" && (
                <span className="inline-flex gap-1 ms-2">
                  <Input className="h-6 w-36 text-xs" dir="ltr" placeholder={t("Acceptance reference", "مرجع القبول")} value={acceptRef[x.id] ?? ""} onChange={(e) => setAcceptRef({ ...acceptRef, [x.id]: e.target.value })} />
                  <Button size="sm" variant="outline" className="h-6 text-xs" disabled={!(acceptRef[x.id] ?? "").trim()} onClick={() => requestEvent.mutate({ id: x.id, data: { kind: "accepted", onDate: businessToday(), reference: (acceptRef[x.id] ?? "").trim() } })} data-testid={`wht-instalment-accept-${x.id}`}>{t("Record ZATCA's written acceptance", "تسجيل قبول الهيئة الكتابي")}</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {canRecord && (
          <div className="grid gap-2 sm:grid-cols-3" data-testid="wht-instalment-request-form">
            <div><Label className="text-xs">{t("From month", "من شهر")}</Label><Input type="month" max="2026-05" value={r.periodFrom} onChange={(e) => setR({ ...r, periodFrom: e.target.value })} /></div>
            <div><Label className="text-xs">{t("To month", "إلى شهر")}</Label><Input type="month" max="2026-05" value={r.periodTo} onChange={(e) => setR({ ...r, periodTo: e.target.value })} /></div>
            <div><Label className="text-xs">{t("Principal", "أصل الضريبة")}</Label><Input dir="ltr" type="number" step="0.01" value={r.principal} onChange={(e) => setR({ ...r, principal: e.target.value })} /></div>
            <div><Label className="text-xs">{t("Requested on", "تاريخ الطلب")}</Label><Input type="date" value={r.requestedOn} onChange={(e) => setR({ ...r, requestedOn: e.target.value })} /></div>
            <div><Label className="text-xs">{t("Request reference", "مرجع الطلب")}</Label><Input dir="ltr" value={r.reference} onChange={(e) => setR({ ...r, reference: e.target.value })} /></div>
            <Button size="sm" disabled={createRequest.isPending || !r.periodFrom || !r.periodTo || !r.principal || !r.reference.trim()}
              onClick={() => createRequest.mutate({ data: { periodFrom: r.periodFrom, periodTo: r.periodTo, principal: Number(r.principal), requestedOn: r.requestedOn, reference: r.reference.trim() } })}>
              {t("Record the instalment request", "تسجيل طلب التقسيط")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
