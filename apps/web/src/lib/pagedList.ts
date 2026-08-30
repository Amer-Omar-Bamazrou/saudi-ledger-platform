import { apiFetch } from "@/lib/api";

/** The envelope every list endpoint returns. */
export interface Paged<T, Totals = Record<string, number>> {
  items: T[];
  page: { limit: number; offset: number; total: number };
  totals: Totals;
}

/** The default page, matching the server's `DEFAULT_PAGE`. */
export const PAGE_SIZE = 50;

/**
 * 🔴 What a PICKER asks for, and why it is a different number.
 *
 * A dropdown is not a screen. Its reader is choosing from "my customers", so a
 * page of 50 does not under-report a total — it removes options, silently, and
 * the 51st customer simply cannot be invoiced. That is B-6 pointing the other
 * way: capped where it should be unbounded is the same illness as unbounded
 * where it should be capped.
 *
 * The honest arrangement is a high ceiling plus a STATED consequence: the
 * picker asks for the server's maximum page and, when the total exceeds what
 * came back, says so instead of quietly offering a subset. It matches
 * `MAX_PAGE` on the server rather than guessing a second number.
 *
 * 🔴 The real answer is a search-backed combobox that narrows server-side, and
 * it is not built. Recorded here rather than in a queue nobody reads at the
 * call site: the trigger is a tenant crossing this ceiling, and until then a
 * notice is a true statement rather than a placeholder.
 */
export const PICKER_LIMIT = 200;

/** Fetch a picker's options, returning the rows and whether the set was cut. */
export async function fetchPickerOptions<T>(path: string): Promise<{ items: T[]; total: number }> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await apiFetch<Paged<T>>(`${path}${sep}limit=${PICKER_LIMIT}`);
  return { items: res.items, total: res.page.total };
}
