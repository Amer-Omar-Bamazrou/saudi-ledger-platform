/** Categories service — assembles the OpenAPI/Zod response shapes (unchanged from pre-M6). */
import {
  ListCategoriesResponse,
  CreateCategoryBody,
  CreateCategoryResponse,
} from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { auditService } from "./audit.service";
import { categoriesRepository } from "../repositories/categories.repository";
import { SYSTEM_ACCOUNTS } from "@workspace/db";

/** The platform's own system accounts — what `map_to_system` accepts (one definition, in @workspace/db). */
const PLATFORM_SYSTEM_CODES = new Set<string>(Object.values(SYSTEM_ACCOUNTS));

type CreateCategoryInput = ReturnType<(typeof CreateCategoryBody)["parse"]>;

export const categoriesService = {
  async list() {
    const rows = await categoriesRepository.list();
    return ListCategoriesResponse.parse(
      rows.map((r) => ({
        id: r.id,
        // N3: the JE form needs to know a control account when it sees one —
        // an AR/AP line must ask for its party.
        systemCode: r.systemCode ?? null,
        name: r.name,
        nameAr: r.nameAr,
        type: r.type,
        vatApplicable: r.vatApplicable,
        liquidityClass: r.liquidityClass ?? null,
        // D-3: the bank → GL relationship and the header flag, so the JE
        // picker can hide "Cash and Bank" and show each bank's own account.
        parentId: r.parentId ?? null,
        bankAccountId: r.bankAccountId ?? null,
        isPosting: r.isPosting,
        /**
         * 🔴 FA-D (2026-09-22): whether the code is one of the PLATFORM's own
         * system accounts (the posting path resolves against them), as opposed
         * to a seeded DEFAULT that merely carries a code (FIXED_ASSETS,
         * INVENTORY…). The migration mapper's two doors disagreed with the
         * server without it: the UI offered `map_to_system` for accounts the
         * server refuses, and hid `merge_into` for accounts it accepts. ONE
         * definition — SYSTEM_ACCOUNTS — read by the client.
         */
        isPlatformSystemAccount: r.systemCode != null && PLATFORM_SYSTEM_CODES.has(r.systemCode),
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
      parentId: inserted.parentId ?? null,
      bankAccountId: inserted.bankAccountId ?? null,
      isPosting: inserted.isPosting,
      isPlatformSystemAccount: inserted.systemCode != null && PLATFORM_SYSTEM_CODES.has(inserted.systemCode),
      description: inserted.description ?? null,
    });
  },
};
