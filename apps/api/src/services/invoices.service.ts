/**
 * Invoices service — the draft/approval workflow (M10.4).
 *
 * The single most important correctness property: **the ZATCA hash chain and
 * the AR GL posting are deferred to approval** (`invoiceApprovable().onApprove`),
 * NOT done at create. A draft/submitted invoice carries a null `invoice_hash`,
 * so it consumes no sequence number and a rejected/deleted draft never leaves a
 * gap in the legally-required chain.
 *
 * `create` therefore only computes totals and persists a DRAFT. An approver
 * (admin/accountant) **self-approves on create** — the controller passes
 * `autoApprove` (from the RBAC matrix), so their invoices post + hash + issue
 * immediately in one call, exactly as before M10. A bookkeeper's create stays a
 * draft awaiting approval.
 *
 * The draft→submitted→approved transitions and the on-approve activation are the
 * generic {@link approvalService} + {@link invoiceApprovable} adapter — the same
 * engine journal entries and bills use.
 */
import { ConflictError, NotFoundError, BadRequestError, BusinessRuleError } from "../lib/errors";
import { pick, assertAmount, assertRate, assertDateString, assertTaxCategoryCode } from "../lib/writeGuards";
import { assertNoteIsValid, isNoteType } from "./creditNotes";
import { auditService } from "./audit.service";
import { postJournalEntry } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { approvalService } from "./approval";
import { invoiceApprovable } from "./invoices.approvable";
import { resolveDraftSeller } from "./sellerIdentity";
import { buildInvoiceOut } from "./invoices.presenter";
import { invoicesRepository, DEFAULT_PAGE, type InvoiceListFilter } from "../repositories/invoices.repository";
import { paymentsRepository } from "../repositories/payments.repository";
import { customersRepository } from "../repositories/customers.repository";
import { round2 } from "../lib/money";

/**
 * MED (audit 2026-08-20): a nonexistent customerId surfaced as a raw 500
 * (FK 23503) — and worse, Postgres runs FK checks OUTSIDE RLS, so another
 * tenant's customer id was ACCEPTED by the database (a cross-tenant reference
 * and an existence oracle). The tenant-scoped lookup closes both at once:
 * under RLS a missing id and another tenant's id are the same fact, and both
 * get the same 422 — semantically invalid input that passed schema validation
 * (status policy, 2026-08-23).
 */
async function assertCustomerExists(customerId: unknown): Promise<void> {
  if (customerId == null) return;
  const [c] = await customersRepository.findById(Number(customerId));
  if (!c) {
    throw new BusinessRuleError(422, {
      error: `Customer ${customerId} does not exist for this organization.`,
      code: "reference_not_found",
      field: "customerId",
    });
  }
}

// Seller identity comes from the ACTIVE COMPANY (services/sellerIdentity.ts).
// The former DEFAULT_SELLER_* constants were a ZATCA SANDBOX placeholder,
// duplicated here and in invoices.approvable.ts — see sellerIdentity.ts.

/** Money rounds at the boundary; the SQL sums are float8. */

export const invoicesService = {
  /**
   * A PAGE of invoices, plus the totals for the whole filtered set.
   *
   * 🔴 The envelope is the point. Returning a bare array made the page's own
   * `reduce` the only available total, which is correct exactly while the list
   * is unbounded and silently wrong the moment it is not — the B-6 trade in
   * reverse. `totals` is computed in SQL over every matching row, so the
   * headline figures do not change when the reader turns the page.
   */
  async list(filter: InvoiceListFilter) {
    const [rows, meta] = await Promise.all([
      invoicesRepository.list(filter),
      invoicesRepository.listMeta(filter),
    ]);
    return {
      items: rows.map((r) => buildInvoiceOut(r.inv, r.cust)),
      page: {
        limit: filter.limit ?? DEFAULT_PAGE,
        offset: filter.offset ?? 0,
        total: meta.total,
      },
      totals: {
        outstanding: round2(meta.outstanding),
        collected: round2(meta.collected),
        overdue: meta.overdue,
      },
    };
  },

  async getById(id: number) {
    const [row] = await invoicesRepository.findWithCustomer(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await invoicesRepository.itemsByInvoice(id);
    return buildInvoiceOut(row.inv, row.cust, items);
  },

  /**
   * Create an invoice as a DRAFT (no hash, no QR, no GL). When `autoApprove` is
   * set (caller may approve — admin/accountant), immediately approve it so it is
   * issued in one call, preserving pre-M10 behavior for approvers.
   */
  async create(body: Record<string, any>, userId: number | null) {
    const { items = [] } = body;

    /**
     * 🔴 AN INVOICE WITH NO LINES IS NOT AN INVOICE.
     *
     * Found 2026-08-28 by sweeping the payload-shape class: `POST /invoices`
     * with `items: []` returned **201**, and because an approver's own invoice
     * is auto-approved it was ISSUED at zero — an ICV consumed, a position taken
     * in the ZATCA hash chain, a QR minted, for SAR 0.00. None of that is
     * recoverable: an issued invoice cannot be deleted, and `PATCH` had no
     * caller to add lines afterwards even if it could.
     *
     * 🔴 The asymmetry is the tell: quotations and purchase orders — which touch
     * NO ledger — already refused this ("A quotation needs at least one line"),
     * while invoices and bills, which do, did not. The guard was written where
     * the consequence was smallest.
     *
     * Enforced HERE, at the write boundary, rather than in the form that
     * happened to be wrong: `Invoices.tsx` hardcoded `items: []` on every
     * create, and a rule that lives in one caller is a rule the next caller
     * does not have (§4).
     */
    if (!Array.isArray(items) || items.length === 0) {
      throw new BusinessRuleError(400, {
        error:
          "An invoice needs at least one line. A zero-line invoice is issued at SAR 0.00 and, " +
          "once issued, cannot be corrected or deleted.",
        code: "invoice_has_no_lines",
        field: "items",
      });
    }
    // 🔴 H1 — ALLOWLIST the header. Totals are computed below; status is forced
    // to "draft"; hash/QR/ICV/ZATCA identity are minted at approval. A client
    // may set only descriptive fields and the note references (validated below).
    const invData = pick<Record<string, unknown>>(body, [
      "invoiceNumber", "date", "dueDate", "customerId", "currency", "discount",
      "notes", "termsAndConditions", "sellerName", "sellerVatNumber",
      "documentType", "originalInvoiceId", "noteReason",
    ]) as Record<string, any>;
    // 🔴 H2 — item amounts validated: NaN/negative quantities and unit prices,
    // and out-of-range VAT rates, no longer reach the numeric columns (or the
    // GL, for an auto-approving admin). DB CHECK 0049 is the backstop.
    (items as any[]).forEach((it, i) => {
      assertAmount(it.quantity, `item ${i + 1} quantity`, { min: 0, allowZero: true });
      assertAmount(it.unitPrice, `item ${i + 1} unit price`, { min: 0, allowZero: true });
      if (it.discount != null) assertAmount(it.discount, `item ${i + 1} discount`, { min: 0, allowZero: true });
      if (it.vatRate != null) assertRate(it.vatRate, `item ${i + 1} VAT rate`);
      // MED (audit 2026-08-20): the column the VAT return files from took any
      // string. Named 400 here; DB CHECK 0056 is the backstop.
      assertTaxCategoryCode(it.taxCategoryCode, `item ${i + 1} taxCategoryCode`);
    });
    if (invData.date != null) assertDateString(invData.date, "date");
    if (invData.dueDate != null) assertDateString(invData.dueDate, "dueDate");
    await assertCustomerExists(invData.customerId);
    // ── Audit fix (Tier 1, finding 2): HEADER = Σ ROUNDED LINES, exactly. ──
    // Pre-fix, per-line VAT was stored ROUNDED while the header accumulated the
    // UNROUNDED values and rounded once at the end — so header VAT could differ
    // from the sum of the line VATs by a halala (3 × base 10.03 @15%: lines
    // 1.50+1.50+1.50 = 4.50, header round(4.5135) = 4.51). Two consumers break
    // on that divergence: the UBL assembler mixes the header (TaxTotal) with
    // the lines (TaxSubtotals) in ONE document, violating EN 16931 BR-CO-14 —
    // ZATCA rejects it at submission; and GL posting writes Dr AR (total) vs
    // Cr subtotal + Cr VAT as three INDEPENDENTLY rounded figures against a
    // 0.005 balance tolerance, so a legitimate mixed-rate invoice could throw
    // "GL entry does not balance" (finding 7). Rounding each line FIRST and
    // summing the rounded values makes header = Σ lines by construction.
    let subtotal = 0;
    let vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const lineTotal = Number(it.quantity) * Number(it.unitPrice);
      const disc = Number(it.discount ?? 0);
      const base = round2(lineTotal - disc);
      const vatRate = Number(it.vatRate ?? 15);
      const vat = round2(base * (vatRate / 100));
      subtotal = round2(subtotal + base);
      vatTotal = round2(vatTotal + vat);
      return {
        ...it,
        quantity: String(it.quantity),
        unitPrice: String(it.unitPrice),
        vatAmount: vat.toFixed(2),
        total: round2(base + vat).toFixed(2),
        // 🔴 M12.8: stamp the ZATCA tax category at CREATE.
        //
        // `tax_category_code` was added in M12.1a and, until now, was written by
        // NOTHING — the column existed, the migration back-filled history, and
        // the write path never set it. So every invoice created through the API
        // carried NULL, and `assembleEInvoiceInput` fails closed on a NULL
        // category. For an onboarded company that meant EVERY invoice was
        // unissuable. Invisible until issuance was actually connected to real
        // ledger rows, because fixtures supply the category by hand.
        //
        // The rule is the migration's, deliberately: a positive VAT rate is
        // unambiguously STANDARD ('S'); a ZERO rate is genuinely ambiguous
        // between zero-rated (Z), exempt (E) and out-of-scope (O) — different
        // tax treatments the amount cannot distinguish. So 0% is left NULL for
        // the caller to state explicitly, and issuance demands an answer rather
        // than guessing a tax fact. An explicit code from the caller always wins.
        taxCategoryCode: it.taxCategoryCode ?? (vatRate > 0 ? "S" : null),
      };
    });
    // Exact by construction: subtotal and vatTotal are sums of 2dp values, so
    // total = subtotal + vat − discount holds to the halala and the GL entry
    // posted at approval balances exactly. (A nonzero header-level discount is
    // NOT posted as a GL line today — pre-existing, unchanged here.)
    const total = round2(subtotal + vatTotal - Number(invData.discount ?? 0));

    // ── C12: the number is allocated SERVER-SIDE ─────────────────────────
    // 🔴 It used to arrive from the browser as `INV-${Date.now().slice(-6)}`,
    // a truncated millisecond clock with no unique constraint behind it — on a
    // value that becomes the ZATCA document's `cbc:ID` and the
    // `BillingReference` a credit note uses to name what it corrects.
    //
    // VAT IR Art. 53(5)(b) requires "a sequential number which uniquely
    // identifies the Tax Invoice". A clock reading is neither.
    //
    // A caller-supplied number is still honoured — a tenant migrating legacy
    // books has its own series, and refusing that would make import
    // impossible — but it is no longer the default, and
    // `UNIQUE (company_id, invoice_number)` now judges every one of them.
    if (!String(invData.invoiceNumber ?? "").trim()) {
      invData.invoiceNumber = await invoicesRepository.allocateInvoiceNumber(invData.date);
    }

    // A draft dated in a closed period is harmless (no ledger effect), but keep
    // the early guard so drafts aren't entered into closed periods.
    //
    // NOTE (M12.1b): this checks the NOTE's OWN date. A note correcting an
    // invoice from a CLOSED period is legitimate and must not be blocked — the
    // correction posts in the current open period, which is standard practice.
    // The consequence is that the closed period's VAT return does not change;
    // the adjustment lands in the note's period.
    await checkPeriodOpen(invData.date ?? new Date().toISOString().split("T")[0]);

    // Credit/debit notes: validate the reference, the reason and the credit
    // ceiling before anything is written.
    if (isNoteType(invData.documentType)) {
      await assertNoteIsValid({
        documentType: invData.documentType,
        originalInvoiceId: invData.originalInvoiceId,
        noteReason: invData.noteReason,
        total,
      });
    } else if (invData.originalInvoiceId || invData.noteReason) {
      // The DB CHECK would reject this anyway; a named 400 beats a raw 500.
      throw new BusinessRuleError(400, {
        code: "note_fields_on_invoice",
        error: "Only a credit or debit note may carry an original invoice reference or a note reason.",
      });
    }

    // Persist a DRAFT — deliberately NO invoiceHash/previousHash/qrCode and NO GL
    // posting here; those are minted only at approval. Seller identity is
    // captured now (denormalized for the QR built at approval).
    // Stamp the seller from the active company (an explicit per-invoice override
    // still wins). Lenient here — a draft is not a legal document; issuance
    // (approval) is where a missing VAT number fails closed.
    const draftSeller = await resolveDraftSeller({
      sellerName: invData.sellerName,
      sellerVatNumber: invData.sellerVatNumber,
    });

    const [inv] = await invoicesRepository.insert({
      ...invData,
      subtotal: String(subtotal.toFixed(2)),
      vatAmount: String(vatTotal.toFixed(2)),
      total: String(total.toFixed(2)),
      status: "draft",
      createdBy: userId ?? null,
      sellerName: draftSeller.sellerName,
      sellerVatNumber: draftSeller.sellerVatNumber,
    } as Parameters<typeof invoicesRepository.insert>[0]);

    if (preparedItems.length > 0) {
      await invoicesRepository.insertItems(preparedItems.map((it: any) => ({ ...it, invoiceId: inv.id })));
    }

    await auditService.created("invoice", inv.id, inv);

    // Self-approve on create for approvers → issue immediately (hash + QR + GL).
    return buildInvoiceOut(inv, null);
  },

  /** Submit a draft invoice into the approval queue (bookkeeper action). */
  submit(id: number, userId: number | null) {
    return approvalService.submit(invoiceApprovable(), id, { userId: userId ?? null });
  },

  /** Send a submitted invoice back to the enterer for correction (approver action). */
  sendBack(id: number, note: string | undefined, userId: number | null) {
    return approvalService.sendBack(invoiceApprovable(), id, { userId: userId ?? null }, note);
  },

  /** Reject (hard-delete) a non-approved invoice (approver action). */
  reject(id: number, userId: number | null) {
    return approvalService.reject(invoiceApprovable(), id, { userId: userId ?? null });
  },

  /** Approve an invoice — issues it (hash chain + QR + AR GL posting). */
  approve(id: number, userId: number | null) {
    return approvalService.approve(invoiceApprovable(), id, { userId: userId ?? null });
  },

  async update(id: number, data: Record<string, unknown>) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft invoices can be edited. Use a credit note to correct an issued invoice.");
    }
    // 🔴 H1 — ALLOWLIST. The raw spread here was the worst finding of the
    // 2026-08-20 audit: a draft PATCHed with {status:"sent", invoiceHash, icv}
    // became an "issued" invoice that never posted to the GL, and because the
    // chain head is ordered by `icv DESC`, a forged high ICV could become the
    // predecessor the next real approval links to. Only descriptive header
    // fields are editable on a draft; status, totals, hash/QR/ICV, ZATCA
    // identity and paid state are minted by approval/pay and NEVER by a client.
    const values = pick<typeof import("@workspace/db").invoicesTable.$inferInsert>(data, [
      "invoiceNumber", "date", "dueDate", "customerId", "currency",
      "notes", "termsAndConditions", "reviewNote", "sellerName", "sellerVatNumber",
    ]);
    if (values.date !== undefined) {
      assertDateString(values.date, "date");
      // 🔴 Owner policy (2026-08-23): an invoice must not be DATED into a
      // closed month — the close means the month's figures (revenue, output
      // VAT) are final, and Saudi VAT files per period, so a backdated
      // document makes a filed return wrong. create refused this and PATCH
      // did not — the same invariant disagreeing across two write paths. The
      // guard honours document.date (the accounting date every report and
      // the VAT return read); issued_at is the ZATCA timestamp, a different
      // fact. Approval re-checks (invoices.approvable), so the ledger was
      // never exposed; this closes the draft-dating asymmetry.
      await checkPeriodOpen(values.date);
    }
    if (values.dueDate != null) assertDateString(values.dueDate, "dueDate");
    await assertCustomerExists(values.customerId);

    /**
     * 🔴 Line replacement (contract batch 3). The edit dialog had sent `items`
     * on every save since M10 and this method never read them: a user edited a
     * draft's lines, got a 200, and the lines were unchanged — the inert-write
     * shape (B-9) on the one document type where the lines ARE the money.
     * Drafts move nothing in any report, so replacing the set is safe; totals
     * are recomputed from the lines the way create does it, and the same
     * "at least one line" rule applies (a zero-line draft would issue at 0.00).
     */
    const items = (data as { items?: unknown }).items;
    let totals: Partial<typeof import("@workspace/db").invoicesTable.$inferInsert> = {};
    let prepared: Record<string, unknown>[] | null = null;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new BusinessRuleError(400, {
          error: "An invoice needs at least one line. A zero-line invoice is issued at SAR 0.00 and, once issued, cannot be corrected or deleted.",
          code: "invoice_has_no_lines",
          field: "items",
        });
      }
      let subtotal = 0;
      let vatTotal = 0;
      prepared = (items as any[]).map((it, i) => {
        assertAmount(it.quantity, `item ${i + 1} quantity`, { min: 0, allowZero: true });
        assertAmount(it.unitPrice, `item ${i + 1} unit price`, { min: 0, allowZero: true });
        if (it.discount != null) assertAmount(it.discount, `item ${i + 1} discount`, { min: 0, allowZero: true });
        if (it.vatRate != null) assertRate(it.vatRate, `item ${i + 1} VAT rate`);
        assertTaxCategoryCode(it.taxCategoryCode, `item ${i + 1} taxCategoryCode`);
        const base = round2(Number(it.quantity) * Number(it.unitPrice) - Number(it.discount ?? 0));
        const vatRate = Number(it.vatRate ?? 15);
        const vat = round2(base * (vatRate / 100));
        subtotal = round2(subtotal + base);
        vatTotal = round2(vatTotal + vat);
        return {
          ...it,
          quantity: String(it.quantity),
          unitPrice: String(it.unitPrice),
          vatAmount: vat.toFixed(2),
          total: round2(base + vat).toFixed(2),
          taxCategoryCode: it.taxCategoryCode ?? (vatRate > 0 ? "S" : null),
        };
      });
      const total = round2(subtotal + vatTotal - Number(existing.discount ?? 0));
      totals = { subtotal: subtotal.toFixed(2), vatAmount: vatTotal.toFixed(2), total: total.toFixed(2) };
    }

    const [inv] = await invoicesRepository.update(id, { ...values, ...totals });
    if (prepared) {
      await invoicesRepository.deleteItems(id);
      await invoicesRepository.insertItems(prepared.map((it) => ({ ...it, invoiceId: id })) as Parameters<typeof invoicesRepository.insertItems>[0]);
    }
    await auditService.updated("invoice", id, existing, inv);
    return buildInvoiceOut(inv, null, prepared ? await invoicesRepository.itemsByInvoice(id) : undefined);
  },

  async pay(id: number, body: { amount: unknown; paidAt?: string }, userId: number | null) {
    const { amount, paidAt } = body;

    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");

    // Only an issued (approved) invoice has a receivable to settle.
    if (existing.status === "draft" || existing.status === "submitted") {
      throw new ConflictError("Invoice must be approved before a payment can be recorded.");
    }
    if (existing.status === "paid") throw new ConflictError("Invoice is already paid.");

    // Validate up front — a missing/non-numeric amount previously reached the
    // numeric column and surfaced as an unhandled 500.
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      throw new BadRequestError("A positive payment amount is required.");
    }

    // ── M16.3: real partial-payment semantics ─────────────────────────────
    // Payments ACCUMULATE against the outstanding balance (total - paid so
    // far). Pre-M16.3 this overwrote paidAmount and flipped status to "paid"
    // whatever the amount — so a partial payment vanished from AR aging
    // (which skips status='paid') while balance-sheet AR still carried the
    // residual: exactly the aging-vs-balance-sheet drift the M12.1b note
    // warns about. Now a partial keeps the invoice open; "paid" means paid.
    // Overpaying the outstanding balance is refused — same posture as the
    // over-crediting guard on credit notes.
    const alreadyPaid = Number(existing.paidAmount ?? 0);
    // Audit Tier 3 (finding 6): the outstanding balance is CREDIT-AWARE. An
    // invoice with an approved credit note is settled by `total − credited`;
    // computing outstanding as `total − paid` meant such an invoice could
    // never reach `paid` (the correct payment registered as a partial forever)
    // and the overpay guard demanded money the customer does not owe.
    const credited = (await invoicesRepository.notesAgainst(id, "credit_note")).reduce(
      (s, n) => s + Number(n.total),
      0,
    );
    const outstanding = Math.round((Number(existing.total) - credited - alreadyPaid) * 100) / 100;
    if (paid > outstanding + 0.005) {
      throw new ConflictError(
        `Payment of ${paid.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)} on this invoice.`,
      );
    }
    const newPaid = Math.round((alreadyPaid + paid) * 100) / 100;
    const fullySettled = outstanding - paid < 0.01;

    const payDate = paidAt ?? new Date().toISOString().split("T")[0];
    const [inv] = await invoicesRepository.update(id, {
      paidAmount: String(newPaid),
      paidAt: payDate,
      status: fullySettled ? "paid" : existing.status,
    });

    // ── GL: Dr Cash and Bank / Cr Accounts Receivable ──
    await postJournalEntry({
      entryNumber: `GL-${inv.invoiceNumber}-PAY`,
      date: payDate,
      description: `Payment received for invoice ${inv.invoiceNumber}`,
      reference: inv.invoiceNumber,
      lines: [
        { systemCode: "CASH", accountName: "Cash and Bank", description: `Receipt for ${inv.invoiceNumber}`, debitAmount: paid, creditAmount: 0 },
        { systemCode: "AR", accountName: "Accounts Receivable", description: `Receipt for ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: paid },
      ],
    });

    // B4 — the dated record of THIS payment. `paid_amount` is a running total
    // and `paid_at` only ever holds the last date, so without this row a
    // second instalment permanently destroys the first one's date.
    await paymentsRepository.recordInvoicePayment(id, paid, payDate);

    await auditService.record({ action: "pay", entityType: "invoice", entityId: id, before: existing, after: inv });
    return buildInvoiceOut(inv, null);
  },

  /** B4 — the payment history, newest first. Backfilled rows are aggregates. */
  async payments(id: number) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    return (await paymentsRepository.listForInvoice(id)).map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidAt: p.paidAt,
      backfilled: p.backfilled,
    }));
  },

  /**
   * 🔴 Named `deleteDraft`, not `remove`, because that is what it does.
   *
   * The route is `DELETE /<resource>/:id` — correct, it addresses the resource —
   * but the verb implies a delete that mostly is NOT one: an issued invoice
   * cannot be deleted at all, and the refusal ("Issued invoices must be
   * reversed with a credit note") is the normal case rather than the edge. A
   * service method called `remove` invites a caller to believe otherwise. The
   * name now states the precondition the body enforces, so a reader sees it
   * before reaching the guard.
   */
  async deleteDraft(id: number) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft invoices can be deleted. Issued invoices must be reversed with a credit note.");
    }
    await invoicesRepository.remove(id);
    await auditService.deleted("invoice", id, existing);
  },
};
