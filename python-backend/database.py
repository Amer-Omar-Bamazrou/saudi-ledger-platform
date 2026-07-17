"""
Saudi Bookkeeping Engine — SQLite Database Layer
Uses SQLAlchemy ORM + SQLite (ledger.db)
"""

import os
from datetime import datetime
from sqlalchemy import (
    create_engine, Column, Integer, String, Boolean, Numeric,
    DateTime, ForeignKey, Text, event
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

DB_PATH = os.environ.get("DB_PATH", "ledger.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)

# Enable WAL mode and foreign key enforcement for SQLite
@event.listens_for(engine, "connect")
def set_sqlite_pragmas(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ─────────────────────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────────────────────

class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    name_ar = Column(String(400), nullable=False)
    type = Column(String(20), nullable=False)          # income|expense|asset|liability|equity
    vat_applicable = Column(Boolean, nullable=False, default=False)
    zakat_relevant = Column(Boolean, nullable=False, default=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    transactions = relationship("Transaction", back_populates="category", lazy="dynamic")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "nameAr": self.name_ar,
            "type": self.type,
            "vatApplicable": self.vat_applicable,
            "zakatRelevant": self.zakat_relevant,
            "description": self.description,
        }


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    date = Column(String(10), nullable=False, index=True)          # YYYY-MM-DD
    description = Column(Text, nullable=False)
    description_ar = Column(Text, nullable=True)
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(String(3), nullable=False, default="SAR")
    type = Column(String(6), nullable=False)                       # debit|credit
    category_id = Column(Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)
    vat_amount = Column(Numeric(15, 2), nullable=True)
    vat_rate = Column(Numeric(5, 2), nullable=True)
    is_zakat_relevant = Column(Boolean, nullable=False, default=False)
    confidence_score = Column(Numeric(5, 4), nullable=True)
    is_manually_overridden = Column(Boolean, nullable=False, default=False)
    source = Column(String(100), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    category = relationship("Category", back_populates="transactions")

    def to_dict(self):
        return {
            "id": self.id,
            "date": self.date,
            "description": self.description,
            "descriptionAr": self.description_ar,
            "amount": float(self.amount) if self.amount is not None else 0.0,
            "currency": self.currency,
            "type": self.type,
            "categoryId": self.category_id,
            "categoryName": self.category.name if self.category else None,
            "categoryNameAr": self.category.name_ar if self.category else None,
            "vatAmount": float(self.vat_amount) if self.vat_amount is not None else None,
            "vatRate": float(self.vat_rate) if self.vat_rate is not None else None,
            "isZakatRelevant": self.is_zakat_relevant,
            "confidenceScore": float(self.confidence_score) if self.confidence_score is not None else None,
            "isManuallyOverridden": self.is_manually_overridden,
            "source": self.source,
            "notes": self.notes,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────

def get_db():
    """FastAPI dependency — yields a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables if they don't exist."""
    Base.metadata.create_all(bind=engine)
