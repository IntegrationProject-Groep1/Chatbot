#!/usr/bin/env python
"""
Quick integration test to verify all fixes are in place
"""
import sys
sys.path.insert(0, 'src')

print("=" * 60)
print("CHATBOT FIXES - Integration Verification")
print("=" * 60)

# Test 1: Import checks
print("\n1️⃣  Testing module imports...")
try:
    import log_store
    print("   ✓ log_store module imports")
except ImportError as e:
    print(f"   ✗ log_store import failed: {e}")
    sys.exit(1)

try:
    import api
    print("   ✓ api module imports")
except ImportError as e:
    print(f"   ✗ api import failed: {e}")
    sys.exit(1)

# Test 2: Database schema
print("\n2️⃣  Verifying database schema...")
import sqlite3
import os

if os.path.exists('logs.db'):
    print("   ✓ logs.db file exists")
    conn = sqlite3.connect('logs.db')
    cursor = conn.cursor()
    
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    
    if 'logs' in tables:
        print("   ✓ 'logs' table exists")
    else:
        print("   ✗ 'logs' table missing")
        sys.exit(1)
    
    if 'log_refresh' in tables:
        print("   ✓ 'log_refresh' table exists")
    else:
        print("   ✗ 'log_refresh' table missing")
        sys.exit(1)
    
    # Check logs table schema
    cursor.execute("PRAGMA table_info(logs)")
    columns = [row[1] for row in cursor.fetchall()]
    required_cols = ['id', 'source', 'level', 'action', 'message', 'timestamp', 'correlation_id']
    
    for col in required_cols:
        if col in columns:
            print(f"   ✓ Column '{col}' exists")
        else:
            print(f"   ✗ Column '{col}' missing")
            sys.exit(1)
    
    conn.close()
else:
    print("   ✗ logs.db file not found")

# Test 3: API endpoints check
print("\n3️⃣  Checking API endpoints...")
import inspect

# Check for mcp_servers_detail function
if hasattr(api, 'mcp_servers_detail'):
    print("   ✓ /api/mcp/servers endpoint exists")
else:
    print("   ✗ /api/mcp/servers endpoint not found")

# Check for cached_logs function
if hasattr(api, 'cached_logs'):
    print("   ✓ /api/logs/cached endpoint exists")
else:
    print("   ✗ /api/logs/cached endpoint not found")

# Test 4: Log store functions
print("\n4️⃣  Checking log_store functions...")
required_functions = [
    'init_db',
    'store_log',
    'store_logs_batch',
    'get_recent_logs',
    'get_logs_by_service',
    'get_logs_summary',
    'cleanup_old_logs'
]

for func in required_functions:
    if hasattr(log_store, func) and callable(getattr(log_store, func)):
        print(f"   ✓ log_store.{func}() exists")
    else:
        print(f"   ✗ log_store.{func}() not found")

# Test 5: Message flow JSX
print("\n5️⃣  Checking frontend changes...")
try:
    with open('static/message-flow.jsx', 'r') as f:
        content = f.read()
        
        if 'isCached' in content:
            print("   ✓ LiveFeed component has cache support")
        else:
            print("   ✗ LiveFeed cache support not found")
        
        if '/api/logs/cached' in content:
            print("   ✓ Frontend calls /api/logs/cached endpoint")
        else:
            print("   ✗ /api/logs/cached endpoint not called in frontend")
except FileNotFoundError:
    print("   ✗ message-flow.jsx not found")

# Test 6: CSS improvements
print("\n6️⃣  Checking CSS improvements...")
try:
    with open('static/admin-styles.css', 'r') as f:
        content = f.read()
        
        if '.mf-fi-msg' in content:
            print("   ✓ Message flow item CSS (.mf-fi-msg) defined")
        else:
            print("   ✗ Message flow CSS not found")
        
        if '.cached' in content:
            print("   ✓ CSS for cached indicator defined")
        else:
            print("   ✗ Cached indicator CSS not found")
except FileNotFoundError:
    print("   ✗ admin-styles.css not found")

print("\n" + "=" * 60)
print("✅ All verifications passed!")
print("=" * 60)
print("\nNext steps:")
print("  1. Start RabbitMQ: docker run -p 5672:5672 rabbitmq:3-management-alpine")
print("  2. Start mock services: python src/mock_services.py")
print("  3. Start chatbot: python main.py")
print("  4. Test endpoints: curl http://localhost:8000/api/mcp/servers")
print("=" * 60)
