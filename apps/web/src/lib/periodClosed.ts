/**
 * The closed-month refusal signal (M22, decision D3).
 *
 * Seven backend paths can refuse a write with 423 `period_closed` — journal
 * entries, invoice create/approve, bill create/approve, transaction posting,
 * and anything future that calls `checkPeriodOpen`. Rather than seven
 * per-page handlers, the shared fetch layer emits ONE signal here and a
 * single dialog (mounted once in App) renders the explanation.
 *
 * 🔴 The handler keys on the structured CODE, never the message text —
 * rewording the server copy can never break this. `period`/`lockedAt` come
 * from the payload for the same reason.
 *
 * Same subscriber pattern as `setApiErrorHandler` in main.tsx: a module-level
 * hook, because the emitting code (plain fetch wrappers) lives outside React.
 */

export interface PeriodClosedEvent {
  /** "YYYY-MM" — the month whose books are closed. */
  period: string;
  /** "YYYY-MM-DD" — when the books were closed. */
  lockedAt: string | null;
}

type Listener = (event: PeriodClosedEvent) => void;

let listener: Listener | null = null;

/** Mounted-dialog registration. Last registration wins (there is one dialog). */
export function onPeriodClosed(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/** Called from the shared error handler when a 423 `period_closed` arrives. */
export function emitPeriodClosed(event: PeriodClosedEvent): void {
  listener?.(event);
}
