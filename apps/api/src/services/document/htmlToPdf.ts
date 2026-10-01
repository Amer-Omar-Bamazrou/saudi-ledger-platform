/**
 * ONE Chromium for every document the platform renders (Phase 14, D14-10).
 *
 * Extracted from `invoiceDocument.service.ts` (L1), where it was the invoice's
 * private renderer, so the report exports reuse the same browser instead of
 * launching a second one. Unchanged behaviour: launched on first use, a fresh
 * page per document, and a failed launch is a NAMED 503 that says how to fix
 * it — never a generic 500, and never a poisoned promise that fails every
 * later request.
 */
import { chromium, type Browser } from "playwright-core";

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

/**
 * Render a self-contained HTML document to an A4 PDF. Pure: no DB access.
 * With no options this is EXACTLY the invoice's former call
 * (`{ format: "A4", printBackground: true }`) — margins and landscape are
 * opt-in, so extracting the browser changed no invoice byte.
 */
export async function htmlToPdf(html: string, opts: { landscape?: boolean; margin?: { top: string; bottom: string; left: string; right: string } } = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      ...(opts.landscape ? { landscape: true } : {}),
      ...(opts.margin ? { margin: opts.margin } : {}),
    });
  } finally {
    await page.close().catch(() => {});
  }
}
