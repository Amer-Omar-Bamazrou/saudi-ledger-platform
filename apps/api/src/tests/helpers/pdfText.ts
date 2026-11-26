/**
 * 19B 19.15 — READ A RENDERED PDF BACK (tests only): its pages' text and where each piece of text sits, through
 * pdf.js. A check of the HTML a PDF was made from is a check of a different artifact; these tests read the file.
 *
 * What a PDF holds is glyphs at positions, not sentences (measured on the files themselves, 2026-11-26):
 *  - there are no spaces, only gaps — so text is compared with every space removed;
 *  - 🔴 Arabic sits in VISUAL order: the runs come left to right along the line, mostly one glyph each; a run of
 *    several glyphs (a ligature, a word's tail) holds its own letters in reading order. Each right-to-left run is
 *    therefore turned round, which makes the whole line visual, and an Arabic needle is looked for as it sits on the
 *    line — reversed — as well as as written.
 * `text` is every page's text in the file's order, Unicode-normalised (NFKC: presentation forms back to letters).
 * `xOf(needle, page)` is the left edge, in points, of the needle's leftmost glyph on that page — for layout checks
 * (which column is on which side). Keep Arabic needles free of punctuation and doubled letters (a shadda is its own
 * mark, placed above the line).
 */
type Item = { str: string; x: number; y: number; w: number; page: number };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
const tight = (s: string) => norm(s).replace(/ /g, "");
const reversed = (s: string) => [...s].reverse().join("");
const isArabic = (s: string) => [...s].some((c) => { const p = c.codePointAt(0)!; return p >= 0x600 && p <= 0x6ff; });
const forms = (needle: string) => (isArabic(needle) ? [tight(needle), reversed(tight(needle))] : [tight(needle)]);

export interface PdfRead {
  pages: number;
  pageText: string[];
  text: string;
  items: Item[];
  /** Each page's width in points. */
  widths: number[];
  /** The runs that start or end outside their page's width — text a reader of the printed page would not see. */
  offPage(): Item[];
  has(needle: string): boolean;
  count(needle: string): number;
  xOf(needle: string, page?: number): number | null;
}

export async function readPdf(buf: Buffer | Uint8Array): Promise<PdfRead> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const items: Item[] = [];
  const pageText: string[] = [];
  const widths: number[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    widths.push(page.getViewport({ scale: 1 }).width);
    const content = await page.getTextContent();
    const onPage: Item[] = [];
    for (const it of content.items as Array<{ str?: string; dir?: string; width?: number; transform?: number[] }>) {
      if (typeof it.str !== "string" || !it.transform || !it.str.trim()) continue;
      const str = tight(it.str);
      onPage.push({ str: it.dir === "rtl" ? reversed(str) : str, x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0, page: p });
    }
    items.push(...onPage);
    pageText.push(onPage.map((i) => i.str).join(" "));
  }
  const pages = doc.numPages;
  await doc.destroy();
  const text = pageText.join(" ");
  const textTight = tight(text);
  const has = (needle: string) => forms(needle).some((f) => textTight.includes(f));
  const count = (needle: string) => Math.max(...forms(needle).map((f) => textTight.split(f).length - 1));
  const xOf = (needle: string, page?: number) => {
    for (const p of page == null ? Array.from({ length: pages }, (_, i) => i + 1) : [page]) {
      const on = items.filter((i) => i.page === p);
      // the page's runs joined, with each character's run remembered
      const chars: string[] = [];
      const owner: number[] = [];
      on.forEach((it, idx) => { for (const c of it.str) { chars.push(c); owner.push(idx); } });
      for (const f of forms(needle)) {
        const want = [...f];
        for (let i = 0; i + want.length <= chars.length; i++) {
          if (want.every((c, k) => chars[i + k] === c)) return Math.min(...want.map((_, k) => on[owner[i + k]!]!.x));
        }
      }
    }
    return null;
  };
  const offPage = () => items.filter((i) => i.x < 0 || i.x + i.w > widths[i.page - 1]! + 0.5);
  return { pages, pageText, text, items, widths, offPage, has, count, xOf };
}
