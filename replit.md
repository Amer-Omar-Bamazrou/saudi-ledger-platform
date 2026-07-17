# Saudi Bookkeeping Engine (KSA Ledger)

A fully operational, production-grade Saudi bookkeeping application. Handles transaction management, ZATCA VAT compliance (15%), Zakat asset calculation (2.5%), and multi-category Arabic/English bookkeeping — all with a deterministic local AI categorization engine and no external API dependencies.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at /api)
- `pnpm --filter @workspace/bookkeeping run dev` — run the React frontend (port 21462, served at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (artifacts/api-server)
- Frontend: React 19 + Vite + Tailwind CSS (artifacts/bookkeeping)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (zod/v4), drizzle-zod
- API codegen: Orval (from OpenAPI spec)
- Charts: Recharts
- Routing: Wouter

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/categories.ts` — categories table (30 canonical Saudi bookkeeping categories)
- `lib/db/src/schema/transactions.ts` — transactions table with VAT/Zakat fields
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod validation schemas (do not edit)
- `artifacts/api-server/src/routes/` — Express route handlers (transactions, categories, categorize, summary)
- `artifacts/api-server/src/lib/categorizer.ts` — Saudi categorization engine (deterministic, no external APIs)
- `artifacts/bookkeeping/src/` — React dashboard (dashboard, transactions, upload, VAT, Zakat, categories pages)
- `python-backend/` — Standalone Python/FastAPI version for local deployment (see python-backend/README.md)

## Architecture decisions

- **Deterministic categorization over LLM**: The categorizer uses compiled regex rules covering 200+ Saudi merchant patterns in Arabic and English, with explicit VAT and Zakat flags per rule. Confidence scoring allows the UI to highlight low-confidence matches for manual review.
- **Dual-stack delivery**: TypeScript/PostgreSQL stack runs in Replit; a complete Python/FastAPI/SQLite stack in `python-backend/` is ready for local deployment on any machine.
- **OpenAPI-first contract**: All endpoints defined in `lib/api-spec/openapi.yaml` before implementation. Codegen produces both server Zod validators and client React Query hooks in one command.
- **VAT at 15% (ZATCA standard)**: VAT amounts are auto-computed on categorization when the matched category is VAT-applicable. VAT-exempt categories (government fees, salaries, insurance) correctly flag with 0%.
- **Zakat nisab = SAR 19,550**: Based on ~85g gold equivalent. Zakat due = 2.5% of net zakatable assets only if above nisab.

## Product

- **Dashboard**: P&L summary cards (income, expenses, net position, VAT), cash flow bar chart, recent transactions table
- **Transactions**: Full ledger with search/filter, confidence score display, manual category override dialog
- **Categorization Engine**: One-click engine run on all uncategorized transactions, live results with matched rule and confidence
- **Upload**: CSV paste or manual row entry form, with auto-categorize toggle
- **VAT Report**: Output/Input VAT breakdown per ZATCA Q-filing requirements
- **Zakat Report**: Zakatable asset totals, Nisab check, 2.5% calculation
- **Categories**: Full chart of accounts management with Arabic names

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before touching backend or frontend code.
- The categorizer is in `artifacts/api-server/src/lib/categorizer.ts` — add new Saudi merchant patterns there.
- `numeric` columns from Drizzle return as strings — always wrap with `Number()` before arithmetic.
- Drizzle `where` with `and(...conditions)` throws on empty array — guard with `conditions.length > 0`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `python-backend/README.md` for full local Python deployment instructions
