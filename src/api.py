import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

import mcp_client
import session_store
import agent

_log = logging.getLogger(__name__)

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
# Cache-bust token: changes on every container start, so a fresh pod always
# serves fresh asset URLs to bypass Cloudflare / browser caches.
_ASSET_VERSION = os.environ.get("ASSET_VERSION") or str(int(time.time()))


def _serve_index(filename: str) -> HTMLResponse:
    path = os.path.join(_STATIC_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    # Append ?v=<version> to every /static/*.{js,jsx,css,svg} reference
    html = re.sub(
        r'(/static/[A-Za-z0-9_\-./]+\.(?:jsx|js|css|svg))',
        lambda m: f"{m.group(1)}?v={_ASSET_VERSION}",
        html,
    )
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


@asynccontextmanager
async def _lifespan(app: FastAPI):
    await mcp_client.init()
    task = asyncio.create_task(_cleanup_loop())
    try:
        yield
    finally:
        task.cancel()
        await mcp_client.close()


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(300)
        session_store.cleanup_expired()


app = FastAPI(title="Event Chatbot API", lifespan=_lifespan)


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response


app.add_middleware(NoCacheStaticMiddleware)
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")

# ── Admin auth — combined: password check + identity resolve in one call ─────
# Set ADMIN_CREDENTIALS=email:password,email2:password2 in env to enforce passwords.
# If ADMIN_CREDENTIALS is not set, password is ignored and any known email can log in.
from auth import verify_credentials, create_token, verify_token, _COOKIE, _CREDS_RAW


@app.get("/api/me")
async def get_me(request: Request):
    """Return current admin identity from cookie (auto-login on page refresh)."""
    token = request.cookies.get(_COOKIE)
    if not token:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    email = verify_token(token)
    if not email:
        return JSONResponse({"error": "session expired"}, status_code=401)
    try:
        from downstream_tools import resolve_identity_by_email, DownstreamConfig
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        user = await loop.run_in_executor(None, resolve_identity_by_email, email, cfg)
        return {"identity_uuid": user.identity_uuid, "email": user.email}
    except Exception:
        return JSONResponse({"error": "session expired"}, status_code=401)


@app.post("/api/admin/logout")
async def admin_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(_COOKIE, httponly=True, samesite="lax")
    return resp
# ────────────────────────────────────────────────────────────────────────────


@app.get("/")
async def root():
    index = os.path.join(_STATIC_DIR, "index.html")
    if os.path.exists(index):
        return _serve_index("index.html")
    return FileResponse(os.path.join(_STATIC_DIR, "test.html"))


@app.post("/api/identify")
async def identify(request: Request):
    """Resolve admin email → identity UUID. Checks password when ADMIN_CREDENTIALS is set."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    email = str(body.get("email", "")).strip().lower()
    if not email:
        return JSONResponse({"error": "email is required"}, status_code=400)

    # Password gate — only active when ADMIN_CREDENTIALS env var is configured
    if _CREDS_RAW:
        password = str(body.get("password", "")).strip()
        if not verify_credentials(email, password):
            return JSONResponse({"error": "Incorrect email or password."}, status_code=401)

    try:
        from downstream_tools import resolve_identity_by_email, DownstreamConfig
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        user = await loop.run_in_executor(None, resolve_identity_by_email, email, cfg)
        result = {"identity_uuid": user.identity_uuid, "email": user.email}
        resp = JSONResponse(result)
        token = create_token(email)
        resp.set_cookie(_COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 8)
        return resp
    except RuntimeError as exc:
        msg = str(exc).lower()
        if "missing" in msg or "not found" in msg or "uuid" in msg:
            return JSONResponse({"error": str(exc)}, status_code=404)
        return JSONResponse({"error": str(exc)}, status_code=503)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/identity/uuid/{identity_uuid}")
async def identify_by_uuid(identity_uuid: str):
    """Reverse identity lookup: UUID → email via the same XML RPC as /api/identify."""
    identity_uuid = identity_uuid.strip()
    if not identity_uuid:
        return JSONResponse({"error": "identity_uuid is required"}, status_code=400)
    try:
        from downstream_tools import resolve_identity_by_uuid, DownstreamConfig
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        user = await loop.run_in_executor(None, resolve_identity_by_uuid, identity_uuid, cfg)
        return {"identity_uuid": user.identity_uuid, "email": user.email}
    except RuntimeError as exc:
        msg = str(exc).lower()
        if "missing" in msg or "not found" in msg or "uuid" in msg:
            return JSONResponse({"error": str(exc)}, status_code=404)
        return JSONResponse({"error": str(exc)}, status_code=503)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── MCP passthrough endpoints for the Admin Console UI ────────────────────
# These let the frontend poll live data without going through the agent/LLM.

async def _call_mcp(tool: str, args: dict = {}) -> dict:
    try:
        raw = await mcp_client.get().call_tool(tool, args)
        import json as _json
        return _json.loads(raw)
    except Exception as exc:
        return {"error": str(exc)}


@app.get("/api/monitoring/status")
async def monitoring_status():
    """Current online/offline/degraded status of all services (heartbeats)."""
    result = await _call_mcp("monitoring__get_service_status")
    # Remap last_heartbeat → last_seen (UI reads last_seen via _secsSince())
    for svc in result.get("services", []):
        if "last_heartbeat" in svc and "last_seen" not in svc:
            svc["last_seen"] = svc.pop("last_heartbeat")
    return result


@app.get("/api/monitoring/errors")
async def monitoring_errors(limit: int = 50):
    """All recent log entries (all levels) across all services, for the log viewer."""
    result = await _call_mcp("monitoring__get_recent_logs", {"limit": min(limit, 200)})
    entries = []
    for e in result.get("logs", []):
        entries.append({
            "source":         e.get("system", ""),
            "level":          e.get("level", ""),
            "message":        e.get("log_message", "") or e.get("message", ""),
            "action":         e.get("action", ""),
            "@timestamp":     e.get("@timestamp", ""),
            "correlation_id": e.get("correlation_id", ""),
        })
    return {"errors": entries, "count": len(entries)}


@app.get("/api/monitoring/alerts")
async def monitoring_alerts():
    """Services currently offline or degraded, derived from heartbeat status."""
    result = await _call_mcp("monitoring__get_service_status")
    alerts = []
    for svc in result.get("services", []):
        if not svc.get("live", True):
            alerts.append({
                "service":    svc.get("service", ""),
                "status":     svc.get("status", "offline"),
                "message":    f"{svc.get('service')} is {svc.get('status', 'offline')}",
                "@timestamp": svc.get("last_heartbeat", svc.get("last_seen", "")),
            })
    return {"alerts": alerts, "count": len(alerts)}


@app.get("/api/monitoring/heartbeat/{service}")
async def monitoring_heartbeat(service: str, hours: int = 1):
    """Per-minute heartbeat timeline for the 60-cell sparkline strip in the UI."""
    hours = max(1, min(hours, 24))
    result = await _call_mcp("monitoring__get_heartbeat_timeline",
                             {"service": service, "hours": hours})
    timeline = result.get("timeline", [])
    cells = [
        {
            "timestamp": bucket.get("timestamp", ""),
            "count":     bucket.get("count", 0),
            "status":    "ok" if bucket.get("count", 0) > 0 else "miss",
        }
        for bucket in timeline[-60:]
    ]
    return {
        "service":   service,
        "cells":     cells,
        "gap_count": result.get("gap_minutes", 0),
        "error":     result.get("error"),
    }


@app.get("/api/dashboard/summary")
async def dashboard_summary():
    """Aggregated KPIs from monitoring for the dashboard strip."""
    result = await _call_mcp("monitoring__get_service_status")
    if isinstance(result, Exception):
        result = {}

    services = result.get("services", [])
    # Use live field as ground truth — a service with live=False is offline
    # regardless of what the last stored status field says
    online = sum(
        1 for s in services
        if s.get("live") and (s.get("status") or "").lower() in ("online", "up", "healthy")
    )
    degraded = sum(
        1 for s in services
        if s.get("live") and (s.get("status") or "").lower() in ("degraded", "slow")
    )
    offline = sum(1 for s in services if not s.get("live", True))
    alerts_count = offline

    return {
        "services_online":   online,
        "services_degraded": degraded,
        "services_offline":  max(offline, 0),
        "services_total":    len(services),
        "active_alerts":     alerts_count,
    }


@app.get("/api/mcp/tools")
async def list_mcp_tools():
    """All loaded MCP tools grouped by server label, with live connection status."""
    client = mcp_client.get()
    server_status = client.get_server_status()
    servers: dict[str, list[str]] = {}
    for namespaced, (_c, tool, orig) in client._registry.items():
        label = namespaced.split("__")[0]
        servers.setdefault(label, []).append(orig)
    return {
        "servers": [
            {
                "id": label,
                "tools": tools,
                "count": len(tools),
                "connected": server_status.get(label, False),
            }
            for label, tools in servers.items()
        ],
        "total_tools": sum(len(t) for t in servers.values()),
        "connected_count": sum(1 for ok in server_status.values() if ok),
        "total_count": len(server_status),
    }


# Routing map (source_service, log_action) → downstream recipients.
# Based on XML/XSD Contract v2.3 + confirmed by actual Elasticsearch log messages.
# ES action field values: registration, payment, session, calendar, invoice, email,
#   user, wallet, badge, refund, xml_validation, system_error
_FLOW_ROUTES: dict[tuple[str, str], list[str]] = {
    # ── Kassa → outgoing ───────────────────────────────────────────────────────
    ("kassa",            "registration"):    ["crm"],
    ("kassa",            "payment"):         ["crm"],          # payment_registered
    ("kassa",            "session"):         ["crm"],          # session events
    ("kassa",            "wallet"):          ["crm"],          # wallet_lease
    ("kassa",            "badge"):           ["crm"],          # badge_assigned
    ("kassa",            "refund"):          ["crm"],          # refund_processed
    ("kassa",            "invoice"):         ["crm"],          # invoice_request
    ("kassa",            "wallet_balance"):  ["frontend"],     # wallet_balance_update
    ("kassa",            "payment_status"):  ["frontend"],     # payment_status

    # ── Frontend → outgoing ────────────────────────────────────────────────────
    ("frontend",         "registration"):    ["crm"],          # new_registration
    ("frontend",         "user"):            ["crm"],          # user_created/updated/deleted
    ("frontend",         "session"):         ["crm"],          # session CRUD via exchange
    ("frontend",         "user_registered"): ["crm", "kassa"], # dual-publish
    ("frontend",         "user_unregistered"):["crm","kassa"], # dual-publish
    ("frontend",         "cancel_registration"):["crm"],
    ("frontend",         "company"):         ["crm"],
    ("frontend",         "calendar"):        ["planning"],     # calendar_invite
    ("frontend",         "event_ended"):     ["facturatie", "kassa"],  # fanout exchange
    ("frontend",         "payment"):         ["facturatie"],   # payment_registered (online)
    ("frontend",         "checkin"):         ["crm"],

    # ── CRM → outgoing ─────────────────────────────────────────────────────────
    ("crm",              "registration"):    ["kassa", "facturatie"],  # new_registration fanout
    ("crm",              "profile_update"):  ["kassa", "facturatie"],
    ("crm",              "cancel_registration"):["kassa"],
    ("crm",              "invoice"):         ["facturatie"],
    ("crm",              "payment"):         ["facturatie"],
    ("crm",              "session"):         ["planning"],
    ("crm",              "calendar"):        ["planning"],
    ("crm",              "email"):           ["mailing"],
    ("crm",              "user"):            ["identity-service"],
    ("crm",              "refund"):          ["facturatie"],
    ("crm",              "payment_registered"):["frontend"],  # push back to portal
    ("crm",              "wallet"):          ["kassa"],

    # ── Facturatie → outgoing ──────────────────────────────────────────────────
    ("facturatie",       "invoice"):         ["mailing"],      # send_mailing after invoice
    ("facturatie",       "email"):           ["mailing"],
    ("facturatie",       "invoice_status"):  ["crm"],          # feedback to CRM
    ("facturatie",       "payment"):         ["crm"],          # payment_registered back
    ("facturatie",       "invoice_available"):["frontend"],    # notify portal

    # ── Planning → outgoing ────────────────────────────────────────────────────
    # Planning has no DB; frontend owns all session data.
    # Planning only confirms calendar invites back to frontend and sends emails.
    ("planning",         "calendar"):        ["frontend"],     # calendar_invite_confirmed
    ("planning",         "email"):           ["mailing"],

    # ── Identity → outgoing ────────────────────────────────────────────────────
    ("identity-service", "user"):            ["crm"],          # user_event fanout
    ("identity-service", "user_event"):      ["crm"],

    # ── Monitoring → outgoing ──────────────────────────────────────────────────
    ("monitoring",       "system_alert"):    ["mailing"],
    ("monitoring",       "alert"):           ["mailing"],
}


@app.get("/api/monitoring/message-flow")
async def monitoring_message_flow(hours: float = 1.0, limit: int = 500):
    """Inter-service message flow graph derived from recent Elasticsearch logs."""
    import datetime
    hours = max(0.083, min(hours, 24.0))
    limit = min(limit, 1000)

    logs_result, status_result = await asyncio.gather(
        _call_mcp("monitoring__get_recent_logs", {"limit": limit}),
        _call_mcp("monitoring__get_service_status"),
    )

    logs = logs_result.get("logs", []) if isinstance(logs_result, dict) else []
    services = status_result.get("services", []) if isinstance(status_result, dict) else []
    health = {s["service"]: s for s in services}

    cutoff_ts = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
    ).timestamp()

    def _parse_ts(s: str) -> float:
        try:
            return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except Exception:
            return time.time()

    edge_data: dict[tuple[str, str, str], dict] = {}
    recent_events: list[dict] = []
    # Track per-service last active timestamp for node "last_seen" display
    service_last_ts: dict[str, str] = {}

    for entry in logs:
        ts  = entry.get("@timestamp", "")
        if _parse_ts(ts) < cutoff_ts:
            continue
        src    = (entry.get("system",      "") or "").lower().strip()
        action = (entry.get("action",      "") or "").lower().strip()
        level  = (entry.get("level",       "") or "info").lower()
        msg    = (entry.get("log_message", "") or "")[:140]

        if src and ts > service_last_ts.get(src, ""):
            service_last_ts[src] = ts

        destinations = _FLOW_ROUTES.get((src, action), [])
        if len(recent_events) < 300:
            recent_events.append({
                "source": src, "action": action, "level": level,
                "message": msg, "timestamp": ts, "destinations": destinations,
            })
        for dst in destinations:
            key = (src, dst, action)
            if key not in edge_data:
                edge_data[key] = {"count": 0, "errors": 0, "recent": [], "last_ts": ""}
            edge_data[key]["count"] += 1
            if level == "error":
                edge_data[key]["errors"] += 1
            if len(edge_data[key]["recent"]) < 5:
                edge_data[key]["recent"].append(
                    {"timestamp": ts, "message": msg, "level": level}
                )
            # logs come DESC from ES; first occurrence per key is the most recent
            if not edge_data[key]["last_ts"]:
                edge_data[key]["last_ts"] = ts

    minutes = max(hours * 60, 1)
    edges = [
        {
            "source":          src,
            "target":          dst,
            "action":          action,
            "count":           d["count"],
            "errors":          d["errors"],
            "rate_per_min":    round(d["count"] / minutes, 2),
            "last_message":    d["last_ts"],
            "recent_messages": d["recent"],
        }
        for (src, dst, action), d in sorted(edge_data.items(), key=lambda x: -x[1]["count"])
    ]

    known = {"crm", "kassa", "facturatie", "planning", "frontend",
             "mailing", "identity-service", "monitoring"}
    active = {e["source"] for e in edges} | {e["target"] for e in edges}
    nodes = [
        {
            "id":        svc,
            "live":      health.get(svc, {}).get("live"),
            "status":    (health.get(svc, {}).get("status") or "unknown"),
            "uptime":    health.get(svc, {}).get("uptime_seconds"),
            "last_seen": health.get(svc, {}).get("last_seen") or health.get(svc, {}).get("last_heartbeat"),
            "last_log":  service_last_ts.get(svc),
            "active":    svc in active,
        }
        for svc in sorted(known | active)
    ]

    return {
        "nodes": nodes,
        "edges": edges,
        "recent_events": recent_events,
        "stats": {
            "total_messages":    sum(e["count"] for e in edges),
            "error_messages":    sum(e["errors"] for e in edges),
            "active_flows":      len(edges),
            "time_window_hours": hours,
        },
        "timestamp": time.time(),
    }


@app.get("/api/mcp/status")
async def mcp_status():
    """Live MCP connection status — which servers the chatbot can actually reach right now."""
    client = mcp_client.get()
    status = client.get_server_status()
    return {
        "servers": [
            {"id": label, "connected": connected}
            for label, connected in status.items()
        ],
        "connected_count": sum(1 for ok in status.values() if ok),
        "total_count": len(status),
    }


@app.get("/api/session/{session_id}/messages")
async def get_session_messages(session_id: str):
    """Return stored conversation messages for a session (used to restore chat UI)."""
    messages = session_store.get_messages_for_api(session_id)
    return {"messages": messages, "count": len(messages)}


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()

    async def emit(event: dict) -> None:
        try:
            await websocket.send_text(json.dumps(event))
        except Exception:
            pass

    try:
        # Step 1: expect identify message with identity_uuid
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        first = json.loads(raw)

        if first.get("type") != "identify":
            await emit({"type": "error", "message": "First message must be {type: 'identify', identity_uuid: '...'}", "recoverable": False})
            return

        identity_uuid = str(first.get("identity_uuid", "")).strip()
        if not identity_uuid:
            await emit({"type": "error", "message": "Not authenticated. Please log in to the portal.", "recoverable": False})
            return

        session_store.init_session(session_id, identity_uuid)
        _log.info("WS connected: session=%s identity=%s", session_id, identity_uuid)
        await emit({"type": "ready", "session_id": session_id})

        # Step 2: chat loop
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            if data.get("type") == "chat":
                message = str(data.get("message", "")).strip()
                if not message:
                    continue
                _log.info("CHAT: session=%s len=%d preview=%r", session_id, len(message), message[:80])
                try:
                    await agent.run_agent(session_id, message, emit)
                except Exception as exc:
                    _log.exception("Agent error: session=%s", session_id)
                    await emit({"type": "error", "message": str(exc), "recoverable": True})

    except asyncio.TimeoutError:
        _log.warning("WS auth timeout: session=%s", session_id)
        await emit({"type": "error", "message": "Authentication timeout.", "recoverable": False})
    except WebSocketDisconnect:
        _log.info("WS disconnected: session=%s", session_id)
    except Exception as exc:
        _log.exception("WS error: session=%s", session_id)
        try:
            await emit({"type": "error", "message": str(exc), "recoverable": False})
        except Exception:
            pass
