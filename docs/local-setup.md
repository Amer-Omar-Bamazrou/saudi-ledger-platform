# Local Setup

Get the Saudi Ledger Platform running on your machine — database, API, and web —
with a working admin account. Following this end to end takes ~10 minutes.

By the end you'll have: local Postgres (via Supabase), all migrations applied, a
seeded default organization + company + admin, the API on `:3000`, and the web
app on `:5173` where you can log in and use the platform.

---

## 1. Prerequisites

| Tool                | Version                | Notes                                                        |
| ------------------- | ---------------------- | ------------------------------------------------------------ |
| **Node.js**         | 24 (see `.nvmrc`)      | `nvm use` picks it up. Newer majors may work but 24 is pinned. |
| **pnpm**            | 11 (see `packageManager`) | `corepack enable && corepack prepare pnpm@11 --activate`. This repo is **pnpm only** — a preinstall guard rejects npm/yarn. |
| **Supabase CLI**    | latest                 | Provides local Postgres. See <https://supabase.com/docs/guides/cli>. |
| **Docker**          | running                | The Supabase CLI runs Postgres (and friends) in Docker.      |

> We use Supabase for **local Postgres only** — not Supabase Auth. Any Postgres
> 16/17 instance works if you'd rather not use the Supabase CLI; you'd then set
> `DATABASE_URL` yourself and create the non-owner `authenticated` role manually
> (see [Troubleshooting](#7-troubleshooting)).

---

## 2. Install dependencies

```bash
git clone <repo-url> saudi-ledger-platform
cd saudi-ledger-platform
pnpm install
```

---

## 3. Start the database (Supabase local)

```bash
supabase start
```

This boots Postgres and prints a set of URLs. The ones that matter:

- **DB**: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- **Studio** (a web DB browser): <http://127.0.0.1:54323>

Leave it running. `supabase stop` shuts it down; `supabase status` reprints the
URLs. The local DB already includes the non-owner `authenticated` role that the
app drops to for Row-Level Security — no extra setup needed.

---

## 4. Configure environment

Copy the example env files and fill in the one required secret.

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

**`apps/api/.env`** — the defaults match Supabase local. The only value you must
change is `SESSION_SECRET`, which **must be at least 32 characters** (the app
refuses to boot otherwise — there is no insecure fallback):

```bash
# generate a strong secret
openssl rand -base64 48
```

Paste the result as `SESSION_SECRET`. The other defaults (`DATABASE_URL`, `PORT=3000`,
`CORS_ALLOWED_ORIGINS`, `DB_APP_ROLE=authenticated`) are fine for local dev.

**`apps/web/.env`** — the defaults (`PORT=5173`, `BASE_PATH=/`,
`API_PROXY_TARGET=http://localhost:3000`) are fine as-is.

> **Config is loaded in two different ways** — this trips people up:
> - The **API** loads `apps/api/.env` automatically (`dotenv`) when you run it.
> - The **database tooling** (`migrate`, `seed`) does **not** read any `.env`
>   file — it reads `DATABASE_URL` (and `SEED_ADMIN_*`) from your **shell
>   environment**. So the migrate/seed commands below set those inline.

---

## 5. Apply migrations and seed

Schema is managed with **versioned SQL migrations** (never `drizzle-kit push`).
Apply them, then seed the bootstrap tenant + admin.

Set the DB URL for your shell, then run migrate + seed:

**bash / zsh (macOS, Linux, Git Bash):**

```bash
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

pnpm --filter @workspace/db run migrate

SEED_ADMIN_EMAIL="you@example.com" \
SEED_ADMIN_PASSWORD="choose-a-strong-password" \
SEED_ADMIN_NAME="Your Name" \
  pnpm --filter @workspace/db run seed
```

**PowerShell (Windows):**

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

pnpm --filter @workspace/db run migrate

$env:SEED_ADMIN_EMAIL = "you@example.com"
$env:SEED_ADMIN_PASSWORD = "choose-a-strong-password"
$env:SEED_ADMIN_NAME = "Your Name"
pnpm --filter @workspace/db run seed
```

The seed is **idempotent** — safe to re-run. It:

- creates the **Default Organization** + **Default Company** (the bootstrap
  tenant every pre-existing row belongs to),
- creates the **admin user** from `SEED_ADMIN_*` **and an active admin
  membership** linking that user to the default org (without the membership the
  admin would get 403 on every business route), and
- seeds the **permission matrix** (role → resource → action).

Expected output:

```
[seed] default tenant ready: organization=… (created), company=… (created)
[seed] admin user created: you@example.com (membership created)
[seed] permissions: 217 inserted, 217 total
```

> `SEED_ADMIN_PASSWORD` must be at least 8 characters. If you omit
> `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`, the admin step is skipped and only the
> tenant + permissions are seeded (you then won't have a login).

### 5b. Sample data (recommended — otherwise every report is empty)

The base seed gives you a tenant and a login, and **nothing to look at**. This
step fills the org with a few months of documents so the statements, VAT
return, aging reports and Analytics have real figures in them:

```bash
pnpm --filter @workspace/api-server run seed:sample
```

It reads `apps/api/.env`, so it uses the same database the API does — you do
**not** need to export `DATABASE_URL` for this one. It needs `SEED_ADMIN_EMAIL`
to know whose organization to fill; if it is not already in `apps/api/.env`,
pass it inline:

```bash
SEED_ADMIN_EMAIL="you@example.com" pnpm --filter @workspace/api-server run seed:sample
```

You get: 2 customers, 2 vendors, a bank account, **5 issued invoices** (one paid
in full, one part-paid), **3 approved bills** (one paid), **5 uncategorised bank
transactions**, an **approved quotation** and an **approved purchase order**.

Three things about it worth knowing:

- **Every figure goes through the product's own write paths.** Invoices and
  bills are created and approved exactly as your clicks would, so the GL
  entries, VAT lines and audit rows are real. Nothing is INSERTed into the
  ledger directly.
- **It sets the company's VAT and CR numbers.** Without them nothing can be
  issued at all — issuance fails closed on a missing VAT number, by design.
  The values are obvious test numbers in the valid format.
- **The bank transactions are deliberately left uncategorised.** An accepted
  uncategorised row posts to a visible **SUSPENSE** balance rather than being
  guessed into a category. Categorising them from `/review` clears it — that is
  the intended demonstration, not a defect.

Re-running is a no-op. If it fails part-way, it tells you how to recover.

---

## 6. Run the apps

Two long-running processes — use two terminals. Each reads its own `.env`.

**Terminal 1 — API (`:3000`):**

```bash
pnpm --filter @workspace/api-server run dev
```

This bundles with esbuild and starts the server. It logs `Server listening` on
port 3000.

**Terminal 2 — web (`:5173`):**

```bash
pnpm --filter @workspace/bookkeeping run dev
```

The web app calls the API **same-origin** at `/api`. In local dev the Vite dev
server **proxies `/api` → the API on `:3000`** (configured in
`apps/web/vite.config.ts`, dev-only — it has no effect on the production build).
So you only ever open the **web** URL:

**Open <http://localhost:5173>** and log in with the `SEED_ADMIN_*` credentials
you seeded. You should land in the dashboard and be able to open Transactions,
Invoices, Reports, etc.

### Quick sanity check (optional, no browser)

```bash
# through the web origin — exercises the dev proxy end to end
curl -s -c cookies.txt -X POST http://localhost:5173/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"choose-a-strong-password"}'

curl -s -b cookies.txt http://localhost:5173/api/transactions
# → {"transactions":[],"total":0,"offset":0,"limit":50}   (200, not 403)
```

---

## 6b. What your login can and cannot reach

The seeded account is an **`admin` of the default organization**, and the
organization is seeded **`approved`**, so the M11.2 verification gate does not
stand in your way. Admin is the highest of the four tenant roles (admin >
accountant > bookkeeper > viewer) and every business feature — invoices, bills,
quotations, purchase orders, journal entries, payroll, reports, Analytics,
company settings, user management — is reachable from the sidebar.

Three exceptions worth knowing before you go looking for them:

**1. The platform-operator surface is a SEPARATE account, not a permission.**
`/operator` reviews other tenants' signup applications — it is platform-staff
work, so no amount of tenant admin reaches it. Seed one if you want to see it:

```bash
SEED_OPERATOR_EMAIL="operator@example.com" SEED_OPERATOR_PASSWORD="choose-a-strong-password"   pnpm --filter @workspace/db run seed
```

Then log in as that account. It has no organization membership, so it sees the
operator queue and nothing else — that separation is the point.

**2. Three API routes have no UI at all**, for anyone: `/period-locks` (so a
period cannot be closed from the product yet — a known gap), `/audit-logs` (the
trail is written but has no reader screen), and `/llm` (inert, parked with the
AI work). They are listed as known gaps in
`apps/api/src/tests/route-reachability.test.ts`; you are not missing a menu.

**3. ZATCA e-invoicing cannot complete locally.** The onboarding screen works
and will build a CSR, but issuing to ZATCA needs a real Saudi VAT registration
and ERAD credentials that do not exist yet. Invoices still post to the ledger
normally — issuance is what is unavailable, and it fails closed with a clear
message rather than pretending.

Nothing else is gated, hidden, or feature-flagged off.

---

## 7. Troubleshooting

**`SESSION_SECRET must be at least 32 characters` at boot.** The API validates
all config at startup (`@workspace/config`). Generate a longer secret
(`openssl rand -base64 48`) and put it in `apps/api/.env`.

**`DATABASE_URL, ensure the database is provisioned` from migrate/seed.** The DB
tooling reads `DATABASE_URL` from the **shell**, not `.env`. Export it first (see
§5). Confirm the DB is up with `supabase status`.

**Login works but every `/api/...` call is 403.** The logged-in user has no
active organization membership. Re-run the seed (§5) with `SEED_ADMIN_*` set — it
backfills the membership for an existing admin too.

**`role "authenticated" does not exist`** (only if you're **not** using the
Supabase CLI). The app drops to a non-owner `authenticated` role for RLS, and
migration `0004` grants to it. Create it once:

```sql
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO postgres;
```

**Web loads but API calls 404 / don't reach the API.** Make sure the API is
running on `:3000` and that you're opening the **web** URL (`:5173`), not calling
`/api` on some other origin. The proxy target is `API_PROXY_TARGET` in
`apps/web/.env` — point it at your API if you changed its port.

**Git Bash on Windows mangles `BASE_PATH=/`.** MSYS rewrites a lone `/` into a
Windows path. Set `BASE_PATH` in `apps/web/.env` (recommended) rather than on the
command line, or prefix the command with `MSYS_NO_PATHCONV=1`.

**Start over with a clean database.**

```bash
supabase db reset      # drops + recreates the local DB
# then re-run §5 (migrate + seed)
```

---

## 8. Useful commands

```bash
pnpm run typecheck                               # typecheck the whole repo
pnpm run build                                   # typecheck + build every workspace
pnpm --filter @workspace/api-server run test     # backend tests (Vitest, no DB needed)
pnpm --filter @workspace/db run test             # DB tests: cross-tenant RLS isolation + rollback
pnpm --filter @workspace/db run generate         # generate a new versioned migration from schema
pnpm --filter @workspace/api-spec run codegen    # regenerate the API client + Zod from OpenAPI
```

Next, read **[`development-guide.md`](./development-guide.md)** to understand the
layering, tenancy, RBAC, and audit patterns before writing code.
