/**
 * THE ROUTE MAP THE BROWSER SUITE AGREES ON.
 *
 * Extracted from `smoke-crawl.spec.ts` so `nav-tree.spec.ts` can assert that
 * every navigation destination is a route something actually renders —
 * Playwright forbids one spec importing another, and the fact both specs need
 * is data, not a test.
 */
export type Kind =
  /** Authenticated app page: must render real content. */
  | "app"
  /** Reachable only when logged OUT; visiting it authenticated redirects. */
  | "anonymous"
  /** Requires the platform-operator role, which the tenant admin does not have. */
  | "operator"
  /** Needs a path parameter — supplied from the seed. */
  | "param"
  /**
   * Authenticated, but rendered OUTSIDE the app shell, so there is no `<main>`.
   *
   * 🔴 Discovered by this crawl, not assumed: `/verification` is
   * `<AuthGuard><VerificationStatus /></AuthGuard>` with no `Layout`, because it
   * is the M11.2 gate shown to an org whose verification is still pending — a
   * tenant that must NOT reach business routes. The missing `<main>` is the
   * design, and the crawl's first run said so by failing.
   *
   * This kind exists so that fact is written down. Relaxing the `<main>`
   * assertion for everything would have hidden it, which is how a guard quietly
   * stops guarding.
   */
  | "authenticated-no-shell";

/**
 * Every route, classified. 🔴 Add a route to `App.tsx` and this file goes red
 * until you say what the route is — that is the point, not an inconvenience.
 */
/** Exported so `nav-tree.spec.ts` can assert its destinations are covered here. */
export const EXPECTATIONS: Record<string, Kind> = {
  "/": "app",
  "/analytics": "app",
  "/ap-aging": "app",
  "/approvals": "app",
  "/ar-aging": "app",
  "/assets": "app",
  "/asset-schedule": "app",
  "/audit-trail": "app",
  "/balance-sheet": "app",
  "/bank-accounts": "app",
  "/bills": "app",
  "/budgets": "app",
  "/cash-flow": "app",
  "/categories": "app",
  "/categorize": "app",
  "/change-password": "app",
  "/closed-months": "app",
  "/company": "app",
  "/credit-notes": "app",
  "/customers": "app",
  "/employees": "app",
  "/finance-hub": "app",
  "/findings": "app",
  "/income-statement": "app",
  "/invoices": "app",
  "/invoice-summary": "app",
  "/journal-entries": "app",
  "/payroll": "app",
  "/payroll-report": "app",
  "/products": "app",
  "/purchase-orders": "app",
  "/quotations": "app",
  "/recurring": "app",
  "/reports": "app",
  "/reports/account-statement": "app",
  "/reports/account-summary": "app",
  "/reports/activity": "app",
  "/reports/aging": "app",
  "/reports/customer-ledger": "app",
  "/reports/general-ledger": "app",
  "/reports/journal-report": "app",
  "/reports/owner-equity": "app",
  "/reports/tax-journal-entries": "app",
  "/review": "app",
  "/scan-review": "app",
  "/transactions": "app",
  "/trial-balance": "app",
  "/upload": "app",
  "/users": "app",
  "/vat": "app",
  "/vendors": "app",
  "/verification": "authenticated-no-shell",
  "/zakat": "app",
  "/zatca": "app",

  "/login": "anonymous",
  "/signup": "anonymous",
  "/accept-invite": "anonymous",

  "/operator": "operator",

  "/integrations": "app",
  "/customers/:id": "param",
  "/vendors/:id": "param",
  // One representative placeholder, so the smoke crawl covers the shape. Every
  // registered slug is crawled individually by `nav-tree.spec.ts` — this entry
  // exists so a change to the ComingSoon component is caught here too.
  "/coming-soon/:slug": "param",
};
