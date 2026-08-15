/**
 * Companies service (M11.6) — read/update the active company's legal identity.
 *
 * WHY THIS MATTERS: `vatNumber` and `name` are not cosmetic settings. They are
 * the SELLER identity stamped into every issued e-invoice — ZATCA QR tags 1-2 and
 * the invoice hash chain (see `sellerIdentity.ts`). Before M11.6 they were
 * hardcoded to a sandbox placeholder, so every invoice carried a fake VAT number.
 * Validation here is therefore statutory, not cosmetic.
 */
import {
  GetCurrentCompanyResponse,
  ListFiscalYearsResponse,
  UpdateCurrentCompanyBody,
  UpdateCurrentCompanyResponse,
} from "@workspace/api-zod";
import { BadRequestError, NotFoundError } from "../lib/errors";
import {
  BUILDING_NUMBER_RE, CR_NUMBER_HELP, CR_NUMBER_RE,
  POSTAL_CODE_RE, VAT_NUMBER_HELP, VAT_NUMBER_RE,
} from "../lib/saudiIdentifiers";
import { companiesRepository } from "../repositories/companies.repository";
import { auditService } from "./audit.service";
import {
  isFiscalCalendar,
  recentFiscalYears,
  fiscalYearContaining,
  type FiscalCalendar,
} from "../lib/fiscalYear";
import type { companiesTable } from "@workspace/db";

type Company = typeof companiesTable.$inferSelect;
export type UpdateCompanyInput = ReturnType<(typeof UpdateCurrentCompanyBody)["parse"]>;

function buildCompanyOut(c: Company) {
  return {
    id: c.id,
    name: c.name,
    nameAr: c.nameAr ?? null,
    crNumber: c.crNumber ?? null,
    vatNumber: c.vatNumber ?? null,
    fiscalYearStart: c.fiscalYearStart,
    fiscalCalendar: c.fiscalCalendar,
    buildingNumber: c.buildingNumber ?? null,
    street: c.street ?? null,
    district: c.district ?? null,
    city: c.city ?? null,
    postalCode: c.postalCode ?? null,
  };
}

/**
 * Normalize an optional text field: `undefined` → leave unchanged, empty string
 * → clear (null), otherwise the trimmed value.
 */
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/** Validate a cleared-or-formatted identifier. */
function validateFormat(value: string | null | undefined, re: RegExp, help: string): void {
  if (value === undefined || value === null) return; // untouched or explicitly cleared
  if (!re.test(value)) throw new BadRequestError(help);
}

export const companiesService = {
  async getCurrent() {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    return GetCurrentCompanyResponse.parse(buildCompanyOut(company));
  },

  /**
   * The active company's fiscal years, resolved to real date ranges (M17.2).
   *
   * This is the production consumer that `fiscal_year_start` never had. It
   * returns the CURRENT period plus a window either side, each with concrete
   * `startDate`/`endDate`/`days` — so a caller never re-derives boundaries, and
   * the settings page can show the user what their configuration actually
   * means instead of promising it is "stored for future use".
   */
  async fiscalYears() {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    const settings = {
      fiscalYearStart: company.fiscalYearStart,
      calendar: (isFiscalCalendar(company.fiscalCalendar)
        ? company.fiscalCalendar
        : "gregorian") as FiscalCalendar,
    };

    return ListFiscalYearsResponse.parse({
      calendar: settings.calendar,
      fiscalYearStart: settings.fiscalYearStart,
      current: fiscalYearContaining(settings),
      periods: recentFiscalYears(settings),
    });
  },

  async updateCurrent(input: UpdateCompanyInput) {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    const updates: Partial<typeof companiesTable.$inferInsert> = {};

    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestError("Company name cannot be empty.");
      updates.name = name;
    }

    const nameAr = optionalText(input.nameAr);
    if (nameAr !== undefined) updates.nameAr = nameAr;

    // Statutory identifiers — format-checked (see lib/saudiIdentifiers).
    const crNumber = optionalText(input.crNumber);
    validateFormat(crNumber, CR_NUMBER_RE, CR_NUMBER_HELP);
    if (crNumber !== undefined) updates.crNumber = crNumber;

    const vatNumber = optionalText(input.vatNumber);
    validateFormat(vatNumber, VAT_NUMBER_RE, VAT_NUMBER_HELP);
    if (vatNumber !== undefined) updates.vatNumber = vatNumber;

    if (input.fiscalYearStart !== undefined) {
      const m = Number(input.fiscalYearStart);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        throw new BadRequestError("fiscalYearStart must be a month number between 1 and 12.");
      }
      updates.fiscalYearStart = m;
    }

    // M17.2 — changing this REINTERPRETS `fiscalYearStart` (1 = January under
    // gregorian, 1 = Muharram under hijri), so it is validated here for a
    // readable 400 and by a DB CHECK for every other writer.
    if (input.fiscalCalendar !== undefined) {
      if (!isFiscalCalendar(input.fiscalCalendar)) {
        throw new BadRequestError("fiscalCalendar must be 'gregorian' or 'hijri'.");
      }
      updates.fiscalCalendar = input.fiscalCalendar;
    }

    // Address block (ZATCA Phase 2 / printed invoices) — free text except the
    // two numeric national-address fields.
    const buildingNumber = optionalText(input.buildingNumber);
    validateFormat(buildingNumber, BUILDING_NUMBER_RE, "Building number must be 4 digits.");
    if (buildingNumber !== undefined) updates.buildingNumber = buildingNumber;

    const postalCode = optionalText(input.postalCode);
    validateFormat(postalCode, POSTAL_CODE_RE, "Postal code must be 5 digits.");
    if (postalCode !== undefined) updates.postalCode = postalCode;

    for (const key of ["street", "district", "city"] as const) {
      const v = optionalText(input[key]);
      if (v !== undefined) updates[key] = v;
    }

    if (Object.keys(updates).length === 0) throw new BadRequestError("No changes supplied.");

    const [updated] = await companiesRepository.update(company.id, updates);
    await auditService.updated("company", company.id, buildCompanyOut(company), buildCompanyOut(updated));
    return UpdateCurrentCompanyResponse.parse(buildCompanyOut(updated));
  },
};
