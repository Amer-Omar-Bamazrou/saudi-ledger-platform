/**
 * ReceiptScanner — drag-and-drop or click receipt OCR dialog.
 *
 * • Accepts JPEG / PNG / WEBP / PDF-page images
 * • Runs Tesseract.js (WASM) in the browser — no backend call needed
 * • Parses extracted text with receiptParser and returns structured fields
 *   so the caller can pre-fill the New Bill form
 */
import { useState, useRef, useCallback } from "react";
import { createWorker } from "tesseract.js";
import { parseReceiptText, type ParsedReceipt } from "@/lib/receiptParser";
import { readZatcaQr, type QrCaptureResult } from "@/lib/qrCapture";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  ScanLine, UploadCloud, X, CheckCircle2, AlertCircle,
  FileImage, Loader2, RotateCcw,
} from "lucide-react";

// ── types ──────────────────────────────────────────────────────────────────────
type Phase = "idle" | "loading" | "done" | "error";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Called when the user confirms — fields ready to pre-fill the bill form.
   * The FILE travels too (audit Tier 3 / A1): the photograph must reach the
   * server-side capture pipeline, or the posted bill has no stored evidence.
   */
  onExtracted: (data: ParsedReceipt, qr: QrCaptureResult | undefined, file: File) => void;
}

// ── component ──────────────────────────────────────────────────────────────────
export function ReceiptScanner({ open, onOpenChange, onExtracted }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<ParsedReceipt | null>(null);
  /** Set when the document carried a readable ZATCA QR — the exact path. */
  const [qr, setQr] = useState<QrCaptureResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragging, setDragging] = useState(false);
  /** The photograph itself — handed to onExtracted for server-side staging. */
  const [srcFile, setSrcFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPhase("idle"); setProgress(0); setProgressMsg("");
    setPreview(null); setResult(null); setQr(null); setErrorMsg(""); setSrcFile(null);
  };

  const handleClose = () => { reset(); onOpenChange(false); };

  // ── extraction: ZATCA QR first, OCR only if that fails ────────────────────
  const runOcr = useCallback(async (file: File) => {
    // Show image preview immediately
    const url = URL.createObjectURL(file);
    setPreview(url);
    setPhase("loading");
    setProgress(5);

    // 🔴 THE MOAT (A1 §0). A ZATCA-compliant supplier invoice carries the
    // seller, VAT number, timestamp, total and VAT as structured TLV. Reading it
    // is exact, instant, free, and never leaves the device — where OCR is
    // probabilistic and slow, especially on the phone this feature is for.
    //
    // Tried FIRST and short-circuits: when it succeeds, the ~10MB Tesseract WASM
    // download never happens.
    setProgressMsg("Looking for a ZATCA QR code…");
    const qrResult = await readZatcaQr(file);
    if (qrResult) {
      setQr(qrResult);
      setResult(qrResult.parsed);
      setPhase("done");
      setProgress(100);
      setProgressMsg("Read directly from the invoice's ZATCA QR code.");
      return;
    }

    setProgressMsg("Initialising OCR engine…");

    try {
      // Tesseract.js v5 — createWorker loads WASM + lang data from CDN
      const worker = await createWorker(["eng", "ara"], 1, {
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js",
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "loading tesseract core") { setProgress(15); setProgressMsg("Loading OCR core…"); }
          if (m.status === "loading language traineddata") { setProgress(35); setProgressMsg("Loading Arabic + English models…"); }
          if (m.status === "initialized api") { setProgress(55); setProgressMsg("Recognising text…"); }
          if (m.status === "recognizing text") {
            setProgress(55 + Math.round(m.progress * 40));
            setProgressMsg("Recognising text…");
          }
        },
      });

      setProgress(60);
      const { data: { text } } = await worker.recognize(file);
      await worker.terminate();

      setProgress(98);
      setProgressMsg("Parsing receipt fields…");
      const parsed = parseReceiptText(text);
      setQr(null);
      setResult(parsed);
      setPhase("done");
      setProgress(100);
    } catch (err: any) {
      setErrorMsg(err?.message ?? "OCR failed. Try a clearer image.");
      setPhase("error");
    }
  }, []);

  // ── file handling ──────────────────────────────────────────────────────────
  const accept = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setErrorMsg("Please upload an image file (JPEG, PNG, WEBP).");
      setPhase("error");
      return;
    }
    setSrcFile(file);
    runOcr(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) accept(f);
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) accept(f);
    e.target.value = "";
  };

  // ── confirm extracted data ─────────────────────────────────────────────────
  const confirm = () => {
    if (result && srcFile) { onExtracted(result, qr ?? undefined, srcFile); handleClose(); }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ScanLine className="w-4 h-4 text-primary" /> Scan Receipt
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-1">

          {/* ── capture (shown while idle) ───────────────────────────────── */}
          {phase === "idle" && (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed
                transition-all py-10 px-6 select-none
                ${dragging
                  ? "border-primary bg-primary/5 scale-[1.01]"
                  : "border-border"}`}
            >
              {/*
                🔴 CAMERA FIRST (A1 Q2). The wedge is "stop typing", and the
                moment that delivers it is photographing a receipt AT THE TILL.
                A file picker presupposes the receipt is already on a computer —
                which is the friction being sold away.

                `capture="environment"` opens the rear camera directly on iOS and
                Android. No native app, no new dependency. On desktop the same
                input falls back to a file dialog, so one control serves both.
              */}
              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onFileChange}
              />
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />

              <div className={`p-4 rounded-full transition-colors ${dragging ? "bg-primary/20" : "bg-secondary"}`}>
                <FileImage className={`w-10 h-10 transition-colors ${dragging ? "text-primary" : "text-muted-foreground"}`} />
              </div>

              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Button size="lg" className="flex-1" onClick={() => cameraRef.current?.click()}>
                  <ScanLine className="w-4 h-4 mr-2" />
                  Photograph a receipt
                </Button>
                <Button size="lg" variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}>
                  <UploadCloud className="w-4 h-4 mr-2" />
                  Choose a file
                </Button>
              </div>

              <p className="text-sm text-muted-foreground text-center">
                {dragging ? "Drop to scan" : "or drag an image here — JPEG, PNG, WEBP"}
              </p>
              <p className="text-xs text-muted-foreground text-center max-w-xs">
                A ZATCA QR code is read instantly and exactly. Otherwise text
                recognition runs in your browser — the image is never uploaded.
              </p>
            </div>
          )}

          {/* ── progress ─────────────────────────────────────────────────── */}
          {phase === "loading" && (
            <div className="space-y-4">
              {preview && (
                <div className="rounded-lg overflow-hidden border border-border max-h-48 flex items-center justify-center bg-secondary/20">
                  <img src={preview} alt="receipt" className="max-h-48 object-contain" />
                </div>
              )}
              <div className="space-y-2 px-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />{progressMsg}</span>
                  <span>{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                First scan downloads ~20 MB of language models (cached for future scans).
              </p>
            </div>
          )}

          {/* ── error ────────────────────────────────────────────────────── */}
          {phase === "error" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-400">OCR failed</p>
                  <p className="text-xs text-muted-foreground mt-1">{errorMsg}</p>
                </div>
              </div>
              <Button variant="outline" className="w-full gap-2" onClick={reset}>
                <RotateCcw className="w-4 h-4" /> Try another image
              </Button>
            </div>
          )}

          {/* ── result ───────────────────────────────────────────────────── */}
          {phase === "done" && result && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {/* image thumbnail */}
                {preview && (
                  <div className="rounded-lg overflow-hidden border border-border bg-secondary/20 flex items-center justify-center max-h-52">
                    <img src={preview} alt="receipt" className="max-h-52 object-contain" />
                  </div>
                )}

                {/* extracted fields */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" /> Extracted fields
                  </div>
                  <Field label="Vendor" value={result.vendorName || "—"} />
                  <Field label="VAT Reg #" value={result.supplierVatNumber || "—"} />
                  <Field label="Ref / Invoice #" value={result.vendorReference || "—"} />
                  <Field label="Date" value={result.date || "—"} />
                  <Field label="Subtotal" value={result.subtotal > 0 ? `SAR ${result.subtotal.toLocaleString("en-SA", { minimumFractionDigits: 2 })}` : "—"} />
                  <Field label="VAT (15%)" value={result.vatAmount > 0 ? `SAR ${result.vatAmount.toLocaleString("en-SA", { minimumFractionDigits: 2 })}` : "—"} />
                  <Field label="Total" value={result.total > 0 ? `SAR ${result.total.toLocaleString("en-SA", { minimumFractionDigits: 2 })}` : "—"} highlight />
                </div>
              </div>

              {/* raw text toggle */}
              <details className="rounded-lg border border-border overflow-hidden text-xs">
                <summary className="px-3 py-2 cursor-pointer text-muted-foreground hover:bg-secondary/30 select-none">
                  View raw OCR text
                </summary>
                <pre className="px-3 py-2 text-muted-foreground bg-secondary/20 whitespace-pre-wrap max-h-28 overflow-y-auto font-mono text-[11px]">
                  {result.rawText || "(no text extracted)"}
                </pre>
              </details>

              <div className="flex gap-3">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={reset}>
                  <RotateCcw className="w-3.5 h-3.5" /> Rescan
                </Button>
                <Button className="flex-1 gap-2" onClick={confirm}>
                  <CheckCircle2 className="w-4 h-4" /> Use these fields
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`font-medium tabular-nums truncate text-right ${highlight ? "text-primary" : "text-foreground"}`}>{value}</span>
    </div>
  );
}
