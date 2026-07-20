import { Router } from "express";
import { db } from "@workspace/db";
import { billsTable, billItemsTable, vendorsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { postJournalEntry } from "../lib/glPosting";
import { checkPeriodOpen } from "../lib/periodLock";
import { handleRouteError } from "../lib/routeError";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

async function buildBillOut(bill: typeof billsTable.$inferSelect, vendor?: typeof vendorsTable.$inferSelect | null, items?: typeof billItemsTable.$inferSelect[]) {
  return {
    id: bill.id, billNumber: bill.billNumber, vendorReference: bill.vendorReference,
    date: bill.date, dueDate: bill.dueDate, vendorId: bill.vendorId, vendorName: vendor?.name ?? null,
    status: bill.status, subtotal: toNum(bill.subtotal), vatAmount: toNum(bill.vatAmount),
    total: toNum(bill.total), currency: bill.currency, paidAmount: toNum(bill.paidAmount),
    paidAt: bill.paidAt, notes: bill.notes, createdAt: bill.createdAt.toISOString(),
    items: items?.map(it => ({
      id: it.id, billId: it.billId, productId: it.productId,
      description: it.description, descriptionAr: it.descriptionAr,
      quantity: toNum(it.quantity), unitPrice: toNum(it.unitPrice),
      vatRate: toNum(it.vatRate), vatAmount: toNum(it.vatAmount), total: toNum(it.total),
    })) ?? [],
  };
}

router.get("/", async (req, res) => {
  try {
    const { status, vendor_id } = req.query as Record<string, string>;
    const conditions = [];
    if (status) conditions.push(eq(billsTable.status, status));
    if (vendor_id) conditions.push(eq(billsTable.vendorId, Number(vendor_id)));
    const rows = await db.select({ bill: billsTable, vendor: vendorsTable }).from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(billsTable.date), desc(billsTable.id));
    res.json(await Promise.all(rows.map(r => buildBillOut(r.bill, r.vendor))));
  } catch (err) { handleRouteError(err, req, res); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select({ bill: billsTable, vendor: vendorsTable }).from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(eq(billsTable.id, id)).limit(1);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const items = await db.select().from(billItemsTable).where(eq(billItemsTable.billId, id));
    res.json(await buildBillOut(row.bill, row.vendor, items));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /bills — creates bill as a draft. Does NOT auto-post GL.
// Call POST /bills/:id/post to post the journal entry.
// This is the single creation path for both scanner and manual flows.
router.post("/", async (req, res) => {
  try {
    const { items = [], ...billData } = req.body;
    let subtotal = 0, vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const base = Number(it.quantity) * Number(it.unitPrice);
      const vat = base * (Number(it.vatRate ?? 15) / 100);
      subtotal += base; vatTotal += vat;
      return { ...it, quantity: String(it.quantity), unitPrice: String(it.unitPrice), vatAmount: String(vat.toFixed(2)), total: String((base + vat).toFixed(2)) };
    });

    // If no line items, trust the submitted subtotal/vatAmount/total values
    const finalSubtotal  = items.length > 0 ? subtotal  : Number(billData.subtotal  ?? 0);
    const finalVatAmount = items.length > 0 ? vatTotal  : Number(billData.vatAmount ?? 0);
    const finalTotal     = items.length > 0 ? subtotal + vatTotal : Number(billData.total ?? 0);

    await checkPeriodOpen(billData.date ?? new Date().toISOString().split("T")[0]);
    const [bill] = await db.insert(billsTable).values({
      ...billData,
      subtotal:  String(finalSubtotal.toFixed(2)),
      vatAmount: String(finalVatAmount.toFixed(2)),
      total:     String(finalTotal.toFixed(2)),
      status:    billData.status ?? "draft",
      createdBy: req.session?.userId ?? null,
    }).returning();

    if (preparedItems.length > 0) {
      await db.insert(billItemsTable).values(preparedItems.map((it: any) => ({ ...it, billId: bill.id })));
    }

    res.status(201).json(await buildBillOut(bill, null));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /bills/:id/post — posts the GL journal entry for an existing bill.
// This is THE SINGLE GL posting path used by both scanner and manual flows.
// Accountant must confirm before this is called (no auto-posting).
router.post("/:id/post", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { debitAccount } = req.body;   // optional: override expense account

    const [row] = await db.select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(eq(billsTable.id, id)).limit(1);
    if (!row) { res.status(404).json({ error: "Bill not found" }); return; }
    if (row.bill.status === "paid") {
      res.status(409).json({ error: "Bill is already paid — cannot re-post." }); return;
    }

    const subtotal  = toNum(row.bill.subtotal);
    const vatAmount = toNum(row.bill.vatAmount);
    const total     = toNum(row.bill.total);

    if (total <= 0) {
      res.status(400).json({ error: "Bill total must be greater than zero to post." }); return;
    }

    // ── GL: Dr Purchases/Input VAT  /  Cr Accounts Payable ──────────────────
    // debitAccount can be overridden by the accountant in the review screen.
    const expenseAccount = (typeof debitAccount === "string" && debitAccount.trim())
      ? debitAccount.trim()
      : "Purchases and Cost of Sales";

    await postJournalEntry({
      entryNumber: `BILL-${row.bill.billNumber}`,
      date: row.bill.date,
      description: `Vendor bill ${row.bill.billNumber}${row.vendor?.name ? ` – ${row.vendor.name}` : ""}`,
      reference: row.bill.billNumber ?? undefined,
      lines: [
        { accountName: expenseAccount,        description: `Bill ${row.bill.billNumber}`, debitAmount: subtotal,   creditAmount: 0 },
        { accountName: "Input VAT Receivable", description: `VAT on ${row.bill.billNumber}`,  debitAmount: vatAmount, creditAmount: 0 },
        { accountName: "Accounts Payable",    description: `Bill ${row.bill.billNumber}`, debitAmount: 0,          creditAmount: total },
      ],
    });

    // Update status to "received" (posted but not yet paid)
    const [updated] = await db.update(billsTable)
      .set({ status: "received" })
      .where(eq(billsTable.id, id))
      .returning();

    res.json(await buildBillOut(updated, row.vendor));
  } catch (err) { handleRouteError(err, req, res); }
});

// PATCH /bills/:id — only draft bills
router.patch("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(billsTable).where(eq(billsTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "Only draft bills can be edited." });
      return;
    }
    const [bill] = await db.update(billsTable).set(req.body).where(eq(billsTable.id, id)).returning();
    res.json(await buildBillOut(bill, null));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /bills/:id/pay — records payment and posts AP clearance entry
router.post("/:id/pay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { amount, paidAt } = req.body;
    const payDate = paidAt ?? new Date().toISOString().split("T")[0];

    const [bill] = await db.update(billsTable).set({
      paidAmount: String(amount),
      paidAt: payDate,
      status: "paid",
    }).where(eq(billsTable.id, id)).returning();
    if (!bill) { res.status(404).json({ error: "Not found" }); return; }

    // ── GL: Dr Accounts Payable / Cr Cash and Bank ──
    const paid = Number(amount);
    if (paid > 0) {
      await postJournalEntry({
        entryNumber: `BILL-${bill.billNumber}-PAY`,
        date: payDate,
        description: `Payment to vendor for bill ${bill.billNumber}`,
        reference: bill.billNumber ?? undefined,
        lines: [
          { accountName: "Accounts Payable", description: `Payment for ${bill.billNumber}`, debitAmount: paid, creditAmount: 0 },
          { accountName: "Cash and Bank",    description: `Payment for ${bill.billNumber}`, debitAmount: 0,    creditAmount: paid },
        ],
      });
    }

    res.json(await buildBillOut(bill, null));
  } catch (err) { handleRouteError(err, req, res); }
});

// DELETE /bills/:id — only draft bills
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(billsTable).where(eq(billsTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "Only draft bills can be deleted." });
      return;
    }
    await db.delete(billsTable).where(eq(billsTable.id, id));
    res.status(204).send();
  } catch (err) { handleRouteError(err, req, res); }
});

export default router;
