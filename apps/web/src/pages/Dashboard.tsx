import { useLanguage } from "@/contexts/LanguageContext";
import { useGetSummary, useListTransactions } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export default function Dashboard() {
  const { t } = useLanguage();
  const { data: summary, isLoading: loadingSummary } = useGetSummary();
  const { data: txList, isLoading: loadingTx } = useListTransactions({ limit: 5 });

  const chartData = [
    { name: t("Income", "الدخل"), amount: summary?.totalIncome || 0 },
    { name: t("Expenses", "المصروفات"), amount: summary?.totalExpenses || 0 },
    { name: t("Net VAT", "صافي الضريبة"), amount: summary?.netVat || 0 },
  ];

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">{t("Financial Cockpit", "لوحة التحكم المالية")}</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title={t("Net Position", "صافي المركز المالي")} amount={summary?.netPosition} loading={loadingSummary} />
        <StatCard title={t("Total Income", "إجمالي الدخل")} amount={summary?.totalIncome} loading={loadingSummary} />
        <StatCard title={t("Total Expenses", "إجمالي المصروفات")} amount={summary?.totalExpenses} loading={loadingSummary} />
        <StatCard title={t("Net VAT Position", "صافي موقف ضريبة القيمة المضافة")} amount={summary?.netVat} loading={loadingSummary} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("Cash Flow Overview", "نظرة عامة على التدفق النقدي")}</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingSummary ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2D3748" vertical={false} />
                    <XAxis dataKey="name" stroke="#A0AEC0" tick={{fill: '#A0AEC0'}} />
                    <YAxis stroke="#A0AEC0" tick={{fill: '#A0AEC0'}} tickFormatter={(val) => `SAR ${val / 1000}k`} />
                    <Tooltip 
                      cursor={{fill: '#2D3748'}} 
                      contentStyle={{ backgroundColor: '#1A202C', borderColor: '#2D3748' }}
                      formatter={(value: number) => formatCurrency(value)}
                    />
                    <Bar dataKey="amount" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("System Status", "حالة النظام")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingSummary ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <div className="space-y-4 font-mono text-sm">
                <div className="flex justify-between items-center p-3 rounded bg-secondary">
                  <span className="text-muted-foreground">{t("Total Transactions", "إجمالي المعاملات")}</span>
                  <span className="text-white font-bold">{summary?.transactionCount || 0}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded bg-secondary border border-destructive/50">
                  <span className="text-muted-foreground">{t("Uncategorized", "غير مصنف")}</span>
                  <span className="text-destructive font-bold">{summary?.uncategorizedCount || 0}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded bg-secondary">
                  <span className="text-muted-foreground">{t("VAT Rate", "نسبة ضريبة القيمة المضافة")}</span>
                  <span className="text-white font-bold">15%</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Recent Transactions", "أحدث المعاملات")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingTx ? (
            <Skeleton className="h-[200px] w-full" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-secondary/50">
                  <tr>
                    <th className="px-4 py-3">{t("Date", "التاريخ")}</th>
                    <th className="px-4 py-3">{t("Description", "الوصف")}</th>
                    <th className="px-4 py-3">{t("Category", "الفئة")}</th>
                    <th className="px-4 py-3 text-right">{t("Amount", "المبلغ")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {txList?.transactions.map(tx => (
                    <tr key={tx.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-muted-foreground whitespace-nowrap">{tx.date}</td>
                      <td className="px-4 py-3 text-white truncate max-w-[300px]">
                        {tx.description}
                        {tx.descriptionAr && <span className="ml-2 text-muted-foreground block text-xs" dir="rtl">{tx.descriptionAr}</span>}
                      </td>
                      <td className="px-4 py-3">
                        {tx.categoryName ? (
                          <Badge variant="outline" className="border-primary/30 text-primary/90 bg-primary/5">
                            {tx.categoryName}
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="bg-destructive/20 text-destructive border-transparent">
                            {t("Uncategorized", "غير مصنف")}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-white whitespace-nowrap">
                        {tx.type === 'debit' ? '-' : '+'}{formatCurrency(tx.amount)}
                      </td>
                    </tr>
                  ))}
                  {txList?.transactions.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                        {t("No transactions found.", "لا توجد بيانات.")}
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

function StatCard({ title, amount, loading }: { title: string, amount?: number, loading: boolean }) {
  return (
    <Card>
      <CardContent className="p-6">
        <p className="text-sm font-medium text-muted-foreground mb-1">{title}</p>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <p className={`text-2xl font-bold font-mono tracking-tight ${(amount || 0) < 0 ? 'text-destructive' : 'text-white'}`}>
            {formatCurrency(amount || 0)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
