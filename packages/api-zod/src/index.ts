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
