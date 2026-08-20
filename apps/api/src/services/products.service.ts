/** Products service — numeric (de)serialization + view. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { pick, assertAmount } from "../lib/writeGuards";

/** H1 allowlist — user-settable product fields. */
const PRODUCT_FIELDS = [
  "code", "name", "nameAr", "type", "unitPrice", "unitCost", "currency", "unit",
  "categoryId", "vatApplicable", "stockQty", "reorderPoint", "description", "isActive",
] as const;
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
    // 🔴 H1/H2 — ALLOWLIST + validate prices ≥ 0.
    const picked = pick<Record<string, unknown>>(data, PRODUCT_FIELDS);
    const values = {
      ...picked,
      unitPrice: assertAmount(data.unitPrice ?? 0, "unitPrice", { min: 0, allowZero: true }).toFixed(2),
      unitCost: data.unitCost != null ? assertAmount(data.unitCost, "unitCost", { min: 0, allowZero: true }).toFixed(2) : null,
    } as typeof productsTable.$inferInsert;
    const [row] = await productsRepository.insert(values);
    await auditService.created("product", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await productsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = pick<Record<string, unknown>>(data, PRODUCT_FIELDS);
    for (const f of ["unitPrice", "unitCost"] as const) {
      if (updates[f] != null) updates[f] = assertAmount(updates[f], f, { min: 0, allowZero: true }).toFixed(2);
    }
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
