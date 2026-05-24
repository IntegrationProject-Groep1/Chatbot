# Quick Test Guide - Chatbot Issues Fixes

## What's Been Fixed

### 1. ✅ Message Flow CSS & Display
- Messages now show full content (no truncation)
- Better visual hierarchy with thicker borders
- Color-coded error/warning/info messages
- `static/admin-styles.css` — Enhanced styling
- `static/message-flow.jsx` — LiveFeed component updated

### 2. ✅ Logs Persistence & Cached Display
- Live logs now stored in SQLite database (`logs.db`)
- When monitoring service is down, cached logs are shown
- Frontend automatically fetches `/api/logs/cached` when live feed is empty
- Displays "gecached" badge to show data source
- `src/log_store.py` — New persistence layer (195 lines)
- `src/api.py` — New endpoint `/api/logs/cached`

### 3. ✅ Servers Tab Details
- New endpoint `/api/mcp/servers` returns:
  - Host & port for each service
  - Live health status
  - Last seen timestamp
  - Service dependencies
  - Uptime seconds
- Frontend can now display actual server info instead of empty state
- `src/api.py` — New endpoint `/api/mcp/servers`

### 4. ⚠️ User Creation Error
- Root cause: Drupal JSON:API is read-only (backend config issue)
- Better error messaging explains the limitation
- This requires Drupal admin panel configuration (not chatbot code)

---

## How to Test

### Prerequisites
```bash
pip install -r requirements.txt
cp .env.example .env  # Add NVIDIA_API_KEY
docker run -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine  # Start RabbitMQ
```

### 1. Test Imports
```bash
cd project_root
export PYTHONPATH=src
python -c "import api, log_store; print('✓ All modules imported')"
```

### 2. Verify Database
```bash
python -c "
import sqlite3
conn = sqlite3.connect('logs.db')
cursor = conn.cursor()
cursor.execute('SELECT name FROM sqlite_master WHERE type=\"table\"')
print('Tables:', [t[0] for t in cursor.fetchall()])
conn.close()
"
```

### 3. Start the App
```bash
python main.py
# or with auto-reload:
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Visit: `http://localhost:8000`

### 5. Agent Logic & Security Tests (Regression)
A new test suite verifies the core agent loop, Write-Gate, and security ownership checks.

```bash
# Run logic tests
python -m unittest tests/test_agent_logic.py -v
```

**What it tests:**
- ✅ **Bug 6:** Confirmation matching with punctuation (e.g., "ja, doe maar!").
- ✅ **Bug 7:** Card extraction turn-isolation (no stale data).
- ✅ **Bug 4:** Duplicate tool call detection via JSON normalization.
- ✅ **Bug 10:** MCP cache exclusion for write tools (`enroll`, `unenroll`).

---

### 6. Visual Testing in Browser

**Check Servers Status:**
```bash
curl http://localhost:8000/api/mcp/servers | python -m json.tool
```

**Get Cached Logs:**
```bash
curl "http://localhost:8000/api/logs/cached?limit=10" | python -m json.tool
```

### 5. Visual Testing in Browser

1. **Message Flow Visibility**
   - Open the admin console
   - Navigate to the Live Berichten section
   - Messages should now show full content with visible styling
   - Check the "SERVERS" tab — should show server details

2. **Cached Logs Fallback**
   - Stop the Monitoring MCP service (if running)
   - Refresh the page
   - Live Berichten should show cached logs with "gecached" badge
   - Messages should be clearly visible

3. **CSS Improvements**
   - Look for better contrast and visibility
   - Error messages should have red background
   - Warning messages should have orange tint
   - Messages should be fully readable without truncation

---

## Files Changed

### New Files:
- `src/log_store.py` — SQLite persistence layer
- `logs.db` — Persisted logs database (auto-created)
- `IMPLEMENTATION_SUMMARY.md` — Detailed documentation

### Modified Files:
- `src/api.py` — Added `/api/mcp/servers` and `/api/logs/cached` endpoints
- `static/message-flow.jsx` — Enhanced LiveFeed with cached fallback
- `static/admin-styles.css` — Improved message flow styling

---

## Next Steps (Optional)

1. **Implement 2-Hour Log Refresh**
   ```python
   # In main.py, add background task:
   import asyncio
   async def refresh_logs_periodically():
       while True:
           await asyncio.sleep(7200)  # 2 hours
           # Call monitoring MCP and refresh cache
   ```

2. **Update Frontend Components**
   - Use `/api/mcp/servers` endpoint in Servers tab
   - Add visual indicator for "local_cache" data source

3. **Drupal Configuration** (Required for user creation)
   - Contact Drupal admin to enable write permissions
   - Configure JSON:API to allow POST/PUT operations

---

## Troubleshooting

**Issue:** `ModuleNotFoundError: No module named 'log_store'`
- **Solution:** Set `PYTHONPATH=src` before running Python

**Issue:** `logs.db` not being created
- **Solution:** Run `python -c "import sys; sys.path.insert(0, 'src'); import log_store"`
- Database should be created automatically on import

**Issue:** `/api/logs/cached` returns empty
- **Solution:** Normal if no logs have been stored yet
- Start monitoring service to generate logs

**Issue:** Cached messages not showing in UI
- **Solution:** Open browser console (F12) to check for fetch errors
- Verify `/api/logs/cached` endpoint is responding

---

## File Locations

```
project_root/
├── src/
│   ├── api.py (MODIFIED)
│   ├── log_store.py (NEW - 195 lines)
│   ├── agent.py
│   └── ... (other modules)
├── static/
│   ├── admin-styles.css (MODIFIED)
│   ├── message-flow.jsx (MODIFIED)
│   └── ... (other assets)
├── main.py
├── logs.db (CREATED automatically)
└── IMPLEMENTATION_SUMMARY.md (NEW)
```

---

## Questions?

- Review `IMPLEMENTATION_SUMMARY.md` for detailed technical documentation
- Check API response formats in the endpoints section
- Logs database schema: `logs`, `log_refresh`, `sqlite_sequence` tables
