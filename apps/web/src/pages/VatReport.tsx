import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGetVatSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Receipt, Calendar } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function VatReport() {
  const { t } = useLanguage();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: vatData, isLoading } = useGetVatSummary({
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined
  });

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Receipt className="w-8 h-8 text-emerald-500" />
            {t("ZATCA VAT Return", "إقرار ضريبة القيمة المضافة - زاتكا")}
          </h1>
          <p className="text-muted-foreground mt-1">{t("Standard rate 15% calculation for Saudi tax compliance.", "احتساب النسبة القياسية 15% للامتثال الضريبي السعودي.")}</p>
        </div>
        
        <div className="flex gap-4 items-end bg-card p-3 rounded-lg border shadow-sm">
          <div className="space-y-1">
            <Label className="text-xs">{t("From", "من")}</Label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("To", "إلى")}</Label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t("Output VAT (Collected)", "ضريبة المخرجات (المحصلة)")}</p>
            {isLoading ? <Skeleton className="h-10 w-32" /> : (
              <p className="text-3xl font-mono font-bold text-white">
                {formatCurrency(vatData?.vatCollected || 0)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("Sales & Revenues", "المبيعات والإيرادات")}</p>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{t("Input VAT (Paid)", "ضريبة المدخلات (المدفوعة)")}</p>
            {isLoading ? <Skeleton className="h-10 w-32" /> : (
              <p className="text-3xl font-mono font-bold text-white">
                {formatCurrency(vatData?.vatPaid || 0)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("Expenses & Purchases", "المصروفات والمشتريات")}</p>
          </CardContent>
        </Card>

        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-emerald-500/80 uppercase tracking-wider">{t("Net VAT Position", "صافي موقف ضريبة القيمة المضافة")}</p>
            {isLoading ? <Skeleton className="h-10 w-32 bg-emerald-500/20" /> : (
              <p className={`text-4xl font-mono font-bold ${(vatData?.netVatPosition || 0) < 0 ? 'text-emerald-400' : 'text-destructive'}`}>
                {formatCurrency(Math.abs(vatData?.netVatPosition || 0))}
              </p>
            )}
            <p className="text-xs font-bold text-white/70">
              {(vatData?.netVatPosition || 0) < 0 ? t("REFUND DUE", "مستحق الاسترداد") : t("PAYMENT DUE", "مستحق السداد")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>{t("VAT Transaction Ledger", "سجل معاملات ضريبة القيمة المضافة")}</CardTitle>
              <CardDescription>{t("All transactions with applicable VAT components.", "جميع المعاملات مع مكونات ضريبة القيمة المضافة المنطبقة.")}</CardDescription>
            </div>
            <Badge variant="outline" className="text-lg py-1 px-3 border-emerald-500/50 text-emerald-400">
              {t("Rate", "النسبة")}: {vatData?.vatRate ? vatData.vatRate * 100 : 15}%
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                  <tr>
                    <th className="px-6 py-4 font-semibold">{t("Date", "التاريخ")}</th>
                    <th className="px-6 py-4 font-semibold">{t("Description", "الوصف")}</th>
                    <th className="px-6 py-4 font-semibold">{t("Type", "النوع")}</th>
                    <th className="px-6 py-4 font-semibold text-right">{t("Gross Amount", "المبلغ الإجمالي")}</th>
                    <th className="px-6 py-4 font-semibold text-right text-emerald-400">{t("VAT Amount", "مبلغ الضريبة")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {vatData?.transactions?.map((tx: any) => (
                    <tr key={tx.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-6 py-4 font-mono text-muted-foreground whitespace-nowrap">{tx.date}</td>
                      <td className="px-6 py-4 text-white font-medium">{tx.description}</td>
                      <td className="px-6 py-4">
                        <Badge variant="outline" className={tx.type === 'credit' ? "border-primary/30 text-primary" : "border-destructive/30 text-destructive"}>
                          {tx.type === 'credit' ? t("Output", "مخرجات") : t("Input", "مدخلات")}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-right font-mono">
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="px-6 py-4 text-right font-mono font-bold text-emerald-400">
                        {formatCurrency(tx.vatAmount)}
                      </td>
                    </tr>
                  ))}
                  {vatData?.transactions?.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                        {t("No VAT-applicable transactions in this period.", "لا توجد معاملات خاضعة لضريبة القيمة المضافة في هذه الفترة.")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
