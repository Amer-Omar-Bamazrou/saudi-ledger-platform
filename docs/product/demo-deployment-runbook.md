# Demo deployment — Railway runbook

**Status: the codebase is ready; nothing is deployed.** The decisions this
implements are in [`demo-deployment-decisions.md`](demo-deployment-decisions.md)
(D1–D10). This file is the operational half: what to click, in what order, and
how to tell it worked.

> ⚠️ **Railway's pricing is NOT verified** — deliberately, per the owner's
> instruction to check it at pick-up time rather than in advance. The figures in
> the decision record ($10–20/month) are an estimate from before that
> instruction. **Check the current Hobby plan price and its included usage
> before creating the project.**

---

## 0. What you are deploying

**One Railway project, two services:**

| Service | What it is |
| --- | --- |
| **Postgres** | Railway's managed Postgres. Replaces the local Supabase stack. |
| **App** | One container: the API, serving the built frontend from the same origin. |

🔴 **One origin, on purpose.** Auth is an httpOnly session cookie with
`sameSite: strict`. Splitting the frontend onto its own static host would force
`SameSite=None` plus a credentialed CORS allow-list — relaxing two cookie
protections to solve a hosting-layout problem. `SERVE_WEB_DIST` (new, default
unset, unused by any other deployment) points the API at the SPA build instead.

**Supabase Storage is gone** with it. Nothing in the demo needs it: document
capture is refused (D3), which was its only consumer.

---

## 1. Before you touch Railway — three accounts you need

The app **refuses to boot** in production without these. That is deliberate and
predates the demo (queue items B1, B2, and the KMS posture); none of it is
relaxed for a demo, so budget the ten minutes.

| What | Why the app insists | Cost |
| --- | --- | --- |
| **A mail provider** — Resend or Postmark. Verify a sending domain, get an API key. | `MAIL_PROVIDER=none` is refused in production: an invitation or renewal reminder that silently reaches nobody is invisible until the thing it guarded has happened. | Free tier is enough. |
| **An alert webhook** — a Slack incoming webhook is the fastest. | `ALERT_PROVIDER=none` is refused in production for the same reason. On the demo it is also what tells you the **weekly reset stopped working**. | Free. |
| **An AWS KMS key** — symmetric, one region. | `ZATCA_KMS_PROVIDER=local-dev` is refused in production; it would wrap tenant signing keys with a key from an env var. | ~$1/month. |

**On the KMS key specifically — read this before you spend the dollar.** The AWS
SDK is loaded **lazily**, on the first key wrap/unwrap. The demo never performs
one: ZATCA transmission is refused at boot and ZATCA onboarding is refused at
the route, so no signing key is ever created. Consequences, stated plainly:

- Setting `ZATCA_KMS_PROVIDER=aws-kms` with a **placeholder** key id would pass
  the boot guard and never be detected, because nothing calls AWS. That is
  satisfying a guard's letter while defeating its purpose, and it is the exact
  move the guard exists to prevent someone making later.
- So **create a real key**. A dollar a month buys a configuration that is
  *true*, not a configuration that merely boots.
- 🔴 It does **not** buy evidence the KMS path works. Queue item C3 (IAM policy,
  deletion window, CloudTrail alarm, multi-region replica) is untouched by this
  deployment, and a green demo says nothing about it.

`AWS_REGION` and the access keys are read by the AWS SDK from the environment,
not by `loadEnv` — the demo works without them, and they are listed below so the
configuration is complete rather than accidentally-sufficient.

---

## 2. On the Railway website, in order

### 2.1 Create the project and the database

1. **New Project** → **Deploy PostgreSQL**. Wait for it to go green.
2. **New** → **GitHub Repo** → pick `saudi-ledger-platform`, branch `main`.
   Railway finds the `Dockerfile` and `railway.json` at the repo root; leave the
   builder alone.
3. Open the app service → **Settings** → **Networking** → **Generate Domain**.
   Note the URL — you need it for `CORS_ALLOWED_ORIGINS` in the next step.

### 2.2 Set the variables on the APP service

**Variables** → **Raw Editor**, paste, then fill in the blanks:

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=<paste 48+ random chars>
CORS_ALLOWED_ORIGINS=https://<your-app>.up.railway.app

DEMO_MODE=true
DEMO_ADMIN_EMAIL=<the address your reviewer will log in with>
DEMO_ADMIN_PASSWORD=<16+ chars — this is a public URL>
DEMO_RESET_INTERVAL_DAYS=7

ZATCA_WORKER_ENABLED=false
ZATCA_KMS_PROVIDER=aws-kms
ZATCA_KMS_KEY_ID=<your KMS key ARN>
AWS_REGION=<the key's region>
AWS_ACCESS_KEY_ID=<...>
AWS_SECRET_ACCESS_KEY=<...>
ZATCA_ARCHIVE_PROVIDER=local-fs
ZATCA_ARCHIVE_DIR=/app/archive

MAIL_PROVIDER=resend
MAIL_API_KEY=<...>
MAIL_FROM=demo@<your verified domain>

ALERT_PROVIDER=webhook
ALERT_WEBHOOK_URL=<your Slack incoming webhook>
ALERT_REPEAT_HOURS=6
```

`${{Postgres.DATABASE_URL}}` is Railway's reference syntax — type it literally;
it resolves to the database service's URL.

`ZATCA_ARCHIVE_DIR=/app/archive` is inside the container, so it is **lost on
every redeploy**. That is acceptable here and only here: nothing is ever
archived, because nothing is ever issued. On a real deployment this must point
at durable storage — which is why the absolute-path guard exists.

**Do NOT set `PORT`.** Railway injects it.

**Do NOT lower `NODE_ENV`.** Every refusal above exists because a demo is the
exact situation where "just for now" gets typed.

### 2.3 Deploy

Railway builds the image, runs `pnpm --filter @workspace/db run migrate` as the
**pre-deploy command** (from `railway.json`), then starts the API.

On first boot the API **seeds the demo tenant itself** — org
`DEMO — Falcon Trading Est.`, seven months of invoices and bills posted through
the product's own write paths, a bank account, two budgets, and the login from
`DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` as an **admin** of that org. It is
idempotent; every later boot is a no-op.

### 2.4 If the deploy fails at boot

The error names the variable. `loadEnv` aggregates every problem into one
message, so read the whole list rather than fixing them one at a time.

---

## 3. Verify it — six checks, in order

1. **`https://<app>/api/healthz`** → `{"status":"ok"}`.
2. **Open the app.** An amber banner in English on the login page, before you
   log in: *"DEMO — sample data for a fictional company…"*. Switch the language
   toggle to Arabic — the banner must change with it. There is **no
   "Create an account" link**.
3. **Log in** with the demo credentials. The dashboard routes; Reports, Finance
   Hub and Analytics all have content.
4. **Finance Hub** — the liquidity claim is **stated**, not withheld. That is
   the seeded starting position and it is what makes the next check a
   demonstration.
5. **Upload `saudi-sme-statement-jul-2026.csv`** (Upload page), accept a row the
   categorizer could not classify, then reopen Finance Hub: the liquidity claim
   is now **withheld**, naming the suspense balance. *That* is the thing worth
   showing an accountant.
6. **Confirm the refusals are server-side**, not just hidden:
   ```
   curl -i https://<app>/api/auth/signup -X POST -H 'content-type: application/json' -d '{}'
   ```
   → `403` with `"code":"demo_mode"`.

---

## 4. The weekly reset, and how you know it is working

Every 7 days the demo wipes itself and re-seeds. The reset is a **transaction**
(truncate + re-seed), so it cannot half-apply, and every run is recorded in
`demo_reset_runs`.

🔴 **The banner does not promise a schedule — it reports the last wipe that
actually happened.** Three states, all server-driven:

| State | Banner says |
| --- | --- |
| Never reset yet (normal for the first week) | "Data is wiped every 7 days; the first wipe has not run yet." |
| Reset on schedule | "…last wiped 23 Aug 2026." |
| Reset overdue | "The scheduled wipe is **overdue** — last completed …" |

And an alarm (`demo-reset-overdue`) pages your webhook once the last success is
more than 8 days old. **If the reset silently dies, the banner retracts the
claim and Slack tells you** — that was the owner's condition for shipping it.

**To force a reset**, redeploy with `DEMO_RESET_INTERVAL_DAYS=1`, wait for the
hourly job, then set it back. There is no operator button for it yet.

### The guard on the reset

`runDemoReset` TRUNCATEs every tenant table. `DEMO_MODE` is the **trigger**, not
the safety mechanism. The safety mechanism is a precondition the real platform
cannot satisfy: **the database must contain exactly one organization, and it
must be the demo.** Point `DEMO_MODE=true` at a database holding real tenants
and the reset refuses, records a failed run, and pages — it does not delete
anything. That refusal is asserted against real rows in
`apps/api/src/tests/demo-reset-guard.test.ts`.

---

## 5. What is switched off, and where the switch is

A demo **removes capabilities**; it silences no guard. Each of these is refused
at the route (server-side) *and* has its entry point hidden (cosmetic):

| Off | Refused at | Why |
| --- | --- | --- |
| Document capture | `POST /api/capture/*` → 403 | The one irreversible act. A promoted photograph enters an archive with no `delete` by design, and PDPL is unanswered (queue C8). |
| Public signup | `POST /api/auth/signup` → 403 | One shared login; no self-service tenants on a public URL. |
| ZATCA onboarding | `POST /api/zatca/onboarding/*` → 403 | It would take a real taxpayer's OTP and store a real signing key. |
| ZATCA transmission | refused at **boot** — `DEMO_MODE` + `ZATCA_WORKER_ENABLED` is a config error | A demo must never reach a government API. |

The demo company's VAT number is `399999999999993` — correctly shaped (15
digits, 3…3, so the product's own validators see realistic input) and
unmistakably fictional.

---

## 6. Handing it to your reviewer

Send: the URL, the email, the password, and one line of context —

> Sample data for a fictional company; it wipes itself weekly, so click
> anything. Nothing you do here reaches ZATCA or any real record.

The reviewer is an **admin** of the demo org (owner's decision): everything is
clickable, the weekly reset makes any mess temporary, and the acts that must not
happen are refused at the server for every role — not withheld by permission
grade.

Expect them to go straight at **Zakat** (the page says "not implemented"), the
**VAT return** (reconcile-grade in places, by design) and **`fiscalYearStart`**
not driving report periods. Those are labelled-honest gaps, and inviting comment
on them is most of the point.
