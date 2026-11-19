import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUnclassifiedJournalEntries,
  useClassifyJournalEntry,
  getListUnclassifiedJournalEntriesQueryKey,
  type UnclassifiedJournalEntry,
  type UnclassifiedJournalEntryCandidate,
} from "@workspace/api-client-react";
import { fmtNum } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DualDate } from "@/components/DualDate";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { refusalOf } from "@/lib/openingVatRefusals";
import { fmtCount } from "@/lib/businessTime";
import { journalStatusLabel } from "@/lib/journalLine";
import { failedCheckLabels, journalSourceLabel, legacyPaymentNote, sourceRuleLabel } from "@/lib/journalSourceLabels";

const PAGE = 50;

/**
 * 🔴 A15 review (owner decisions 2026-11-17 and 2026-11-19; migration 0164) — THE UNCLASSIFIED-ENTRIES REVIEW.
 *
 * The entries the A15 back-fill could not tie to what produced them: what it found, what the records confirm today,
 * and where each stands. An admin may classify one only as a source the records confirm — never as a manual entry,
 * which waits for an accountant-approved policy. Read by an admin or an accountant; the server refuses everyone else.
 */
export default function UnclassifiedEntries() {
  const { t } = useLanguage();
  const { isOrgAdmin } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const list = useListUnclassifiedJournalEntries({ limit: PAGE, offset });
  const [confirm, setConfirm] = useState<{ entry: UnclassifiedJournalEntry; candidate: UnclassifiedJournalEntryCandidate } | null>(null);

  const classify = useClassifyJournalEntry({
    mutation: {
      onSuccess: (e) => {
        qc.invalidateQueries({ queryKey: getListUnclassifiedJournalEntriesQueryKey() });
        qc.invalidateQueries({ queryKey: ["journal-entries"] });
        toast({
          title: t("Entry classified", "صُنِّف القيد"),
          description: t(
            `${e.entryNumber ?? `#${e.id}`} now reads ${journalSourceLabel(e.currentSourceType, t)}.`,
            `أصبح مصدر ${e.entryNumber ?? `#${e.id}`}: ${journalSourceLabel(e.currentSourceType, t)}.`,
          ),
        });
        setConfirm(null);
      },
      onError: (err) => {
        toast({ title: t("Not classified", "لم يُصنَّف"), description: refusalOf(err).words, variant: "destructive" });
        setConfirm(null);
      },
    },
  });

  const data = list.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-6" data-testid="unclassified-entries">
      <div>
        <Link href="/journal-entries" className="text-sm text-muted-foreground hover:underline">
          {t("← General Ledger", "→ دفتر الأستاذ العام")}
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-1">{t("Unclassified entries", "القيود غير المصنَّفة")}</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
          {t(
            "Entries written before the platform recorded what produced each one, whose source the records could not establish. They cannot be reversed from here, and a draft among them cannot be posted, until it is classified. An admin may classify one only as a source the records confirm; none is classified as a manual entry until an accountant-approved policy says how.",
            "قيود سُجِّلت قبل أن تبدأ المنصة بتسجيل مصدر كل قيد، ولم تتمكن السجلات من تحديد مصدرها. لا يمكن عكسها من هنا، ولا ترحيل المسودة منها، إلى أن تُصنَّف. يصنِّف المسؤول القيد بمصدر تؤكده السجلات فقط، ولا يُصنَّف أي قيد قيداً يدوياً إلى أن تحدد سياسة يعتمدها المحاسب طريقة ذلك.",
          )}
        </p>
      </div>

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
      ) : list.isError ? (
        <Card className="border-border bg-card">
          <CardContent className="py-6 text-sm" data-testid="unclassified-refused">{refusalOf(list.error).words}</CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="py-6 text-sm text-muted-foreground" data-testid="unclassified-empty">
            {t("No entry of this company was left unclassified.", "لم يُترك أي قيد لهذه الشركة دون تصنيف.")}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" data-testid="unclassified-count">
            {t(
              `${fmtCount(offset + 1)}–${fmtCount(offset + items.length)} of ${fmtCount(total)} entries`,
              `${fmtCount(offset + 1)}–${fmtCount(offset + items.length)} من ${fmtCount(total)} قيداً`,
            )}
          </p>
          <div className="space-y-4">
            {items.map((e) => (
              <EntryCard key={e.id} entry={e} canClassify={isOrgAdmin} onClassify={(c) => setConfirm({ entry: e, candidate: c })} />
            ))}
          </div>
          {total > PAGE && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                {t("Previous", "السابق")}
              </Button>
              <Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                {t("Next", "التالي")}
              </Button>
            </div>
          )}
        </>
      )}

      <AlertDialog open={confirm != null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent data-testid="classify-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Classify this entry?", "تصنيف هذا القيد؟")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm &&
                t(
                  `${confirm.entry.entryNumber ?? `#${confirm.entry.id}`} will read ${journalSourceLabel(confirm.candidate.type, t)}${confirm.candidate.sourceId != null ? ` #${confirm.candidate.sourceId}` : ""}. Only its source changes; the review is recorded under your account and cannot be undone from here.`,
                  `سيصبح مصدر ${confirm.entry.entryNumber ?? `#${confirm.entry.id}`}: ${journalSourceLabel(confirm.candidate.type, t)}${confirm.candidate.sourceId != null ? ` رقم ${confirm.candidate.sourceId}` : ""}. لا يتغيّر فيه إلا مصدره، وتُسجَّل المراجعة باسم حسابك ولا يمكن التراجع عنها من هنا.`,
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel", "إلغاء")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="classify-confirm-yes"
              disabled={classify.isPending}
              onClick={(ev) => {
                ev.preventDefault();
                if (confirm) classify.mutate({ id: confirm.entry.id, data: { sourceType: confirm.candidate.type, sourceId: confirm.candidate.sourceId } });
              }}
            >
              {t("Classify", "تصنيف")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EntryCard({ entry: e, canClassify, onClassify }: {
  entry: UnclassifiedJournalEntry;
  canClassify: boolean;
  onClassify: (c: UnclassifiedJournalEntryCandidate) => void;
}) {
  const { t } = useLanguage();
  const status =
    e.reviewStatus === "classified"
      ? t("Classified", "مصنَّف")
      : e.reviewStatus === "classifiable"
        ? t("Can be classified", "قابل للتصنيف")
        : t("Awaiting an accountant-approved policy", "بانتظار سياسة يعتمدها المحاسب");
  const p = legacyPaymentNote((e.backfillEvidence ?? {}) as Record<string, unknown>, t);
  return (
    <Card className="border-border bg-card" data-testid={`unclassified-${e.id}`} data-review-status={e.reviewStatus}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">
              <span dir="ltr">{e.entryNumber ?? `#${e.id}`}</span>
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <DualDate date={e.date} inline />
              <span>·</span>
              <span>{journalStatusLabel(e.status, t)}</span>
              <span>·</span>
              <span>{fmtNum(e.total)}</span>
            </CardDescription>
          </div>
          {/* A real state of the record, so a plain badge: never the status palette for a judgement (CLAUDE.md §4). */}
          <Badge variant="outline" data-testid="review-status">{status}</Badge>
        </div>
        {e.description && <p className="text-sm text-muted-foreground mt-1 break-words">{e.description}</p>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="font-medium">{t("What the back-fill found", "ما وجده الترحيل الاستدراكي")}</p>
          <p className="text-muted-foreground">
            {e.backfillOutcome === "ambiguous"
              ? t("Records that point at this entry, but disagree or fail a check — so it was not classified.", "سجلات تشير إلى هذا القيد، لكنها متعارضة أو أخفقت في فحص — لذا لم يُصنَّف.")
              : t("No record that produced this entry.", "لا يوجد سجل أنشأ هذا القيد.")}
          </p>
          {p && <p className="text-muted-foreground mt-1" data-testid="legacy-payment-note">{p}</p>}
        </div>

        {e.review ? (
          <p data-testid="review-done">
            {t(
              `Classified on review as ${journalSourceLabel(e.review.newSourceType, t)}${e.review.newSourceId != null ? ` #${e.review.newSourceId}` : ""}, on `,
              `صُنِّف بالمراجعة: ${journalSourceLabel(e.review.newSourceType, t)}${e.review.newSourceId != null ? ` رقم ${e.review.newSourceId}` : ""}، بتاريخ `,
            )}
            <DualDate date={e.review.reviewedAt.slice(0, 10)} inline />.
          </p>
        ) : (
          <div>
            <p className="font-medium">{t("What the records show today", "ما تُظهره السجلات اليوم")}</p>
            {e.candidates.length === 0 ? (
              <p className="text-muted-foreground" data-testid="no-candidates">
                {t(
                  "Nothing ties this entry to what produced it. It stays unclassified until an accountant-approved policy says how such entries are treated.",
                  "لا شيء يربط هذا القيد بما أنشأه. يبقى غير مصنَّف إلى أن تحدد سياسة يعتمدها المحاسب طريقة معاملة مثل هذه القيود.",
                )}
              </p>
            ) : (
              <ul className="space-y-2 mt-1">
                {e.candidates.map((c, i) => {
                  const failed = failedCheckLabels(c.evidence as Record<string, unknown>, t);
                  return (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2" data-testid="candidate" data-classifiable={String(c.classifiable)}>
                      <div className="min-w-0">
                        <p>
                          {journalSourceLabel(c.type, t)}
                          {c.sourceId != null && <span dir="ltr"> #{c.sourceId}</span>}
                          <span className="text-muted-foreground"> — {sourceRuleLabel(c.rule, c.sourceId, t)}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.checksPass
                            ? c.classifiable
                              ? t("Confirmed by the records.", "تؤكده السجلات.")
                              : t("Confirmed, but a manual classification waits for an accountant-approved policy.", "مؤكَّد، لكن التصنيف قيداً يدوياً ينتظر سياسة يعتمدها المحاسب.")
                            : t(`Not confirmed: ${failed.join("; ") || "a check failed"}.`, `غير مؤكَّد: ${failed.join("؛ ") || "أخفق فحص"}.`)}
                        </p>
                      </div>
                      {canClassify && c.classifiable && (
                        <Button size="sm" data-testid="classify" onClick={() => onClassify(c)}>
                          {t("Classify as this", "صنِّف بهذا المصدر")}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
