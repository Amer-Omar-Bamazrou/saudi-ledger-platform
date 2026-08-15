import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, AlertTriangle } from "lucide-react";

/**
 * Company Settings (M11.6) — the tenant's legal identity.
 *
 * The VAT registration number and legal name are NOT cosmetic: they are stamped
 * into every issued e-invoice (ZATCA QR + hash chain). Without a VAT number the
 * server refuses to issue invoices, so this page surfaces that prominently.
 */
interface Company {
  id: string;
  name: string;
  nameAr: string | null;
  crNumber: string | null;
  vatNumber: string | null;
  fiscalYearStart: number;
  fiscalCalendar: "gregorian" | "hijri";
  buildingNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
}

/** M17.2 — one resolved fiscal year (see apps/api/src/lib/fiscalYear.ts). */
interface FiscalPeriod {
  label: number;
  endYear: number;
  calendar: "gregorian" | "hijri";
  startDate: string;
  endDate: string;
  days: number;
}
interface FiscalYears {
  calendar: "gregorian" | "hijri";
  fiscalYearStart: number;
  current: FiscalPeriod;
  periods: FiscalPeriod[];
}

const GREGORIAN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Hijri month names. Needed because `fiscalYearStart` is a month number IN THE
 * COMPANY'S CALENDAR — showing "January" for a Hijri filer's month 1 would be a
 * plainly wrong label for Muharram.
 */
const HIJRI_MONTHS = [
  "Muharram", "Safar", "Rabi' al-Awwal", "Rabi' al-Thani", "Jumada al-Ula", "Jumada al-Akhirah",
  "Rajab", "Sha'ban", "Ramadan", "Shawwal", "Dhu al-Qi'dah", "Dhu al-Hijjah",
];
const HIJRI_MONTHS_AR = [
  "محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة",
  "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة",
];

export default function CompanySettings() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Partial<Company>>({});
  const [error, setError] = useState("");

  const { data: company, isLoading } = useQuery<Company>({
    queryKey: ["company"],
    queryFn: () => apiFetch("/companies/current"),
  });

  useEffect(() => {
    if (company) setForm(company);
  }, [company]);

  // M17.2 — the server resolves the fiscal year; this page never recomputes it.
  // Hijri boundaries come from the Umm al-Qura tables in ICU, and duplicating
  // that in the browser would be a second implementation of the same fact.
  const { data: fiscalYears } = useQuery<FiscalYears>({
    queryKey: ["company", "fiscal-years"],
    queryFn: () => apiFetch("/companies/current/fiscal-years"),
  });

  const save = useMutation({
    mutationFn: (body: Partial<Company>) =>
      apiFetch("/companies/current", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      setError("");
      // Invalidates the fiscal-years query too (same key prefix) — changing the
      // start month or the calendar changes every resolved boundary.
      qc.invalidateQueries({ queryKey: ["company"] });
      toast({ title: t("Company settings saved", "تم حفظ إعدادات الشركة") });
    },
    onError: (e: Error) => setError(e.message),
  });

  const set = (k: keyof Company) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  if (isLoading) {
    return <p className="text-muted-foreground text-sm p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: form.name,
      nameAr: form.nameAr ?? "",
      crNumber: form.crNumber ?? "",
      vatNumber: form.vatNumber ?? "",
      fiscalYearStart: Number(form.fiscalYearStart ?? 1),
      fiscalCalendar: form.fiscalCalendar ?? "gregorian",
      buildingNumber: form.buildingNumber ?? "",
      street: form.street ?? "",
      district: form.district ?? "",
      city: form.city ?? "",
      postalCode: form.postalCode ?? "",
    });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Company Settings", "إعدادات الشركة")}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t("Your legal identity, as it appears on invoices and tax filings", "هويتك القانونية كما تظهر في الفواتير والإقرارات الضريبية")}
        </p>
      </div>

      {!company?.vatNumber && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {t(
                "No VAT registration number is set. Invoices cannot be issued until you add it — it is required on every ZATCA e-invoice.",
                "لم يتم تعيين رقم التسجيل الضريبي. لا يمكن إصدار الفواتير حتى تضيفه — فهو مطلوب في كل فاتورة إلكترونية.",
              )}
            </span>
          </AlertDescription>
        </Alert>
      )}

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <form onSubmit={submit} className="space-y-6">
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              {t("Legal identity", "الهوية القانونية")}
            </CardTitle>
            <CardDescription>
              {t("Stamped onto every issued e-invoice (ZATCA QR code and hash)", "تُطبع على كل فاتورة إلكترونية صادرة (رمز ZATCA والتجزئة)")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">{t("Legal name *", "الاسم القانوني *")}</Label>
                <Input id="name" value={form.name ?? ""} onChange={set("name")} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nameAr">{t("Arabic legal name", "الاسم القانوني بالعربية")}</Label>
                <Input id="nameAr" dir="rtl" value={form.nameAr ?? ""} onChange={set("nameAr")} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="vatNumber">{t("VAT registration number", "الرقم الضريبي")}</Label>
                <Input id="vatNumber" inputMode="numeric" value={form.vatNumber ?? ""} onChange={set("vatNumber")} placeholder="3XXXXXXXXXXXXX3" />
                <p className="text-[11px] text-muted-foreground">{t("15 digits, starting and ending with 3", "15 رقماً، تبدأ وتنتهي بالرقم 3")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="crNumber">{t("CR number", "رقم السجل التجاري")}</Label>
                <Input id="crNumber" inputMode="numeric" value={form.crNumber ?? ""} onChange={set("crNumber")} placeholder="1010101010" />
                <p className="text-[11px] text-muted-foreground">{t("10 digits", "10 أرقام")}</p>
              </div>
            </div>
            {/*
              M17.2 — the fiscal year. The calendar selector comes FIRST because
              it reinterprets the month below it (1 = January vs 1 = Muharram),
              and the resolved range underneath is the whole point: the user
              sees the actual boundaries their settings produce, rather than
              being told the value is "stored for future use" as this page said
              from M11.6 until now.
            */}
            <div className="grid grid-cols-2 gap-4 max-w-lg">
              <div className="space-y-1.5">
                <Label htmlFor="fiscalCalendar">{t("Fiscal calendar", "التقويم المالي")}</Label>
                <select
                  id="fiscalCalendar"
                  className="w-full h-9 text-sm rounded-md border border-input bg-background px-3"
                  value={form.fiscalCalendar ?? "gregorian"}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, fiscalCalendar: e.target.value as Company["fiscalCalendar"] }))
                  }
                >
                  <option value="gregorian">{t("Gregorian", "ميلادي")}</option>
                  <option value="hijri">{t("Hijri (Umm al-Qura)", "هجري (أم القرى)")}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fiscalYearStart">{t("Fiscal year starts", "تبدأ السنة المالية")}</Label>
                <select
                  id="fiscalYearStart"
                  className="w-full h-9 text-sm rounded-md border border-input bg-background px-3"
                  value={form.fiscalYearStart ?? 1}
                  onChange={(e) => setForm((p) => ({ ...p, fiscalYearStart: Number(e.target.value) }))}
                >
                  {(form.fiscalCalendar ?? "gregorian") === "hijri"
                    ? HIJRI_MONTHS.map((m, i) => (
                        <option key={m} value={i + 1}>{t(m, HIJRI_MONTHS_AR[i])}</option>
                      ))
                    : GREGORIAN_MONTHS.map((m, i) => (
                        <option key={m} value={i + 1}>{t(m, m)}</option>
                      ))}
                </select>
              </div>
            </div>

            {fiscalYears && (
              <div className="rounded-md border border-border bg-secondary/20 p-3 max-w-lg space-y-1">
                <p className="text-xs font-medium text-foreground">
                  {t("Current fiscal year", "السنة المالية الحالية")}
                  {" · "}
                  <span className="font-mono">{fiscalYears.current.label}</span>
                </p>
                <p className="text-[11px] text-muted-foreground font-mono">
                  {fiscalYears.current.startDate} → {fiscalYears.current.endDate}
                  {" · "}
                  {fiscalYears.current.days} {t("days", "يوماً")}
                </p>
                {(form.fiscalCalendar ?? "gregorian") !== fiscalYears.calendar && (
                  <p className="text-[11px] text-amber-500">
                    {t(
                      "Unsaved calendar change — save to see the new boundaries.",
                      "تغيير غير محفوظ في التقويم — احفظ لعرض الحدود الجديدة.",
                    )}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("National address", "العنوان الوطني")}</CardTitle>
            <CardDescription>
              {t("Optional today; required for ZATCA Phase 2 invoices", "اختياري حالياً؛ مطلوب لفواتير المرحلة الثانية")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="buildingNumber">{t("Building number", "رقم المبنى")}</Label>
                <Input id="buildingNumber" inputMode="numeric" value={form.buildingNumber ?? ""} onChange={set("buildingNumber")} placeholder="1234" />
                <p className="text-[11px] text-muted-foreground">{t("4 digits", "4 أرقام")}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="street">{t("Street", "الشارع")}</Label>
                <Input id="street" value={form.street ?? ""} onChange={set("street")} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="district">{t("District", "الحي")}</Label>
                <Input id="district" value={form.district ?? ""} onChange={set("district")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="city">{t("City", "المدينة")}</Label>
                <Input id="city" value={form.city ?? ""} onChange={set("city")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="postalCode">{t("Postal code", "الرمز البريدي")}</Label>
                <Input id="postalCode" inputMode="numeric" value={form.postalCode ?? ""} onChange={set("postalCode")} placeholder="12212" />
                <p className="text-[11px] text-muted-foreground">{t("5 digits", "5 أرقام")}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save changes", "حفظ التغييرات")}
        </Button>
      </form>
    </div>
  );
}
