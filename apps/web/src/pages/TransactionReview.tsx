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
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCheck, Check, Link2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";

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
  vatBasis?: string | null;
  treatmentAssumed?: boolean;
  needsAttention: boolean;
  suggestion: Suggestion | null;
}

const TREATMENTS = ["S", "Z", "E", "O"] as const;

/**
 * Flaw #6 — whether VAT was actually charged, which is a different question
 * from what the supply is. Shown only for standard-rated rows, because it is
 * the only case where the answer changes anything.
 */
const VAT_BASES = [
  { value: "charged", en: "VAT charged", ar: "ضريبة محصّلة" },
  { value: "reverse_charge", en: "Reverse charge (foreign supplier)", ar: "احتساب عكسي (مورد أجنبي)" },
  { value: "supplier_unregistered", en: "Supplier not VAT-registered", ar: "المورّد غير مسجّل" },
] as const;

export default function TransactionReview() {
  const { lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: rows = [], isLoading } = useQuery<PendingRow[]>({
    queryKey: ["transactions-review"],
    queryFn: () => apiFetch("/transactions/review"),
  });

  /**
   * 🔴 The TRUE totals, counted in SQL — never `rows.length`.
   *
   * `/transactions/review` returns a 200-row page because it feeds this screen.
   * The bulk button below was labelled `Accept ready (${ready.length})` off that
   * page and then called the endpoint with NO ids, which accepts EVERY safe
   * pending row in the tenant and POSTS THEM TO THE LEDGER. A tenant with 5,000
   * rows read "200" and one click posted all of them. The label understated the
   * blast radius of an accounting act — invisible below 200 rows, which is
   * every dataset this product has ever been developed against.
   */
  const { data: counts } = useQuery<{ total: number; needsAttention: number; ready: number }>({
    queryKey: ["transactions-review-counts"],
    queryFn: () => apiFetch("/transactions/review/counts"),
  });

  const [confirmBulk, setConfirmBulk] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["transactions-review"] });
    qc.invalidateQueries({ queryKey: ["transactions-review-counts"] });
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

  // Flaw #6 — correct a wrongly-guessed basis in either direction. The engine
  // flags known foreign suppliers as reverse-charge, but several have since
  // registered in KSA, so the guess must be overridable.
  const basisMut = useMutation({
    mutationFn: ({ id, value }: { id: number; value: string | null }) =>
      apiFetch(`/transactions/${id}`, { method: "PATCH", body: JSON.stringify({ vatBasis: value }) }),
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

  /**
   * 🔴 The true ready total, and whether one click reaches past what the user
   * can see. Bulk accept sends NO ids, so the server acts on every safe pending
   * row in the tenant and POSTS each one to the ledger. Below the 200-row cap
   * the two numbers are equal and none of this shows; past it, a confirm names
   * what the click will actually do.
   *
   * This does not violate the M16 principle that accepting the match IS the
   * review — a second confirmation of a fact the user just reviewed is a design
   * defect. Rows beyond the page were never reviewed, so naming them is not a
   * second confirmation; it is the first mention.
   */
  const readyTotal = counts?.ready ?? null;
  const reachesBeyondPage = readyTotal != null && readyTotal > ready.length;

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
          <DualDate date={r.date} inline /> · {r.type} · {fmtNum(r.amount)}
          {r.kind !== "operating" && <Badge className="ms-2" variant="outline">{r.kind}</Badge>}
          {r.categoryName && <span className="ms-2">{r.categoryName}</span>}
          {r.kind === "operating" && (
            <span className="ms-2 inline-flex items-center gap-1">
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
                <Badge variant="outline" className="border-attention-surface/40 text-attention-surface">
                  {lang === "ar" ? "مفترضة" : "assumed"}
                </Badge>
              )}
              {r.taxTreatment === "S" && (
                <select
                  className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                  value={r.vatBasis ?? "charged"}
                  title={
                    lang === "ar"
                      ? "هل تضمّنت هذه الدفعة ضريبة فعليًا؟ المورّدون الأجانب لا يحتسبونها"
                      : "Did this payment actually carry VAT? Foreign suppliers charge none — you self-account"
                  }
                  onChange={(e) => basisMut.mutate({ id: r.id, value: e.target.value })}
                  disabled={basisMut.isPending}
                >
                  {VAT_BASES.map((b) => (
                    <option key={b.value} value={b.value}>{lang === "ar" ? b.ar : b.en}</option>
                  ))}
                </select>
              )}
              {r.vatBasis === "reverse_charge" && (
                <Badge variant="outline" className="border-info-surface/40 text-info">
                  {lang === "ar" ? "احتساب عكسي" : "reverse charge"}
                </Badge>
              )}
            </span>
          )}
        </div>
        {r.suggestion && (
          <div className="mt-1 flex items-center gap-1 text-xs text-info-surface">
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
        {/*
          Disabled on the TRUE count where we have it: every visible row needing
          attention does not mean there is nothing ready BEYOND the page. Falls
          back to the page count only while the server count is still loading.
        */}
        <Button
          onClick={() => (reachesBeyondPage ? setConfirmBulk(true) : acceptMut.mutate(undefined))}
          disabled={acceptMut.isPending || (readyTotal != null ? readyTotal === 0 : ready.length === 0)}
          className="gap-2"
        >
          <CheckCheck className="h-4 w-4" />
          {/*
            The number is the SERVER's count of every row this click will accept
            and post — never `ready.length`, which counts only the visible page.
            When the count has not loaded, the button states no number at all
            rather than asserting the page count as a total.
          */}
          {lang === "ar"
            ? readyTotal != null
              ? `قبول الجاهزة (${readyTotal})`
              : "قبول الجاهزة"
            : readyTotal != null
              ? `Accept ready (${readyTotal})`
              : "Accept ready"}
        </Button>
      </div>

      {/*
        ── The blast-radius confirm ────────────────────────────────────────────
        Shown ONLY when the click reaches past the rows on screen. It names the
        number, says the rows are not visible, and says that accepting posts to
        the ledger — the three facts the old label hid behind a page count.
      */}
      <Dialog open={confirmBulk} onOpenChange={setConfirmBulk}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {lang === "ar"
                ? `قبول ${readyTotal} معاملة؟`
                : `Accept ${readyTotal} transactions?`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {lang === "ar"
                ? `هذه الصفحة تعرض ${ready.length} فقط. سيقبل هذا الإجراء كل المعاملات الجاهزة البالغ عددها ${readyTotal}، بما فيها ما لا يظهر أمامك.`
                : `This page shows ${ready.length} of them. The action accepts all ${readyTotal} ready rows, including the ones you cannot see here.`}
            </p>
            <p className="font-medium">
              {lang === "ar"
                ? "القبول يُرحّل إلى دفتر الأستاذ: ستتحرك قائمة الدخل والتقارير فورًا."
                : "Accepting POSTS to the ledger — the income statement and every report move immediately."}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirmBulk(false)}>
                {lang === "ar" ? "إلغاء" : "Cancel"}
              </Button>
              <Button
                size="sm"
                disabled={acceptMut.isPending}
                onClick={() => {
                  setConfirmBulk(false);
                  acceptMut.mutate(undefined);
                }}
              >
                {lang === "ar" ? `قبول ${readyTotal}` : `Accept all ${readyTotal}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
              <span className="ms-2 text-xs font-normal text-muted-foreground">
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
