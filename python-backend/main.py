"""
Saudi Bookkeeping Engine — FastAPI Backend
Run: uvicorn main:app --reload --port 5000
Database: SQLite (ledger.db)
"""

import csv
import io
import os
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Any, Dict

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_

from database import Category, Transaction, get_db, init_db
from categorizer import categorize_transaction, SEED_CATEGORIES

# ─────────────────────────────────────────────────────────────────────────────
# App setup
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Saudi Bookkeeping Engine",
    description="Production-ready Saudi bookkeeping API with VAT and Zakat support",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NISAB_SAR = 19_550.0   # approx. 85g gold @ ~230 SAR/g
ZAKAT_RATE = 0.025


@app.on_event("startup")
def startup():
    init_db()
    _seed_categories_if_empty()


def _seed_categories_if_empty():
    db = next(get_db())
    try:
        if db.query(Category).count() == 0:
            for c in SEED_CATEGORIES:
                db.add(Category(
                    id=c["id"],
                    name=c["name"],
                    name_ar=c["name_ar"],
                    type=c["type"],
                    vat_applicable=c["vat_applicable"],
                    zakat_relevant=c["zakat_relevant"],
                ))
            db.commit()
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ─────────────────────────────────────────────────────────────────────────────

class CategoryOut(BaseModel):
    id: int
    name: str
    nameAr: str
    type: str
    vatApplicable: bool
    zakatRelevant: bool
    description: Optional[str] = None

    class Config:
        from_attributes = True


class CategoryCreate(BaseModel):
    name: str
    nameAr: str
    type: str
    vatApplicable: bool
    zakatRelevant: bool
    description: Optional[str] = None


class TransactionOut(BaseModel):
    id: int
    date: str
    description: str
    descriptionAr: Optional[str] = None
    amount: float
    currency: str
    type: str
    categoryId: Optional[int] = None
    categoryName: Optional[str] = None
    categoryNameAr: Optional[str] = None
    vatAmount: Optional[float] = None
    vatRate: Optional[float] = None
    isZakatRelevant: bool
    confidenceScore: Optional[float] = None
    isManuallyOverridden: bool
    source: Optional[str] = None
    notes: Optional[str] = None
    createdAt: str

    class Config:
        from_attributes = True


class TransactionCreate(BaseModel):
    date: str
    description: str
    descriptionAr: Optional[str] = None
    amount: float
    currency: str = "SAR"
    type: str  # debit | credit
    categoryId: Optional[int] = None
    vatAmount: Optional[float] = None
    vatRate: Optional[float] = None
    isZakatRelevant: bool = False
    notes: Optional[str] = None
    source: Optional[str] = None


class TransactionUpdate(BaseModel):
    categoryId: Optional[int] = None
    isZakatRelevant: Optional[bool] = None
    vatAmount: Optional[float] = None
    vatRate: Optional[float] = None
    notes: Optional[str] = None
    descriptionAr: Optional[str] = None


class TransactionListOut(BaseModel):
    transactions: List[TransactionOut]
    total: int
    offset: int
    limit: int


class UploadRow(BaseModel):
    date: str
    description: str
    descriptionAr: Optional[str] = None
    amount: float
    currency: str = "SAR"
    type: str
    categoryId: Optional[int] = None
    vatAmount: Optional[float] = None
    vatRate: Optional[float] = None
    isZakatRelevant: bool = False
    notes: Optional[str] = None
    source: Optional[str] = None


class UploadPayload(BaseModel):
    rows: List[UploadRow]
    autoCategrize: Optional[bool] = False


class UploadResult(BaseModel):
    inserted: int
    categorized: int
    errors: List[str]


class CategorizationRequest(BaseModel):
    transactionIds: Optional[List[int]] = None
    overrideExisting: Optional[bool] = False


class CategorizationResultItem(BaseModel):
    transactionId: int
    categoryId: int
    categoryName: str
    confidence: float
    matchedRule: Optional[str] = None


class CategorizationResult(BaseModel):
    processed: int
    categorized: int
    skipped: int
    results: List[CategorizationResultItem]


class FinancialSummary(BaseModel):
    totalIncome: float
    totalExpenses: float
    netPosition: float
    totalVatCollected: float
    totalVatPaid: float
    netVat: float
    transactionCount: int
    uncategorizedCount: int


class VatTransaction(BaseModel):
    id: int
    date: str
    description: str
    amount: float
    vatAmount: float
    type: str


class VatSummary(BaseModel):
    vatCollected: float
    vatPaid: float
    netVatPosition: float
    vatRate: float
    transactions: List[VatTransaction]


class ZakatSummary(BaseModel):
    totalZakatableAssets: float
    nisabThresholdSAR: float
    zakatDue: float
    eligibleTransactions: List[TransactionOut]


class CategoryBreakdown(BaseModel):
    categoryId: int
    categoryName: str
    categoryNameAr: str
    type: str
    total: float
    count: int
    vatTotal: float


# ─────────────────────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────────────────────

def _tx_to_out(tx: Transaction) -> TransactionOut:
    return TransactionOut(
        id=tx.id,
        date=tx.date,
        description=tx.description,
        descriptionAr=tx.description_ar,
        amount=float(tx.amount),
        currency=tx.currency,
        type=tx.type,
        categoryId=tx.category_id,
        categoryName=tx.category.name if tx.category else None,
        categoryNameAr=tx.category.name_ar if tx.category else None,
        vatAmount=float(tx.vat_amount) if tx.vat_amount is not None else None,
        vatRate=float(tx.vat_rate) if tx.vat_rate is not None else None,
        isZakatRelevant=tx.is_zakat_relevant,
        confidenceScore=float(tx.confidence_score) if tx.confidence_score is not None else None,
        isManuallyOverridden=tx.is_manually_overridden,
        source=tx.source,
        notes=tx.notes,
        createdAt=tx.created_at.isoformat() if tx.created_at else datetime.utcnow().isoformat(),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/healthz")
def health():
    return {"status": "ok"}


# ─────────────────────────────────────────────────────────────────────────────
# Categories
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/categories", response_model=List[CategoryOut])
def list_categories(db: Session = Depends(get_db)):
    cats = db.query(Category).order_by(Category.type, Category.name).all()
    return [CategoryOut(
        id=c.id, name=c.name, nameAr=c.name_ar, type=c.type,
        vatApplicable=c.vat_applicable, zakatRelevant=c.zakat_relevant,
        description=c.description,
    ) for c in cats]


@app.post("/api/categories", response_model=CategoryOut, status_code=201)
def create_category(payload: CategoryCreate, db: Session = Depends(get_db)):
    cat = Category(
        name=payload.name,
        name_ar=payload.nameAr,
        type=payload.type,
        vat_applicable=payload.vatApplicable,
        zakat_relevant=payload.zakatRelevant,
        description=payload.description,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return CategoryOut(
        id=cat.id, name=cat.name, nameAr=cat.name_ar, type=cat.type,
        vatApplicable=cat.vat_applicable, zakatRelevant=cat.zakat_relevant,
        description=cat.description,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Transactions
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/transactions", response_model=TransactionListOut)
def list_transactions(
    category_id: Optional[int] = None,
    is_zakat_relevant: Optional[bool] = None,
    is_manually_overridden: Optional[bool] = None,
    type: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    q = db.query(Transaction)
    if category_id is not None:
        q = q.filter(Transaction.category_id == category_id)
    if is_zakat_relevant is not None:
        q = q.filter(Transaction.is_zakat_relevant == is_zakat_relevant)
    if is_manually_overridden is not None:
        q = q.filter(Transaction.is_manually_overridden == is_manually_overridden)
    if type is not None:
        q = q.filter(Transaction.type == type)
    if search:
        q = q.filter(Transaction.description.ilike(f"%{search}%"))

    total = q.count()
    txs = q.order_by(Transaction.date.desc(), Transaction.id.desc()).offset(offset).limit(limit).all()

    return TransactionListOut(
        transactions=[_tx_to_out(t) for t in txs],
        total=total,
        offset=offset,
        limit=limit,
    )


@app.post("/api/transactions", response_model=TransactionOut, status_code=201)
def create_transaction(payload: TransactionCreate, db: Session = Depends(get_db)):
    tx = Transaction(
        date=payload.date,
        description=payload.description,
        description_ar=payload.descriptionAr,
        amount=Decimal(str(payload.amount)),
        currency=payload.currency,
        type=payload.type,
        category_id=payload.categoryId,
        vat_amount=Decimal(str(payload.vatAmount)) if payload.vatAmount is not None else None,
        vat_rate=Decimal(str(payload.vatRate)) if payload.vatRate is not None else None,
        is_zakat_relevant=payload.isZakatRelevant,
        is_manually_overridden=False,
        source=payload.source or "manual",
        notes=payload.notes,
    )
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return _tx_to_out(tx)


@app.post("/api/transactions/upload", response_model=UploadResult)
def upload_transactions(payload: UploadPayload, db: Session = Depends(get_db)):
    inserted = 0
    categorized = 0
    errors = []

    for row in payload.rows:
        try:
            cat_id = row.categoryId
            vat_amount = row.vatAmount
            vat_rate = row.vatRate
            is_zakat = row.isZakatRelevant
            confidence = None

            if payload.autoCategrize and cat_id is None:
                match = categorize_transaction(
                    row.description, row.amount, row.type, row.descriptionAr
                )
                cat_id = match.category_id
                confidence = match.confidence
                is_zakat = match.is_zakat_relevant
                if match.vat_applicable and match.suggested_vat_rate and vat_amount is None:
                    vat_rate = match.suggested_vat_rate
                    vat_amount = round(row.amount * match.suggested_vat_rate / 100, 2)
                categorized += 1

            tx = Transaction(
                date=row.date,
                description=row.description,
                description_ar=row.descriptionAr,
                amount=Decimal(str(row.amount)),
                currency=row.currency,
                type=row.type,
                category_id=cat_id,
                vat_amount=Decimal(str(vat_amount)) if vat_amount is not None else None,
                vat_rate=Decimal(str(vat_rate)) if vat_rate is not None else None,
                is_zakat_relevant=is_zakat,
                confidence_score=Decimal(str(confidence)) if confidence else None,
                is_manually_overridden=False,
                source=row.source or "upload",
                notes=row.notes,
            )
            db.add(tx)
            inserted += 1
        except Exception as exc:
            errors.append(f'Row "{row.description}": {exc}')

    db.commit()
    return UploadResult(inserted=inserted, categorized=categorized, errors=errors)


@app.get("/api/transactions/{tx_id}", response_model=TransactionOut)
def get_transaction(tx_id: int, db: Session = Depends(get_db)):
    tx = db.query(Transaction).filter(Transaction.id == tx_id).first()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return _tx_to_out(tx)


@app.patch("/api/transactions/{tx_id}", response_model=TransactionOut)
def update_transaction(tx_id: int, payload: TransactionUpdate, db: Session = Depends(get_db)):
    tx = db.query(Transaction).filter(Transaction.id == tx_id).first()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if payload.categoryId is not None:
        tx.category_id = payload.categoryId
    if payload.isZakatRelevant is not None:
        tx.is_zakat_relevant = payload.isZakatRelevant
    if payload.vatAmount is not None:
        tx.vat_amount = Decimal(str(payload.vatAmount))
    if payload.vatRate is not None:
        tx.vat_rate = Decimal(str(payload.vatRate))
    if payload.notes is not None:
        tx.notes = payload.notes
    if payload.descriptionAr is not None:
        tx.description_ar = payload.descriptionAr
    tx.is_manually_overridden = True

    db.commit()
    db.refresh(tx)
    return _tx_to_out(tx)


@app.delete("/api/transactions/{tx_id}", status_code=204)
def delete_transaction(tx_id: int, db: Session = Depends(get_db)):
    tx = db.query(Transaction).filter(Transaction.id == tx_id).first()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    db.delete(tx)
    db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Categorization engine
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/categorize", response_model=CategorizationResult)
def run_categorization(payload: CategorizationRequest, db: Session = Depends(get_db)):
    q = db.query(Transaction)

    if payload.transactionIds:
        q = q.filter(Transaction.id.in_(payload.transactionIds))
    elif not payload.overrideExisting:
        q = q.filter(Transaction.category_id.is_(None))

    txs = q.all()

    categorized = 0
    skipped = 0
    results = []

    for tx in txs:
        if tx.is_manually_overridden and tx.id not in (payload.transactionIds or []):
            skipped += 1
            continue
        if tx.category_id is not None and not payload.overrideExisting and tx.id not in (payload.transactionIds or []):
            skipped += 1
            continue

        match = categorize_transaction(
            tx.description, float(tx.amount), tx.type, tx.description_ar
        )

        vat_amount = tx.vat_amount
        vat_rate = tx.vat_rate
        if match.vat_applicable and match.suggested_vat_rate and vat_amount is None:
            vat_rate = Decimal(str(match.suggested_vat_rate))
            vat_amount = Decimal(str(round(float(tx.amount) * match.suggested_vat_rate / 100, 2)))

        tx.category_id = match.category_id
        tx.confidence_score = Decimal(str(match.confidence))
        tx.is_zakat_relevant = match.is_zakat_relevant
        tx.vat_amount = vat_amount
        tx.vat_rate = vat_rate
        tx.is_manually_overridden = False

        results.append(CategorizationResultItem(
            transactionId=tx.id,
            categoryId=match.category_id,
            categoryName=match.category_name,
            confidence=match.confidence,
            matchedRule=match.matched_rule,
        ))
        categorized += 1

    db.commit()
    return CategorizationResult(
        processed=len(txs),
        categorized=categorized,
        skipped=skipped,
        results=results,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Summary endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/summary", response_model=FinancialSummary)
def get_summary(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Transaction)
    if date_from:
        q = q.filter(Transaction.date >= date_from)
    if date_to:
        q = q.filter(Transaction.date <= date_to)

    txs = q.all()
    total_income = sum(float(t.amount) for t in txs if t.type == "credit")
    total_expenses = sum(float(t.amount) for t in txs if t.type == "debit")
    vat_collected = sum(float(t.vat_amount) for t in txs if t.type == "credit" and t.vat_amount)
    vat_paid = sum(float(t.vat_amount) for t in txs if t.type == "debit" and t.vat_amount)
    uncategorized = sum(1 for t in txs if t.category_id is None)

    return FinancialSummary(
        totalIncome=round(total_income, 2),
        totalExpenses=round(total_expenses, 2),
        netPosition=round(total_income - total_expenses, 2),
        totalVatCollected=round(vat_collected, 2),
        totalVatPaid=round(vat_paid, 2),
        netVat=round(vat_collected - vat_paid, 2),
        transactionCount=len(txs),
        uncategorizedCount=uncategorized,
    )


@app.get("/api/summary/vat", response_model=VatSummary)
def get_vat_summary(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Transaction).filter(Transaction.vat_amount.isnot(None))
    if date_from:
        q = q.filter(Transaction.date >= date_from)
    if date_to:
        q = q.filter(Transaction.date <= date_to)

    txs = q.order_by(Transaction.date).all()
    vat_collected = sum(float(t.vat_amount) for t in txs if t.type == "credit")
    vat_paid = sum(float(t.vat_amount) for t in txs if t.type == "debit")

    return VatSummary(
        vatCollected=round(vat_collected, 2),
        vatPaid=round(vat_paid, 2),
        netVatPosition=round(vat_collected - vat_paid, 2),
        vatRate=15.0,
        transactions=[
            VatTransaction(
                id=t.id,
                date=t.date,
                description=t.description,
                amount=float(t.amount),
                vatAmount=float(t.vat_amount),
                type=t.type,
            ) for t in txs
        ],
    )


@app.get("/api/summary/zakat", response_model=ZakatSummary)
def get_zakat_summary(db: Session = Depends(get_db)):
    txs = (
        db.query(Transaction)
        .filter(Transaction.is_zakat_relevant == True)
        .order_by(Transaction.date)
        .all()
    )
    total = sum(float(t.amount) if t.type == "credit" else -float(t.amount) for t in txs)
    total = max(total, 0.0)
    zakat_due = round(total * ZAKAT_RATE, 2) if total >= NISAB_SAR else 0.0

    return ZakatSummary(
        totalZakatableAssets=round(total, 2),
        nisabThresholdSAR=NISAB_SAR,
        zakatDue=zakat_due,
        eligibleTransactions=[_tx_to_out(t) for t in txs],
    )


@app.get("/api/summary/by-category", response_model=List[CategoryBreakdown])
def get_summary_by_category(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = (
        db.query(Transaction)
        .filter(Transaction.category_id.isnot(None))
    )
    if date_from:
        q = q.filter(Transaction.date >= date_from)
    if date_to:
        q = q.filter(Transaction.date <= date_to)

    txs = q.all()

    # Group in Python (avoids complex SQLAlchemy aggregations for SQLite)
    groups: Dict[int, Dict] = {}
    for t in txs:
        cid = t.category_id
        if cid not in groups:
            cat = t.category
            groups[cid] = {
                "categoryId": cid,
                "categoryName": cat.name if cat else "Unknown",
                "categoryNameAr": cat.name_ar if cat else "",
                "type": cat.type if cat else "expense",
                "total": 0.0,
                "count": 0,
                "vatTotal": 0.0,
            }
        groups[cid]["total"] += float(t.amount)
        groups[cid]["count"] += 1
        groups[cid]["vatTotal"] += float(t.vat_amount) if t.vat_amount else 0.0

    return sorted(
        [CategoryBreakdown(**v) for v in groups.values()],
        key=lambda x: x.total,
        reverse=True,
    )
