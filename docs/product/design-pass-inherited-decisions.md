# Decisions the UI design pass inherits

**Status (2026-08-27): live. Current state authority: CLAUDE.md §2.**

The UI is going to be redesigned. That fact changes what is worth fixing *now*
in the front end: work whose only value is to be replaced is not worth its cost,
and work whose absence would be invisible to the redesign is worth even less.

This file is where those calls are recorded so they are **decisions with a
stated reason and a measured cost**, rather than omissions that get rediscovered
as bugs. It is live and tickable — it defers to nothing, and nothing defers to
it for platform state (that is CLAUDE.md §2).

Each entry carries: what was deliberately not done, the **measured** size of it,
what breaks while it stays undone, and what the design pass has to decide.

---

## D-1 — The vendored `components/ui/**` are NOT ours yet

**Decided 2026-08-27, with PR #94 (RTL logical properties).**

PR #94 converted **422 physical Tailwind tokens across 52 files** of app code to
logical properties, so that `dir="rtl"` — which `LanguageContext` was already
setting correctly — finally flips the layout it was always supposed to flip.

It deliberately **excluded `apps/web/src/components/ui/**`**, the vendored shadcn
primitives.

### The measured size of what was left

| | tokens | files |
|---|---|---|
| app code (converted in #94) | 422 | 52 |
| **vendored `components/ui/**` (NOT converted)** | **120** | **25** |

Concentrated in the components where direction matters most — the ones that
*open* toward a side:

| tokens | file |
|---|---|
| 20 | `sidebar.tsx` |
| 11 | `context-menu.tsx` |
| 11 | `dropdown-menu.tsx` |
| 11 | `menubar.tsx` |
| 8 | `input-group.tsx` |
| 6 each | `calendar.tsx`, `carousel.tsx`, `sheet.tsx` |
| ≤4 each | 17 more files |

> 🔴 **This corrects the figure in PR #94, which said 105 tokens across 22
> files.** The correction matters less than *why* it was wrong: the token-aware
> codemod is the instrument that produced (and validated) the app-code number,
> and it **excludes `components/ui/` by construction** — so it structurally
> could not have produced the vendored column. That number came from a different,
> unvalidated method, in a PR whose own body documents two earlier miscounts.
> The figure above was measured by running the codemod's own logic with the
> exclusion inverted, `--dry`, writing nothing. Same instrument, same rules.
> *(The general form is already a named lesson: a claim inside a measuring
> instrument is still a claim — and so is a claim sitting next to one.)*

### The decision

**Do not own them yet.** Do not rewrite the 120 tokens.

**Why.** Rewriting vendored files makes every one of them a merge conflict
against every future `shadcn add` or upgrade — permanent drift, paid forever,
for a component layer that is about to be redesigned anyway. That is a real and
recurring cost set against a benefit the redesign may simply supersede.

### 🔴 What is broken while this stands — stated, not softened

**RTL is not complete.** This is not a cosmetic remainder. In Arabic:

- the sidebar, dropdown menus, context menus and menubar still resolve their
  padding, offsets and alignment on the left/right axis rather than
  start/end — so they align, indent and open the wrong way;
- `sheet.tsx` slides in from the physical side, not the logical one;
- icon padding inside inputs (`input-group.tsx`) stays on the physical side, so
  icon and text can overlap.

Arabic is a **launch requirement** (CLAUDE.md §2). So D-1 is a decision that is
correct *until the design pass*, and **becomes a launch blocker if the design
pass does not happen before launch.** It is not a deferral without an expiry.

### What the design pass must decide

1. **Own or track?** Owning them (forking into our own component layer) makes
   the RTL fix a one-time edit and ends the drift question by ending the
   upstream relationship. Tracking them upstream keeps `shadcn add` cheap and
   pushes RTL into a wrapper or a Tailwind-level solution instead.
2. If tracked, **where does the RTL fix live** so it is not re-applied by hand
   after every upgrade?
3. Whichever way: the 120 tokens above are the work item, and the four files at
   the top are 53 of them.

---

## D-2 — The `.dark` block has no consumer

**Found 2026-08-27, with PR #94. Queued, not fixed.**

`apps/web/src/index.css:138` defines a `.dark { … }` block. **Nothing anywhere
in the application ever applies that class.**

Verified rather than assumed — the search shape, so the claim is reviewable:

- `:root` (line 75) already holds the **dark** palette (`--background: 222 47% 8%`);
- searched `apps/web/src` for `className="dark"`, `classList.add("dark")`, a
  `"dark"` string literal, `setTheme`, `useTheme` and `ThemeProvider`, and
  `apps/web/index.html` / `main.tsx` for a hardcoded class — **no hits** outside
  the vendored primitives;
- so there is no theme toggle, and no code path that could set the class.

**This is the shape-with-no-consumer failure** (CLAUDE.md §3), in CSS: a block
that looks like working dark-mode support, is dead, and would be read by the
next person as "dark mode is handled". It is doubly misleading because the app
*is* dark — just from `:root`, not from `.dark`.

### The decision

**Leave it. Do not delete it now, and do not wire a toggle now.**

Deleting it is a two-line change with no user-visible effect, but it presumes
the answer to a question the design pass owns: *is there a light theme at all?*
If the answer is yes, `.dark` is a half-built piece of the right structure and
the correct move is to invert the palettes (`:root` = light, `.dark` = dark,
which is the convention the block was clearly copied from). If the answer is no,
the block should go, along with the token duplication.

Either way it is one decision, made once, by whoever owns the palette — not a
tidy-up.

### What the design pass must decide

1. **Is there a light theme?** If yes, `:root` and `.dark` swap roles and a
   toggle needs a home (and a persistence story).
2. If no: delete the block and say so here, so its absence reads as a decision.

---

## D-3 — Numeric column alignment in RTL is unresolved

**Raised 2026-08-27, with PR #94.**

PR #94 mechanically converted `text-right` → `text-end` on numeric/amount
columns. That is the correct *logical* equivalence, and it means that **in
Arabic, amounts now align to the left of their column.**

That is standard logical behaviour and it may well be wrong for financial
tables, where a case exists for pinning amounts to the same physical side in
both directions so the decimal points line up the way an accountant reads them.

The codemod made the mechanically-correct choice. **It is not a design ruling,
and the design pass should make one** — with an accountant's eye, not a
developer's, since the question is what a Saudi accountant expects to see.
