# Base44 Dev Environment

## What this is

The Base44 dev compose (`docker-compose.base44.yml`) runs the Saudi Ledger Platform
from bind-mounted source: PostgreSQL, the Express API, and the Vite web app.

## Architecture

- **Single origin**: the Vite dev server on port 3000 proxies `/api` → the API
  (`api:3000`) inside the compose network. Only port 3000 is exposed to the host.
- **PostgreSQL 16** with a non-owner `authenticated` role (created by
  `docker-init.base44.sql`) — the app drops to this role per request so RLS is
  enforced.
- **Frontend hot reload**: Vite watches source files.
- **Backend no hot reload**: the API's dev script is `esbuild bundle + node start`.
  Restart the `api` service after backend changes:
  `docker compose -f docker-compose.base44.yml restart api`.

## Services

| Service   | Role                                      |
| --------- | ----------------------------------------- |
| postgres  | PostgreSQL 16 + `authenticated` role      |
| install   | One-shot `pnpm install --frozen-lockfile` |
| migrate   | One-shot drizzle migrations + seed        |
| api       | Express API on :3000 (internal)            |
| web       | Vite dev server on :3000 (host-exposed)   |

## Secrets

- `SESSION_SECRET` (required, min 32 chars) — auto-generated for development via
  the Base44 platform. Stored in `/run/base44/app.env`, delivered to the `api`
  service via `env_file`. A placeholder in `.env.base44-defaults` is overridden by
  the real value.

## Seeded admin login

- Email: `admin@ledger.local`
- Password: `Admin123456!`

## Common commands

```bash
# Start everything
docker compose -f docker-compose.base44.yml up -d

# Check status
docker compose -f docker-compose.base44.yml ps

# View logs
docker compose -f docker-compose.base44.yml logs -f api web

# Restart the API after backend code changes (no hot reload)
docker compose -f docker-compose.base44.yml restart api

# Re-run migrations + seed
docker compose -f docker-compose.base44.yml run --rm migrate
```

## Verification

1. `docker compose -f docker-compose.base44.yml ps` — all services up/healthy.
2. `curl -s http://localhost:3000` — web app HTML (Vite dev server).
3. `curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@ledger.local","password":"Admin123456!"}'` — returns 200 with a session cookie.
4. Log in at the preview URL with the seeded admin credentials.

## Quirks

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (1-day supply-chain defense).
  With `--frozen-lockfile` this does not block installation.
- The `preinstall` guard rejects npm/yarn — pnpm only (handled by corepack).
- Node 22 is used (matching the project Dockerfile) despite `engines: >=24`.
- The Vite config already sets `allowedHosts: true`, so the preview origin is accepted.
