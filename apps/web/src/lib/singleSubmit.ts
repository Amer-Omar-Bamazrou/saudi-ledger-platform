/**
 * ONE REQUEST PER INTENT, WHATEVER THE MOUSE DOES.
 *
 * `mutation.isPending` is React STATE: it disables a button only after the next
 * render, and a double-click delivers both clicks before that render — so both
 * requests were already on their way. QA FIX #1 (2026-09-04) closed it for
 * invoice creation with a synchronous ref; the Phase 16/17 manual QA
 * (2026-10-04) found every tax and treasury button still guarded by
 * `isPending` alone: a double-click added a tax adjustment twice (the Zakat
 * went up with it), created two identical payment plans, and fired two
 * remittances (the second answered 500).
 *
 * `createSubmitGuard` is the synchronous half — a plain flag, set before the
 * request leaves and released when it settles. `useGuarded` wraps a TanStack
 * mutation in it where the mutation is DECLARED, so every `x.mutate(...)` on
 * the page is single-flight and no call site can be forgotten.
 */
import { useMemo, useRef } from "react";

export interface SubmitGuard {
  readonly busy: boolean;
  /** Runs `start(release)` unless a submit is in flight; `release` re-arms it. Returns whether it ran. */
  run(start: (release: () => void) => void): boolean;
}

export function createSubmitGuard(): SubmitGuard {
  let busy = false;
  return {
    get busy() { return busy; },
    run(start) {
      if (busy) return false;
      busy = true;
      let released = false;
      const release = () => { if (!released) { released = true; busy = false; } };
      try {
        start(release);
      } catch (e) {
        release();
        throw e;
      }
      return true;
    },
  };
}

type MutateOptions = { onSettled?: (...args: never[]) => unknown } & Record<string, unknown>;
type Mutation = { mutate: (variables: never, options?: never) => void };

/** The mutation, with `mutate` single-flight: a second call while the first is in flight is dropped. */
export function useGuarded<M extends Mutation>(mutation: M): M {
  const guard = useRef<SubmitGuard | null>(null);
  if (!guard.current) guard.current = createSubmitGuard();
  const g = guard.current;
  return useMemo(() => {
    const mutate = ((variables: unknown, options?: MutateOptions) => {
      g.run((release) => {
        (mutation.mutate as unknown as (v: unknown, o: MutateOptions) => void)(variables, {
          ...options,
          onSettled: (...args: never[]) => { release(); options?.onSettled?.(...args); },
        });
      });
    }) as unknown as M["mutate"];
    return { ...mutation, mutate };
  }, [mutation, g]);
}
