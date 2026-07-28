/** Products service — numeric (de)serialization + view. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { productsRepository, type ProductListFilter } from "../repositories/products.repository";
import type { productsTable } from "@workspace/db";

type Product = typeof productsTable.$inferSelect;

const toView = (p: Product) => ({
  ...p,
  unitPrice: Number(p.unitPrice),
  unitCost: p.unitCost != null ? Number(p.unitCost) : null,
  stockQty: p.stockQty != null ? Number(p.stockQty) : 0,
  reorderPoint: p.reorderPoint != null ? Number(p.reorderPoint) : null,
});

export const productsService = {
  async list(filter: ProductListFilter) {
    const rows = await productsRepository.list(filter);
    return rows.map(toView);
  },

  async getById(id: number) {
    const [row] = await productsRepository.findById(id);
    if (!row) throw new NotFoundError("Not found");
    return toView(row);
  },

  async create(data: Record<string, unknown>) {
    const values = {
      ...data,
      unitPrice: String(data.unitPrice ?? 0),
      unitCost: data.unitCost != null ? String(data.unitCost) : null,
    } as typeof productsTable.$inferInsert;
    const [row] = await productsRepository.insert(values);
    await auditService.created("product", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await productsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = { ...data } as Record<string, unknown>;
    if (updates.unitPrice != null) updates.unitPrice = String(updates.unitPrice);
    if (updates.unitCost != null) updates.unitCost = String(updates.unitCost);
    const [row] = await productsRepository.update(id, updates as Partial<typeof productsTable.$inferInsert>);
    await auditService.updated("product", id, before, row);
    return toView(row);
  },

  async remove(id: number) {
    const [before] = await productsRepository.findById(id);
    await productsRepository.remove(id);
    if (before) await auditService.deleted("product", id, before);
  },
};
