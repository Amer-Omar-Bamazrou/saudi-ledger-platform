import type { ReactNode } from "react";

/**
 * 🔴 THE REPORT PAGES' FILTER ROW — From, To, any party or account picker, and Generate — in ONE place (2026-11-21).
 *
 * It WRAPS. The app's content area clips sideways (Layout.tsx `overflow-x-hidden`), so a row wider than a phone
 * loses its last control off screen with nothing to scroll: five report pages wrote this row without `flex-wrap`, and
 * at 390 px their Generate button lay 44 of its 49 px past the edge. Every report page uses this component instead of
 * its own row; the route crawl measures every page at 390 px (e2e/smoke-crawl.spec.ts).
 */
export function ReportFilterRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-4">{children}</div>;
}
