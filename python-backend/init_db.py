#!/usr/bin/env python3
"""
Initialize the SQLite database and seed canonical Saudi bookkeeping categories.
Run once before starting the server: python init_db.py
"""

from database import init_db, get_db, Category
from categorizer import SEED_CATEGORIES


def main():
    print("Creating tables in ledger.db ...")
    init_db()

    db = next(get_db())
    try:
        existing = db.query(Category).count()
        if existing > 0:
            print(f"Database already has {existing} categories. Skipping seed.")
            return

        print(f"Seeding {len(SEED_CATEGORIES)} categories ...")
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
        print("Done. Categories seeded successfully.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
