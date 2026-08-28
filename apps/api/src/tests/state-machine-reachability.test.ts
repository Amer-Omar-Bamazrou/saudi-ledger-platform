import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * P4 — STATE-MACHINE REACHABILITY: for every status transition the system
 * permits, is there a UI path that can produce it?
 *
 * ── 🔴 WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER ROUTE CHECK ──────────────
 * Nine of the fifteen findings in the 2026-08-28 audits are defects only a
 * person touching the product could have found. Every one of them passed every
 * static guard we own, and the guard built for this exact class —
 * `route-reachability.test.ts` — was green for all of them, because it asks
 * whether a UI file *mentions* a route PREFIX. `/quotations` is mentioned
 * dozens of times, so `POST /quotations/:id/reject` having no caller at all is
 * invisible to it.
 *
 * 🔴 **And the sharpest case is invisible even to a verb-aware check.** A
 * button can exist, be correctly wired, and still be unreachable — because the
 * STATE that reveals it can never be produced. `Approve` renders when
 * `status === "submitted"`; if nothing in the product can move a record from
 * `draft` to `submitted`, that button never appears for any user, and no
 * file-level check can see it, because every file involved is correct.
 *
 * So this guard does not ask "is this route called". It builds the transition
 * GRAPH and computes what a user can actually reach:
 *
 *   1. SERVER — every `POST /:id/<action>` on every approvable entity, read
 *      from the routers, so a new action cannot be added without appearing here.
 *   2. CLIENT — for each (entity, action), whether any call site in `apps/web`
 *      can produce it, and BY WHAT EVIDENCE (exact path, or a dispatcher whose
 *      entity and action literals both appear).
 *   3. GRAPH — seed the states creation can produce, propagate along
 *      transitions that have a client producer, and report:
 *        (a) transitions with NO producer                → dead capability
 *        (b) states no reachable transition can produce  → dead state
 *        (c) transitions whose SOURCE state is dead      → the button that
 *            exists and can never render (the B-7 shape)
 *
 * ── 🔴 THE EVIDENCE RULE, AND THE MISTAKE IT AVOIDS ────────────────────────
 * A static "uncalled endpoint" checker was built here before and WITHDRAWN the
 * same day at 65 false positives, because this client calls the API five
 * different ways. So this one is deliberately biased the other way: an
 * ambiguous match counts as REACHABLE, and the guard fails only on *no evidence
 * at all*. That bias means it can miss a defect; it cannot invent one.
 *
 * 🔴 The bias is dangerous in exactly one way — a guard that overstates its
 * coverage is what let this class run for months — so every resolved transition
 * PRINTS the evidence that resolved it, and `dispatch` evidence is never
 * presented as proof. What this guard verifies is that a call site exists which
 * can produce the transition. It does NOT verify that a control renders, that a
 * role may use it, or that the request succeeds. Those need the rendering layer
 * (§3) and are named here so nobody reads green as "a user can do this".
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const routesDir = join(repoRoot, "apps", "api", "src", "routes");
const webSrc = join(repoRoot, "apps", "web", "src");

/**
 * The approvable entities, as `mount → router file`.
 *
 * Declared, then VALIDATED against `routes/index.ts` below — a declaration that
 * nothing checks is how a guard rots into a decoration.
 */
const ENTITIES: Array<{ mount: string; file: string }> = [
  { mount: "journal-entries", file: "journalEntries.ts" },
  { mount: "bills", file: "bills.ts" },
  { mount: "invoices", file: "invoices.ts" },
  { mount: "payroll", file: "payroll.ts" },
  { mount: "quotations", file: "quotations.ts" },
  { mount: "purchase-orders", file: "purchaseOrders.ts" },
];

type State = "draft" | "submitted" | "approved" | "gone";

/**
 * What each action does to the record's lifecycle state.
 *
 * The four workflow actions are the approval engine's own contract
 * (`services/approval/approval.service.ts`). The rest act on an
 * already-approved record — they are still transitions a user must be able to
 * reach, and they still require `approved` to be reachable first.
 *
 * 🔴 An action route that is NOT in this map fails the test rather than being
 * skipped. A new lifecycle action must be classified deliberately; silence is
 * how `conversionState` ended up derived from data nobody loaded.
 */
const SEMANTICS: Record<string, { from: State[]; to: State }> = {
  submit: { from: ["draft"], to: "submitted" },
  "send-back": { from: ["submitted"], to: "draft" },
  approve: { from: ["draft", "submitted"], to: "approved" },
  reject: { from: ["draft", "submitted"], to: "gone" },
  // Post-approval acts. They do not change the abstract lifecycle state, but
  // they are capabilities that must be reachable, and they are only reachable
  // if `approved` is.
  post: { from: ["approved"], to: "approved" },
  pay: { from: ["approved"], to: "approved" },
  reverse: { from: ["approved"], to: "approved" },
  convert: { from: ["approved"], to: "approved" },
  decline: { from: ["approved"], to: "approved" },
  cancel: { from: ["approved"], to: "approved" },
  close: { from: ["approved"], to: "approved" },
  reopen: { from: ["approved"], to: "approved" },
};

/**
 * 🔴 `journal-entries` has no submit stage — it is approved straight from
 * draft, by design (approval.service's header, and Approvals.tsx passes
 * `canSubmit={false}`). Its `submitted` state is therefore expected to be
 * unreachable, and that is a DESIGN FACT, not a defect.
 *
 * Every entry needs a reason. This is the one place a finding can be silenced,
 * so it is kept small and read on every failure.
 */
const EXPECTED_DEAD_STATES: Array<{ entity: string; state: State; why: string }> = [
  {
    entity: "journal-entries",
    state: "submitted",
    why: "JEs have no submit stage — approved straight from draft (approval.service §header).",
  },
];

// ── 1. SERVER: what transitions exist ───────────────────────────────────────

function actionRoutes(file: string): string[] {
  const src = readFileSync(join(routesDir, file), "utf8");
  return [...src.matchAll(/router\.post\(\s*"\/:id\/([a-z-]+)"/g)].map((m) => m[1]!);
}

// ── 2. CLIENT: what can produce them ────────────────────────────────────────

function webFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...webFiles(p));
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const WEB = webFiles(webSrc).map((p) => ({ path: p, src: readFileSync(p, "utf8") }));

/**
 * The three call styles this client actually uses to reach an action route.
 *
 * 🔴 THE FIRST VERSION OF THIS RESOLVER KNEW ONLY TWO, AND WAS WRONG IN THE
 * DANGEROUS DIRECTION. It reported all fourteen quotation and purchase-order
 * transitions as unreachable — inventing findings rather than missing them,
 * which is exactly how the previous static checker died at 65 false positives.
 * The miss: `Quotations.tsx` calls `` `/quotations/${id}/${action}` `` — the
 * entity is a literal segment but the ACTION is interpolated, so neither an
 * exact match nor a three-segment dispatcher pattern could see it.
 *
 * It was caught only because those buttons had been read by hand the day
 * before, and the guard contradicted a known fact. **A guard's own resolver is
 * a claim, and it needs ground truth before anything is believed on its word.**
 */
/** `/${key}/${id}/${action}` — entity AND action interpolated (Approvals.tsx). */
const FULL_DISPATCH = /`\/\$\{[^`]*\}\/\$\{[^`]*\}\/\$\{[^`]*\}`/;

type Evidence = { how: "exact" | "dispatch" | "entity-dispatch"; where: string } | null;

/**
 * Can any call site produce `POST /<entity>/<id>/<action>`?
 *
 * `exact`           — a template naming both the entity and the action.
 * `entity-dispatch` — `` `/<entity>/${id}/${action}` ``, with the action present
 *                     as a literal somewhere in the same file.
 * `dispatch`        — a fully interpolated three-segment path, with the entity
 *                     mount and the action both present as literals.
 *
 * The last two are weaker evidence and are always labelled as such: they prove a
 * call site COULD produce the transition, not that a control does.
 */
function clientProducer(entity: string, action: string): Evidence {
  const exact = new RegExp(`["'\`]/${entity}/[^"'\`]*${action}\\b`);
  for (const f of WEB) {
    if (exact.test(f.src)) return { how: "exact", where: rel(f.path) };
  }
  const actionLiteral = new RegExp(`["']${action}["']`);
  const entityDispatch = new RegExp("`/" + entity + "/\\$\\{[^`]*\\}/\\$\\{[^`]*\\}`");
  for (const f of WEB) {
    if (entityDispatch.test(f.src) && actionLiteral.test(f.src)) {
      return { how: "entity-dispatch", where: rel(f.path) };
    }
  }
  const entityLiteral = new RegExp(`["'\`]/?${entity}["'\`]`);
  for (const f of WEB) {
    if (FULL_DISPATCH.test(f.src) && entityLiteral.test(f.src) && actionLiteral.test(f.src)) {
      return { how: "dispatch", where: rel(f.path) };
    }
  }
  return null;
}

const rel = (p: string) => p.slice(repoRoot.length + 1).replace(/\\/g, "/");

// ── 3. GRAPH ────────────────────────────────────────────────────────────────

interface Transition {
  entity: string;
  action: string;
  from: State[];
  to: State;
  producer: Evidence;
}

function buildGraph(): Transition[] {
  const out: Transition[] = [];
  for (const e of ENTITIES) {
    for (const action of actionRoutes(e.file)) {
      const sem = SEMANTICS[action];
      if (!sem) {
        out.push({ entity: e.mount, action, from: [], to: "gone", producer: null });
        continue;
      }
      out.push({ ...sem, entity: e.mount, action, producer: clientProducer(e.mount, action) });
    }
  }
  return out;
}

/**
 * States a user can actually reach, per entity.
 *
 * `draft` is the seed: every one of these entities is created through a POST
 * that the product uses. Everything else must be REACHED — that is the whole
 * point, and it is why a correctly-wired Approve button on an unreachable
 * `submitted` counts as unreachable here.
 */
function reachableStates(entity: string, graph: Transition[]): Set<State> {
  const reached = new Set<State>(["draft"]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of graph) {
      if (t.entity !== entity || !t.producer) continue;
      if (t.to !== "gone" && !reached.has(t.to) && t.from.some((f) => reached.has(f))) {
        reached.add(t.to);
        changed = true;
      }
    }
  }
  return reached;
}

const GRAPH = buildGraph();

describe("P4 — state-machine reachability: can a user produce every transition the system permits?", () => {
  it("the declared entity list matches what routes/index.ts actually mounts (the guard cannot rot)", () => {
    const index = readFileSync(join(routesDir, "index.ts"), "utf8");
    for (const e of ENTITIES) {
      expect(index, `no mount found for /${e.mount}`).toMatch(
        new RegExp(`router\\.use\\("/${e.mount}"`),
      );
    }
    // And every mounted router that HAS an approve action must be in the list —
    // otherwise a new approvable entity joins the product unguarded.
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith(".ts") || file === "index.ts") continue;
      let actions: string[] = [];
      try {
        actions = actionRoutes(file);
      } catch {
        continue;
      }
      if (actions.includes("approve") && !ENTITIES.some((e) => e.file === file)) {
        throw new Error(
          `routes/${file} has an approve action but is not in ENTITIES — ` +
            `a new approvable entity must join this guard deliberately.`,
        );
      }
    }
  });

  it("every action route is CLASSIFIED — an unknown lifecycle action is a finding, not a skip", () => {
    const unclassified = GRAPH.filter((t) => t.from.length === 0);
    expect(
      unclassified.map((t) => `${t.entity}/${t.action}`),
      "add these to SEMANTICS with a from/to, deliberately",
    ).toEqual([]);
  });

  it("the graph is real (anti-vacuity): entities, transitions, and resolved producers all present", () => {
    // Without this the whole file could pass by finding nothing to check.
    expect(GRAPH.length).toBeGreaterThan(25);
    expect(new Set(GRAPH.map((t) => t.entity)).size).toBe(ENTITIES.length);
    expect(GRAPH.filter((t) => t.producer).length).toBeGreaterThan(10);
  });

  it("🔴 (a) every transition the system permits has a UI path that can produce it", () => {
    const dead = GRAPH.filter((t) => !t.producer);
    const report = dead.map((t) => `  POST /${t.entity}/:id/${t.action}  (${t.from.join("|")} → ${t.to})`);
    expect(
      report,
      `\n${dead.length} transition(s) the API permits and NOTHING in apps/web can trigger:\n` +
        `${report.join("\n")}\n\n` +
        `Each is a capability that was built, tested, and cannot be used. This is the\n` +
        `class the prefix-matching route guard cannot see.\n`,
    ).toEqual([]);
  });

  it("🔴 (b) every lifecycle state is reachable — a state nothing can produce hides every control gated on it", () => {
    const findings: string[] = [];
    for (const e of ENTITIES) {
      const reached = reachableStates(e.mount, GRAPH);
      for (const state of ["submitted", "approved"] as State[]) {
        if (reached.has(state)) continue;
        const expected = EXPECTED_DEAD_STATES.find((x) => x.entity === e.mount && x.state === state);
        if (expected) continue;
        findings.push(`  ${e.mount}: "${state}" is unreachable — no producible transition leads to it`);
      }
    }
    expect(
      findings,
      `\nUnreachable lifecycle state(s):\n${findings.join("\n")}\n\n` +
        `🔴 Every control gated on such a state is dead too, however correctly it is\n` +
        `wired — the button exists and no user can ever see it.\n`,
    ).toEqual([]);
  });

  it("🔴 (c) no transition is stranded behind an unreachable state (the wired button nobody can reach)", () => {
    const stranded: string[] = [];
    for (const e of ENTITIES) {
      const reached = reachableStates(e.mount, GRAPH);
      for (const t of GRAPH) {
        if (t.entity !== e.mount || !t.producer) continue;
        if (t.from.some((f) => reached.has(f))) continue;
        if (EXPECTED_DEAD_STATES.some((x) => x.entity === e.mount && t.from.includes(x.state))) continue;
        stranded.push(`  ${t.entity}/${t.action}: wired (${t.producer.how}) but needs ${t.from.join("|")}, which is unreachable`);
      }
    }
    expect(
      stranded,
      `\nTransition(s) wired to a state no user can reach:\n${stranded.join("\n")}\n`,
    ).toEqual([]);
  });

  it("prints the evidence behind every RESOLVED transition — `dispatch` is not proof", () => {
    // Not an assertion about the product: an assertion about this guard. A
    // reader must be able to see WHY each transition was called reachable,
    // because the resolver is deliberately biased toward saying yes.
    const lines = GRAPH.filter((t) => t.producer).map(
      (t) => `${t.entity}/${t.action}: ${t.producer!.how} — ${t.producer!.where}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[P4] resolved ${lines.length} transitions:\n  ${lines.join("\n  ")}`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

/**
 * ── The verb-level companion ────────────────────────────────────────────────
 *
 * 🔴 P4's transition graph could not express AUD-4 or AUD-5, and that is a fact
 * about the guard worth stating rather than hiding: `PATCH /quotations/:id`
 * (edit) and `POST /capture/:id/discard` (delete the photograph) are not status
 * transitions, so a state machine has nothing to say about them. They are the
 * same DEFECT — a capability built, tested, and unreachable — reached by a
 * different question: does every MUTATING route have something that calls it?
 *
 * That question is what `route-reachability.test.ts` was meant to answer and
 * cannot, because it matches the path PREFIX. Scoped here to the domains this
 * audit actually read, so the claim stays one the list can support.
 */
const MUTATION_DOMAINS: Array<{ mount: string; file: string }> = [
  ...ENTITIES,
  { mount: "capture", file: "capture.ts" },
];

/** Every non-GET route, as (method, action-or-root) pairs. */
function mutatingRoutes(file: string): Array<{ method: string; suffix: string }> {
  const src = readFileSync(join(routesDir, file), "utf8");
  const out: Array<{ method: string; suffix: string }> = [];
  for (const m of src.matchAll(/router\.(post|patch|put|delete)\(\s*"([^"]+)"/g)) {
    out.push({ method: m[1]!.toUpperCase(), suffix: m[2]! });
  }
  return out;
}

/**
 * Deliberate exceptions, each with a reason. Kept short and read on failure —
 * this is the one place a finding can be silenced.
 */
const NO_UI_EXPECTED: Array<{ route: string; why: string }> = [
  {
    route: "POST /capture/",
    why: "Called from Bills.tsx as a multipart upload built with FormData, not a path template.",
  },
];

/**
 * 🔴 OPEN FINDINGS, NOT ACCEPTED DESIGN — the five this guard found the day it
 * was written, listed so it can stay green without the gaps going quiet.
 *
 * A mistaken draft invoice or bill can be neither CORRECTED nor DELETED from
 * the product: no page issues a PATCH or a DELETE against these mounts at all.
 * `PATCH /bills/:id` is the same defect the 2026-08-27 QA audit found by
 * clicking; P4 re-found it from source, which is the first evidence that this
 * guard sees the class the browser pass saw.
 *
 * Queued in CLAUDE.md §5. Each entry must be REMOVED when the caller is built —
 * and the test below fails if one is still listed after it gains a caller, so
 * this list cannot rot into a permanent excuse the way an untested allowlist
 * does.
 */
const KNOWN_GAPS: Array<{ route: string; why: string }> = [
  { route: "PATCH /bills/:id", why: "AUD-10: a bill cannot be edited (QA audit #4, still open)." },
  { route: "PATCH /invoices/:id", why: "AUD-11: a draft invoice cannot be corrected." },
  { route: "DELETE /bills/:id", why: "AUD-12: a mistaken draft bill cannot be removed." },
  { route: "DELETE /invoices/:id", why: "AUD-12: a mistaken draft invoice cannot be removed." },
  { route: "DELETE /journal-entries/:id", why: "AUD-12: a mistaken draft entry cannot be removed." },
];

describe("P4 (verb-level) — every mutating route in the audited domains has a caller", () => {
  it("🔴 no built-and-unreachable mutation is left in these domains", () => {
    const dead: string[] = [];
    const stillGapped: string[] = [];
    for (const d of MUTATION_DOMAINS) {
      for (const r of mutatingRoutes(d.file)) {
        const label = `${r.method} /${d.mount}${r.suffix === "/" ? "/" : r.suffix}`;
        if (NO_UI_EXPECTED.some((x) => x.route === label)) continue;
        if (KNOWN_GAPS.some((x) => x.route === label)) {
          stillGapped.push(label);
          continue;
        }

        // The action segment, where there is one ("/:id/discard" → "discard").
        const action = r.suffix.match(/\/:id\/([a-z-]+)$/)?.[1];
        if (action) {
          if (!clientProducer(d.mount, action)) dead.push(`  ${label}`);
          continue;
        }
        /**
         * Root and "/:id" routes: does any file address this mount AND use this
         * method? Deliberately loose, per the evidence rule at the top — and
         * written with plain string containment rather than a built regex,
         * because escaping a regex through three layers is how the resolver
         * above was wrong twice in one sitting.
         */
        const addressesMount = (src: string) =>
          src.includes(`"/${d.mount}"`) ||
          src.includes(`\`/${d.mount}\``) ||
          src.includes(`\`/${d.mount}/`) ||
          src.includes(`"/${d.mount}/`);
        const usesMethod = (src: string) =>
          src.includes(`method: "${r.method}"`) || src.includes(`method: \`${r.method}\``);
        const found = WEB.some((f) => addressesMount(f.src) && usesMethod(f.src));
        if (!found) dead.push(`  ${label}`);
      }
    }
    expect(
      dead,
      [
        "",
        `${dead.length} mutating route(s) with no caller in apps/web:`,
        ...dead,
        "",
        "Same class as the transitions above, different question. A PATCH nobody",
        "calls means the record cannot be edited from the product at all.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("🔴 a KNOWN_GAP that has been fixed must LEAVE the list (it cannot rot into an excuse)", () => {
    // The half that makes an allowlist honest: the route-reachability guard has
    // this property and it is why its list stays true. A gap that gains a
    // caller and stays listed is a claim about the product that is no longer
    // correct — and a list nobody prunes is how six audit facades survived.
    const fixed = KNOWN_GAPS.filter((g) => {
      const m = g.route.match(/^([A-Z]+) \/([a-z-]+)(\/:id)?/);
      if (!m) return false;
      const [, method, mount] = m;
      const addresses = (src: string) =>
        src.includes(`"/${mount}/`) || src.includes(`\`/${mount}/`);
      const uses = (src: string) => src.includes(`method: "${method}"`);
      return WEB.some((f) => addresses(f.src) && uses(f.src));
    });
    expect(
      fixed.map((g) => g.route),
      "these now have callers — delete them from KNOWN_GAPS",
    ).toEqual([]);
  });
});
