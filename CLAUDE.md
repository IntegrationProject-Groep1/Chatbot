# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Admin-only chatbot for the event management platform. A Llama-powered agent calls MCP tools to query backend services on behalf of administrators. The chatbot is the **MCP client**; each service team runs (or will run) their own **MCP server**.

Architecture:
```
Admin (WebSocket) → Chatbot Agent (MCP client)
  → Frontend MCP server (Frontend team, port 8006) → Drupal JSON:API  [sessions + users + enrollments]
  → Monitoring MCP server (Monitoring team, port 8005) → Elasticsearch [health + logs + metrics]
  → Facturatie MCP server (Facturatie team, port 8007) → FossBilling + MySQL
  → Kassa MCP server (Kassa team, port 8004) → Odoo
  → CRM MCP server (CRM team) → Salesforce  [not yet deployed]
  → Identity (RabbitMQ RPC, direct — no MCP server needed)
```

**A2A upgrade path:** When a team builds their own AI agent, they swap their MCP server's tool implementation from "call API" to "ask our AI". The chatbot agent code doesn't change.

There are two versions in the repo:
- **`src/` + `main.py`** — current working version (MCP client architecture)
- **`v2/`** — older standalone version (kept for reference)

## Commands

### Development

```bash
# Install dependencies
pip install -r requirements.txt
cp .env.example .env   # then add NVIDIA_API_KEY

# Start RabbitMQ (required)
docker run -p 5672:5672 -p 15672:15672 rabbitmq:3-management-alpine

# Start mock downstream services (Planning + Facturatie NL2SQL agents)
python src/mock_services.py

# Start chatbot server
python main.py
# or with auto-reload:
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

App runs at `http://localhost:8000`. Enter a user UUID to start chatting via the floating widget.

### Testing

```bash
# Smoke tests (no RabbitMQ needed)
python test_basic.py

# Integration tests (requires RabbitMQ + mock services running)
python test_integration.py

# CI test suite
python -m unittest discover tests
```

### Docker

```bash
docker-compose up -d              # RabbitMQ + mock services
docker build -t chatbot:latest .
docker run -p 8000:8000 --env-file .env chatbot:latest
```

## Architecture

### Request Flow

```
Browser (WebSocket)
  → FastAPI (src/api.py)
    → Agent loop (src/agent.py) — Llama decides which tool to call
      → ask_planning: RabbitMQ RPC → Planning NL2SQL agent
      → ask_facturatie: RabbitMQ RPC → Facturatie NL2SQL agent
  → Session store (src/session_store.py) — per-user conversation history
  → WebSocket response
```

### Key Modules

| File | Role |
|---|---|
| `src/api.py` | FastAPI app, WebSocket endpoint, MCP client init in lifespan |
| `src/agent.py` | Llama tool-use loop — calls MCP tools, streams response |
| `src/mcp_client.py` | Connects to all MCP servers at startup, discovers tools, routes calls |
| `src/mcp_servers/sessions.py` | Legacy MCP server (superseded by Frontend team's MCP on port 8006 — kept for reference) |
| `src/mcp_servers/monitoring.py` | Legacy MCP server (superseded by Monitoring team's MCP on port 8005 — kept for reference) |
| `src/downstream_tools.py` | Identity lookup via RabbitMQ RPC (kept direct, no MCP needed) |
| `src/rabbitmq_rpc.py` | Thread-local persistent RabbitMQ connections, correlation ID matching |
| `src/session_store.py` | TTL-based in-memory conversation history, admin system prompt |
| `src/xml_builders.py` / `xml_parsers.py` | XML v2.0 envelope for identity RPC calls |

### XML Message Format (v2.0 Envelope)

All inter-service messages use this XML envelope:

```xml
<message>
  <header>
    <message_id>uuid</message_id>
    <source>chatbot</source>
    <type>ai_query</type>
    <version>2.0</version>
    <correlation_id>uuid</correlation_id>
  </header>
  <body>
    <identity_uuid>user-uuid</identity_uuid>
    <scope>personal|public</scope>
    <query>natural language question</query>
  </body>
</message>
```

`scope: personal` — queries are UUID-filtered (user sees only their own data).  
`scope: public` — no UUID filter (e.g. browsing available sessions).

XSD contracts are in `xsd/`.

### RabbitMQ RPC Pattern

- Each RPC call creates a `reply_to` queue and sends a `correlation_id`
- Caller blocks until the matching correlation ID arrives or `RPC_TIMEOUT` elapses
- Connections are thread-local (one persistent connection per worker thread) to avoid contention

## Environment Variables

**Required:**
- `NVIDIA_API_KEY` — get a free key at https://integrate.api.nvidia.com/

**MCP servers** (comma-separated `label@url` pairs):
- `MCP_SERVERS` — e.g. `monitoring@http://localhost:8005/mcp,frontend@http://localhost:8006/mcp,facturatie@http://localhost:8007/mcp`
- Sessions (`port 8001`) is **removed** — the Frontend MCP (port 8006) fully supersedes it with 30+ tools
- `FRONTEND_BASE_URL` — used by Frontend team's MCP server (port 8006) to reach Drupal JSON:API
- `ELASTICSEARCH_URL` — used by Monitoring team's MCP server (port 8005) to reach Elasticsearch

**RabbitMQ** (defaults work with the Docker command above):
- `RABBITMQ_HOST` (default: `localhost`)
- `RABBITMQ_PORT` (default: `5672`)
- `RABBIT_USER` / `RABBIT_PASS` (default: `guest`/`guest`)

**Identity RPC:**
- `IDENTITY_RPC_QUEUE` (default: `identity.user.lookup.email.request`)
- `RPC_TIMEOUT` (default: `10.0` seconds)

**Tuning:**
- `SESSION_TTL_SECONDS` (default: `3600`)
- `NVIDIA_MODEL` (default: `meta/llama-3.1-8b-instruct`)

## Admin Console — Logs & Monitoring

### Log query flow (`GET /api/logs/query`)

The endpoint has two hard paths determined by the `hours` parameter.
The split point is **15 minutes** (`_LIVE_WINDOW_HOURS = 0.25`).

#### Live path (`hours ≤ 0.25`)

Used by the **Live** and **15 min** buttons in the UI.

```
Frontend → GET /api/logs/query?hours=0.25
  → monitoring__get_logs_in_timerange (MCP / Elasticsearch)
      ↓ on success
    normalize + deduplicate entries
    write-through: store_logs_batch() → local SQLite DB
    return entries, source="live"
      ↓ if MCP returns nothing (server down / no data)
    get_logs_by_filter(since=now-15min) → local DB
    return cached entries, source="cache", error="Showing cached logs…"
```

The live path **always** tries MCP first so the DB stays warm. Every
successful live poll feeds the local cache — this is the only way
historical data enters the DB.

#### Historical path (`hours > 0.25`)

Used by the **1 uur**, **4 uur**, **7 uur** buttons.

```
Frontend → GET /api/logs/query?hours=1   (or 4, or 7)
  → get_logs_by_filter(since=now-Xh) → local SQLite DB only
    return entries, source="cache"
```

MCP/Elasticsearch is **never called** for historical queries. Results
are therefore consistent regardless of whether the monitoring MCP server
is up or down. The tradeoff: the DB only contains what the live polls
have captured since the chatbot server started — if the server was
restarted an hour ago, `7h` shows at most one hour of data.

### Time-filter buttons

All buttons show a **lookback window from now going back** — they are
not slices between two points.

| Button | `hours` sent | Source | Shows |
|--------|-------------|--------|-------|
| **Live** | `0.25` | MCP → DB fallback | Last 15 min, auto-refresh every 10 s |
| **15 min** | `0.25` | MCP → DB fallback | Last 15 min, one-shot |
| **1 uur** | `1` | DB only | Last 60 min (includes the 15-min window) |
| **4 uur** | `4` | DB only | Last 4 hours (includes the 1-hour window) |
| **7 uur** | `7` | DB only | Last 7 hours (includes the 4-hour window) |

"Live" and "15 min" show the exact same data. The difference is that
"Live" polls every 10 seconds and "15 min" fetches once.

### MCP tool sidebar (`GET /api/mcp/tools`)

Returns all tools currently loaded from connected MCP servers. Each
tool includes its `name`, `description`, and `inputSchema` (parameter
names, types, descriptions, required flags, enums). The sidebar in the
admin UI polls `/api/mcp/status` every 5 seconds for connection state
and fetches the full tool list once on mount.

Clicking a tool in the sidebar opens a detail modal that shows the
description and a structured parameter list rendered from `inputSchema`.

### Service metadata (`GET /api/services/metadata`)

Merges the hardcoded `_SERVICE_METADATA` dict in `api.py` (host, port,
dependency list) with live heartbeat data from the monitoring MCP. Any
service reported by monitoring that is not in `_SERVICE_METADATA` is
included with placeholder host/port. This is the data source for the
Overview dashboard service cards.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:
- Python 3.10, RabbitMQ 3-management service
- `python setup_mocks.py` — initializes SQLite test databases
- `python -m unittest discover tests`
- Requires `NVIDIA_API_KEY` secret in GitHub repo settings
- `PYTHONPATH=src` is set for all test runs
