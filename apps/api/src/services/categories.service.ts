/** Categories service — assembles the OpenAPI/Zod response shapes (unchanged from pre-M6). */
import {
  ListCategoriesResponse,
  CreateCategoryBody,
  CreateCategoryResponse,
} from "@workspace/api-zod";
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
          description: r.description ?? null,
      })),
    );
  },

  async create(data: CreateCategoryInput) {
    const [inserted] = await categoriesRepository.insert({
      name: data.name,
      nameAr: data.nameAr,
      type: data.type,
      vatApplicable: data.vatApplicable,
      description: data.description ?? null,
    });
    await auditService.created("category", inserted.id, inserted);
    return CreateCategoryResponse.parse({
      id: inserted.id,
      name: inserted.name,
      nameAr: inserted.nameAr,
      type: inserted.type,
      vatApplicable: inserted.vatApplicable,
      description: inserted.description ?? null,
    });
  },
};
