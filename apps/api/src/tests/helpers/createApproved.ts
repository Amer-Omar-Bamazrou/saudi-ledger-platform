/**
 * Create a document, then approve it — as TWO acts, which is now the only way.
 *
 * 🔴 Auto-approve was removed from the product on 2026-08-28 (owner decision).
 * Its justification expired when M22 gave the product a real approve button,
 * and what remained contradicted M10's own principle: **approval is an act
 * about a specific document, and auto-approve made it an act about a setting.**
 * On invoices it was also the leg that turned AUD-13 from an annoying form into
 * an unrecoverable one — a create call that minted an ICV and a ZATCA stamp.
 *
 * Fixtures that need an ISSUED document now issue it the way a tenant must.
 * This helper exists so that stays visible at the call site rather than hiding
 * behind an option, and so the second act names the document it approves.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural only. The services differ in their exact signatures (some approve
 * takes extra options), and a fixture helper should not force them to agree —
 * the product's own types already do that where it matters.
 */
interface Approvable {
  create(body: any, userId: any, ...rest: any[]): Promise<any>;
  approve(id: number, userId: any, ...rest: any[]): Promise<any>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createApproved<T = any>(
  service: Approvable,
  body: unknown,
  userId: number | null,
): Promise<T> {
  const draft = (await service.create(body as never, userId)) as { id: number };
  return (await service.approve(draft.id, userId)) as T;
}
