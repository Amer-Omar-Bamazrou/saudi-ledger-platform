import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle } from "lucide-react";

interface BSItem { name: string; nameAr?: string; amount: number; }
interface BSData {
  assets: { items: BSItem[]; accountsReceivable: number; total: number };
  liabilities: { items: BSItem[]; accountsPayable: number; total: number };
  equity: { retainedEarnings: number; total: number };
  totalLiabilitiesAndEquity: number;
  asOf: string;
}

function Section({ title, titleAr, color, rows, extra, total }: { title: string; titleAr: string; color: string; rows: BSItem[]; extra?: { label: string; labelAr: string; amount: number }[]; total: number }) {
  const { n, t } = useLanguage();
  return (
    <div className="space-y-1">
      <div className={`text-xs font-bold uppercase tracking-widest py-2 px-2 rounded ${color}`}>{t(title, titleAr)}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between py-1.5 px-2 hover:bg-secondary/10 rounded text-sm">
          <span className="text-foreground">{n(r.name, r.nameAr)}</span>
          <span className="font-mono">{fmtNum(r.amount)}</span>
        </div>
      ))}
      {extra?.map((e, i) => (
        <div key={`ex-${i}`} className="flex justify-between py-1.5 px-2 hover:bg-secondary/10 rounded text-sm">
          <span className="text-foreground">{t(e.label, e.labelAr)}</span>
          <span className="font-mono">{fmtNum(e.amount)}</span>
        </div>
      ))}
      <div className="flex justify-between py-2 px-2 border-t border-border font-bold text-sm mt-1">
        <span className="text-muted-foreground uppercase text-xs tracking-wide">{t("Total", "الإجمالي")} {t(title, titleAr)}</span>
        <span className="font-mono text-base">{fmtNum(total)}</span>
      </div>
    </div>
  );
}

export default function BalanceSheet() {
  const { t } = useLanguage();
  const [asOf, setAsOf] = useState(new Date().toISOString().split("T")[0]);
  const [applied, setApplied] = useState(new Date().toISOString().split("T")[0]);

  const { data, isLoading } = useQuery<BSData>({
    queryKey: ["balance-sheet", applied],
    queryFn: () => apiFetch(`/reports/balance-sheet?as_of=${applied}`),
  });

  const totalLE = data ? data.liabilities.total + data.equity.total : 0;
  const balanced = data ? Math.abs(data.assets.total - totalLE) < 1 : false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Balance Sheet", "الميزانية العمومية")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Assets = Liabilities + Equity · Statement of Financial Position", "الأصول = الخصوم + حقوق الملكية · قائمة المركز المالي")}</p>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("As of Date", "بتاريخ")}</Label><Input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)} className="mt-1 h-8 text-sm w-44" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied(asOf)}>{t("Generate", "إنشاء")}</Button>
            {data && (
              <div className={`flex items-center gap-2 ml-auto px-4 py-2 rounded-lg border ${balanced ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
                {balanced ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                <span className={`text-sm font-medium ${balanced ? "text-emerald-400" : "text-red-400"}`}>{balanced ? t("Balanced", "متوازن") : t("Check entries", "تحقق من القيود")}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Generating balance sheet...", "جارٍ التحميل...")}</div> : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-4">
            {[
              [t("Total Assets", "إجمالي الأصول"), fmtNum(data.assets.total), "text-blue-400"],
              [t("Total Liabilities", "إجمالي الخصوم"), fmtNum(data.liabilities.total), "text-amber-400"],
              [t("Equity", "حقوق الملكية"), fmtNum(data.equity.total), "text-purple-400"],
              [t("Liab + Equity", "الخصوم + حقوق الملكية"), fmtNum(totalLE), balanced ? "text-emerald-400" : "text-red-400"],
            ].map(([l, v, c]) => (
              <Card key={String(l)} className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
                <CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Assets", "الأصول")}</CardTitle></CardHeader>
              <CardContent>
                <Section
                  title="Assets"
                  titleAr="الأصول"
                  color="bg-blue-500/10 text-blue-400"
                  rows={data.assets.items}
                  extra={[{ label: "Accounts Receivable (AR)", labelAr: "ذمم مدينة (AR)", amount: data.assets.accountsReceivable }]}
                  total={data.assets.total}
                />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Liabilities", "الخصوم")}</CardTitle></CardHeader>
                <CardContent>
                  <Section
                    title="Liabilities"
                    titleAr="الخصوم"
                    color="bg-amber-500/10 text-amber-400"
                    rows={data.liabilities.items}
                    extra={[{ label: "Accounts Payable (AP)", labelAr: "ذمم دائنة (AP)", amount: data.liabilities.accountsPayable }]}
                    total={data.liabilities.total}
                  />
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Equity", "حقوق الملكية")}</CardTitle></CardHeader>
                <CardContent>
                  <Section
                    title="Equity"
                    titleAr="حقوق الملكية"
                    color="bg-purple-500/10 text-purple-400"
                    rows={[{ name: "Retained Earnings", nameAr: "الأرباح المحتجزة", amount: data.equity.retainedEarnings }]}
                    total={data.equity.total}
                  />
                </CardContent>
              </Card>

              <div className={`rounded-lg px-4 py-3 border flex justify-between items-center ${balanced ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("Total Liabilities + Equity", "إجمالي الخصوم + حقوق الملكية")}</span>
                <span className={`font-mono font-bold text-lg ${balanced ? "text-emerald-400" : "text-red-400"}`}>{fmtNum(totalLE)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
