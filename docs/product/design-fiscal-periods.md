# Fiscal periods in reports — DECISION RECORD

**Decided 2026-08-16 with the owner, by interview.** Round 4, after Zakat,
the Finance Hub and Analytics.

This closes the gap M17.2 opened deliberately: `fiscalYearStart` gained a
resolver, a calendar basis, an endpoint and a settings page — and **no report
consumer**. The producer has existed for five milestones with one reader.

---

## 1. The decisions

| # | Question | Decision |
| --- | --- | --- |
| **F1** | Default window, or picker? | **Both — the DEFAULT FIRST, and it is a BUG, not a feature gap.** |
| **F2** | Which pages keep arbitrary dates? | **All of them.** Free dates *plus* period shortcuts everywhere; nothing becomes period-only. Balance Sheet gets "as at FY-end" as a shortcut. |
| **F3** | What a Hijri tenant sees | **Labels and boundaries: yes. Dates inside reports: NO** — explicitly out, and kept separated so it cannot be absorbed later. |
| **F4** | Does "FY 2026" mean anything to an SME owner? | **Assumption, not knowledge:** they think in months and quarters, with the annual filing handed to an accountant. The picker is largely **for the accountant**. 🔴 Recorded as UNVALIDATED. |
| **F5** | Twenty bespoke date controls | **Accept the duplication.** Add period support where needed; revisit only if a third pattern appears. |
| **F6** | Period vs custom dates | **A shortcut, never a mode.** Picking a period sets the dates; they stay editable; the label reverts to "Custom" when touched. |
| **F7** | Prior-period comparison | **OUT OF SCOPE.** Two-column layouts across every report is its own milestone. |
| **F8** | Undeclared fiscal year | **NULL is a first-class state** — ask, never silently assume January. Historical periods **keep their original boundaries**; no recomputation. |
| **F9** | Scope | **Reports only** for now. Analytics stays month-based. |

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
- 🔴 decide what happens to existing rows. Every current row holds `1`, and
  that `1` is indistinguishable from a deliberate January declaration. There are
  no customers, so the honest move is to **NULL them all** and let the (two)
  real tenants re-declare — a backfill that preserves the value would preserve a
  fiction.
- treat NULL as "not declared" everywhere the resolver is called.

**What reports do while it is NULL** — the decision F8 forces, stated so it is
not resolved by drift later:

> The default window falls back to a **rolling last-12-months**, and the page
> says the fiscal year has not been declared, with a link to Company Settings.

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

## 5. F4 — an assumption, flagged as one

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

## 7. Build order (not started)

| # | Milestone | Content | Gate |
| --- | --- | --- | --- |
| **M20.0** | The lying column | `fiscal_year_start` nullable, no default, existing rows NULLed; resolver and endpoint handle NULL; Company Settings asks. | — |
| **M20.1** | The default (F1) | Every report opens on the tenant's **current fiscal year**, or a rolling 12 months when undeclared — with the page saying which. | M20.0 |
| **M20.2** | The shortcut (F2, F6) | Period shortcuts that SET the dates and leave them editable; "Custom" when touched. Balance Sheet gets "as at FY-end". | M20.1 |
| **M20.3** | Hijri labels (F3) | `FY 1447 (Jun 2025 – Jun 2026)` where a period is named. Dates inside tables unchanged. | M20.2 |

Out: prior-period comparison (F7), Analytics (F9), in-table date conversion (F3).
