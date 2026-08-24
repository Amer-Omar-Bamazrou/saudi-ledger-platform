# State of the platform — snapshot, 2026-08-24

**Everything downstream is waiting on the Saudi entity registration. That is
the first fact of this document, not a section of it** — it gates the ZATCA
simulation and production pilot (the one unproven leg of the core product),
the A2 open-banking signatures, and therefore the first customer. No code
shortens it; only the owner can start it.

**Status (2026-08-24): a dated SNAPSHOT. Current state authority is
[CLAUDE.md §2](../../CLAUDE.md) — if this document and §2 disagree, §2 is
right and this file is history.**

## The owner's four actions, in the owner's chosen order (2026-08-24)

1. **The entity** — CR + VAT registration + ERAD. The long pole; everything
   below fits inside its shadow.
2. **The advisor conversation** — `advisor-questions.md` Blocks A–D plus the
   closed-month exception question. Gates the Zakat build (C10), the
   retention/PDPL design (C7/C8 — the risk not to carry past customer #1),
   the training-data question, and downstream the AI (b)-widening and
   opinion register.
3. **The Groq Enterprise agreement** (Dammam + contractual ZDR) — the single
   switch that turns AI-3b and AI-6a from dark to tenant-facing.
4. **The receipt corpus** — unblocks AI-4 (vision in A1).

## Genuinely done — working, tested, reachable today

The accounting product is complete for a Saudi SME: double-entry GL (one
writer per effect); invoices/bills/JEs/payroll through draft→approval;
credit notes with ceilings; quotations→invoices and POs→bills with partial
conversion and variance records; statement ingestion → review →
reconciliation → settlement through the real pay paths; transfers posting by
declared direction; dated payment history; period locks with the
closed-months surface and the no-backdating guard; the VAT return filed
line-level from documents; C12-verified invoice numbering; fiscal years in
both calendars across every report, dual dates, prior-period comparison;
Analytics and the Finance Hub with the withholding discipline; multi-tenancy
with RLS **including the FK blind spot closed**; 4-role RBAC; the audit
trail with its reader; onboarding/verification/operators/invitations;
recurring documents with rule health; phone capture staged-then-promoted;
the findings engine with its scheduler and escalation ladder; demo mode.
21 of 25 tax-treatment defaults are text-verified (C9 + C11); the four
assumed ones say so in the product.

**The honest asterisk:** ZATCA document CONSTRUCTION is proven against the
live sandbox; the production submission path
(`/invoices/{clearance,reporting}/single`) **has never been called in any
environment**. Built, unproven, entity-gated.

## Dark, pending one signature

AI-3b (verified explanations) and AI-6a (grounded answers, register A) are
built, tested, and invisible to tenants. The signed Enterprise agreement
plus the attestation string is the whole flip — config, not code, by
design. The categorizer's second opinion lights up with it.

## 🔴 The billing gap — a mechanical requirement, not a feature gap

**The platform cannot take money.** No subscription, no billing, no plan
gating exists — AI usage is metered per tenant, but no mechanism turns a
tenant into a *paying* tenant. **No billing means no revenue, whatever else
works** — it is the last mechanical requirement between a working product
and income. Queued as its own item in CLAUDE.md §5. For customer #1, an
invoice sent outside the product suffices; it stops sufficing quickly.

## Deployment-time items (engineering that needs no one's permission)

Hosting/region (C6's platform half) + KMS (C3); then the recorded env
facts: `TRUST_PROXY_HOPS`, mail provider (B1), alert webhook (B2), clamd
(C4), archive storage, `SESSION_COOKIE_SECURE`. All buildable inside the
entity's shadow.

## The shortest path to a first paying customer

Register the entity **(1)** while standing up production **(deployment
list)**; run ZATCA simulation then the production pilot — expecting *some*
rework despite the sandbox's coverage, because "no rework expected" is a
prediction, not a fact; make the pilot tenant the first paying customer —
one motion for sales, pilot, and proof — invoiced off-platform until
billing exists. The advisor conversation fits inside the same window and
de-risks the capture/PDPL posture before real third-party documents
accumulate.

**Not on the path:** the Groq agreement (AI is the moat, not the wedge),
AI-4, the opinion register, Zakat.
