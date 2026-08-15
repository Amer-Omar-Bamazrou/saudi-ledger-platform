/** Categories service — assembles the OpenAPI/Zod response shapes (unchanged from pre-M6). */
import {
  ListCategoriesResponse,
  CreateCategoryBody,
  CreateCategoryResponse,
} from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { auditService } from "./audit.service";
import { categoriesRepository } from "../repositories/categories.repository";

type CreateCategoryInput = ReturnType<(typeof CreateCategoryBody)["parse"]>;

export const categoriesService = {
  async list() {
    const rows = await categoriesRepository.list();
    return ListCategoriesResponse.parse(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        nameAr: r.nameAr,
        type: r.type,
        vatApplicable: r.vatApplicable,
        liquidityClass: r.liquidityClass ?? null,
        description: r.description ?? null,
      })),
    );
  },

  async create(data: CreateCategoryInput) {
    /**
     * M18.1 — a liquidity class only means something on a balance-sheet
     * account. Refused here for a readable 400 AND by a DB CHECK, because an
     * income account marked `quick` would be summed into current assets by a
     * reader that trusts the column — an invariant more than one writer could
     * violate belongs at the write boundary, not in whichever path came first.
     */
    const liquidityClass = data.liquidityClass ?? null;
    if (liquidityClass !== null && data.type !== "asset" && data.type !== "liability") {
      throw new BadRequestError(
        "liquidityClass applies only to asset and liability accounts.",
      );
    }

    const [inserted] = await categoriesRepository.insert({
      name: data.name,
      nameAr: data.nameAr,
      type: data.type,
      vatApplicable: data.vatApplicable,
      liquidityClass,
      description: data.description ?? null,
    });
    await auditService.created("category", inserted.id, inserted);
    return CreateCategoryResponse.parse({
      id: inserted.id,
      name: inserted.name,
      nameAr: inserted.nameAr,
      type: inserted.type,
      vatApplicable: inserted.vatApplicable,
      liquidityClass: inserted.liquidityClass ?? null,
      description: inserted.description ?? null,
    });
  },
};
