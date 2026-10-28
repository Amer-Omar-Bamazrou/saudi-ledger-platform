/**
 * 🔴 T1e (DR-10): the period records — statements authorised for issue, filed
 * VAT returns, filed Zakat / income-tax returns. Each is a FACT the tenant
 * records once (append-only: nothing here edits or deletes one); a later
 * filing is an amendment naming the reference it amends. Recording changes no
 * figure. DR-30: once a year's statements are authorised, its months cannot be
 * reopened — the Closed months page says so when it refuses.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStatementAuthorisations, useRecordStatementAuthorisation, getListStatementAuthorisationsQueryKey,
  useListVatReturnFilings, useRecordVatReturnFiling, getListVatReturnFilingsQueryKey,
  useListZakatIncomeTaxFilings, useRecordZakatIncomeTaxFiling, getListZakatIncomeTaxFilingsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { VatCorrections } from "./VatCorrections";

const field = "grid gap-1";

export function PeriodRecords({ canRecord }: { canRecord: boolean }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fail = (e: unknown) => toast({ title: t("Not recorded", "لم يُسجَّل"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
  const done = (key: readonly unknown[]) => { qc.invalidateQueries({ queryKey: key }); toast({ title: t("Recorded", "سُجِّل") }); };

  const auths = useListStatementAuthorisations();
  const vat = useListVatReturnFilings();
  const zit = useListZakatIncomeTaxFilings();

  const [a, setA] = useState({ fiscalYearEnd: "", authorisedOn: "", authorisedBy: "" });
  const [v, setV] = useState({ periodFrom: "", periodTo: "", filedOn: "", zatcaReference: "", amendsZatcaReference: "" });
  const [z, setZ] = useState({ kind: "zakat" as "zakat" | "income_tax", fiscalYearEnd: "", filedOn: "", zatcaReference: "", amendsZatcaReference: "" });

  const recordAuth = useRecordStatementAuthorisation({ mutation: { onSuccess: () => { setA({ fiscalYearEnd: "", authorisedOn: "", authorisedBy: "" }); done(getListStatementAuthorisationsQueryKey()); }, onError: fail } });
  const recordVat = useRecordVatReturnFiling({ mutation: { onSuccess: () => { setV({ periodFrom: "", periodTo: "", filedOn: "", zatcaReference: "", amendsZatcaReference: "" }); done(getListVatReturnFilingsQueryKey()); }, onError: fail } });
  const recordZit = useRecordZakatIncomeTaxFiling({ mutation: { onSuccess: () => { setZ({ kind: "zakat", fiscalYearEnd: "", filedOn: "", zatcaReference: "", amendsZatcaReference: "" }); done(getListZakatIncomeTaxFilingsQueryKey()); }, onError: fail } });

  return (
    <div className="space-y-6" data-testid="period-records">
      <p className="text-sm text-muted-foreground">
        {t(
          "Period records are facts you record once: they change no figure, and they cannot be edited or deleted. A later filing is recorded as an amendment, naming the reference it amends.",
          "سجلات الفترات حقائق تُسجَّل مرة واحدة: لا تغيّر أي رقم، ولا يمكن تعديلها أو حذفها. الإقرار اللاحق يُسجَّل تعديلًا يذكر مرجع الإقرار الذي يعدّله.",
        )}
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("Financial statements authorised for issue", "القوائم المالية المعتمدة للإصدار")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("Once a fiscal year's statements are recorded as authorised, no month of that year can be reopened (IAS 10).", "بعد تسجيل اعتماد قوائم سنة مالية، لا يمكن إعادة فتح أي شهر منها (معيار المحاسبة الدولي 10).")}
          </p>
          <ul className="text-sm divide-y divide-border/60" data-testid="auth-list">
            {(auths.data ?? []).map((r) => (
              <li key={r.id} className="py-1.5">{r.fiscalYearStart} – {r.fiscalYearEnd}: {t("authorised on", "اعتُمدت في")} {r.authorisedOn} · {r.authorisedBy}</li>
            ))}
            {auths.data?.length === 0 && <li className="py-1.5 text-muted-foreground">{t("None recorded.", "لا شيء مسجّل.")}</li>}
          </ul>
          {canRecord && (
            <div className="grid sm:grid-cols-3 gap-2 items-end">
              <div className={field}><Label htmlFor="auth-fy-end">{t("Fiscal year ends", "نهاية السنة المالية")}</Label><Input id="auth-fy-end" data-testid="auth-fy-end" type="date" value={a.fiscalYearEnd} onChange={(e) => setA({ ...a, fiscalYearEnd: e.target.value })} /></div>
              <div className={field}><Label htmlFor="auth-on">{t("Authorised on", "تاريخ الاعتماد")}</Label><Input id="auth-on" data-testid="auth-on" type="date" value={a.authorisedOn} onChange={(e) => setA({ ...a, authorisedOn: e.target.value })} /></div>
              <div className={field}><Label htmlFor="auth-by">{t("Authorised by", "اعتمدها")}</Label><Input id="auth-by" data-testid="auth-by" value={a.authorisedBy} placeholder={t("e.g. Board of directors", "مثال: مجلس الإدارة")} onChange={(e) => setA({ ...a, authorisedBy: e.target.value })} /></div>
              <Button size="sm" data-testid="auth-submit" disabled={recordAuth.isPending || !a.fiscalYearEnd || !a.authorisedOn || !a.authorisedBy.trim()} onClick={() => recordAuth.mutate({ data: a })}>
                {t("Record authorisation", "تسجيل الاعتماد")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("VAT returns filed", "إقرارات ضريبة القيمة المضافة المقدّمة")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ul className="text-sm divide-y divide-border/60" data-testid="vat-filing-list">
            {(vat.data ?? []).map((r) => (
              <li key={r.id} className="py-1.5">{r.periodFrom}{r.periodTo !== r.periodFrom ? ` – ${r.periodTo}` : ""}: {r.zatcaReference} · {t("filed", "قُدِّم")} {r.filedOn}{r.kind === "amendment" ? ` · ${t("amends", "يعدّل")} ${r.amendsZatcaReference}` : ""}</li>
            ))}
            {vat.data?.length === 0 && <li className="py-1.5 text-muted-foreground">{t("None recorded.", "لا شيء مسجّل.")}</li>}
          </ul>
          {canRecord && (
            <div className="grid sm:grid-cols-3 gap-2 items-end">
              <div className={field}><Label htmlFor="vat-from">{t("First month", "الشهر الأول")}</Label><Input id="vat-from" data-testid="vat-from" type="month" value={v.periodFrom} onChange={(e) => setV({ ...v, periodFrom: e.target.value })} /></div>
              <div className={field}><Label htmlFor="vat-to">{t("Last month", "الشهر الأخير")}</Label><Input id="vat-to" data-testid="vat-to" type="month" value={v.periodTo} onChange={(e) => setV({ ...v, periodTo: e.target.value })} /></div>
              <div className={field}><Label htmlFor="vat-filed">{t("Filed on", "تاريخ التقديم")}</Label><Input id="vat-filed" data-testid="vat-filed" type="date" value={v.filedOn} onChange={(e) => setV({ ...v, filedOn: e.target.value })} /></div>
              <div className={field}><Label htmlFor="vat-ref">{t("ZATCA reference", "مرجع الهيئة")}</Label><Input id="vat-ref" data-testid="vat-ref" value={v.zatcaReference} onChange={(e) => setV({ ...v, zatcaReference: e.target.value })} /></div>
              <div className={field}><Label htmlFor="vat-amends">{t("Amends reference (if an amendment)", "يعدّل المرجع (إن كان تعديلًا)")}</Label><Input id="vat-amends" data-testid="vat-amends" value={v.amendsZatcaReference} onChange={(e) => setV({ ...v, amendsZatcaReference: e.target.value })} /></div>
              <Button size="sm" data-testid="vat-submit" disabled={recordVat.isPending || !v.periodFrom || !v.periodTo || !v.filedOn || !v.zatcaReference.trim()}
                onClick={() => recordVat.mutate({ data: { periodFrom: v.periodFrom, periodTo: v.periodTo, filedOn: v.filedOn, zatcaReference: v.zatcaReference, ...(v.amendsZatcaReference.trim() ? { kind: "amendment" as const, amendsZatcaReference: v.amendsZatcaReference.trim() } : {}) } })}>
                {t("Record VAT filing", "تسجيل الإقرار")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase 18 G2a (decisions 9–12; A5(a)): errors found in a filed return, their route, and the entries recorded after a filing. */}
      <VatCorrections canRecord={canRecord} filings={vat.data ?? []} />

      <Card>
        <CardHeader><CardTitle className="text-base">{t("Zakat and income-tax returns filed", "إقرارات الزكاة وضريبة الدخل المقدّمة")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <ul className="text-sm divide-y divide-border/60" data-testid="zit-filing-list">
            {(zit.data ?? []).map((r) => (
              <li key={r.id} className="py-1.5">{r.tax === "zakat" ? t("Zakat", "الزكاة") : t("Income tax", "ضريبة الدخل")} · {t("year ending", "السنة المنتهية في")} {r.fiscalYearEnd}: {r.zatcaReference} · {t("filed", "قُدِّم")} {r.filedOn}{r.kind === "amendment" ? ` · ${t("amends", "يعدّل")} ${r.amendsZatcaReference}` : ""}</li>
            ))}
            {zit.data?.length === 0 && <li className="py-1.5 text-muted-foreground">{t("None recorded.", "لا شيء مسجّل.")}</li>}
          </ul>
          {canRecord && (
            <div className="grid sm:grid-cols-3 gap-2 items-end">
              <div className={field}>
                <Label htmlFor="zit-kind">{t("Tax", "الضريبة")}</Label>
                <select id="zit-kind" data-testid="zit-kind" className="h-9 rounded-md border bg-background px-2 text-sm" value={z.kind} onChange={(e) => setZ({ ...z, kind: e.target.value as "zakat" | "income_tax" })}>
                  <option value="zakat">{t("Zakat", "الزكاة")}</option>
                  <option value="income_tax">{t("Income tax", "ضريبة الدخل")}</option>
                </select>
              </div>
              <div className={field}><Label htmlFor="zit-fy-end">{t("Fiscal year ends", "نهاية السنة المالية")}</Label><Input id="zit-fy-end" data-testid="zit-fy-end" type="date" value={z.fiscalYearEnd} onChange={(e) => setZ({ ...z, fiscalYearEnd: e.target.value })} /></div>
              <div className={field}><Label htmlFor="zit-filed">{t("Filed on", "تاريخ التقديم")}</Label><Input id="zit-filed" data-testid="zit-filed" type="date" value={z.filedOn} onChange={(e) => setZ({ ...z, filedOn: e.target.value })} /></div>
              <div className={field}><Label htmlFor="zit-ref">{t("ZATCA reference", "مرجع الهيئة")}</Label><Input id="zit-ref" data-testid="zit-ref" value={z.zatcaReference} onChange={(e) => setZ({ ...z, zatcaReference: e.target.value })} /></div>
              <div className={field}><Label htmlFor="zit-amends">{t("Amends reference (if an amendment)", "يعدّل المرجع (إن كان تعديلًا)")}</Label><Input id="zit-amends" data-testid="zit-amends" value={z.amendsZatcaReference} onChange={(e) => setZ({ ...z, amendsZatcaReference: e.target.value })} /></div>
              <Button size="sm" data-testid="zit-submit" disabled={recordZit.isPending || !z.fiscalYearEnd || !z.filedOn || !z.zatcaReference.trim()}
                onClick={() => recordZit.mutate({ data: { kind: z.kind, fiscalYearEnd: z.fiscalYearEnd, filedOn: z.filedOn, zatcaReference: z.zatcaReference, ...(z.amendsZatcaReference.trim() ? { filingKind: "amendment" as const, amendsZatcaReference: z.amendsZatcaReference.trim() } : {}) } })}>
                {t("Record return filing", "تسجيل الإقرار")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
