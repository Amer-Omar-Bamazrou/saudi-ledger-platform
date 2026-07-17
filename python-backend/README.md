# Saudi Bookkeeping Engine — Local Setup Guide

A fully operational, production-ready bookkeeping application for Saudi businesses.
Handles VAT (15% ZATCA rate), Zakat compliance, and multi-category transaction management
using a deterministic local AI engine — **no external APIs required**.

---

## Architecture

```
python-backend/          ← Python / FastAPI backend (this folder)
│  main.py               ← FastAPI app, all REST endpoints
│  database.py           ← SQLAlchemy ORM + SQLite (ledger.db)
│  categorizer.py        ← Deterministic Saudi categorization engine
│  init_db.py            ← One-time DB initializer + category seeder
│  requirements.txt      ← Python dependencies

frontend/                ← React dashboard (index.html or the compiled dist/)
```

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Python      | 3.10+   |
| pip         | latest  |

> No Docker, no cloud services, no API keys needed.

---

## Step-by-Step Setup

### 1 — Clone / copy this folder

```bash
# If you downloaded from Replit, unzip the project and navigate here:
cd python-backend
```

### 2 — Create a virtual environment (recommended)

```bash
python -m venv .venv

# Activate it:
# macOS / Linux:
source .venv/bin/activate

# Windows (PowerShell):
.venv\Scripts\Activate.ps1

# Windows (cmd.exe):
.venv\Scripts\activate.bat
```

### 3 — Install Python dependencies

```bash
pip install -r requirements.txt
```

This installs:
- `fastapi` — async web framework
- `uvicorn` — ASGI server
- `sqlalchemy` — ORM for SQLite
- `pydantic` — data validation
- `python-multipart` — multipart form support

### 4 — Initialize the database

```bash
python init_db.py
```

This creates `ledger.db` in the current directory and seeds all **30 Saudi bookkeeping categories**
(income, expense, asset, liability) with Arabic names, VAT applicability flags, and Zakat
relevance markers.

You only need to run this **once**.

### 5 — Start the server

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 5000
```

The API is now running at `http://localhost:5000`.

- Interactive API docs (Swagger UI): `http://localhost:5000/docs`
- Health check: `http://localhost:5000/api/healthz`

---

## Using the Dashboard (Frontend)

Open the `index.html` file in your browser, **or** run the React dev server if you have Node.js:

```bash
# From the project root (not python-backend/):
npm install
npm run dev
# → http://localhost:3000
```

The dashboard connects to `http://localhost:5000/api` automatically.

---

## API Endpoints Reference

### Transactions

| Method   | Endpoint                        | Description                                 |
|----------|---------------------------------|---------------------------------------------|
| `GET`    | `/api/transactions`             | List all transactions (supports filters)    |
| `POST`   | `/api/transactions`             | Create a single transaction                 |
| `POST`   | `/api/transactions/upload`      | Bulk upload (JSON array + auto-categorize)  |
| `GET`    | `/api/transactions/{id}`        | Get a single transaction                    |
| `PATCH`  | `/api/transactions/{id}`        | Manual override of category / VAT / Zakat   |
| `DELETE` | `/api/transactions/{id}`        | Delete a transaction                        |

**List query parameters:**
```
category_id, is_zakat_relevant, is_manually_overridden,
type (debit|credit), search, limit (default 50), offset (default 0)
```

### Categories

| Method | Endpoint          | Description              |
|--------|-------------------|--------------------------|
| `GET`  | `/api/categories` | List all 30+ categories  |
| `POST` | `/api/categories` | Create a new category    |

### Categorization Engine

| Method | Endpoint          | Description                                       |
|--------|-------------------|---------------------------------------------------|
| `POST` | `/api/categorize` | Run the engine on uncategorized (or all) records  |

Request body:
```json
{
  "transactionIds": null,      // null = process all uncategorized
  "overrideExisting": false    // true = re-categorize everything
}
```

### Financial Summaries

| Method | Endpoint                    | Description                          |
|--------|-----------------------------|--------------------------------------|
| `GET`  | `/api/summary`              | P&L totals, VAT overview, counts     |
| `GET`  | `/api/summary/vat`          | Input/Output VAT breakdown (ZATCA)   |
| `GET`  | `/api/summary/zakat`        | Zakatable assets, Nisab, 2.5% due    |
| `GET`  | `/api/summary/by-category`  | Spending grouped by category         |

---

## Uploading Transactions

### Via the Dashboard (CSV paste)

1. Open the dashboard → Upload tab
2. Paste raw CSV rows in the format:
   ```
   date,description,amount,currency,type
   2024-01-15,STC Monthly Bill,850,SAR,debit
   2024-01-16,Client Invoice Payment,12000,SAR,credit
   ```
3. Toggle **Auto-Categorize** to run the engine immediately on upload.
4. Click **Upload Transactions**.

### Via API (JSON)

```bash
curl -X POST http://localhost:5000/api/transactions/upload \
  -H "Content-Type: application/json" \
  -d '{
    "autoCategrize": true,
    "rows": [
      {
        "date": "2024-01-15",
        "description": "STC Monthly Bill",
        "amount": 850,
        "currency": "SAR",
        "type": "debit"
      },
      {
        "date": "2024-01-16",
        "description": "Client Invoice Payment",
        "amount": 12000,
        "currency": "SAR",
        "type": "credit"
      }
    ]
  }'
```

---

## Running the Categorization Engine

```bash
curl -X POST http://localhost:5000/api/categorize \
  -H "Content-Type: application/json" \
  -d '{"overrideExisting": false}'
```

The engine returns each matched transaction with:
- `categoryId` and `categoryName`
- `confidence` score (0.0 – 1.0)
- `matchedRule` — the specific rule that triggered the match

---

## Categorization Engine Details

The engine is fully deterministic — no external calls, no ML models required.

**What it matches:**

| Domain | Examples |
|--------|---------|
| Saudi banks | SNB, Al-Rajhi الراجحي, Riyad Bank بنك الرياض, SAMBA, ANB, Alinma |
| Saudi telecom | STC, Mobily موبايلي, Zain, STC Pay |
| Saudi utilities | SEC كهرباء, NWC مياه |
| Ride-hailing / transport | Careem كريم, Uber, Haramain Rail الحرمين |
| Food & restaurants | Al-Baik البيك, Kudu كودو, HungerStation جاهز, Carrefour |
| Government / regulatory | ZATCA, MOC وزارة التجارة, GOSI, Municipality أمانة |
| IT / SaaS | Microsoft, AWS, Google Workspace, SAP, Salesforce |
| Insurance / Takaful | Tawuniya التعاونية, Bupa Arabia, AXA Cooperative |
| Marketing / Ads | Google Ads, Meta/Facebook Ads, Snapchat Ads |
| Professional services | Deloitte, PwC, KPMG, Al-Tamimi |
| Investments / Tadawul | Tadawul تداول, sukuk صكوك, dividends |

**VAT logic:**
- Standard rate: 15% (applied to VAT-applicable categories)
- Exempt: government fees, salaries, insurance, Zakat/VAT remittances
- VAT amount auto-computed as `amount × 0.15` when applicable

**Zakat logic:**
- Flags transactions in: Cash & Bank, Accounts Receivable, Inventory, Investments
- Nisab threshold: SAR 19,550 (≈ 85g gold)
- Zakat rate: 2.5% of net zakatable assets

---

## Using a Local LLM (Optional — Ollama)

The engine works perfectly without any LLM. If you want to enhance matching
for unusual or ambiguous descriptions:

1. Install [Ollama](https://ollama.ai) and pull a model:
   ```bash
   ollama pull llama3
   ```

2. Add this function to `categorizer.py`:
   ```python
   import requests

   def llm_fallback(description: str, categories: list) -> int:
       """Call local Ollama for ambiguous transactions."""
       prompt = f"""You are a Saudi bookkeeping assistant.
   Classify this transaction into one of these categories: {[c['name'] for c in categories]}
   Transaction: {description}
   Reply with the category name only."""
       
       resp = requests.post("http://localhost:11434/api/generate", json={
           "model": "llama3",
           "prompt": prompt,
           "stream": False,
       })
       answer = resp.json()["response"].strip()
       # Match the answer to a category
       for c in categories:
           if c["name"].lower() in answer.lower():
               return c["id"]
       return 23  # fallback to Other Expenses
   ```

3. Call `llm_fallback()` in `categorize_transaction()` when `confidence < 0.4`.

---

## Environment Variables

| Variable | Default    | Description              |
|----------|------------|--------------------------|
| `DB_PATH` | `ledger.db` | Path to the SQLite file  |

```bash
DB_PATH=/data/mycompany.db uvicorn main:app --reload
```

---

## File Reference

| File              | Purpose                                          |
|-------------------|--------------------------------------------------|
| `main.py`         | FastAPI app — all API routes                     |
| `database.py`     | SQLAlchemy models, SQLite engine, session factory|
| `categorizer.py`  | Deterministic rule engine (Arabic + English)     |
| `init_db.py`      | DB initialization + category seed script         |
| `requirements.txt`| Python dependencies                              |
| `ledger.db`       | SQLite database (created on first run)           |

---

## Common Issues

**Port already in use:**
```bash
uvicorn main:app --reload --port 8000  # use any free port
```

**SQLite locked error:**
SQLite WAL mode is enabled automatically. If you still get locks,
ensure only one uvicorn worker is running: `uvicorn main:app --workers 1`.

**Arabic text not displaying correctly:**
Ensure your terminal / browser is set to UTF-8 encoding.
The database stores Arabic text natively in UTF-8.
