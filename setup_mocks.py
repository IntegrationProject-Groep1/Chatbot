import sqlite3
import os

def setup_databases():
    # Planning DB
    plan_db = "planning.db"
    if os.path.exists(plan_db): os.remove(plan_db)
    conn = sqlite3.connect(plan_db)
    conn.execute("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, name TEXT, date TEXT, location TEXT, description TEXT)")
    conn.execute("CREATE TABLE enrollments (master_uuid TEXT, session_id TEXT)")
    conn.execute("INSERT INTO sessions VALUES ('sess-001', 'Docker & Microservices Workshop', '2026-05-20T09:00:00Z', 'Room A', 'Hands-on workshop')")
    conn.execute("INSERT INTO sessions VALUES ('sess-002', 'API Design', '2026-05-21T14:00:00Z', 'Room B', 'Best practices')")
    conn.execute("INSERT INTO enrollments VALUES ('mock-uuid-12345', 'sess-001')")
    conn.commit()
    conn.close()
    print(f"Created {plan_db}")

    # Facturatie DB
    fact_db = "facturatie.db"
    if os.path.exists(fact_db): os.remove(fact_db)
    conn = sqlite3.connect(fact_db)
    conn.execute("CREATE TABLE invoices (invoice_id TEXT PRIMARY KEY, master_uuid TEXT, amount DECIMAL, currency TEXT, date TEXT, status TEXT)")
    conn.execute("INSERT INTO invoices VALUES ('inv-001', 'mock-uuid-12345', 49.99, 'EUR', '2026-04-01', 'paid')")
    conn.execute("INSERT INTO invoices VALUES ('inv-002', 'mock-uuid-12345', 50.00, 'EUR', '2026-05-01', 'pending')")
    conn.execute("INSERT INTO invoices VALUES ('inv-003', 'mock-uuid-12345', 25.00, 'EUR', '2026-05-10', 'overdue')")
    conn.commit()
    conn.close()
    print(f"Created {fact_db}")

if __name__ == "__main__":
    setup_databases()
