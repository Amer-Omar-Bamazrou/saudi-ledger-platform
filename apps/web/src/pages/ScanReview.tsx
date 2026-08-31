/**
 * ScanReview.tsx
 *
 * Post-extraction review page shown after the receipt scanner finishes OCR.
 * Implements Parts 1–6 from the spec:
 *   1 — shows raw extraction vs. validated output with field-level flags
 *   2 — all 7 fields editable before anything touches the database
 *   3 — auto-matches supplier by VAT number (exact) or name (fuzzy); lets
 *       accountant confirm, pick from suggestions, or create a new supplier
 *   4 — validation flags shown prominently (not buried)
 *   5 — proposed journal entry with editable debit account
 *   6 — posts through POST /bills/:id/post — the same single code path
 *       used for manually-created vendor bills
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { fetchPickerOptions } from "@/lib/pagedList";
import { PickerLimitNotice } from "@/components/PickerLimitNotice";
import type { ParsedReceipt } from "@/lib/receiptParser";
import { loadAndClearScanData } from "@/lib/scanReviewStore";
import { validateReceipt } from "@/lib/receiptValidator";
import type { ValidationFlag } from "@/lib/receiptValidator";
import { EXPENSE_ACCOUNTS, DEFAULT_EXPENSE_ACCOUNT } from "@/lib/accounts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  AlertCircle, AlertTriangle, CheckCircle2, ArrowLeft, Trash2,
  Building2, Plus, ScanLine, BookOpen, Loader2,
} from "lucide-react";

// ── types ─────────────────────────────────────────────────────────────────────
// `created` is returned by POST /vendors so the UI knows the vendor was
// just created server-side, rather than inferring it from local state.
interface Vendor { id: number; name: string; nameAr?: string; taxNumber?: string; created?: boolean; }
interface MatchResult {
  matchType: "exact" | "fuzzy" | "none";
  vendor: Vendor | null;
  suggestions: Vendor[];
}

// ── helpers ───────────────────────────────────────────────────────────────────
function n(v: string | number): number {
  const x = Number(v);
  return isNaN(x) ? 0 : Math.round(x * 100) / 100;
}

// ── component ─────────────────────────────────────────────────────────────────
export default function ScanReview() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { t } = useLanguage();
  const qc = useQueryClient();

  // AUD-5: discarding a staged capture — the reachable half of B3's deletion.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // ── form state (editable by accountant) ───────────────────────────────────
  const [fields, setFields] = useState({
    vendorName:          "",
    vendorNameAr:        "",   // populated when OCR detects Arabic vendor name
    supplierVatNumber:   "",
    invoiceNumber:       "",
    date:                new Date().toISOString().split("T")[0],
    subtotal:            "" as string | number,
    vatAmount:           "" as string | number,
    total:               "" as string | number,
    notes:               "",
  });
  const [rawText, setRawText] = useState("");
  /** How these figures were obtained — the A1 provenance requirement. */
  const [source, setSource] = useState<"qr" | "ocr" | "manual">("ocr");
  const [qrMissing, setQrMissing] = useState<string[]>([]);
  const [isPhase2, setIsPhase2] = useState(false);
  const [rawVisible, setRawVisible] = useState(false);
  /**
   * A1 (audit Tier 3): the server-side staged capture. When set, the
   * photograph is stored, a refresh resumes from GET /capture/:id instead of
   * losing the extraction, and posting links the bill to its evidence.
   */
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [signatureStatus, setSignatureStatus] = useState<string | null>(null);

  // ── vendor match state ─────────────────────────────────────────────────────
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [createNew, setCreateNew] = useState(false);
  const [manualVendorId, setManualVendorId] = useState<string>("");

  // ── JE debit account ──────────────────────────────────────────────────────
  const [debitAccount, setDebitAccount] = useState<string>(DEFAULT_EXPENSE_ACCOUNT);

  // ── posting state ─────────────────────────────────────────────────────────
  const [isPosting, setIsPosting] = useState(false);

  // ── vendors dropdown (for manual override) ────────────────────────────────
  const { data: vendorsPage } = useQuery<{ items: Vendor[]; total: number }>({
    queryKey: ["vendors", "picker"],
    queryFn: () => fetchPickerOptions<Vendor>("/vendors"),
  });
  const allVendors = vendorsPage?.items ?? [];

  // ── load the scan: handoff store first, staged capture as the fallback ────
  useEffect(() => {
    const applyParsed = (data: ParsedReceipt) => {
      setFields({
        vendorName:        data.vendorName ?? "",
        vendorNameAr:      data.vendorNameAr ?? "",
        supplierVatNumber: data.supplierVatNumber ?? "",
        invoiceNumber:     data.vendorReference ?? "",
        date:              data.date || new Date().toISOString().split("T")[0],
        subtotal:          data.subtotal > 0 ? data.subtotal : "",
        vatAmount:         data.vatAmount > 0 ? data.vatAmount : "",
        total:             data.total > 0 ? data.total : "",
        notes:             data.notes ?? "",
      });
      setRawText(data.rawText ?? "");
      if (data.supplierVatNumber || data.vendorName) {
        runMatch(data.supplierVatNumber ?? "", data.vendorName ?? "");
      }
    };

    const payload = loadAndClearScanData();
    if (payload) {
      setSource(payload.source);
      setQrMissing(payload.missing ?? []);
      setIsPhase2(!!payload.isPhase2);
      setCaptureId(payload.captureId ?? null);
      setSignatureStatus(payload.signatureStatus ?? null);
      applyParsed(payload.parsed);
      return;
    }

    // A1 (audit Tier 3): the refresh-loses-everything defect the spec opens
    // with. With a staged capture in the URL, the review RESUMES server-side.
    const capture = new URLSearchParams(window.location.search).get("capture");
    if (capture) {
      apiFetch<{ id: string; source: string; extraction: ParsedReceipt | null; signatureStatus: string | null }>(
        `/capture/${capture}`,
      )
        .then((doc) => {
          setCaptureId(doc.id);
          setSource((doc.source as "qr" | "ocr" | "manual") ?? "ocr");
          setSignatureStatus(doc.signatureStatus ?? null);
          if (doc.extraction) applyParsed(doc.extraction);
        })
        .catch(() => navigate("/bills"));
      return;
    }
    navigate("/bills");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── validation flags (recomputed whenever amounts change) ─────────────────
  const flags: ValidationFlag[] = validateReceipt({
    supplierVatNumber: String(fields.supplierVatNumber),
    subtotal:  n(fields.subtotal),
    vatAmount: n(fields.vatAmount),
    total:     n(fields.total),
  });
  const errors = flags.filter(f => f.severity === "error");
  const warnings = flags.filter(f => f.severity === "warning");

  // ── vendor match API call ─────────────────────────────────────────────────
  async function runMatch(vatNumber: string, vendorName: string) {
    if (!vatNumber && !vendorName) return;
    setMatchLoading(true);
    try {
      const result: MatchResult = await apiFetch("/vendors/match", {
        method: "POST",
        body: JSON.stringify({ vatNumber: vatNumber || undefined, vendorName: vendorName || undefined }),
      });
      setMatchResult(result);
      if (result.matchType === "exact" && result.vendor) {
        setSelectedVendorId(result.vendor.id);
        setCreateNew(false);
      }
    } catch (e) {
      console.error("Vendor match failed:", e);
    } finally {
      setMatchLoading(false);
    }
  }

  // ── create new vendor mutation ────────────────────────────────────────────
  // POST /vendors returns { ...vendor, created: true } — we use that server
  // signal to drive the "new supplier" UI state instead of a local boolean.
  const [justCreatedVendor, setJustCreatedVendor] = useState<Vendor | null>(null);

  const createVendorMut = useMutation({
    mutationFn: (body: any): Promise<Vendor> =>
      apiFetch("/vendors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (vendor: Vendor) => {
      qc.invalidateQueries({ queryKey: ["vendors"] });
      setSelectedVendorId(vendor.id);
      setCreateNew(false);
      // Use the server-returned created:true flag — not a local boolean
      if (vendor.created) setJustCreatedVendor(vendor);
      toast({ title: t("Supplier created", "تم إنشاء المورّد"), description: vendor.name });
    },
    onError: (e: Error) => toast({ title: t("Could not create supplier", "تعذّر إنشاء المورّد"), description: e.message, variant: "destructive" } as any),
  });

  // ── confirm & post ────────────────────────────────────────────────────────
  async function handleConfirm() {
    const vendorId = createNew ? null : (selectedVendorId ?? (manualVendorId ? Number(manualVendorId) : null));
    if (!vendorId) {
      toast({ title: t("Supplier required", "المورّد مطلوب"), description: t("Select or create a supplier before posting.", "اختر مورّدًا أو أنشئ واحدًا قبل الترحيل."), variant: "destructive" });
      return;
    }
    if (errors.length > 0 && !window.confirm(
      `There ${errors.length === 1 ? "is 1 validation error" : `are ${errors.length} validation errors`}. Post anyway?`
    )) return;

    setIsPosting(true);
    try {
      // Step 1: create draft bill (no GL posting yet)
      const bill: { id: number; billNumber: string } = await apiFetch("/bills", {
        method: "POST",
        body: JSON.stringify({
          // 🔴 Blank: the server allocates from the company's bill counter.
          // See the note in Bills.tsx — this was the second instance of the
          // same mint, and the sweep is why it was found.
          billNumber:      undefined,
          vendorReference: fields.invoiceNumber || undefined,
          date:            fields.date,
          vendorId,
          status:          "draft",
          subtotal:        n(fields.subtotal),
          vatAmount:       n(fields.vatAmount),
          total:           n(fields.total),
          notes:           fields.notes || undefined,
          items:           [],
        }),
      });

      // Step 2: post the journal entry (same endpoint as manual bill post).
      // `captureId` links the bill to its staged photograph ATOMICALLY with the
      // posting (bills.approvable attaches inside the same transaction) — the
      // A1 provenance chain: figure → extraction → stored source document.
      await apiFetch(`/bills/${bill.id}/post`, {
        method: "POST",
        body: JSON.stringify({ debitAccount, ...(captureId ? { captureId } : {}) }),
      });

      qc.invalidateQueries({ queryKey: ["bills"] });
      toast({ title: t("Bill posted", "تم ترحيل الفاتورة"), description: t(`${bill.billNumber} posted to the general ledger.`, `تم ترحيل ${bill.billNumber} إلى دفتر الأستاذ.`) });
      navigate("/bills");
    } catch (e: any) {
      toast({ title: t("Posting failed", "فشل الترحيل"), description: e?.message ?? t("Check the fields and try again.", "راجع الحقول وحاول مرة أخرى."), variant: "destructive" });
    } finally {
      setIsPosting(false);
    }
  }

  // ── JE preview amounts ────────────────────────────────────────────────────
  const previewSubtotal  = n(fields.subtotal);
  const previewVat       = n(fields.vatAmount);
  const previewTotal     = n(fields.total);

  // ── render ────────────────────────────────────────────────────────────────
  /**
   * Delete the staged photograph, then leave. The server reports
   * `imageDeleted` — B3's whole point was that a discard which does not delete
   * the bytes is a false statement — so a false there is surfaced rather than
   * swallowed.
   */
  const discardCapture = async () => {
    if (!captureId) return;
    setDiscarding(true);
    try {
      const res: { imageDeleted?: boolean } = await apiFetch(`/capture/${captureId}/discard`, {
        method: "POST",
      });
      toast({
        title: res.imageDeleted
          ? t("Photograph deleted", "تم حذف الصورة")
          : t("Capture discarded — the image could not be deleted yet", "تم إلغاء الالتقاط — تعذّر حذف الصورة بعد"),
        variant: res.imageDeleted ? undefined : ("destructive" as never),
      });
      navigate("/bills");
    } catch (e: unknown) {
      toast({
        title: t("Could not discard", "تعذّر الإلغاء"),
        description: (e as Error).message,
        variant: "destructive" as never,
      });
      setDiscarding(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={() => navigate("/bills")}>
          <ArrowLeft className="w-4 h-4" /> Back to Bills
        </Button>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ScanLine className="w-5 h-5 text-primary" /> Review Scanned Receipt
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {source === "qr"
              ? "Read from the invoice's ZATCA QR code — check and post"
              : "Correct any OCR errors before posting to the ledger"}
          </p>
        </div>
        {/* A1: evidence status — stored means the posted bill will be traceable
            to this photograph; a missing capture means storage failed and the
            bill will carry no source document. */}
        {captureId ? (
          <a
            href={`/api/capture/${captureId}/image`}
            target="_blank"
            rel="noreferrer"
            className="ms-auto inline-flex items-center gap-1 rounded border border-positive-surface/30 bg-positive-surface/10 px-2 py-1 text-xs text-positive-surface"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> {t("Source photograph stored — view", "الصورة المصدرية محفوظة — عرض")}
          </a>
        ) : (
          <span className="ms-auto inline-flex items-center gap-1 rounded border border-attention-surface/30 bg-attention-surface/10 px-2 py-1 text-xs text-attention-surface">
            <AlertTriangle className="w-3.5 h-3.5" /> {t("Photograph not stored", "الصورة غير محفوظة")}
          </span>
        )}
        {/*
          🔴 AUD-5 — the ONLY way to un-take a photograph.
          `POST /capture/:id/discard` was built by B3 to delete the image
          IMMEDIATELY rather than leave it staged for 30 days, and it returns
          `imageDeleted` precisely because reporting a deletion that did not
          happen was half of that defect. Nothing in the product called it, so a
          user who photographed the wrong document — a personal ID, someone
          else's invoice — had no way to remove it. That is also the C8/PDPL
          edge: the erasure path we built was the one nobody could reach.
        */}
        {captureId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={discarding}
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 className="w-3.5 h-3.5 me-1" />
            {t("Discard photograph", "حذف الصورة")}
          </Button>
        )}
      </div>

      {/* The confirm names what is destroyed and what is not. */}
      {confirmDiscard && (
        <div className="rounded-lg border border-negative-surface/40 bg-negative-surface/10 px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-negative-surface">
            {t(
              "Delete the stored photograph and abandon this review?",
              "حذف الصورة المحفوظة وإلغاء هذه المراجعة؟",
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "The image is deleted immediately and cannot be recovered. No bill has been posted, so nothing in the ledger changes.",
              "تُحذف الصورة فورًا ولا يمكن استرجاعها. لم يتم ترحيل أي فاتورة، فلا يتغيّر شيء في دفتر الأستاذ.",
            )}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
              {t("Keep it", "الاحتفاظ بها")}
            </Button>
            <Button size="sm" variant="destructive" disabled={discarding} onClick={discardCapture}>
              {discarding ? t("Deleting…", "جارٍ الحذف…") : t("Delete photograph", "حذف الصورة")}
            </Button>
          </div>
        </div>
      )}

      {signatureStatus === "failed" && (
        <div className="rounded-lg border border-negative-surface/40 bg-negative-surface/10 px-4 py-3">
          <p className="text-sm font-medium text-negative-surface flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            This invoice&apos;s ZATCA cryptographic stamp did NOT verify
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            The QR carries a Phase 2 signature that does not match its contents. Verify the
            document with the supplier before posting — it may be altered or corrupted.
          </p>
        </div>
      )}

      {/*
        🔴 PROVENANCE (A1). The actual question a disputed figure raises is
        "was this decoded, read by OCR, or typed?" — and the honest answer
        changes how hard the user should look before posting.

        A QR decode is exact: the supplier's own system wrote those bytes. OCR is
        a guess from pixels. Telling the user which they are looking at is the
        difference between "check this" and "verify all of it".
      */}
      {source === "qr" ? (
        <div className="rounded-lg border border-positive-surface/30 bg-positive-surface/10 px-4 py-3">
          <p className="text-sm font-medium text-positive-surface flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Read directly from the invoice&apos;s ZATCA QR code — these figures are exact
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            The seller, VAT number, date and amounts come from the supplier&apos;s own
            e-invoice data, not from reading the image.
            {isPhase2 && " This invoice is cryptographically stamped."}
          </p>
          {qrMissing.length > 0 && (
            <p className="text-xs text-attention-surface mt-1">
              Not carried by the QR code, please check: {qrMissing.join(", ")}.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
          <p className="text-sm font-medium flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-muted-foreground" />
            Read by text recognition — please check every figure
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            No ZATCA QR code was found on this document, so the fields below were
            recognised from the image and may contain errors.
          </p>
        </div>
      )}

      {/* ── validation flags ──────────────────────────────────────────────── */}
      {flags.length > 0 && (
        <div className="space-y-2">
          {errors.map((f, i) => (
            <div key={i} className="flex items-start gap-2.5 p-3 rounded-lg bg-negative-surface/10 border border-negative-surface/30 text-sm">
              <AlertCircle className="w-4 h-4 text-negative shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-negative capitalize">{f.field.replace("_", " ")}: </span>
                <span className="text-foreground">{f.message}</span>
              </div>
            </div>
          ))}
          {warnings.map((f, i) => (
            <div key={i} className="flex items-start gap-2.5 p-3 rounded-lg bg-attention-surface/10 border border-attention-surface/30 text-sm">
              <AlertTriangle className="w-4 h-4 text-attention shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-attention capitalize">{f.field.replace("_", " ")}: </span>
                <span className="text-foreground">{f.message}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── extracted fields ──────────────────────────────────────────────── */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" /> Extracted Fields
            <span className="text-xs text-muted-foreground font-normal">(all editable — correct any OCR errors)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Supplier / Vendor Name</Label>
              <Input value={fields.vendorName} onChange={e => setFields(p => ({ ...p, vendorName: e.target.value }))}
                className="mt-1 h-8 text-sm" placeholder="As printed on the document" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                Supplier VAT Registration #
                {fields.supplierVatNumber && /^3\d{13}3$/.test(fields.supplierVatNumber)
                  ? <span className="text-positive ms-1">✓</span>
                  : fields.supplierVatNumber
                    ? <span className="text-negative ms-1">✗ invalid format</span>
                    : null}
              </Label>
              <Input value={fields.supplierVatNumber}
                onChange={e => setFields(p => ({ ...p, supplierVatNumber: e.target.value }))}
                className="mt-1 h-8 text-sm font-mono" placeholder="15 digits, starts/ends with 3"
                maxLength={15} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Invoice / Receipt Number</Label>
              <Input value={fields.invoiceNumber} onChange={e => setFields(p => ({ ...p, invoiceNumber: e.target.value }))}
                className="mt-1 h-8 text-sm font-mono" placeholder="e.g. INV-2025-001" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Date</Label>
              <Input type="date" value={fields.date} onChange={e => setFields(p => ({ ...p, date: e.target.value }))}
                className="mt-1 h-8 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Subtotal (SAR)</Label>
              <Input type="number" step="0.01" value={fields.subtotal}
                onChange={e => setFields(p => ({ ...p, subtotal: e.target.value }))}
                className="mt-1 h-8 text-sm font-mono" placeholder="0.00" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">VAT Amount (SAR)</Label>
              <Input type="number" step="0.01" value={fields.vatAmount}
                onChange={e => setFields(p => ({ ...p, vatAmount: e.target.value }))}
                className={`mt-1 h-8 text-sm font-mono ${errors.some(f => f.field === "vat_amount") ? "border-negative-surface" : ""}`}
                placeholder="0.00" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Total (SAR)</Label>
              <Input type="number" step="0.01" value={fields.total}
                onChange={e => setFields(p => ({ ...p, total: e.target.value }))}
                className={`mt-1 h-8 text-sm font-mono ${errors.some(f => f.field === "totals") ? "border-negative-surface" : ""}`}
                placeholder="0.00" />
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">Notes</Label>
            <Input value={fields.notes} onChange={e => setFields(p => ({ ...p, notes: e.target.value }))}
              className="mt-1 h-8 text-sm" />
          </div>

          {/* raw OCR toggle */}
          {rawText && (
            <div className="rounded-lg border border-border overflow-hidden text-xs">
              <button
                onClick={() => setRawVisible(v => !v)}
                className="w-full text-start px-3 py-2 text-muted-foreground hover:bg-secondary/30 transition-colors select-none"
              >
                {rawVisible ? "▼" : "►"} Raw OCR text (verify against source)
              </button>
              {rawVisible && (
                <pre className="px-3 py-2 text-muted-foreground bg-secondary/20 whitespace-pre-wrap max-h-36 overflow-y-auto font-mono text-[11px]">
                  {rawText}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── supplier match ────────────────────────────────────────────────── */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" /> Supplier Match
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {matchLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Searching for existing supplier…
            </div>
          )}

          {/* exact match */}
          {!matchLoading && matchResult?.matchType === "exact" && matchResult.vendor && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-positive-surface/10 border border-positive-surface/30">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-positive shrink-0" />
                <div>
                  <p className="text-sm font-medium">{matchResult.vendor.name}</p>
                  {matchResult.vendor.taxNumber && (
                    <p className="text-xs text-muted-foreground font-mono">VAT: {matchResult.vendor.taxNumber}</p>
                  )}
                </div>
              </div>
              <Badge className="bg-positive-surface/20 text-positive border-positive-surface/30 text-xs">{t("Exact match", "تطابق تام")}</Badge>
            </div>
          )}

          {/* fuzzy suggestions */}
          {!matchLoading && matchResult?.matchType === "fuzzy" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-attention">
                <AlertTriangle className="w-4 h-4" />
                Possible matches found — please select the correct supplier or create a new one
              </div>
              <div className="space-y-1.5">
                {matchResult.suggestions.map(v => (
                  <label key={v.id}
                    className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-colors
                      ${selectedVendorId === v.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-secondary/30"}`}
                  >
                    <div className="flex items-center gap-2">
                      <input type="radio" name="vendorMatch" value={v.id}
                        checked={selectedVendorId === v.id}
                        onChange={() => { setSelectedVendorId(v.id); setCreateNew(false); }}
                        className="accent-primary" />
                      <div>
                        <p className="text-sm font-medium">{v.name}</p>
                        {v.taxNumber && <p className="text-xs text-muted-foreground font-mono">VAT: {v.taxNumber}</p>}
                      </div>
                    </div>
                  </label>
                ))}
                <label className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors
                  ${createNew ? "border-primary bg-primary/5" : "border-dashed border-border hover:bg-secondary/30"}`}
                >
                  <input type="radio" name="vendorMatch" checked={createNew}
                    onChange={() => { setCreateNew(true); setSelectedVendorId(null); }}
                    className="accent-primary" />
                  <Plus className="w-3.5 h-3.5 text-primary" />
                  <span className="text-sm">{t("Create new supplier — ", "إنشاء مورّد جديد — ")}<em className="text-muted-foreground">{fields.vendorName || "unnamed"}</em></span>
                  <Badge className="bg-attention-surface/20 text-attention border-attention-surface/30 text-xs ms-auto">{t("New supplier — please confirm details", "مورّد جديد — يرجى تأكيد البيانات")}</Badge>
                </label>
              </div>
            </div>
          )}

          {/* no match */}
          {!matchLoading && matchResult?.matchType === "none" && (
            <div className="p-3 rounded-lg bg-attention-surface/10 border border-attention-surface/30 text-sm">
              <p className="font-medium text-attention flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> No existing supplier found
              </p>
              <p className="text-muted-foreground text-xs mt-1">
                A new supplier will be created from the extracted name and VAT number — please confirm the details above are correct.
              </p>
              <Badge className="mt-2 bg-attention-surface/20 text-attention border-attention-surface/30 text-xs">{t("New supplier — please confirm details", "مورّد جديد — يرجى تأكيد البيانات")}</Badge>
            </div>
          )}

          {/* always-available manual override + create new */}
          <div className="pt-1 border-t border-border/50 space-y-2">
            <p className="text-xs text-muted-foreground">Or select manually:</p>
            <div className="flex gap-2">
              <Select value={manualVendorId} onValueChange={v => {
                setManualVendorId(v);
                setSelectedVendorId(Number(v));
                setCreateNew(false);
              }}>
                <SelectTrigger className="h-8 text-sm flex-1">
                  <SelectValue placeholder="Choose existing supplier…" />
                </SelectTrigger>
                <SelectContent>
                  {allVendors.map(v => (
                    <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>
                  ))}
                <PickerLimitNotice shown={allVendors.length} total={vendorsPage?.total ?? allVendors.length} /></SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs shrink-0"
                disabled={createVendorMut.isPending}
                onClick={() => createVendorMut.mutate({
                  name:       fields.vendorName || "New Supplier",
                  nameAr:     fields.vendorNameAr || undefined,
                  taxNumber:  fields.supplierVatNumber || undefined,
                  isActive:   true,
                })}
              >
                {createVendorMut.isPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Plus className="w-3.5 h-3.5" />}
                Create new
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── proposed journal entry ────────────────────────────────────────── */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" /> Proposed Journal Entry
            <span className="text-xs text-muted-foreground font-normal">— nothing posts until you confirm below</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-border overflow-hidden text-sm">
            <table className="w-full">
              <thead className="bg-secondary/40">
                <tr>
                  <th className="text-start px-3 py-2 text-xs text-muted-foreground font-medium">{t("Account", "الحساب")}</th>
                  <th className="text-end px-3 py-2 text-xs text-muted-foreground font-medium">Debit (SAR)</th>
                  <th className="text-end px-3 py-2 text-xs text-muted-foreground font-medium">Credit (SAR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {/* editable debit line */}
                <tr className="hover:bg-secondary/20">
                  <td className="px-3 py-2">
                    <Select value={debitAccount} onValueChange={setDebitAccount}>
                      <SelectTrigger className="h-7 text-xs border-dashed w-full max-w-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPENSE_ACCOUNTS.map(a => (
                          <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-foreground">
                    {previewSubtotal > 0 ? fmtNum(previewSubtotal) : "—"}
                  </td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-muted-foreground">—</td>
                </tr>
                {/* VAT line — fixed */}
                <tr className="hover:bg-secondary/20">
                  <td className="px-3 py-2 text-muted-foreground text-xs">{t("Input VAT Receivable", "ضريبة القيمة المضافة على المشتريات")}</td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-foreground">
                    {previewVat > 0 ? fmtNum(previewVat) : "—"}
                  </td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-muted-foreground">—</td>
                </tr>
                {/* AP line — fixed */}
                <tr className="hover:bg-secondary/20">
                  <td className="px-3 py-2 text-muted-foreground text-xs">{t("Accounts Payable", "الذمم الدائنة")}</td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-muted-foreground">—</td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums text-foreground">
                    {previewTotal > 0 ? fmtNum(previewTotal) : "—"}
                  </td>
                </tr>
              </tbody>
              <tfoot className="bg-secondary/20 border-t border-border">
                <tr>
                  <td className="px-3 py-2 text-xs font-semibold text-muted-foreground">Total</td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums font-semibold text-foreground">
                    {previewSubtotal + previewVat > 0 ? fmtNum(previewSubtotal + previewVat) : "—"}
                  </td>
                  <td className="px-3 py-2 text-end font-mono tabular-nums font-semibold text-foreground">
                    {previewTotal > 0 ? fmtNum(previewTotal) : "—"}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {previewSubtotal + previewVat > 0 && previewTotal > 0 &&
           Math.abs(previewSubtotal + previewVat - previewTotal) > 0.02 && (
            <p className="text-xs text-negative mt-2 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              Journal entry does not balance — fix the amounts before posting.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── action bar ───────────────────────────────────────────────────── */}
      <div className="flex gap-3 pb-8">
        <Button variant="outline" className="gap-2" onClick={() => navigate("/bills")} disabled={isPosting}>
          Cancel
        </Button>
        <Button
          className="flex-1 gap-2"
          onClick={handleConfirm}
          disabled={isPosting || (!selectedVendorId && !createNew && !manualVendorId)}
        >
          {isPosting
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Posting…</>
            : <><CheckCircle2 className="w-4 h-4" /> Confirm & Post Bill</>}
        </Button>
      </div>
    </div>
  );
}
