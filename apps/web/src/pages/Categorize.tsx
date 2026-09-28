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
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Progress } from "@/components/ui/progress";
import { BrainCog, Loader2 } from "lucide-react";
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
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title={t("Categorization Engine", "محرك التصنيف")}
        description={t("Run rule-based and AI matching algorithms across uncategorized ledger entries.", "تشغيل خوارزميات المطابقة القائمة على القواعد والذكاء الاصطناعي على إدخالات دفتر الأستاذ غير المصنّفة.")}
        actions={
          <Button
            className="gap-2"
            onClick={handleRun}
            disabled={runMutation.isPending || summary?.uncategorizedCount === 0}
          >
            {runMutation.isPending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {t("Running...", "جارٍ التشغيل...")}</>
            ) : (
              <><BrainCog className="w-4 h-4" />{t("Run Engine", "تشغيل المحرك")}</>
            )}
          </Button>
        }
      />

      <StatStrip cols={4}>
        <Stat label={t("Uncategorized Entries", "الإدخالات غير المصنّفة")} value={summary?.uncategorizedCount ?? '-'} tone={summary?.uncategorizedCount ? "attention" : "default"} />
        <Stat label={t("Processed", "تمت المعالجة")} value={results ? results.processed : "—"} />
        <Stat label={t("Matched", "تمت المطابقة")} value={results ? results.categorized : "—"} />
        <Stat label={t("Skipped", "تم التخطي")} value={results ? results.skipped : "—"} />
      </StatStrip>

      <Panel
        title={t("Last Run Results", "نتائج آخر تشغيل")}
        description={t("Details of the most recent categorization job.", "تفاصيل أحدث مهمة تصنيف.")}
        flush
      >
            {runMutation.isPending ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                <p className="text-sm text-muted-foreground">{t("Analyzing transaction patterns...", "جارٍ تحليل أنماط المعاملات...")}</p>
              </div>
            ) : results ? (
              results.results && results.results.length > 0 ? (
                  <div>
                    <h3 className="px-5 pt-4 pb-2 text-[13px] font-medium text-muted-foreground">{t("Top Matches", "أفضل التطابقات")}</h3>
                    <div>
                      {results.results.slice(0, 10).map((r: any, i: number) => (
                        <div key={i} className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3 text-sm last:border-0">
                          <div className="flex flex-wrap items-center gap-3 min-w-0">
                            <span className="tabular-nums text-muted-foreground">ID: {r.transactionId}</span>
                            <Badge variant="outline" className="border-primary/30 text-primary font-normal">{r.categoryName}</Badge>
                            {r.matchedRule && <span className="text-[12px] text-muted-foreground">{t("Rule:", "القاعدة:")} {r.matchedRule}</span>}
                          </div>
                          <div className="flex items-center gap-3 w-32 shrink-0">
                            <Progress value={r.confidence * 100} className="h-1.5" />
                            <span className="tabular-nums text-[12px] w-8 text-end">{Math.round(r.confidence * 100)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {results.results.length > 10 && (
                      <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">
                        + {results.results.length - 10} {t("more matches", "مطابقات إضافية")}
                      </p>
                    )}
                  </div>
              ) : <div className="h-2" />
            ) : (
              <EmptyState
                icon={BrainCog}
                title={<>{t("Engine idle. Ready to process", "المحرك في وضع الخمول. جاهز لمعالجة")} {summary?.uncategorizedCount ?? 0} {t("transactions.", "معاملة.")}</>}
              />
            )}
      </Panel>
    </div>
  );
}
