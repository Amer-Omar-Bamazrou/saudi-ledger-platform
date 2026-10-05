export * from './generated/api';
export * from './generated/types';
/**
 * getInvoiceDocument is the first operation with BOTH path and query params,
 * and orval names them into a collision: the zod bundle exports a PATH-params
 * schema `GetInvoiceDocumentParams` while the types bundle exports the
 * QUERY-params TYPE under the same name. The explicit re-export resolves the
 * TS2308 ambiguity in favour of the TYPE (what client code consumes); the
 * path-params zod const remains importable from './generated/api' directly.
 * This file is hand-maintained (it is not under generated/**).
 */
export type { GetInvoiceDocumentParams } from './generated/types';
// Same collision for the customer statement (path id + query date range; Phase E).
export type { GetCustomerStatementParams } from './generated/types';
// Same collision for the supplier statement (path vendorId + query window; Phase 11 Part 2 B5).
export type { GetSupplierStatementParams } from './generated/types';
// Same collision for the report export (path report + query params; Phase 14 D14-10) and the
// Phase 15 budget reads (path id + query version_id / through_period).
export type { ExportReportParams, GetBudgetParams, GetBudgetVsActualParams } from './generated/types';
// Phase 16: the tax computation read (path id + query version_id) and the WHT beneficiary statement (path vendorId + query period).
export type { GetTaxComputationParams, GetWhtBeneficiaryStatementParams } from './generated/types';
