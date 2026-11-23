/**
 * 🔴 19B S2b (v4 §11, D9 (b) = B2) — THE INVOICE PDF, DOWNLOADED OR REFUSED IN WORDS.
 *
 * A signed tax document is not altered per reader: a role without a class the PDF carries (the buyer's address; the
 * buyer's national ID on an education or healthcare invoice) is refused it by name — 403 `document_field_withheld`.
 * A plain download link would save that refusal as a broken file, so this link downloads through the app's own seam
 * (`apiDownload`) and, on a refusal, SAYS so — the server's own sentence, in the reader's language — instead of
 * hiding the control (§3: explain a refusal; key the UI on the structured code). The invoice itself stays in the app.
 * The `href` stays, so the link is still a link (open in a new tab, a screen reader); the server is the boundary.
 */
import type { ReactNode } from "react";
import { ApiError, apiDownload } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";

export function InvoiceDocumentLink({ invoiceId, lang, className, title, testId, children }: {
  invoiceId: number; lang: "ar" | "en"; className?: string; title?: string; testId?: string; children: ReactNode;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const path = `/invoices/${invoiceId}/document?lang=${lang}`;
  return (
    <a
      href={`/api${path}`}
      download
      className={className}
      title={title}
      data-testid={testId}
      onClick={async (e) => {
        e.preventDefault();
        try {
          await apiDownload(path, `invoice-${invoiceId}-${lang}.pdf`);
        } catch (err) {
          const withheld = err instanceof ApiError && err.code === "document_field_withheld";
          toast({
            title: withheld ? t("This PDF is not available to your role", "ملف PDF هذا غير متاح لدورك") : t("The PDF was not downloaded", "لم يتم تنزيل ملف PDF"),
            description: (err as Error).message,
            variant: withheld ? undefined : "destructive",
          });
        }
      }}
    >
      {children}
    </a>
  );
}
