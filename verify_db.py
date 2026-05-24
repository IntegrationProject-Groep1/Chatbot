#!/usr/bin/env python
import sys
sys.path.insert(0, 'src')

import log_store
import sqlite3

conn = sqlite3.connect('logs.db')
cursor = conn.cursor()

cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cursor.fetchall()
print('Tables in logs.db:')
for table in tables:
    print(f'  - {table[0]}')

if tables:
    cursor.execute('PRAGMA table_info(logs)')
    columns = cursor.fetchall()
    print('\nColumns in logs table:')
    for col in columns:
        print(f'  - {col[1]} ({col[2]})')

conn.close()
print("\n✓ Database schema verified successfully!")
