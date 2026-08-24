/**
 * Ask your books (AI-6a) — register A: facts and projections, never advice.
 *
 * Placement per the hub decision (owner Q5): woven into Analytics and the
 * Finance Hub beside the figures it grounds on — no destination of its own.
 * Hidden entirely while the assistant is unavailable (dark until the
 * Enterprise agreement): an ask box that always errors would be a promise
 * the deployment can't keep.
 *
 * A refusal renders in words — "your books cannot answer that" is an
 * answer, not an error. A projection's assumption arrives INSIDE the answer
 * text by construction (the verifier rejects it otherwise), so this
 * component never renders assumptions separately — there is nothing to
 * relegate to a tooltip.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageCircleQuestion, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

interface AskResult {
  refused: boolean;
  refusalReason: string | null;
  toolUsed: string | null;
  answer: { en: string; ar: string } | null;
}

const REFUSAL_WORDS: Record<string, { en: string; ar: string }> = {
  your_books_cannot_answer: {
    en: "Your books cannot answer that question.",
    ar: "دفاترك لا تستطيع الإجابة عن هذا السؤال.",
  },
};

export function AskYourBooks() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [question, setQuestion] = useState("");
  const [last, setLast] = useState<AskResult | null>(null);

  const { data: status } = useQuery<{ available: boolean }>({
    queryKey: ["ask-status"],
    queryFn: () => apiFetch("/ask/status"),
    staleTime: 5 * 60_000,
  });

  const askMut = useMutation({
    mutationFn: (q: string) => apiFetch("/ask", { method: "POST", body: JSON.stringify({ question: q }) }),
    onSuccess: (r: AskResult) => {
      setLast(r);
      qc.invalidateQueries({ queryKey: ["ask-history"] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  if (!status?.available) return null;

  const refusalText = (r: AskResult) => {
    const known = r.refusalReason ? REFUSAL_WORDS[r.refusalReason] : undefined;
    if (known) return t(known.en, known.ar);
    // Every other refusal class (rejected output, tool failure) gets one
    // honest sentence — the detail lives in the stored record and the logs.
    return t(
      "No answer could be given for this question — the attempt is recorded.",
      "تعذّر تقديم إجابة عن هذا السؤال — المحاولة مسجّلة.",
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircleQuestion className="h-4 w-4" />
          {t("Ask your books", "اسأل دفاترك")}
          <span className="text-xs font-normal text-muted-foreground">
            {t("figures and projections from your own records — never advice", "أرقام وإسقاطات من سجلاتك — لا نصائح")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) askMut.mutate(question.trim());
          }}
        >
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            placeholder={t(
              "e.g. What would hiring at 8,000/month do to my cash?",
              "مثال: ماذا يفعل توظيف بتكلفة ٨٠٠٠ شهريًا بالنقد لدي؟",
            )}
          />
          <Button type="submit" disabled={askMut.isPending} className="gap-1 shrink-0">
            <Send className="h-3.5 w-3.5" /> {t("Ask", "اسأل")}
          </Button>
        </form>

        {askMut.isPending && <p className="text-sm text-muted-foreground">{t("Reading your books…", "جارٍ قراءة دفاترك…")}</p>}

        {last && !askMut.isPending && (
          <div className="rounded-md border p-3">
            {last.refused ? (
              <p className="text-sm text-muted-foreground">{refusalText(last)}</p>
            ) : (
              <p className="text-sm">{t(last.answer!.en, last.answer!.ar)}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
