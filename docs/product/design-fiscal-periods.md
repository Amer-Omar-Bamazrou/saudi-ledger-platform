# Fiscal periods in reports — DECISION RECORD

**Decided 2026-08-16 with the owner, by interview.** Round 4, after Zakat,
the Finance Hub and Analytics. **Revised the same day after the owner's
accountant answered** — the first user research this product has had. F4 was
corrected; F3 and F7 were REOPENED as validated requirements. The earlier
answers are kept below, marked superseded, because a silently-overwritten
decision reads later as though the research never happened.

This closes the gap M17.2 opened deliberately: `fiscalYearStart` gained a
resolver, a calendar basis, an endpoint and a settings page — and **no report
consumer**. The producer has existed for five milestones with one reader.

---

## 1. The decisions

| # | Question | Decision |
| --- | --- | --- |
| **F1** | Default window, or picker? | **Both — the DEFAULT FIRST, and it is a BUG, not a feature gap.** |
| **F2** | Which pages keep arbitrary dates? | **All of them.** Free dates *plus* period shortcuts everywhere; nothing becomes period-only. Balance Sheet gets "as at FY-end" as a shortcut. |
| **F3** | What a Hijri tenant sees | ✅ **DECIDED (2026-08-16, validated by user research).** Headers/period labels with M20.3; **dual display in tables as its own milestone after M20 — at the shared formatters, never per-page**. Dual display over a toggle because the accountant said *both* — a toggle forces choosing one at a time, which is not the ask. Hijri as a secondary line; columns do not double; date INPUTS stay Gregorian. The 16 raw date interpolations get converted to the shared formatter **regardless** — 16 bespoke date renders is the same disease as 20 bespoke date pickers. *(The original "too expensive, out of scope" call was wrong — see the note under §6b.)* |
| **F4** | Does "FY 2026" mean anything to an SME owner? | ✏️ **CORRECTED by accountant research (2026-08-16).** ~~Months and quarters only; the fiscal picker is the accountant's~~ *(superseded)*. Clients think in **monthly, quarterly AND yearly** terms — the yearly shortcut is a first-class need, not an accountant's tool. And fiscal years genuinely vary: some clients start in January, some in other months, so the Jan–Dec default defect (§2) harms real clients, not hypothetical ones. |
| **F5** | Twenty bespoke date controls | **Accept the duplication.** Add period support where needed; revisit only if a third pattern appears. |
| **F6** | Period vs custom dates | **A shortcut, never a mode.** Picking a period sets the dates; they stay editable; the label reverts to "Custom" when touched. |
| **F7** | Prior-period comparison | ✅ **DECIDED (2026-08-16, validated by user research).** **The three financial statements only** (income statement, balance sheet, cash flow), this-year-vs-last-year and quarter-vs-quarter, as **one milestone after F3's dual display**. All twenty pages is 3–4× the cost for pages nobody named; if more are wanted later, the pattern will exist. *(The original "out of scope" call was wrong — see the note under §6b.)* |
| **F8** | Undeclared fiscal year | **NULL is a first-class state** — ask, never silently assume January. Historical periods **keep their original boundaries**; no recomputation. |
| **F9** | Scope | **Reports only** for now. Analytics stays month-based. |
| **F10** | Existing `fiscal_year_start` rows | **NULL them all.** `NOT NULL DEFAULT 1` means nobody declared January — the schema asserted it for them. Preserving the value preserves a fiction; an undeclared fact must not look declared. Same call as M17.1's ownership. |
| **F11** | Default while undeclared | **Rolling last-12-months**, and the page says so — a rolling window asserts nothing about the tenant's year. 🔴 The message must be **specific enough to act on** ("your financial year hasn't been set — showing the last 12 months"), never a passive caveat. |
| **F12** | Shortcut list and order | **This month / Last month / This quarter / Last quarter / This fiscal year / Last fiscal year.** ⚠️ The original rationale for fiscal-last ("the accountant's, not the owner's") was F4's superseded assumption; the corrected research says yearly is first-class for clients too. The LIST survives — all six are wanted — but the ORDER is now a presentation choice, not a research finding. "Fiscal year to date" stays dropped (expressible with custom dates). |
| **F13** | Where the undeclared prompt appears | **Company Settings, and inline on a report that is using the rolling window** — on that report, saying why. **Not a session-wide banner:** a persistent nag is noise. |

---

## 2. 🔴 F1 — why the default is a defect, not a missing feature

Every report page opens with a hardcoded window:

```ts
const [dateFrom, setDateFrom] = useState(`${thisYear}-01-01`);
const [dateTo,   setDateTo]   = useState(`${thisYear}-12-31`);
```

That is not *absence* of fiscal awareness. It is an **active assertion that the
year runs January to December**. A tenant whose year starts in April opens the
income statement, sees a plausible figure covering the wrong twelve months, and
nothing on the page says which period it is relative to their year.

**Owner's framing, kept because it names the family:** *"a confidently wrong
number, same family as the SAR 0.00 Zakat."* Both render a computed-looking
answer from a premise nobody stated — and a wrong answer that looks like an
answer does not get reported, because there is nothing to notice.

So the default is fixed first and separately from the picker. A picker on top of
a wrong default helps only the user who already knew to use it.

---

## 3. 🔴 F8 has a migration hiding in it — and the column is already lying

`companies.fiscal_year_start` is **`integer NOT NULL DEFAULT 1`** (since
`0000`). So every tenant who has never opened Company Settings is *already*
recorded as having a January fiscal year — not as undeclared. The database is
asserting the thing F8 says the platform must not assert.

**Therefore F8 is not implementable as a UI change.** It needs the M17.1
`ownership_type` treatment:

- make `fiscal_year_start` **nullable with NO default**,
- **NULL every existing row (F10, owner-decided).** Each holds `1`, and that
  `1` is indistinguishable from a deliberate January declaration — so it is not
  data, it is the schema having spoken for the tenant. A backfill preserving the
  value would preserve a fiction.
- treat NULL as "not declared" everywhere the resolver is called.

**What reports do while it is NULL** — the decision F8 forces, stated so it is
not resolved by drift later:

> The default window falls back to a **rolling last-12-months** (F11), and the
> report **using** that window says so, in words specific enough to act on —
> *"your financial year hasn't been set — showing the last 12 months"* — with a
> link to Company Settings. Not a passive caveat, and not a session-wide banner
> (F13): a persistent nag is noise, and the place to say it is the report whose
> figures the choice is shaping.

A rolling window asserts nothing about anyone's fiscal year, which is the whole
point. Defaulting to January "just for the default" would reintroduce §2's
defect one layer up.

---

## 4. F3 — the boundary that must not blur

Three separable things; two are in, one is out:

| | In scope | Why |
| --- | --- | --- |
| **Labels** | ✅ | "FY 1447" / "FY 1447 (Jun 2025 – Jun 2026)". Cheap, and the label is what makes the shortcut usable. |
| **Boundaries** | ✅ | The resolver already returns the correct Gregorian dates for a Hijri year — the work is displaying them, not computing them. |
| **Dates inside reports** | ❌ **OUT** | Converting every date in every table for a Hijri tenant is a change to every table on every page, for unclear benefit: a Hijri tenant reading a journal line dated 2026-03-14 is not confused by it. |

🔴 **Kept explicitly out so it cannot be absorbed.** "While we're in there" is how
a bounded change becomes an unbounded one, and this particular one would touch
every report table in the product.

---

## 5. F4 — an assumption, flagged as one — ✏️ AND THEN CHECKED (2026-08-16)

**The flag worked.** This section recorded F4 as unvalidated; the owner's
accountant then provided the first actual user input this product has had, and
the assumption was WRONG in one half: clients do think in yearly terms, not only
months and quarters — and their fiscal years genuinely vary (some January, some
not). The consequences are folded into F3/F4/F7/F12 above. The original
reasoning is kept below as written, because "we assumed X, flagged it, checked
it, and it was half-wrong" is exactly the record a flagged assumption should
leave behind.

---

The owner's answer, in their words: *"Assumption, not knowledge: they think in
months and quarters, with the annual filing handed to an accountant."*

**Consequences if it is right:** the picker is an accountant's tool, so it
belongs where an accountant looks (the reports themselves) rather than being
promoted to a primary navigation concept — and month/quarter shortcuts matter
more than the fiscal-year one.

**Consequences if it is wrong:** the shortcuts are ordered wrongly. That is a
cheap correction, which is why building on the assumption is acceptable.

🔴 **This is the second unvalidated user-behaviour assumption in the product**
(the first is the tax-treatment defaults, queue C9). Neither is dangerous alone;
both should be checked the first time a real tenant is available to ask. **There
are no users to observe yet** — the demo reviewer is an accountant, not an SME
owner, so he can confirm the accountant half and not the owner half.

---

## 6. F5 — accepting duplication, and what would reverse it

Twenty pages, three shapes:

| Shape | Pages | Control |
| --- | --- | --- |
| from/to date | most | two `<Input type="date">` |
| as-of date | Balance Sheet | one `<Input type="date">` |
| month range | VAT | two `<Input type="month">` |

One component covering three modes, landed across twenty pages in a single
change, is where shared components start going wrong. So: **add period
shortcuts to the pages that need them, leave the controls where they are.**

**The reversal condition, stated now so it is a decision and not a drift:** if a
*third* pattern appears — or if the same period logic has been pasted into more
than about five pages — extract then, with the shapes already known.

---

## 6b. F3 and F7 — costs, measured not guessed (2026-08-16)

**Estimates, not decisions.** The owner asked for costs before deciding; these
are recorded so the numbers survive the conversation. Grounded in counts, per
the cost-an-option-after-verifying-inputs lesson.

### F3 — Hijri dates inside reports

**The inputs exist.** Browsers ship full ICU, so
`Intl.DateTimeFormat('…-u-ca-islamic-umalqura')` renders Umm al-Qura
client-side with no API change (probed: 1 Muharram 1447 = 26 Jun 2025 — the
same externally-checkable fact as the M17.2 boot assertion, because "it didn't
throw" is not evidence).

**The cost driver is call sites, counted:** 35 date renders already route
through the two shared formatters (`formatDate` / `fmtDate`, 27 pages); 16 more
are raw `{tx.date}` interpolations (14 pages) that would need converting to the
formatter first. ≈ 50 touch points, almost all mechanical.

| Line | What it is | Cost | What it does NOT give |
| --- | --- | --- | --- |
| **Headers/period labels only** | Already the M20.3 plan | ~free (in M20.3) | Not what the accountant asked for — tables stay Gregorian. |
| **Dual display via the shared formatters** | Make the formatters calendar-aware (company `fiscal_calendar` via a hook/context); convert the 16 raw sites; render Hijri as a secondary small line/tooltip so columns do not double in width | **~3–5 days** | Date INPUTS stay Gregorian — only display converts. |
| **A toggle (one calendar at a time)** | Same plumbing + a persisted preference | +~1 day on the above | The accountant said **both**, which argues dual display, not a toggle. |

**Where the line sensibly falls (proposal):** headers ship with M20.3 as
planned; dual display in tables is its own milestone after M20, at the shared
formatters — never per-page. The 16 raw interpolations get converted to the
formatter regardless, because 16 bespoke date renders is the same disease as
20 bespoke date pickers.

**Both estimates were accepted 2026-08-16 and both features are now scheduled
(see §7). Owner's note, recorded because it is the operating lesson:** the
original "too expensive" (F3) and "out of scope" (F7) calls **were wrong**, and
they were made before anyone had asked a user. *"Asking cost less than assuming
would have."* The same shape as costing an option before verifying its inputs —
a scoping decision is only as good as the user fact it rests on.

### F7 — prior-period comparison (validated requirement, per the accountant)

**Backend: ~zero.** Every report service already takes explicit dates; a
comparison is two calls with two windows. No API change needed for v1.

**Frontend is the whole cost, and it scales with report count.** Each page
rolls its own table, so a side-by-side + variance column is per-page work
(~0.5–1 day each, incl. the dataviz rules: diverging palette for variance,
no status colours, table view).

| Scope | Cost |
| --- | --- |
| The three financial statements (income statement, balance sheet, cash flow) — this-year-vs-last-year and quarter-vs-quarter | **~1 milestone (3–5 days)** |
| All ~20 report pages | 3–4× that, and probably not what anyone asked for |

**Where it sits is the open decision** — the owner ruled it out of M20, and the
accountant's ask reads as the three statements, not all twenty.

---

## 7. Build order — ✅ APPROVED 2026-08-16 (proposed by Claude, approved with D-first amendment; F3/F7 appended after the accountant research)

The full sequence, in the owner's words: **"M20.0 → M20.3, then F3 dual
display, then F7 statements, then A, then B4."** (B5/D preceded M20 — expiring
facts outrank a defect nobody is currently reading.)

| # | Milestone | Content | Gate |
| --- | --- | --- | --- |
| **M20.0** | The lying column | `fiscal_year_start` nullable, no default, existing rows NULLed (F10); resolver and endpoint handle NULL; Company Settings asks. | — |
| **M20.1** | The default (F1) | Every report opens on the tenant's current fiscal year, or a rolling 12 months when undeclared — the report says which (F11, F13). 🔴 Release note required: reports change on open with no user action behind it. | M20.0 |
| **M20.2** | The shortcuts (F2, F6, F12) | Six shortcuts that SET the dates and stay editable; "Custom" when touched; Balance Sheet gets "as at FY-end". | M20.1 |
| **M20.3** | Hijri labels (F3, first half) | `FY 1447 (Jun 2025 – Jun 2026)` wherever a period is named. | M20.2 |
| **F3-dual** | Hijri in tables | Dual display at the shared formatters; the 16 raw interpolations converted first. | M20.3 |
| **F7-cmp** | Statement comparison | Income statement, balance sheet, cash flow: year-vs-year and quarter-vs-quarter. | F3-dual |
| **A** | GL owns cash | Transfers post through a contra, built on DECLARED transfer directions (B5). | — |
| **B4** | `invoice_payments` | Each payment its own dated row, on the existing pay path. | — |

Out of scope regardless (decided): prior-period comparison (F7), Analytics (F9),
in-table Hijri date conversion (F3).

## 8. As built

### M20.0 — the lying column (✅ merged 2026-08-16, PR #47)

Migration 0044: `fiscal_year_start` nullable, default dropped, **every
untouched row NULLed** (F10 — the stored January declarations were the
migration's own artifact, not tenant statements).
`GET /companies/current/fiscal-years` returns `declared: false` with
`current: null` and `periods: []` when undeclared — a consumer cannot receive
a resolved January year nobody declared. The resolver keeps its non-null
contract; "undeclared" is handled by its caller and never reaches it.
`fiscalYearStart: null` on the update path WITHDRAWS a declaration, and
Company Settings asks ("Not declared" is an explicit option — the M17.1
ownership posture) instead of showing a January it invented.

🔴 **What the milestone surfaced** (recorded in
[`findings-and-lessons.md`](../history/findings-and-lessons.md)): the
Company Settings submit still coerced `?? 1`, so saving an unrelated field
would have re-declared January — the write-boundary corollary ("a removed
default is an invariant; check every writer, not just the DDL"). And
standing-check part 6 fired correctly: the fiscal-year suite's first test
pinned "a fresh company defaults to a Gregorian January year" — correct when
written, a guard for the defect ever since — rewritten to pin the opposite,
plus a withdrawal test.

### M20.1 — the default window (✅ merged 2026-08-17, PR #48)

Sixteen report pages open on the tenant's **current fiscal year** when
declared (the resolver's boundaries — Gregorian or Hijri, never recomputed),
or a **rolling last 12 months** when undeclared (F11) with the inline notice
on the report itself (F13) linking to Company Settings. One data hook,
`useReportDefaultRange`, owns the decision; the twenty bespoke date controls
stay (F5 barred a shared component, not a shared decision). Pages gate
mounting on the resolved range so the wrong window is never queried, even
for a frame.

Honesty details: a FAILED settings fetch falls back to rolling with **no
notice** (claiming "your year isn't set" would assert something unknown);
the rolling window is pure and tested with a pinned January case (a January
'now' must reach into the previous year); Company Settings invalidates the
generated fiscal-years query key, so declaring a year updates reports
immediately instead of after cache expiry. `VatReport` was verified OUT of
the defect class — it opens on empty month pickers and asserted nothing.

Release note: [`m20-1-report-default-windows.md`](../release-notes/m20-1-report-default-windows.md)
(reports change what they show on open, with no user action behind it).

Remaining in M20: **M20.2** (shortcuts) and **M20.3** (Hijri labels).
