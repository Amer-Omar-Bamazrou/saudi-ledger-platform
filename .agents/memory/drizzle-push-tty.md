---
name: Drizzle push TTY requirement
description: drizzle-kit push prompts interactively for schema conflicts; fails in non-TTY shells
---

## Rule
When adding new columns or tables to an existing schema in this project, apply changes with raw `psql` ALTER TABLE / CREATE TABLE rather than `pnpm --filter @workspace/db run push`.

## Why
`drizzle-kit push` detects conflicts (e.g. new columns, renamed tables) and opens an interactive prompt. In Replit's workflow shell (no TTY), it errors: "Interactive prompts require a TTY terminal". The push succeeds for net-new schemas (first run) but fails on subsequent modifications.

## How to apply
```bash
psql "$DATABASE_URL" << 'SQL'
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_hash text;
-- etc.
SQL
```
