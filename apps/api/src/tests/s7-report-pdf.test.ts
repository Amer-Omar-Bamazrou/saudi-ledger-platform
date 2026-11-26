/**
 * 🔴 19B 19.15 / 19.17 (control 19B-S7B) — PDF EXPORT OF BUILDER REPORTS, with the same per-role withholding as CSV.
 *
 * Owner, 2026-11-26: "Test the real rendered PDF, not only its HTML: sensitive fields absent, Arabic RTL, long tables
 * across pages, subtotals, an empty report."
 *
 * Every content check below reads the FILE the route sent (helpers/pdfText.ts, through pdf.js), never the HTML it was
 * made from:
 *  - the bank's own text is in the accountant's PDF and ABSENT from the viewer's, whose file marks the cell withheld and
 *    still carries the typed text (presence, absence and movement); a column a role may not read at all is not in the
 *    file, and the file names it;
 *  - in Arabic the page is right-to-left: the first column sits to the RIGHT of the last one (and to the left in
 *    English), the labels are Arabic and the figures keep Latin digits;
 *  - 130 lines run over several pages, none lost, the column header repeated on each;
 *  - a grouped report's subtotals and total are in the file, to the halala;
 *  - an empty report is a one-page file that says so.
 * And what does not need the renderer: the format is refused by name when unknown; a PDF above its row limit is refused
 * with the count; a refused export is recorded as a refusal and sends nothing; every PDF sent is in the audit trail.
 *
 * 🔴 Where no Chromium is installed (CI's API job) the route answers 503 `pdf_renderer_unavailable`; the content checks
 * then say so and stop — the same checks run in the browser suite (e2e/s7-report-pdf.spec.ts), which has one.
 * DB-backed; skips on the placeholder.
 */
process.env.PORT ??= "3248";
process.env.SESSION_SECRET ??= "s7-report-pdf-000000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, type PermissionRow } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __setDatasetRowLimitsForTests } from "../services/reporting/reportExport.service";
import { closeDocumentRenderer } from "../services/document/htmlToPdf";
import { g04Harness } from "./helpers/g04Harness";
import { readPdf, type PdfRead } from "./helpers/pdfText";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s7-report-pdf-password-2026-xx";
const h = g04Harness("s7pdf");
const WINDOW = "date_from=2026-10-01&date_to=2026-10-31";
const BANK_TEXT = "S7 BANK SARIE TRANSFER REF 7719";
const TYPED_TEXT = "S7 typed accrual";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const LONG = 130;
const without = (pred: (r: PermissionRow) => boolean) => PERMISSION_MATRIX.filter((r) => !pred(r));

describeDb("19B 19.15 — a builder report as a PDF", () => {
  let orgId = "";
  let rendererMissing = false;
  let saved = 0;
  const ok = (r: { status: number; text: string; body: any }, status = 200) => { expect(r.status, r.text).toBe(status); return r.body; };

  /** The PDF a role is sent, read back — or null where this machine has no renderer (said once, by name). */
  async function pdf(who: string, dataset: string, qs: string): Promise<PdfRead | null> {
    const r = await h.bytes(who, `/reports/datasets/${dataset}/export?format=pdf&${qs}`);
    if (r.status === 503) {
      expect(JSON.parse(r.buf.toString("utf8")).code).toBe("pdf_renderer_unavailable");
      rendererMissing = true;
      return null;
    }
    expect(r.status, r.buf.toString("utf8").slice(0, 400)).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename="[A-Za-z0-9._-]+\.pdf"/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // kept for a human to open, when asked for (S7_PDF_DIR): the files these checks read
    if (process.env.S7_PDF_DIR) writeFileSync(join(process.env.S7_PDF_DIR, `${who}_${dataset}_${++saved}.pdf`), r.buf);
    return readPdf(r.buf);
  }

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S7 PDF Co", "319898989898991");
    for (const role of ROLES) await h.mkUser(role, PW, orgId, role);
    for (const role of ROLES) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    const bank = ok(await h.api("admin", "POST", "/bank-accounts", { name: "S7 Ops", bankName: "SNB", currency: "SAR" }), 201);
    // October: a bank line (the bank's own text) and a typed entry
    ok(await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: bank.id }), 201);
    const typed = ok(await h.api("admin", "POST", "/journal-entries", { date: "2026-10-15", description: TYPED_TEXT, lines: [
      { accountId: await acct("RENT_UTILITIES"), accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
      { accountId: await acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
    ] }), 201);
    ok(await h.api("admin", "POST", `/journal-entries/${typed.id}/approve`, {}));
    // September: one entry of 130 lines — a table longer than a page
    const rent = await acct("RENT_UTILITIES");
    const accrued = await acct("ACCRUED_LIABILITIES");
    const lines = Array.from({ length: LONG }, (_, i) => {
      const n = String(i + 1).padStart(3, "0");
      return i % 2 === 0
        ? { accountId: rent, accountName: "Rent & Utilities", debitAmount: 1, creditAmount: 0, description: `S7LONG${n}` }
        : { accountId: accrued, accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 1, description: `S7LONG${n}` };
    });
    const long = ok(await h.api("admin", "POST", "/journal-entries", { date: "2026-09-15", description: "S7 long entry", lines }), 201);
    ok(await h.api("admin", "POST", `/journal-entries/${long.id}/approve`, {}));
    // October sales, for the subtotals
    const customers: Record<string, number> = {};
    for (const name of ["Alpha", "Beta"]) customers[name] = ok(await h.api("admin", "POST", "/customers", { name: `S7 ${name}` }), 201).id;
    for (const [customer, unitPrice] of [["Alpha", 1000], ["Alpha", 33.33], ["Beta", 400.2]] as const) {
      const d = ok(await h.api("admin", "POST", "/invoices", { date: "2026-10-05", dueDate: "2026-10-31", customerId: customers[customer], items: [{ description: "S7", quantity: 1, unitPrice, vatRate: 15 }] }), 201);
      ok(await h.api("admin", "POST", `/invoices/${d.id}/submit`));
      ok(await h.api("admin", "POST", `/invoices/${d.id}/approve`));
    }
  }, 240_000);
  afterAll(async () => {
    primePermissionCache(PERMISSION_MATRIX);
    __setDatasetRowLimitsForTests(null);
    await closeDocumentRenderer();
    await h.stop();
    await h.cleanup();
    if (rendererMissing) console.warn("[s7-report-pdf] no PDF renderer on this machine: the rendered-file checks did not run here (they run in e2e/s7-report-pdf.spec.ts)");
  });

  const LINES = "columns=date,entryNumber,textOrigin,description,debit,credit&sort=date";

  it("🔴 sensitive fields: the bank's text is in the accountant's PDF and absent from the viewer's, which marks it withheld and keeps the typed text", async () => {
    const acc = await pdf("accountant", "journal_lines", `${WINDOW}&${LINES}`);
    const view = await pdf("viewer", "journal_lines", `${WINDOW}&${LINES}`);
    if (!acc || !view) return;
    expect(acc.has(BANK_TEXT)).toBe(true);
    expect(acc.has("[withheld")).toBe(false);
    expect(view.has(BANK_TEXT)).toBe(false);
    expect(view.has("SARIE")).toBe(false);
    expect(view.has("7719")).toBe(false);
    expect(view.has("[withheld: bank text]")).toBe(true);
    for (const p of [acc, view]) expect(p.has(TYPED_TEXT)).toBe(true);
    expect(view.has("withheld for your role")).toBe(true);
  });

  it("🔴 a column a role may not read at all is not in the file — its header, its values — and the file names what is missing", async () => {
    // the bookkeeper without the bank-text grant: cash movements' text is bank text on every row
    primePermissionCache(without((r) => r.role === "bookkeeper" && r.resource === "transactions" && r.action === "field.bank_narrative.read"));
    try {
      const narrowed = await pdf("bookkeeper", "cash_movements", WINDOW);
      const full = await pdf("accountant", "cash_movements", WINDOW);
      if (!narrowed || !full) return;
      expect(full.has(BANK_TEXT)).toBe(true);
      expect(full.xOf("Bank text", 1)).not.toBeNull();
      expect(narrowed.has(BANK_TEXT)).toBe(false);
      expect(narrowed.has("SARIE")).toBe(false);
      expect(narrowed.has("absent from this file: Bank text (bank_narrative)")).toBe(true);
      // the header row has no such column (the note names it; the table does not)
      expect(narrowed.count("Bank text")).toBe(1);
      expect(narrowed.has("120.00")).toBe(true); // the amount is still there
    } finally {
      primePermissionCache(PERMISSION_MATRIX);
    }
  });

  it("🔴 Arabic is right-to-left on the page: the first column is to the RIGHT of the last (to the left in English); Arabic labels, Latin digits", async () => {
    const cols = "columns=date,entryNumber,debit&sort=date";
    const en = await pdf("accountant", "journal_lines", `${WINDOW}&${cols}&lang=en`);
    const ar = await pdf("accountant", "journal_lines", `${WINDOW}&${cols}&lang=ar`);
    if (!en || !ar) return;
    const [enFirst, enLast] = [en.xOf("Date", 1), en.xOf("Debit", 1)];
    const [arFirst, arLast] = [ar.xOf("التاريخ", 1), ar.xOf("مدين", 1)];
    expect([enFirst, enLast, arFirst, arLast].every((x) => x != null), `en ${enFirst} ${enLast} ar ${arFirst} ${arLast} — ${ar.pageText[0]!.slice(0, 300)}`).toBe(true);
    expect(enFirst!).toBeLessThan(enLast!);
    expect(arFirst!).toBeGreaterThan(arLast!);
    expect(ar.has("سطور القيود")).toBe(true); // the title
    expect(ar.has("S7 PDF Co")).toBe(true);
    expect(ar.has("Journal lines")).toBe(false);
    expect(ar.has("Debit")).toBe(false);
    // Latin digits (N-11): the date and the amount as written, and no Arabic-Indic digit anywhere
    expect(ar.has("2026-10-15")).toBe(true);
    expect(ar.has("50.00")).toBe(true);
    expect(/[٠-٩۰-۹]/.test(ar.text)).toBe(false);
  });

  it("🔴 a long table runs over several pages: every one of the 130 lines is there once, and each page repeats the column header", async () => {
    const p = await pdf("accountant", "journal_lines", "date_from=2026-09-01&date_to=2026-09-30&columns=date,entryNumber,description,debit,credit");
    if (!p) return;
    expect(p.pages).toBeGreaterThan(2);
    for (let i = 1; i <= LONG; i++) {
      const tag = `S7LONG${String(i).padStart(3, "0")}`;
      expect([tag, p.count(tag)]).toEqual([tag, 1]);
    }
    for (let page = 1; page <= p.pages; page++) expect([page, p.xOf("Line text", page) != null]).toEqual([page, true]);
  });

  it("🔴 nothing is cut off at the page's edge: with EVERY column shown, each dataset's PDF keeps every header and every cell inside the page, in both languages", async () => {
    const { DATASETS } = await import("../lib/reports/datasets");
    for (const [name, ds] of Object.entries(DATASETS)) {
      for (const lang of ["en", "ar"] as const) {
        const p = await pdf("accountant", name, `${WINDOW}&lang=${lang}`);
        if (!p) return;
        expect([name, lang, p.offPage().map((i) => `${i.str}@${Math.round(i.x)}`)]).toEqual([name, lang, []]);
        // every column's header is on the first page (words in a header may wrap; its first word is looked for)
        for (const c of ds.columns) {
          const first = (lang === "ar" ? c.labelAr : c.label).split(/[ (]/)[0]!;
          expect([name, lang, c.key, p.xOf(first, 1) != null]).toEqual([name, lang, c.key, true]);
        }
      }
    }
  });

  it("🔴 subtotals: a grouped report's PDF carries each group's subtotal and the total, to the halala — the same figures the run gives", async () => {
    const qs = `${WINDOW}&group=customerName&columns=customerName,documentNumber,signedTotal`;
    const run = ok(await h.api("accountant", "GET", `/reports/datasets/sales_documents/rows?${qs}`));
    const p = await pdf("accountant", "sales_documents", qs);
    if (!p) return;
    const money = (n: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    expect(run.groups.map((g: any) => [g.key, g.totals[0].total])).toEqual([["S7 Alpha", 1188.33], ["S7 Beta", 460.23]]);
    expect(p.has("Subtotal: S7 Alpha (2)")).toBe(true);
    expect(p.has("Subtotal: S7 Beta (1)")).toBe(true);
    expect(p.has("Total (3)")).toBe(true);
    for (const g of run.groups) expect([g.key, p.has(money(g.totals[0].total))]).toEqual([g.key, true]);
    expect(p.has(money(run.grandTotal.totals[0].total))).toBe(true);
    expect(run.grandTotal.totals[0].total).toBe(1648.56);
    expect(p.has("Grouped by Customer")).toBe(true);
    // journal lines: the file says there is no grand total, and carries none
    const jl = await pdf("accountant", "journal_lines", `${WINDOW}&group=accountId&columns=accountId,accountName,debit,credit`);
    expect(jl!.has("This report has no grand total")).toBe(true);
    expect(jl!.has("Total (")).toBe(false);
  });

  it("🔴 an empty report is a one-page file that says so, in the reader's language", async () => {
    const en = await pdf("accountant", "sales_documents", "date_from=2020-01-01&date_to=2020-01-31");
    const ar = await pdf("accountant", "sales_documents", "date_from=2020-01-01&date_to=2020-01-31&lang=ar&group=customerName");
    if (!en || !ar) return;
    expect([en.pages, ar.pages]).toEqual([1, 1]);
    expect(en.has("Sales documents")).toBe(true);
    expect(en.has("Nothing in this period.")).toBe(true);
    expect(ar.has("لا توجد بيانات في هذه الفترة")).toBe(true);
    expect(ar.has("Nothing in this period")).toBe(false);
    expect(en.has("2020-01-01")).toBe(true);
  });

  it("an Arabic file says yes and no in Arabic (a file's own words follow its language; a stored value stays as stored)", async () => {
    const cols = "columns=documentNumber,isOpening";
    const ar = await h.api("accountant", "GET", `/reports/datasets/sales_documents/export?${WINDOW}&${cols}&lang=ar`);
    const en = await h.api("accountant", "GET", `/reports/datasets/sales_documents/export?${WINDOW}&${cols}&lang=en`);
    expect([ar.status, en.status]).toEqual([200, 200]);
    const last = (text: string) => text.split(/\r?\n/).filter((l) => l.startsWith("INV-")).map((l) => l.split(",").pop());
    expect(last(en.text)).toEqual(["no", "no", "no"]);
    expect(last(ar.text)).toEqual(["لا", "لا", "لا"]);
  });

  it("🔴 the format is refused by name when unknown; a PDF above its row limit is refused WITH the count, and CSV still answers", async () => {
    const bad = await h.api("accountant", "GET", `/reports/datasets/sales_documents/export?${WINDOW}&format=xlsx`);
    expect([bad.status, bad.body.code]).toEqual([400, "report_bad_filter"]);
    __setDatasetRowLimitsForTests({ pdf: 2 });
    try {
      const big = await h.api("accountant", "GET", `/reports/datasets/sales_documents/export?${WINDOW}&format=pdf`);
      expect([big.status, big.body.code]).toEqual([422, "export_too_large"]);
      expect(big.body.error).toContain("would hold 3 rows; the limit is 2");
      expect(big.body.error).toContain("CSV");
      expect((await h.api("accountant", "GET", `/reports/datasets/sales_documents/export?${WINDOW}`)).status).toBe(200);
    } finally {
      __setDatasetRowLimitsForTests(null);
    }
  });

  it("🔴 a role that may not export is refused the PDF as it is the CSV — recorded as a refusal, never as an export; every PDF sent is in the audit trail", async () => {
    const exportsOf = async () => (await pool.query(`SELECT user_id, after_state AS after FROM audit_logs WHERE organization_id = $1 AND entity_type = 'report_dataset_export' ORDER BY created_at, seq`, [orgId])).rows;
    const refusals = async () => (await pool.query(`SELECT * FROM permission_refusal_events WHERE organization_id = $1 AND action = 'export' ORDER BY id`, [orgId])).rows;
    const [e0, r0] = [(await exportsOf()).length, (await refusals()).length];
    const viewer = await h.api("viewer", "GET", `/reports/datasets/cash_movements/export?${WINDOW}&format=pdf`);
    expect([viewer.status, viewer.body.code]).toEqual([403, "report_dataset_not_granted"]);
    expect((await refusals()).length).toBe(r0 + 1);
    expect((await exportsOf()).length).toBe(e0);
    const sent = await h.bytes("accountant", `/reports/datasets/sales_documents/export?${WINDOW}&format=pdf&lang=ar`);
    if (sent.status === 503) { rendererMissing = true; expect((await exportsOf()).length).toBe(e0); return; } // nothing sent, nothing recorded
    expect(sent.status).toBe(200);
    const after = await exportsOf();
    expect(after.length).toBe(e0 + 1);
    const last = after[after.length - 1]!.after;
    expect([last.format, last.lang, last.rows, /\.pdf$/.test(last.filename)]).toEqual(["pdf", "ar", 3, true]);
    expect(JSON.stringify(last)).not.toContain("S7 Alpha"); // names what was exported, never a value
  });
});
