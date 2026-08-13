/**
 * M15/M16.3 — the holding-area review surface, now actually IN the product.
 *
 * The M15 review endpoints existed with no UI consumer (a shape without a
 * consumer, found at M16.3): imported rows landed `pending_review` and nothing
 * in the app could accept them. This page is the consumer: it lists pending
 * rows, separates "ready" from "needs attention" (the server enforces that
 * split in bulk accept), and — M16.3 — shows exact-match settlement
 * SUGGESTIONS. Accepting the match is ONE act: the row leaves the holding
 * area and the payment is recorded through the existing invoice/bill pay
 * path. Nothing here is ever automatic; the human clicks.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCheck, Check, Link2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

interface Suggestion {
  documentKind: "invoice" | "bill";
  documentId: number;
  documentNumber: string;
  counterpartyName: string | null;
  outstanding: number;
  matchedBy: "number" | "amount";
  partial: boolean;
}

interface PendingRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  type: "debit" | "credit";
  categoryName: string | null;
  confidenceScore: number | null;
  vatAmount: number | null;
  kind: string;
  taxTreatment: string | null;
  treatmentAssumed?: boolean;
  needsAttention: boolean;
  suggestion: Suggestion | null;
}

const TREATMENTS = ["S", "Z", "E", "O"] as const;

export default function TransactionReview() {
  const { lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: rows = [], isLoading } = useQuery<PendingRow[]>({
    queryKey: ["transactions-review"],
    queryFn: () => apiFetch("/transactions/review"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["transactions-review"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["bills"] });
  };

  const acceptMut = useMutation({
    mutationFn: (ids?: number[]) =>
      apiFetch("/transactions/review/accept", {
        method: "POST",
        body: JSON.stringify(ids ? { ids } : {}),
      }),
    onSuccess: (r: { accepted: number }) => {
      toast({ title: lang === "ar" ? `تم قبول ${r.accepted}` : `Accepted ${r.accepted} row(s)` });
      refresh();
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  // M16.3.1 — per-row treatment override. An "assumed" treatment (a category
  // default never verified against KSA rules) is shown as such and is
  // correctable in place; a user must never read a confident 'S' off a guess.
  const treatmentMut = useMutation({
    mutationFn: ({ id, value }: { id: number; value: string | null }) =>
      apiFetch(`/transactions/${id}`, { method: "PATCH", body: JSON.stringify({ taxTreatment: value }) }),
    onSuccess: refresh,
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const settleMut = useMutation({
    mutationFn: ({ id, s }: { id: number; s: Suggestion }) =>
      apiFetch(`/transactions/${id}/settle`, {
        method: "POST",
        body: JSON.stringify(
          s.documentKind === "invoice" ? { invoiceId: s.documentId } : { billId: s.documentId },
        ),
      }),
    onSuccess: (_r, { s }) => {
      toast({
        title:
          lang === "ar"
            ? `تمت التسوية مقابل ${s.documentNumber}`
            : `Settled against ${s.documentNumber}`,
      });
      refresh();
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const ready = rows.filter((r) => !r.needsAttention);
  const attention = rows.filter((r) => r.needsAttention);

  const suggestionLabel = (s: Suggestion) => {
    const verb = s.documentKind === "invoice" ? (lang === "ar" ? "تسوي الفاتورة" : "settles") : lang === "ar" ? "تسدد" : "pays";
    const how = s.matchedBy === "number" ? (lang === "ar" ? "بالرقم" : "matched by number") : lang === "ar" ? "بالمبلغ" : "matched by amount";
    const part = s.partial ? (lang === "ar" ? "، دفعة جزئية" : ", partial") : "";
    return `${verb} ${s.documentNumber} — ${fmtNum(s.outstanding)} ${lang === "ar" ? "مستحق" : "outstanding"} (${how}${part})`;
  };

  const Row = ({ r }: { r: PendingRow }) => (
    <div className="flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{r.description}</div>
        <div className="text-xs text-muted-foreground">
          {fmtDate(r.date)} · {r.type} · {fmtNum(r.amount)}
          {r.kind !== "operating" && <Badge className="ml-2" variant="outline">{r.kind}</Badge>}
          {r.categoryName && <span className="ml-2">{r.categoryName}</span>}
          {r.kind === "operating" && (
            <span className="ml-2 inline-flex items-center gap-1">
              <select
                className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                value={r.taxTreatment ?? ""}
                title={
                  r.treatmentAssumed
                    ? lang === "ar"
                      ? "معاملة مفترضة — لم تُتحقق من قواعد ضريبة القيمة المضافة؛ صحّحها إن لزم"
                      : "Assumed default — not verified against KSA VAT rules; override if wrong"
                    : lang === "ar" ? "المعاملة الضريبية" : "VAT treatment"
                }
                onChange={(e) => treatmentMut.mutate({ id: r.id, value: e.target.value || null })}
                disabled={treatmentMut.isPending}
              >
                <option value="">{lang === "ar" ? "غير معروف" : "unknown"}</option>
                {TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {r.treatmentAssumed && (
                <Badge variant="outline" className="border-amber-500/40 text-amber-500">
                  {lang === "ar" ? "مفترضة" : "assumed"}
                </Badge>
              )}
            </span>
          )}
        </div>
        {r.suggestion && (
          <div className="mt-1 flex items-center gap-1 text-xs text-blue-500">
            <Link2 className="h-3 w-3" /> {suggestionLabel(r.suggestion)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {r.suggestion && (
          <Button
            size="sm"
            onClick={() => settleMut.mutate({ id: r.id, s: r.suggestion! })}
            disabled={settleMut.isPending}
            className="gap-1"
          >
            <Link2 className="h-3.5 w-3.5" />
            {lang === "ar" ? "قبول وتسوية" : "Accept & settle"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => acceptMut.mutate([r.id])}
          disabled={acceptMut.isPending}
          className="gap-1"
        >
          <Check className="h-3.5 w-3.5" />
          {lang === "ar" ? "قبول" : "Accept"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {lang === "ar" ? "مراجعة المعاملات" : "Transaction Review"}
        </h1>
        <Button
          onClick={() => acceptMut.mutate(undefined)}
          disabled={acceptMut.isPending || ready.length === 0}
          className="gap-2"
        >
          <CheckCheck className="h-4 w-4" />
          {lang === "ar" ? "قبول الجاهزة" : `Accept ready (${ready.length})`}
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">…</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {lang === "ar" ? "لا توجد معاملات بانتظار المراجعة." : "No transactions awaiting review."}
        </p>
      )}

      {ready.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {lang === "ar" ? "جاهزة للقبول" : "Ready to accept"} ({ready.length})
            </CardTitle>
          </CardHeader>
          <CardContent>{ready.map((r) => <Row key={r.id} r={r} />)}</CardContent>
        </Card>
      )}

      {attention.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {lang === "ar" ? "تحتاج انتباهًا" : "Needs attention"} ({attention.length})
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {lang === "ar"
                  ? "لا يشملها القبول الجماعي — يجب قبول كل صف باسمه"
                  : "excluded from bulk accept — each row must be accepted by name"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>{attention.map((r) => <Row key={r.id} r={r} />)}</CardContent>
        </Card>
      )}
    </div>
  );
}
