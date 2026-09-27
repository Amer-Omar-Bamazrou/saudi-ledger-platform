/**
 * 🔴 PHASE 13A — INPUT VAT HELD FOR EVIDENCE.
 *
 * Every purchase document whose input VAT is not claimed because its evidence
 * does not support the claim yet — and WHY, in the user's language, keyed on
 * the server's structured reason. Accountant X1 (2026-09-27): such a document
 * POSTS, its VAT in the holding asset "Input VAT awaiting evidence", on no
 * return. Here it is found and given its evidence (the supplier document
 * held, its number, the document itself, the date it is held); when that
 * supports the claim, the server moves the held VAT into Input VAT dated that
 * day — the claim's period (X2). A draft still awaiting evidence is listed
 * too, and is opened in the bill form.
 *
 * The counts are the server's, over the whole held set — never this page.
 */
import { useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { listBillsHeldForVatEvidence, type Bill, type ListBillsHeldForVatEvidenceParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { businessToday } from "@workspace/shared";
import type { AttachEvidenceInput } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";
import { SUPPLIER_DOCUMENT_KINDS, flagShort, flagText, inputVatLabel, kindLabel, statusLabel, type SupplierDocumentKind } from "@/lib/vatEvidence";
import { ShieldAlert } from "lucide-react";

const PAGE = 50;

const isPosted = (b: Bill) => b.status !== "draft" && b.status !== "submitted";

/**
 * Evidence for a POSTED document whose VAT is held: the supplier document now
 * held, its number, the document itself, and the day it is held. Nothing here
 * edits a figure — the document is in the books. The server decides; the toast
 * says whether the VAT was claimed or what is still missing.
 */
function PostedEvidenceDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<string>(bill.supplierDocumentKind ?? "");
  const [reference, setReference] = useState(bill.vendorReference ?? "");
  const [date, setDate] = useState(businessToday());
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      let captureId: string | null = null;
      if (file) {
        const fd = new FormData();
        fd.append("document", file, file.name);
        fd.append("source", "manual");
        const cap: { captureId: string } = await apiFetch("/capture", { method: "POST", body: fd });
        captureId = cap.captureId;
      }
      const body: AttachEvidenceInput = {
        ...(captureId ? { captureId } : {}),
        ...(kind ? { supplierDocumentKind: kind as SupplierDocumentKind } : {}),
        ...(reference.trim() ? { vendorReference: reference.trim() } : {}),
        evidenceDate: date,
      };
      const b = await apiFetch<Bill>(`/bills/${bill.id}/evidence`, { method: "POST", body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ["vat-evidence"] });
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast(b.inputVat?.state === "claimed"
        ? { title: t(`${b.billNumber}: input VAT claimed`, `${b.billNumber}: خُصمت ضريبة المدخلات`), description: t(`Claimed on ${b.inputVat.claimedOn} — in that period's VAT return.`, `خُصمت بتاريخ ${b.inputVat.claimedOn} — في إقرار تلك الفترة.`) }
        : { title: t(`${b.billNumber}: still awaiting evidence`, `${b.billNumber}: ما زال بانتظار الإثبات`), description: t("The evidence was recorded but does not yet support the claim — see the reasons listed.", "سُجّل الإثبات لكنه لا يدعم الخصم بعد — راجع الأسباب المذكورة.") });
      onClose();
    } catch (e) {
      toast({ title: t("Could not record the evidence", "تعذّر تسجيل الإثبات"), description: (e as Error).message, variant: "destructive" } as never);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="posted-evidence-dialog">
        <DialogHeader><DialogTitle>{t("Supply the evidence", "استكمال الإثبات")} — <span dir="ltr">{bill.billNumber}</span></DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t("This bill is posted. Its VAT is held in \"Input VAT awaiting evidence\" and is on no VAT return. When the evidence supports the claim, the VAT moves into Input VAT on the date below — that date's period claims it (VAT IR Art. 49(8), within five calendar years of the supply).",
             "هذه الفاتورة مُرحّلة، وضريبتها محتجزة في حساب «ضريبة مدخلات بانتظار الإثبات» ولا تظهر في أي إقرار. عندما يدعم الإثبات الخصم تنتقل الضريبة إلى ضريبة المدخلات بالتاريخ أدناه — وتُخصم في فترته (المادة 49(8)، خلال خمس سنوات تقويمية من التوريد).")}
        </p>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("Supplier document you hold", "مستند المورد الذي بحوزتك")}</Label>
            <Select value={kind || "unset"} onValueChange={(v) => setKind(v === "unset" ? "" : v)}>
              <SelectTrigger className="mt-1 h-8 text-sm" data-testid="posted-evidence-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unset" className="text-xs">{t("— Choose —", "— اختر —")}</SelectItem>
                {SUPPLIER_DOCUMENT_KINDS.map((k) => <SelectItem key={k} value={k} className="text-xs" data-testid={`posted-evidence-kind-${k}`}>{kindLabel(k, t)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Supplier's invoice number", "رقم فاتورة المورد")}</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1 h-8 text-sm font-mono" dir="ltr" data-testid="posted-evidence-reference" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Date the evidence is held", "تاريخ حيازة الإثبات")}</Label>
            <Input type="date" value={date} max={businessToday()} onChange={(e) => setDate(e.target.value)} className="mt-1 h-8 text-sm" data-testid="posted-evidence-date" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t("The document (optional for a tax invoice; required for a simplified one)", "المستند (اختياري للفاتورة الضريبية، ومطلوب للمبسطة)")}</Label>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" data-testid="posted-evidence-file"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => fileRef.current?.click()}>
                {t("Choose file", "اختر ملفًا")}
              </Button>
              <span className="text-xs text-muted-foreground truncate" dir="ltr">{file?.name ?? ""}</span>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button size="sm" disabled={saving} onClick={submit} data-testid="posted-evidence-submit">
            {saving ? t("Recording…", "جارٍ التسجيل…") : t("Record evidence", "تسجيل الإثبات")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function VatEvidence() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const initialQ = new URLSearchParams(window.location.search).get("q") ?? "";
  const [q, setQ] = useState(initialQ);
  const [search, setSearch] = useState(initialQ);
  const [reason, setReason] = useState<string>("");
  const [page, setPage] = useState(0);
  const [checking, setChecking] = useState<number | null>(null);
  const [supplying, setSupplying] = useState<Bill | null>(null);

  const params: ListBillsHeldForVatEvidenceParams = {
    limit: PAGE, offset: page * PAGE,
    ...(reason ? { reason } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
  };
  const { data, isLoading } = useQuery({
    queryKey: ["vat-evidence", params],
    queryFn: () => listBillsHeldForVatEvidence(params),
  });
  // The reason chips come from an UNFILTERED read, so each shows its own count whatever is selected.
  const { data: all } = useQuery({
    queryKey: ["vat-evidence", "all-reasons"],
    queryFn: () => listBillsHeldForVatEvidence({ limit: 1, offset: 0 }),
  });
  const items = data?.items ?? [];
  const total = data?.page.total ?? 0;

  const recheck = async (id: number) => {
    setChecking(id);
    try {
      // Re-check = the evidence endpoint with nothing attached. A literal path, typed by the GENERATED Bill.
      const b = await apiFetch<Bill>(`/bills/${id}/evidence`, { method: "POST", body: JSON.stringify({}) });
      qc.invalidateQueries({ queryKey: ["vat-evidence"] });
      qc.invalidateQueries({ queryKey: ["bills"] });
      toast({ title: `${b.billNumber}: ${statusLabel(b.vatEvidence?.status, t)}` });
    } catch (e) {
      toast({ title: t("Could not re-check", "تعذّرت إعادة التحقق"), description: (e as Error).message, variant: "destructive" } as never);
    } finally {
      setChecking(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="page-vat-evidence">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <ShieldAlert className="w-6 h-6 text-attention" /> {t("VAT evidence", "إثبات ضريبة المدخلات")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
          {t("Purchase documents whose input VAT is not claimed because their evidence does not support it yet. A posted one holds its VAT in \"Input VAT awaiting evidence\" — on no VAT return. Supply the evidence and the VAT is claimed in the period you hold it (VAT IR Art. 49(8), within five calendar years). Blocked VAT (Art. 50) is not listed: it is part of the cost.",
             "مستندات مشتريات لم تُخصم ضريبة مدخلاتها لأن إثباتها لا يدعم الخصم بعد. المستند المُرحّل يحتجز ضريبته في حساب «ضريبة مدخلات بانتظار الإثبات» ولا تظهر في أي إقرار. استكمل الإثبات فتُخصم الضريبة في الفترة التي تحوزه فيها (المادة 49(8)، خلال خمس سنوات تقويمية). ولا تظهر هنا الضريبة المحظورة (المادة 50) لأنها ضمن التكلفة.")}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          [t("Documents held", "المستندات المعلّقة"), all ? String(all.page.total) : "—", "held-count"],
          [t("VAT not claimed while held", "ضريبة لم تُخصم أثناء التعليق"), all ? fmtNum(all.totals.heldVat) : "—", "held-vat"],
          [t("Posted — VAT held", "مُرحّلة — الضريبة محتجزة"), all ? String(all.totals.byStatus.postedHeld) : "—", "held-posted"],
          [t("Drafts awaiting evidence", "مسودات بانتظار الإثبات"), all ? String(all.totals.byStatus.awaitingEvidence) : "—", "held-awaiting"],
        ].map(([l, v, id]) => (
          <Card key={id} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className="text-xl sm:text-2xl font-bold font-mono" data-testid={id} dir="ltr">{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3 space-y-3">
          <div className="flex flex-wrap gap-2" data-testid="held-reasons">
            <Button size="sm" variant={reason === "" ? "default" : "ghost"} className="h-7 text-xs" onClick={() => { setReason(""); setPage(0); }}>
              {t("All reasons", "كل الأسباب")}
            </Button>
            {(all?.totals.byReason ?? []).map((r) => (
              <Button key={r.code} size="sm" variant={reason === r.code ? "default" : "ghost"} className="h-7 text-xs max-w-full" data-reason={r.code}
                onClick={() => { setReason(r.code); setPage(0); }}>
                <span className="truncate">{flagShort(r.code, t)}</span>
                <span className="ms-1 font-mono" dir="ltr">({r.count})</span>
              </Button>
            ))}
            {(all?.totals.byStatus.notEvaluated ?? 0) > 0 && (
              <Button size="sm" variant={reason === "not_evaluated" ? "default" : "ghost"} className="h-7 text-xs" onClick={() => { setReason("not_evaluated"); setPage(0); }}>
                {t("Not yet checked", "لم يُتحقق بعد")} <span className="ms-1 font-mono" dir="ltr">({all!.totals.byStatus.notEvaluated})</span>
              </Button>
            )}
          </div>
          <form className="flex gap-2 max-w-md" onSubmit={(e) => { e.preventDefault(); setSearch(q); setPage(0); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search by number or supplier…", "ابحث بالرقم أو المورد…")} className="h-8 text-sm" data-testid="held-search" />
            <Button type="submit" size="sm" variant="outline" className="h-8">{t("Search", "بحث")}</Button>
          </form>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center" data-testid="held-empty">
              {reason || search
                ? t("No held document matches this filter.", "لا يوجد مستند معلّق يطابق هذا التصفية.")
                : t("No document is held for VAT evidence.", "لا يوجد مستند معلّق بانتظار إثبات الضريبة.")}
            </p>
          ) : (
            <div className="space-y-3">
              {items.map((b) => {
                const reasons = (b.vatEvidence?.flags ?? []).filter((f) => f.severity === "blocking");
                return (
                  <div key={b.id} className="rounded-lg border border-border p-3 space-y-2" data-testid={`held-row-${b.id}`}>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <span className="font-mono text-primary" dir="ltr">{b.billNumber}</span>
                      <span className="font-medium">{b.vendorName ?? t("No supplier", "دون مورد")}</span>
                      <span className="text-xs text-muted-foreground"><DualDate date={b.date} /></span>
                      <span className="font-mono" dir="ltr">{fmtNum(b.total)}</span>
                      <span className="text-xs text-muted-foreground">{t("VAT", "الضريبة")} <span className="font-mono" dir="ltr">{fmtNum(b.vatAmount)}</span></span>
                      <span className="text-xs rounded border border-attention-surface/40 bg-attention-surface/10 px-1.5 text-attention" data-testid={`held-state-${b.id}`}>
                        {isPosted(b) ? inputVatLabel(b.inputVat?.state, t) : `${t("Draft", "مسودة")} · ${statusLabel(b.vatEvidence?.status, t)}`}
                      </span>
                      {isPosted(b) && <span className="text-xs text-muted-foreground">{t("Held", "محتجزة")} <span className="font-mono" dir="ltr">{fmtNum(b.inputVat?.pending ?? 0)}</span></span>}
                      {b.recordedAsExpense && <span className="text-xs rounded border border-border px-1.5 text-muted-foreground">{t("Expense", "مصروف")}</span>}
                    </div>
                    {reasons.length > 0 ? (
                      <ul className="space-y-0.5">
                        {reasons.map((f) => <li key={f.code} className="text-xs text-muted-foreground" data-code={f.code}>• {flagText(f, t)}</li>)}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("Older than the evidence check — re-check it to see what it needs.", "أقدم من فحص الإثبات — أعد التحقق لمعرفة ما يلزمه.")}</p>
                    )}
                    <div className="flex gap-2">
                      {isPosted(b) ? (
                        <Button size="sm" className="h-7 text-xs" onClick={() => setSupplying(b)} data-testid={`held-supply-${b.id}`}>
                          {t("Supply evidence", "استكمال الإثبات")}
                        </Button>
                      ) : (
                        <Button size="sm" className="h-7 text-xs" onClick={() => navigate(`/bills?edit=${b.id}`)} data-testid={`held-open-${b.id}`}>
                          {t("Open and add evidence", "فتح واستكمال الإثبات")}
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={checking === b.id} onClick={() => recheck(b.id)} data-testid={`held-recheck-${b.id}`}>
                        {checking === b.id ? t("Checking…", "جارٍ التحقق…") : t("Re-check", "إعادة التحقق")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {total > 0 && (
            <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
              <span>{t(`Showing ${page * PAGE + 1}–${Math.min(page * PAGE + items.length, total)} of ${total}`, `عرض ${page * PAGE + 1}–${Math.min(page * PAGE + items.length, total)} من ${total}`)}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t("Previous", "السابق")}</Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>{t("Next", "التالي")}</Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground pt-3">
            {t("Suppliers' VAT numbers are kept on the supplier:", "تُحفظ الأرقام الضريبية للموردين في بيانات المورد:")} <Link href="/vendors" className="underline">{t("Vendors", "الموردون")}</Link>
          </p>
        </CardContent>
      </Card>
      {supplying && <PostedEvidenceDialog bill={supplying} onClose={() => setSupplying(null)} />}
    </div>
  );
}
