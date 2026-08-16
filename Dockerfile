# ═══════════════════════════════════════════════════════════════════════════
# Single-image build: the API, with the built frontend served from the same
# origin (docs/product/demo-deployment-decisions.md).
# ═══════════════════════════════════════════════════════════════════════════
#
# 🔴 ONE ORIGIN IS A SECURITY CHOICE, not a cost one. Auth is an httpOnly
# session cookie with `sameSite: strict`; a separate static host would force
# `SameSite=None` plus a credentialed CORS allow-list — two cookie protections
# relaxed to solve a hosting-layout problem. The API serves `/api`, and
# `SERVE_WEB_DIST` (default unset everywhere else) points it at the SPA build.
#
# Written for Railway but it is a plain Dockerfile: nothing here is
# platform-specific beyond honouring $PORT.

FROM node:22-slim AS build
WORKDIR /app

# pnpm via corepack — the repo's preinstall guard rejects npm and yarn.
RUN corepack enable

# Manifests first, so a dependency-free code change reuses the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json          apps/api/
COPY apps/web/package.json          apps/web/
COPY packages/db/package.json       packages/db/
COPY packages/config/package.json   packages/config/
COPY packages/api-spec/package.json packages/api-spec/
COPY packages/api-zod/package.json  packages/api-zod/
COPY packages/api-client-react/package.json packages/api-client-react/
COPY scripts/package.json           scripts/

RUN pnpm install --frozen-lockfile

COPY . .

# The web build reads BASE_PATH and PORT from the environment at BUILD time
# (apps/web/vite.config.ts throws without them). BASE_PATH=/ because the SPA is
# served from the origin root; PORT only satisfies that config's validation —
# the Vite dev server is never started in this image.
ENV BASE_PATH=/
ENV PORT=3000

# The libs are project references; both apps build against their emitted types.
RUN pnpm run typecheck:libs \
 && pnpm --filter @workspace/api-server run build \
 && pnpm --filter @workspace/bookkeeping run build

# ── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

# The API is an esbuild bundle, so its own dependencies are inlined — but
# drizzle-kit and the migration SQL are NOT: migrations run as a separate
# pre-deploy step from this same image, so the workspace has to be present.
COPY --from=build /app /app

# Where the SPA lives, for the API to serve. Overridable, but this is the path
# the image actually contains.
ENV SERVE_WEB_DIST=/app/apps/web/dist/public

# Railway injects $PORT; the app reads it through loadEnv.
EXPOSE 3000
CMD ["node", "--enable-source-maps", "apps/api/dist/index.mjs"]
