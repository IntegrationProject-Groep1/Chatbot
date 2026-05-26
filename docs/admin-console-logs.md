# Admin Console — Logs & Monitoring

## Overview

The admin console has a Logs screen that shows inter-service log entries from Elasticsearch via the Monitoring MCP server. Entries are also cached locally in SQLite so the UI stays usable when the monitoring service is down.

---

## Log Query Flow

All log queries go through `GET /api/logs/query` in `src/api.py`. The endpoint routes to one of two paths based on how far back you are looking. The split point is **15 minutes**.

### Live path — `hours ≤ 0.25` (≤ 15 min)

```
Frontend
  └─ GET /api/logs/query?hours=0.25
       │
       ├─ Call monitoring__get_logs_in_timerange via MCP
       │    (Elasticsearch, last 15 minutes)
       │
       ├─ [success] normalize + deduplicate entries
       │              write to local SQLite DB  ← write-through cache
       │              return entries, source="live"
       │
       └─ [MCP down / empty] fall back to local DB
                              get_logs_by_filter(since=now−15min)
                              return entries, source="cache"
                              error="Showing cached logs (live MCP unavailable)"
```

Every successful live poll writes to the local DB. This is the **only** way historical data enters the cache — there is no separate backfill.

### Historical path — `hours > 0.25` (> 15 min)

```
Frontend
  └─ GET /api/logs/query?hours=1   (or 4, or 7)
       │
       └─ Read local SQLite DB only
            get_logs_by_filter(since=now−Xh)
            return entries, source="cache"
            (MCP / Elasticsearch is never called)
```

Historical queries **never** hit MCP. Results are therefore consistent and stable regardless of whether the monitoring server is reachable. The trade-off: the DB only contains what the live polls have captured since the chatbot process started. If the chatbot was restarted an hour ago, `7h` shows at most one hour of data — not a failure, just the honest state of the cache.

---

## Time-Filter Buttons

All buttons show a **lookback window from now going backwards**. They are not slices between two points — clicking "1 uur" shows everything from now back to 60 minutes ago, which fully includes the last 15 minutes.

| Button | `hours` param | Data source | What it shows |
|--------|--------------|-------------|---------------|
| **Live** | `0.25` | MCP → DB fallback | Last 15 min — auto-refreshes every 10 s |
| **15 min** | `0.25` | MCP → DB fallback | Last 15 min — one-shot fetch |
| **1 uur** | `1` | DB only | Last 60 min (includes the 15-min window) |
| **4 uur** | `4` | DB only | Last 4 hours (includes the 1-hour window) |
| **7 uur** | `7` | DB only | Last 7 hours (includes the 4-hour window) |

**Live vs 15 min:** both show exactly the same data. The only difference is that Live polls every 10 seconds while 15 min is a single fetch.

**Why 1 / 4 / 7 and not 1 / 6 / 7?** The previous 6h and 7h buttons differed by only one hour, which was meaningless. 1 / 4 / 7 gives evenly spread coverage: last hour, half a day, full day.

---

## Filters

Filters can be combined freely. They apply on top of the time window.

| Filter | Where applied | Notes |
|--------|--------------|-------|
| **Service** (kassa, crm, …) | API + DB query | Historical only — live fetches all services client-side to avoid count mismatches |
| **Level** (info, warn, error) | API + DB query | Passed to MCP for live; applied in SQL for historical |
| **Action** | Post-fetch | MCP does not support action filtering natively; applied in Python after fetch for both paths |
| **Text search** | Client-side only | Filters the already-fetched result list in the browser |

---

## Local Cache (SQLite)

The local DB (`log_store.py`) stores a normalized copy of every log entry seen by the live path. Schema columns: `source`, `level`, `action`, `message`, `timestamp`, `correlation_id`.

Useful API endpoints for the cache:

| Endpoint | Description |
|----------|-------------|
| `GET /api/logs/cached?limit=100&service=crm` | Read cache directly, bypass MCP |
| `DELETE /api/logs/clear` | Delete all cached entries |

The cache has no TTL-based eviction — it grows until manually cleared. Use `DELETE /api/logs/clear` from the Logs screen ("Cache wissen" button) to reset it.

---

## MCP Tool Sidebar

The right-hand sidebar in the admin console shows all tools loaded from connected MCP servers. Data comes from `GET /api/mcp/tools`, which reads from the in-memory registry built at startup (no MCP calls at query time).

Each server entry shows:
- Server label and tool count
- Connection dot (green = connected, red = unreachable, grey = unknown)
- Expandable tool list — click any tool to open a detail modal

The detail modal shows:
- Tool name and server label
- Description (from the MCP server's tool manifest)
- Parameter list: name, type, required flag, description, enum values if applicable

Connection status (`/api/mcp/status`) is polled every 5 seconds. The tool list is fetched once on mount and does not auto-refresh — restart the chatbot server to pick up newly registered tools.
