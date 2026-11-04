/**
 * 🔴 AFTER THE COMMIT, BEFORE THE RESPONSE (Phase 18 final round, TR-5; register §11.133).
 *
 * A step a request schedules here runs once its tenant transaction has COMMITTED, and before its response is written.
 * It is for what must not run while that transaction is open: the first user was a bank-detail decision reading names
 * through the owner connection while its own transaction held its row locks, and when the identity tables were locked
 * that transaction sat idle until the 15-second timeout killed the decision.
 *
 * A step runs after the write is durable, so it cannot be allowed to fail the request: its failure is logged and the
 * response goes out as it stands. It runs on a rollback never (`commitBeforeResponse` only calls it after a commit).
 * Outside a request there is no transaction to wait for, so `afterCommit` answers false and the caller runs the step
 * itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Step = () => Promise<void>;

const scope = new AsyncLocalStorage<Step[]>();

/** Schedule `step` for after this request's commit. False outside a request: the caller runs it itself. */
export function afterCommit(step: Step): boolean {
  const steps = scope.getStore();
  if (!steps) return false;
  steps.push(step);
  return true;
}

/** One request's scope, opened by `resolveTenant` around its handlers. */
export function afterCommitScope(onFailure: (err: unknown) => void) {
  const steps: Step[] = [];
  return {
    run: <T>(fn: () => T): T => scope.run(steps, fn),
    /** Never rejects: a step's failure cannot reach a response whose write has already committed. */
    settle: async (): Promise<void> => {
      for (const step of steps.splice(0)) {
        try {
          await step();
        } catch (err) {
          onFailure(err);
        }
      }
    },
  };
}
