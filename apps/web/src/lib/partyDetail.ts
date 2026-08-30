/**
 * Shared machinery for the customer and vendor detail pages.
 *
 * 🔴 ONE implementation, deliberately. Customer aging and vendor aging are the
 * same computation over different documents, and two copies of one rule is the
 * shape that drifts — the header-vs-line arithmetic lesson applied to a report.
 */

/** A document that can age: anything with a due date and an unpaid remainder. */
export interface AgeableDoc {
  dueDate?: string | null;
  date: string;
  total: number;
  paidAmount?: number | null;
  status: string;
}

export interface AgingBuckets {
  current: number;
  d1to30: number;
  d31to60: number;
  d61to90: number;
  d90plus: number;
  total: number;
}

const EMPTY: AgingBuckets = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 };

/**
 * Bucket the OUTSTANDING remainder of each document by how overdue it is.
 *
 * Only issued, not-fully-paid documents age. A draft moves nothing (the
 * zero-movement standard), and a fully-paid document is not a receivable.
 * `dueDate` is nullable across this schema, so a missing due date is treated as
 * due on the document date rather than silently dropped — an undated
 * receivable that vanished from the aging would be the confident-zero shape.
 */
export function computeAging(docs: AgeableDoc[], asOf = new Date()): AgingBuckets {
  const out = { ...EMPTY };
  for (const d of docs) {
    if (d.status === "draft" || d.status === "submitted" || d.status === "rejected") continue;
    const outstanding = Number(d.total ?? 0) - Number(d.paidAmount ?? 0);
    if (outstanding <= 0) continue;

    const due = new Date(d.dueDate || d.date);
    const days = Math.floor((asOf.getTime() - due.getTime()) / 86_400_000);

    if (days <= 0) out.current += outstanding;
    else if (days <= 30) out.d1to30 += outstanding;
    else if (days <= 60) out.d31to60 += outstanding;
    else if (days <= 90) out.d61to90 += outstanding;
    else out.d90plus += outstanding;

    out.total += outstanding;
  }
  return out;
}

/**
 * 🔴 How many documents a detail page asks for, and why it must say when it
 * did not get them all.
 *
 * Aging and the payment history here are computed CLIENT-SIDE over the fetched
 * documents. That is only honest while the fetched set IS the whole set: a
 * figure derived from a capped list describes a set the reader does not know
 * about, which is the defect class this project keeps finding. So every list
 * below reports `truncated`, and the page states it rather than rendering a
 * number that quietly means something narrower.
 *
 * The real fix is a server-side aging endpoint scoped to one party; it does not
 * exist yet, and a stated cap is a true statement in the meantime.
 */
export const DETAIL_FETCH_LIMIT = 200;

export interface FetchedDocs<T> {
  items: T[];
  total: number;
  /** The party has more documents than were fetched — every derived figure is partial. */
  truncated: boolean;
}

export function toFetched<T>(res: { items: T[]; page: { total: number } }): FetchedDocs<T> {
  return {
    items: res.items,
    total: res.page.total,
    truncated: res.page.total > res.items.length,
  };
}
