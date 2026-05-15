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

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:
- Python 3.10, RabbitMQ 3-management service
- `python setup_mocks.py` — initializes SQLite test databases
- `python -m unittest discover tests`
- Requires `NVIDIA_API_KEY` secret in GitHub repo settings
- `PYTHONPATH=src` is set for all test runs
