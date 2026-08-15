# Railway DEMO deployment — DECISION RECORD (parked)

**Decided 2026-08-15 with the owner. PARKED — not built.** Recorded so none of
it needs re-deciding when it is picked back up.

**What this is:** a demo so an accountant can look at the product. **Not a
launch.** No real business data, no customers. The pre-production queue is
deliberately still open; this deployment is shaped so the things the queue
protects **do not exist in it** rather than being switched off.

---

## The decisions

| # | Decision |
| --- | --- |
| **D1** | **Option A — satisfy the production guards truthfully.** Real Resend key + verified sender, real webhook for alerting, real AWS KMS key. **No code change, no guard weakened.** |
| **D2** | 🔴 **Never lower `NODE_ENV`.** See the reasoning below — it is the whole basis of D1. |
| **D3** | **Document capture disabled.** |
| **D4** | **Signup disabled.** One shared login. |
| **D5** | **ZATCA off** — `ZATCA_WORKER_ENABLED=false`, no company onboarded. |
| **D6** | **Weekly reset**, and 🔴 **it must be verifiable** (D9). |
| **D7** | **Server-driven banner**, both languages, on every page including login. |
| **D8** | **Obviously invalid VAT number** on the demo company. |

---

## D2 — why `NODE_ENV` must not be lowered

Three guards refuse under `NODE_ENV=production`: `ZATCA_KMS_PROVIDER='local-dev'`,
`MAIL_PROVIDER='none'`, `ALERT_PROVIDER='none'` (plus `ZATCA_ARCHIVE_DIR` must be
absolute under `local-fs`). The tempting escape is to run the demo as
non-production so none of them fire.

🔴 **`NODE_ENV` conflates two unrelated things:**

1. **Security posture** — `secure: isProduction` on the session cookie,
   `trust proxy`. A public HTTPS URL needs this unconditionally.
2. **"Am I serving real tenants?"** — which is what the queue guards actually
   mean.

A demo is the first and not the second. Lowering `NODE_ENV` to dodge the guards
would trade a **boot-time refusal** for a **real weakness**: a session cookie
without `Secure` over a public URL. That is strictly worse than the thing being
avoided, and it is why D1 is the answer rather than the easier route.

**The load-bearing fact behind D1:** with ZATCA off and no company onboarded,
the KMS wrapper is never invoked and the outbox is always empty. The subjects
the guards protect do not exist in this deployment, so satisfying the guards is
honest rather than ceremonial. It is also literally the "remaining deployment
step" queue items B1 and B2 already record.

**The rejected alternative (Option B)** was a demo profile that removes the
guarded capabilities and refuses to boot unless they are off. More principled in
the abstract, but it is new guard-shaped code and a new flag that could be
misused later. Not worth it for one demo — revisit only if D1 becomes
unworkable.

---

## D3 — why capture in particular

C8/PDPL is unanswered, and a promoted capture is undeletable by design
(`ArchiveStore` has no `delete`). A demo actively invites someone to photograph
a real supplier invoice containing a third party's details. It is the one place
this deployment could do **irreversible** harm, so it is off — not because it
would break, but because it would work.

---

## D9 — 🔴 the weekly reset must be VERIFIABLE

Added by the owner, and it is the sharpest requirement here.

The banner says *"data is wiped weekly"*. That is a **claim made to the user**.
If the reset job fails silently, the claim becomes false and nobody finds out —
and the people relying on it are exactly those who typed something they
shouldn't have.

So the reset is not a cron job that hopefully runs. It must:

- **record each run** (when, what it deleted, whether it completed);
- **surface the last successful run** where the claim is made — the banner
  should be able to say *"last reset: 3 days ago"* rather than asserting a
  schedule it cannot see;
- **alarm on a missed window** (the B2 alerter is configured under D1 anyway, so
  there is a real destination for it);
- **fail loudly** rather than partially — a half-completed reset that leaves
  some tenant data behind is worse than a refusal, because the banner still
  claims a wipe happened.

This is the "who finds out?" lesson applied to our own promise: silence is not a
neutral outcome, and a claim nobody verifies is the same defect as an alarm
nobody receives.

---

## D10 — the demo data must survive being played with

Also added by the owner. The seed must let the reviewer **upload the sample CSV
and watch the liquidity claim get withheld** — without breaking the seed.

Concretely:

- Seeded state is **claimable**: every balance-sheet account classified,
  suspense zero, so the Finance Hub shows its plain-language sentence.
- Uploading `saudi-sme-statement-jul-2026.csv` and accepting the uncategorised
  rows posts them to **SUSPENSE**, which flips `claimable` to false and shows
  the blocker with its amount.
- That is **the more interesting half of the demo**: not that the platform can
  compute a ratio, but that it knows when not to state one.
- So the seed must not pre-empt it (no pre-existing suspense balance, no
  unclassified accounts) and must be restorable by the reset.

---

## Deployment shape (as assessed, unverified)

Three services: API (Node), web (static build), Postgres. 🔴 **The API does not
serve the frontend** — there is no `express.static` — so the web build needs its
own service or a small change to serve it. Railway Postgres replaces Supabase,
so `SUPABASE_*` is unset and Supabase Storage is unavailable; D3 removes the
only feature that needed it.

**Cost: roughly $10–20/month** (Railway Hobby $5 including usage; AWS KMS ~$1;
Resend and Slack free tiers). ⚠️ **Verify Railway's current pricing when this is
picked up** — owner instruction, deliberately not done now, and their rates have
changed before.

---

## Expect this feedback

An accountant will go straight for Zakat ("not implemented"), the VAT return
(reconcile-grade in places, by design) and `fiscalYearStart` not driving report
periods. Those are known-honest gaps that the product labels as such — but the
demo is inviting comment on exactly them, which is probably the point.
