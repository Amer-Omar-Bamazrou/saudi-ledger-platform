# KSA Ledger — Installation & Setup Tutorial

A step-by-step guide to cloning, configuring, and running the KSA Ledger ERP system locally in VS Code.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the Repository](#2-clone-the-repository)
3. [Open in VS Code](#3-open-in-vs-code)
4. [Install Dependencies](#4-install-dependencies)
5. [Set Up PostgreSQL](#5-set-up-postgresql)
6. [Configure Environment Variables](#6-configure-environment-variables)
7. [Push the Database Schema](#7-push-the-database-schema)
8. [Run the Project](#8-run-the-project)
9. [Project Structure](#9-project-structure)
10. [Recommended VS Code Extensions](#10-recommended-vs-code-extensions)
11. [Common Errors & Fixes](#11-common-errors--fixes)

---

## 1. Prerequisites

Install the following tools before you begin. Click each link for the official installer.

| Tool | Minimum Version | Download |
|---|---|---|
| **Node.js** | v20 or later | https://nodejs.org |
| **pnpm** | v9 or later | https://pnpm.io/installation |
| **PostgreSQL** | v14 or later | https://www.postgresql.org/download |
| **Git** | any recent version | https://git-scm.com |
| **VS Code** | any recent version | https://code.visualstudio.com |

### Verify your installations

Open a terminal and run:

```bash
node --version       # should print v20.x.x or higher
pnpm --version       # should print 9.x.x or higher
psql --version       # should print psql (PostgreSQL) 14.x or higher
git --version        # should print git version 2.x.x or higher
```

> **Note:** This project uses **pnpm** exclusively. Do not use `npm` or `yarn` — they will be rejected by a preinstall guard.

---

## 2. Clone the Repository

```bash
git clone https://github.com/fahoody236/Saudi-Ledger-Engine.git
cd Saudi-Ledger-Engine
```

To work on the main development branch:

```bash
git checkout fahad-branch
```

---

## 3. Open in VS Code

```bash
code .
```

Or open VS Code manually, choose **File → Open Folder**, and select the `Saudi-Ledger-Engine` folder.

---

## 4. Install Dependencies

From the root of the project (where `pnpm-workspace.yaml` lives), run:

```bash
pnpm install
```

This installs dependencies for all three workspaces at once:
- `artifacts/bookkeeping` — React frontend
- `artifacts/api-server` — Express backend
- `lib/db` — Drizzle ORM schema

> **Do not run `npm install` or `yarn install`.** The project will reject them.

---

## 5. Set Up PostgreSQL

### Option A — Local PostgreSQL (recommended for development)

1. Make sure PostgreSQL is running on your machine.
2. Open a terminal and connect to PostgreSQL:

```bash
psql -U postgres
```

3. Create a database for the project:

```sql
CREATE DATABASE ksa_ledger;
CREATE USER ksa_user WITH PASSWORD 'yourpassword';
GRANT ALL PRIVILEGES ON DATABASE ksa_ledger TO ksa_user;
\q
```

Your connection string will be:

```
postgresql://ksa_user:yourpassword@localhost:5432/ksa_ledger
```

### Option B — Cloud PostgreSQL (Neon, Supabase, Railway, etc.)

Sign up for any hosted PostgreSQL provider and copy the connection string they give you. It will look like:

```
postgresql://username:password@host:5432/dbname?sslmode=require
```

---

## 6. Configure Environment Variables

The project needs two `.env` files — one for the API server and one for the frontend.

### 6a. API Server — `artifacts/api-server/.env`

Create the file:

```bash
touch artifacts/api-server/.env
```

Paste in:

```env
# Database connection string (from Step 5)
DATABASE_URL=postgresql://ksa_user:yourpassword@localhost:5432/ksa_ledger

# Port the Express API server will listen on
PORT=8080

# A long random string used to sign session cookies
# Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=replace_with_a_long_random_string_at_least_32_chars
```

### 6b. Frontend — `artifacts/bookkeeping/.env`

Create the file:

```bash
touch artifacts/bookkeeping/.env
```

Paste in:

```env
# Port the Vite dev server will listen on
PORT=5173

# Base path for the frontend app (must match the API proxy config)
BASE_PATH=/

# URL of the API server (used by the frontend to call the backend)
VITE_API_BASE_URL=http://localhost:8080
```

> **Security:** Neither `.env` file is committed to git. Never commit real credentials.

---

## 7. Push the Database Schema

Once your `.env` is configured, push the Drizzle schema to create all tables:

```bash
pnpm --filter @workspace/db run push
```

This reads `lib/db/src/schema/` and creates every table (vendors, customers, invoices, journal entries, employees, etc.) in your PostgreSQL database.

> **First-time only.** You do not need to run this again unless you change the schema files.

If Drizzle asks you to confirm destructive changes, type `y` and press Enter.

---

## 8. Run the Project

The project has two separate servers that must both be running at the same time. Open **two terminals** in VS Code (`` Ctrl+` `` to open, then the `+` button to split).

### Terminal 1 — Start the API Server

```bash
pnpm --filter @workspace/api-server run dev
```

You should see:

```
Server listening  { port: 8080 }
```

### Terminal 2 — Start the Frontend

```bash
pnpm --filter @workspace/bookkeeping run dev
```

You should see:

```
VITE v7.x.x  ready in xxx ms
➜  Local:   http://localhost:5173/
```

### Open the app

Navigate to **http://localhost:5173** in your browser.

On first load, click **Create account** to register the first admin user. Subsequent accounts must be created from the User Management page inside the app.

---

## 9. Project Structure

```
Saudi-Ledger-Engine/
│
├── artifacts/
│   ├── bookkeeping/              ← React 18 + Vite frontend
│   │   └── src/
│   │       ├── pages/            ← One file per route/page
│   │       ├── components/       ← Shared UI components (Layout, shadcn/ui)
│   │       ├── contexts/         ← React context (Auth, Language/i18n)
│   │       ├── lib/              ← API client, utilities, Arabic helpers
│   │       └── App.tsx           ← Router + providers
│   │
│   └── api-server/               ← Express 5 + TypeScript backend
│       └── src/
│           ├── routes/           ← All API route handlers
│           │   ├── auth.ts       ← Login, register, session
│           │   ├── reports.ts    ← Trial Balance, Income Statement, etc.
│           │   └── *.ts          ← One file per entity
│           ├── lib/              ← Database connection, logger
│           └── app.ts            ← Express app setup + middleware
│
├── lib/
│   └── db/                       ← Shared Drizzle ORM layer
│       └── src/
│           ├── schema/           ← Table definitions (one file per table)
│           │   ├── vendors.ts
│           │   ├── customers.ts
│           │   ├── invoices.ts
│           │   └── ...
│           └── index.ts          ← Exports db client
│
├── pnpm-workspace.yaml           ← Monorepo workspace config
├── package.json                  ← Root scripts
└── TUTORIAL.md                   ← This file
```

---

## 10. Recommended VS Code Extensions

Install these from the VS Code Extensions panel (`Ctrl+Shift+X`):

| Extension | Purpose |
|---|---|
| **ESLint** (`dbaeumer.vscode-eslint`) | TypeScript/JS linting |
| **Prettier** (`esbenp.prettier-vscode`) | Code formatting |
| **Tailwind CSS IntelliSense** (`bradlc.vscode-tailwindcss`) | Autocomplete for Tailwind classes |
| **Drizzle ORM** (`drizzle-team.drizzle-vscode`) | Schema syntax highlighting |
| **PostgreSQL** (`cweijan.vscode-postgresql-client2`) | Browse your local DB visually |
| **Thunder Client** (`rangav.vscode-thunder-client`) | Test API endpoints without Postman |
| **Arabic Language Pack** (`ms-ceintl.vscode-language-pack-ar`) | Optional — Arabic UI for VS Code |
| **GitLens** (`eamodio.gitlens`) | Enhanced git history and blame |

---

## 11. Common Errors & Fixes

### `Error: PORT environment variable is required`
You are missing the `.env` file. Go back to **Step 6** and create both `.env` files.

### `Authentication failed for 'postgresql://...'`
Your `DATABASE_URL` credentials are wrong. Double-check the username, password, and database name match what you created in **Step 5**.

### `relation "users" does not exist`
The schema has not been pushed. Run the command in **Step 7**.

### `pnpm: command not found`
pnpm is not installed. Run:
```bash
npm install -g pnpm
```
Then re-run `pnpm install`.

### `CORS error` in the browser
Make sure both servers are running (Steps 8a and 8b) and that `VITE_API_BASE_URL` in `artifacts/bookkeeping/.env` points to the correct API port.

### `Error: Use pnpm instead`
You ran `npm install` or `yarn`. Delete `node_modules` and `package-lock.json`/`yarn.lock`, then use `pnpm install`.

---

## Tech Stack Summary

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS v4, shadcn/ui |
| Routing | Wouter |
| State management | TanStack Query (React Query v5) |
| Backend | Express 5, TypeScript, Node.js |
| Database | PostgreSQL |
| ORM | Drizzle ORM |
| Auth | Session-based (bcryptjs + connect-pg-simple) |
| Monorepo | pnpm workspaces |
| i18n | Custom LanguageContext (Arabic / English) |

---

*For questions or issues, open a GitHub Issue at https://github.com/fahoody236/Saudi-Ledger-Engine/issues*
