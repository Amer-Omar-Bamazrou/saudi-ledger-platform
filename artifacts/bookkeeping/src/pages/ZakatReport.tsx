import { useGetZakatSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Landmark } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

export default function ZakatReport() {
  const { data: zakatData, isLoading } = useGetZakatSummary();

  const isEligible = (zakatData?.totalZakatableAssets || 0) >= (zakatData?.nisabThresholdSAR || 0);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <Landmark className="w-8 h-8 text-amber-500" />
          Zakat Assessment
        </h1>
        <p className="text-muted-foreground mt-1">Automated 2.5% calculation based on Hijri year applicable assets.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Zakatable Assets</p>
            {isLoading ? <Skeleton className="h-10 w-32" /> : (
              <p className="text-3xl font-mono font-bold text-white">
                {formatCurrency(zakatData?.totalZakatableAssets || 0)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">Total of relevant categories</p>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Nisab Threshold</p>
            {isLoading ? <Skeleton className="h-10 w-32" /> : (
              <p className="text-3xl font-mono font-bold text-white/80">
                {formatCurrency(zakatData?.nisabThresholdSAR || 0)}
              </p>
            )}
            <p className="text-xs text-muted-foreground">Current Gold/Silver Standard</p>
          </CardContent>
        </Card>

        <Card className={isEligible ? "border-amber-500/50 bg-amber-500/10 shadow-[0_0_30px_-10px_rgba(245,158,11,0.3)]" : "border-border bg-card"}>
          <CardContent className="p-6 space-y-2 relative overflow-hidden">
            {isEligible && (
              <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl -mr-10 -mt-10" />
            )}
            <p className={`text-sm font-medium uppercase tracking-wider ${isEligible ? 'text-amber-500' : 'text-muted-foreground'}`}>
              Calculated Zakat Due (2.5%)
            </p>
            {isLoading ? <Skeleton className="h-10 w-32" /> : (
              <p className={`text-4xl font-mono font-bold ${isEligible ? 'text-amber-400' : 'text-muted-foreground'}`}>
                {isEligible ? formatCurrency(zakatData?.zakatDue || 0) : 'SAR 0.00'}
              </p>
            )}
            <p className="text-xs font-bold text-white/70">
              {isEligible ? 'OBLIGATION MET' : 'BELOW NISAB THRESHOLD'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>Included Transactions</CardTitle>
              <CardDescription>Line items that contribute to the Zakatable Assets total.</CardDescription>
            </div>
            <Badge variant="outline" className="border-amber-500/50 text-amber-500 bg-amber-500/5">
              Zakat Relevant Only
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
                    <th className="px-6 py-4 font-semibold">Date</th>
                    <th className="px-6 py-4 font-semibold">Description</th>
                    <th className="px-6 py-4 font-semibold">Category</th>
                    <th className="px-6 py-4 font-semibold text-right">Impact Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {zakatData?.eligibleTransactions?.map((tx: any) => (
                    <tr key={tx.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-6 py-4 font-mono text-muted-foreground whitespace-nowrap">{tx.date}</td>
                      <td className="px-6 py-4 text-white font-medium">{tx.description}</td>
                      <td className="px-6 py-4">
                        <Badge variant="outline" className="border-primary/30 text-primary bg-primary/5">
                          {tx.categoryName}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-right font-mono text-white">
                        {tx.type === 'debit' ? '-' : '+'}{formatCurrency(tx.amount)}
                      </td>
                    </tr>
                  ))}
                  {zakatData?.eligibleTransactions?.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground">
                        No Zakat-relevant transactions found.
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
