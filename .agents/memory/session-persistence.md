---
name: Session persistence
description: connect-pg-simple createTableIfMissing silently fails without a TTY; must create user_sessions table manually via psql
---

## Rule
Always create the `user_sessions` table via raw SQL before starting the API server. Do not rely on `createTableIfMissing: true`.

## Why
connect-pg-simple's `createTableIfMissing` option requires an interactive prompt in some environments. When running in a non-TTY shell (Replit workflow), it fails silently — the store initializes but no table is created, so every session lookup returns nothing and all requests return 401.

## How to apply
Run this once after setting up the app:
```sql
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
```
