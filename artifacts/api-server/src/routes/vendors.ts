import { Router } from "express";
import { db } from "@workspace/db";
import { vendorsTable, billsTable } from "@workspace/db";
import { eq, ilike, and, or } from "drizzle-orm";
import { handleRouteError } from "../lib/routeError";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { search, is_active } = req.query as Record<string, string>;
    const conditions = [];
    if (search) conditions.push(ilike(vendorsTable.name, `%${search}%`));
    if (is_active !== undefined) conditions.push(eq(vendorsTable.isActive, is_active === "true"));
    const rows = await db.select().from(vendorsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(vendorsTable.name);
    res.json(rows);
  } catch (err) { handleRouteError(err, req, res); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
    if (!vendor) { res.status(404).json({ error: "Vendor not found" }); return; }
    const bills = await db.select().from(billsTable).where(eq(billsTable.vendorId, id));
    const totalBilled = bills.reduce((s, b) => s + Number(b.total), 0);
    const totalPaid = bills.reduce((s, b) => s + Number(b.paidAmount ?? 0), 0);
    res.json({ ...vendor, totalBilled, totalPaid, balance: totalBilled - totalPaid, billCount: bills.length });
  } catch (err) { handleRouteError(err, req, res); }
});

/**
 * POST /vendors/match
 * Finds an existing vendor by VAT number (exact) or name (fuzzy).
 * Returns: { matchType: "exact"|"fuzzy"|"none", vendor, suggestions }
 * Used by the receipt scan review page to link a bill to the correct supplier.
 */
router.post("/match", async (req, res) => {
  try {
    const { vatNumber, vendorName } = req.body as { vatNumber?: string; vendorName?: string };

    // 1. Exact VAT registration number match (most reliable)
    if (vatNumber && vatNumber.trim()) {
      const [exact] = await db.select().from(vendorsTable)
        .where(eq(vendorsTable.taxNumber, vatNumber.trim()))
        .limit(1);
      if (exact) {
        res.json({ matchType: "exact", vendor: exact, suggestions: [] });
        return;
      }
    }

    // 2. Fuzzy name match — search on first token of the vendor name
    if (vendorName && vendorName.trim()) {
      // Try increasingly broad matches: full name first, then first word
      const tokens = vendorName.trim().split(/\s+/).filter(Boolean);
      let suggestions: (typeof vendorsTable.$inferSelect)[] = [];

      for (const token of tokens.slice(0, 2)) {
        if (token.length < 3) continue;
        suggestions = await db.select().from(vendorsTable)
          .where(
            or(
              ilike(vendorsTable.name,   `%${token}%`),
              ilike(vendorsTable.nameAr, `%${token}%`)
            )
          )
          .limit(5);
        if (suggestions.length) break;
      }

      if (suggestions.length === 1) {
        // Unique fuzzy hit — surface as a suggestion, not an exact match
        res.json({ matchType: "fuzzy", vendor: null, suggestions });
        return;
      }
      if (suggestions.length > 1) {
        res.json({ matchType: "fuzzy", vendor: null, suggestions });
        return;
      }
    }

    res.json({ matchType: "none", vendor: null, suggestions: [] });
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /vendors — creates a new vendor.
// Returns the vendor row with an explicit created:true flag so callers
// can reliably distinguish "just created" from "already existed" without
// inferring that state from local UI booleans.
router.post("/", async (req, res) => {
  try {
    const [row] = await db.insert(vendorsTable).values(req.body).returning();
    res.status(201).json({ ...row, created: true });
  } catch (err) { handleRouteError(err, req, res); }
});

router.patch("/:id", async (req, res) => {
  try {
    const [row] = await db.update(vendorsTable).set(req.body).where(eq(vendorsTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { handleRouteError(err, req, res); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(vendorsTable).where(eq(vendorsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { handleRouteError(err, req, res); }
});

export default router;
