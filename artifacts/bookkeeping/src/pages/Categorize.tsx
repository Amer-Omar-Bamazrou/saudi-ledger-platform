import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { 
  useRunCategorization,
  useGetSummary,
  getListTransactionsQueryKey,
  getGetSummaryQueryKey
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { BrainCog, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";

export default function Categorize() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();
  const { data: summary } = useGetSummary();
  
  const [results, setResults] = useState<any>(null);

  const runMutation = useRunCategorization({
    mutation: {
      onSuccess: (data) => {
        setResults(data);
        toast({ title: t("Categorization Complete", "اكتمل التصنيف"), description: `${t("Processed", "تمت معالجة")} ${data.processed} ${t("transactions.", "معاملة.")}` });
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetSummaryQueryKey() });
      },
      onError: () => {
        toast({ title: t("Engine Error", "خطأ في المحرك"), description: t("The categorization engine failed to run.", "فشل تشغيل محرك التصنيف."), variant: "destructive" });
      }
    }
  });

  const handleRun = () => {
    runMutation.mutate({
      data: { overrideExisting: false }
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <BrainCog className="w-8 h-8 text-primary" />
            {t("Categorization Engine", "محرك التصنيف")}
          </h1>
          <p className="text-muted-foreground mt-1">{t("Run rule-based and AI matching algorithms across uncategorized ledger entries.", "تشغيل خوارزميات المطابقة القائمة على القواعد والذكاء الاصطناعي على إدخالات دفتر الأستاذ غير المصنّفة.")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-1 border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-primary">{t("Engine Status", "حالة المحرك")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <p className="text-sm font-medium text-muted-foreground">{t("Uncategorized Entries", "الإدخالات غير المصنّفة")}</p>
              <p className="text-4xl font-mono font-bold text-white mt-2">
                {summary?.uncategorizedCount ?? '-'}
              </p>
            </div>
            
            <Button 
              size="lg" 
              className="w-full font-bold text-lg h-14" 
              onClick={handleRun}
              disabled={runMutation.isPending || summary?.uncategorizedCount === 0}
            >
              {runMutation.isPending ? (
                <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {t("Running...", "جارٍ التشغيل...")}</>
              ) : (
                <>{t("Run Engine", "تشغيل المحرك")}</>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t("Last Run Results", "نتائج آخر تشغيل")}</CardTitle>
            <CardDescription>{t("Details of the most recent categorization job.", "تفاصيل أحدث مهمة تصنيف.")}</CardDescription>
          </CardHeader>
          <CardContent>
            {runMutation.isPending ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
                <p className="text-muted-foreground font-mono animate-pulse">{t("Analyzing transaction patterns...", "جارٍ تحليل أنماط المعاملات...")}</p>
              </div>
            ) : results ? (
              <div className="space-y-6">
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-4 rounded-lg bg-secondary/50 border flex items-center gap-3">
                    <BrainCog className="w-8 h-8 text-blue-400" />
                    <div>
                      <p className="text-sm text-muted-foreground">{t("Processed", "تمت المعالجة")}</p>
                      <p className="text-xl font-bold">{results.processed}</p>
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-secondary/50 border flex items-center gap-3">
                    <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                    <div>
                      <p className="text-sm text-muted-foreground">{t("Matched", "تمت المطابقة")}</p>
                      <p className="text-xl font-bold">{results.categorized}</p>
                    </div>
                  </div>
                  <div className="p-4 rounded-lg bg-secondary/50 border flex items-center gap-3">
                    <AlertCircle className="w-8 h-8 text-amber-400" />
                    <div>
                      <p className="text-sm text-muted-foreground">{t("Skipped", "تم التخطي")}</p>
                      <p className="text-xl font-bold">{results.skipped}</p>
                    </div>
                  </div>
                </div>

                {results.results && results.results.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="font-semibold text-lg border-b pb-2">{t("Top Matches", "أفضل التطابقات")}</h3>
                    <div className="space-y-2">
                      {results.results.slice(0, 10).map((r: any, i: number) => (
                        <div key={i} className="flex items-center justify-between p-3 rounded bg-secondary/30 text-sm">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-muted-foreground">ID: {r.transactionId}</span>
                            <Badge variant="outline" className="border-primary/30 text-primary">{r.categoryName}</Badge>
                            {r.matchedRule && <span className="text-xs text-muted-foreground ml-2">{t("Rule:", "القاعدة:")} {r.matchedRule}</span>}
                          </div>
                          <div className="flex items-center gap-3 w-32">
                            <Progress value={r.confidence * 100} className="h-2" />
                            <span className="font-mono text-xs w-8 text-right">{Math.round(r.confidence * 100)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {results.results.length > 10 && (
                      <p className="text-center text-sm text-muted-foreground py-2">
                        + {results.results.length - 10} {t("more matches", "مطابقات إضافية")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <BrainCog className="w-12 h-12 opacity-20 mb-4" />
                <p>{t("Engine idle. Ready to process", "المحرك في وضع الخمول. جاهز لمعالجة")} {summary?.uncategorizedCount ?? 0} {t("transactions.", "معاملة.")}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
