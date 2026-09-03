/**
 * L1 — THE INVOICE LEAVES THE PRODUCT (launch blocker, found by the first
 * core-path walk: a simplified invoice's QR exists to be PRESENTED to the
 * customer, and no artifact could present it).
 *
 * Single writer for the decisions this implements:
 * `docs/product/design-invoice-document.md`. The short form:
 *
 *  - TWO DOCUMENTS (owner, 2026-09-03): the ARABIC PDF is the tax invoice —
 *    the legal artifact; the ENGLISH PDF is a labelled translation generated
 *    on demand and never stored. One template, parameterised by `lang`.
 *  - PDF/A-3B from the start, via the spike-proven two-stage pipeline:
 *    Chromium renders (the only engine that shapes Arabic correctly —
 *    HarfBuzz), pdf-lib attaches the signed XML and writes the PDF/A metadata.
 *  - The sentinel never prints; a missing translation no longer blocks.
 *  - Issued documents only: a draft has no QR, no ICV and no legal existence,
 *    and rendering it would be a stand-in that looks designed.
 *
 * ── The browser is a lazy singleton ────────────────────────────────────────
 * Launching Chromium costs ~½–1s; a browser per request would make every
 * download pay it. One browser, launched on first use, a fresh page per
 * render (pages are cheap and isolated). If the executable is missing the
 * refusal NAMES the remedy (`npx playwright install chromium`) — a refusal
 * that teaches the next step, not a hidden control.
 *
 * 🔴 C6a's shape, stated honestly rather than claimed solved: through the
 * HTTP path the request's tenant transaction IDLES while Chromium renders
 * (~1s, no DB and no external service — well inside the 15s guardrail). The
 * pipeline is still split so the render itself does ZERO DB work: every read
 * happens in `buildInvoiceDocModel`/`findSignedXml`, and `renderInvoicePdf`
 * is pure — which is what makes it trivially movable outside the transaction
 * (or into a worker) if renders ever get slow enough to matter.
 */
import { chromium, type Browser } from "playwright-core";
import QRCode from "qrcode";
import { invoicesRepository } from "../../repositories/invoices.repository";
import { customersRepository } from "../../repositories/customers.repository";
import { companiesRepository } from "../../repositories/companies.repository";
import { bankAccountsRepository } from "../../repositories/bankAccounts.repository";
import { einvoiceDocumentsRepository } from "../../repositories/einvoiceDocuments.repository";
import { NotFoundError, ConflictError } from "../../lib/errors";
import { dayNumberFromIso, toHijri } from "../../lib/hijriCalendar";
import { renderInvoiceHtml, type InvoiceDocModel, type DocLine } from "./renderInvoiceHtml";
import { documentTitle, type DocLang } from "./labels";
import { toPdfA3 } from "./pdfa3";

export class RendererUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "pdf_renderer_unavailable";
  constructor(cause: string) {
    super(
      `The PDF renderer is unavailable: ${cause}. ` +
        `The document service needs a Chromium executable — install one with \`npx playwright install chromium\` ` +
        `(deployment: the ~150 MB Chromium image layer is a C6 hosting line).`,
    );
    this.name = "RendererUnavailableError";
  }
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch().catch((err) => {
      browserPromise = null; // a failed launch must not poison every later request
      throw new RendererUnavailableError(err instanceof Error ? err.message.split("\n")[0] : String(err));
    });
  }
  return browserPromise;
}

/** Test seam + graceful shutdown. */
export async function closeDocumentRenderer(): Promise<void> {
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

function partyAddress(p: {
  street?: string | null;
  buildingNumber?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
}): string | null {
  const parts = [p.buildingNumber, p.street, p.district, p.city, p.postalCode].filter(
    (x): x is string => !!x && !!x.trim(),
  );
  return parts.length ? parts.join("، ") : null;
}

const hijriOf = (iso: string): string => {
  const h = toHijri(dayNumberFromIso(iso));
  return `${h.year}-${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")} هـ`;
};

/**
 * Assemble the model — every DB read, so the controller can run this inside
 * the request's tenant transaction and the render outside it.
 */
export async function buildInvoiceDocModel(invoiceId: number, lang: DocLang): Promise<InvoiceDocModel> {
  const [inv] = await invoicesRepository.findById(invoiceId);
  if (!inv) throw new NotFoundError("Not found");
  if (inv.status === "draft" || inv.status === "submitted") {
    throw new ConflictError(
      "Only an issued document can be rendered — a draft has no QR and no legal existence yet. Approve the invoice first.",
    );
  }

  const items = await invoicesRepository.itemsByInvoice(invoiceId);
  const company = await companiesRepository.findCurrent();
  const customer = inv.customerId != null ? (await customersRepository.findById(inv.customerId))[0] : undefined;
  const banks = inv.documentType === "invoice" ? await bankAccountsRepository.list() : [];
  const defaultBank = banks.find((b) => b.isDefault) ?? null;
  const original =
    inv.originalInvoiceId != null ? (await invoicesRepository.findById(inv.originalInvoiceId))[0] : undefined;

  const lines: DocLine[] = items.map((it) => ({
    productCode: null,
    description: it.description,
    descriptionAr: it.descriptionAr,
    quantity: String(it.quantity),
    unitPrice: String(it.unitPrice),
    vatRate: String(it.vatRate ?? "15"),
    vatAmount: String(it.vatAmount ?? "0"),
    total: String(it.total ?? "0"),
  }));

  const qrDataUrl = inv.qrCode ? await QRCode.toDataURL(inv.qrCode, { margin: 1, width: 280 }) : null;

  return {
    lang,
    documentType: inv.documentType,
    invoiceNumber: inv.invoiceNumber,
    originalInvoiceNumber: original?.invoiceNumber ?? null,
    dateGregorian: inv.date,
    dateHijri: hijriOf(inv.date),
    dueDate: inv.dueDate || null,
    seller: {
      // The issued document's seller identity is the SNAPSHOT stamped at
      // approval (schema/invoices.ts:58 — a company rename must not mutate an
      // already-stamped artifact); the live company fills what the snapshot
      // does not carry.
      name: inv.sellerName ?? company?.name ?? "",
      nameAr: company?.nameAr ?? null,
      vatNumber: inv.sellerVatNumber ?? company?.vatNumber ?? null,
      crNumber: company?.crNumber ?? null,
      address: company ? partyAddress(company) : null,
    },
    buyer: customer
      ? {
          name: customer.name,
          nameAr: customer.nameAr,
          vatNumber: customer.taxNumber,
          crNumber: customer.crNumber ?? null,
          address: partyAddress(customer),
        }
      : null,
    lines,
    subtotal: String(inv.subtotal),
    vatAmount: String(inv.vatAmount),
    total: String(inv.total),
    paidAmount: String(inv.paidAmount ?? "0"),
    qrDataUrl,
    logoDataUrl: null, // level-1 logo: upload lands with the settings UI; absent = registered name alone (no fallback mark)
    termsAndConditions: inv.termsAndConditions ?? null,
    bankDetails: defaultBank
      ? { bankName: defaultBank.bankName ?? defaultBank.name, iban: defaultBank.iban ?? "", accountName: defaultBank.name }
      : null,
    noteReason: inv.noteReason ?? null,
  };
}

/** The signed-XML attachment, when the invoice has a ZATCA document. Read
 *  inside the tenant transaction alongside the model. */
export async function findSignedXml(invoiceId: number): Promise<{ fileName: string; content: Buffer; description: string } | undefined> {
  const doc = await einvoiceDocumentsRepository.findByInvoice(invoiceId);
  const xml = doc?.clearedXml ?? doc?.signedXml;
  if (!xml) return undefined;
  return {
    fileName: "invoice.xml",
    content: Buffer.from(xml, "utf8"),
    description: "ZATCA e-invoice XML",
  };
}

/** Pure pipeline: model → HTML → Chromium PDF → PDF/A-3B. No DB access — run
 *  it OUTSIDE the tenant transaction. */
export async function renderInvoicePdf(
  model: InvoiceDocModel,
  attachXml?: { fileName: string; content: Buffer; description: string },
): Promise<Uint8Array> {
  const html = renderInvoiceHtml(model);
  const browser = await getBrowser();
  const page = await browser.newPage();
  let pdf: Buffer;
  try {
    await page.setContent(html, { waitUntil: "load" });
    pdf = await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await page.close().catch(() => {});
  }
  const title = `${documentTitle(model.lang, model.documentType, !!model.buyer?.vatNumber)} ${model.invoiceNumber}`;
  return toPdfA3(pdf, { title, attachXml });
}
