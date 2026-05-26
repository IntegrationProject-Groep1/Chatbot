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

_START_TIME = time.time()
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


@app.get("/api/health")
async def health():
    """Lightweight health probe — used by the monitoring panel to show chatbot status."""
    return {
        "service":        "chatbot",
        "status":         "online",
        "live":           True,
        "uptime_seconds": int(time.time() - _START_TIME),
        "last_seen":      time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


@app.get("/api/me")
async def get_me(request: Request):
    """Return current admin identity from cookie (auto-login on page refresh)."""
    token = request.cookies.get(_COOKIE)
    if not token:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    parsed = verify_token(token)
    if not parsed:
        return JSONResponse({"error": "session expired"}, status_code=401)
    email, identity_uuid = parsed
    # Fast path: new tokens include identity_uuid — no RabbitMQ call needed
    if identity_uuid:
        return {"identity_uuid": identity_uuid, "email": email}
    # Fallback for old tokens without uuid
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
        from downstream_tools import resolve_identity_by_email, create_identity_user, DownstreamConfig
        from xml_parsers import IdentityUser
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        try:
            user = await loop.run_in_executor(None, resolve_identity_by_email, email, cfg)
        except RuntimeError as lookup_exc:
            # User not in identity service yet — auto-register to get a master UUID
            if "not_found" in str(lookup_exc).lower() or "not found" in str(lookup_exc).lower():
                created = await loop.run_in_executor(None, create_identity_user, email, cfg)
                if not created.get("success"):
                    raise RuntimeError(created.get("error", "Failed to register with identity service"))
                user = IdentityUser(
                    identity_uuid=created["master_uuid"],
                    email=created.get("email", email),
                )
            else:
                raise
        result = {"identity_uuid": user.identity_uuid, "email": user.email}
        resp = JSONResponse(result)
        token = create_token(email, user.identity_uuid)
        resp.set_cookie(_COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 8)
        return resp
    except TimeoutError:
        return JSONResponse({"error": "Identity service tijdelijk niet bereikbaar. Probeer het opnieuw."}, status_code=503)
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
async def health_simple():
    return {"status": "ok"}


# ── MCP passthrough endpoints for the Admin Console UI ────────────────────
# These let the frontend poll live data without going through the agent/LLM.

async def _call_mcp(tool: str, args: dict = {}) -> dict:
    try:
        raw = await mcp_client.get().call_tool(tool, args)
        return json.loads(raw)
    except Exception as exc:
        _log.warning("MCP call failed: tool=%s error=%s", tool, exc)
        return {"error": str(exc)}


_CONNECTION_NOISE_PATTERNS = (
    "connectionerror",
    "newconnectionerror",
    "has failed for",
    "retrying request after failure",
    "resurrected node",
    "putting on 30 second timeout",
    "detector main loop error",
)


def _is_connection_noise(entry: dict) -> bool:
    msg = (entry.get("message") or entry.get("log_message") or "").lower()
    return any(p in msg for p in _CONNECTION_NOISE_PATTERNS)


def _is_http_transport_success(entry: dict) -> bool:
    """Detect internal HTTP transport logs for successful 2xx requests.
    These are emitted by the elasticsearch-py/urllib3 client on every poll and
    carry zero actionable information — they should never reach the dashboard.
    Checks for the specific '[status:2XX' bracket that urllib3 appends, combined
    with a known internal service hostname pattern (e.g. 'monitoring-service:9200').
    Only filters on explicit 2xx bracket to avoid false positives on error logs.
    """
    msg = (entry.get("message") or entry.get("log_message") or "")
    return "[status:2" in msg and ("http://" in msg or "https://" in msg)


def _deduplicate_connection_noise(entries: list) -> list:
    """Collapse runs of identical connection-error noise into a single entry with a repeat count."""
    result = []
    noise_groups: dict[str, dict] = {}  # key: (source, message_prefix) → representative entry

    for entry in entries:
        if not _is_connection_noise(entry):
            result.append(entry)
            continue

        source = entry.get("source") or entry.get("system") or ""
        msg = (entry.get("message") or entry.get("log_message") or "")[:80]
        key = f"{source}:{msg}"

        if key not in noise_groups:
            rep = dict(entry)
            rep["_repeat_count"] = 1
            noise_groups[key] = rep
        else:
            noise_groups[key]["_repeat_count"] += 1

    for rep in noise_groups.values():
        count = rep.pop("_repeat_count")
        if count > 1:
            orig = rep.get("message") or rep.get("log_message") or ""
            rep["message"] = rep["log_message"] = f"[{count}x] {orig}"
        result.append(rep)

    return result


_SOURCE_ALIAS = {
    # Planning
    "user":              "planning",
    "planning-service":  "planning",
    "planning_service":  "planning",
    # Identity
    "registration":       "identity-service",
    "identity":           "identity-service",
    "identity service":   "identity-service",
    "identity_service":   "identity-service",
    "identityservice":    "identity-service",
    # Mailing
    "mail":              "mailing",
    "mailer":            "mailing",
    "email":             "mailing",
    "email-service":     "mailing",
    "email_service":     "mailing",
    "notification":      "mailing",
    "notifications":     "mailing",
    "mailing-service":   "mailing",
    "mailing_service":   "mailing",
}

def _normalize_log_entry(entry: dict) -> dict:
    header = entry.get("header") if isinstance(entry.get("header"), dict) else {}
    body = entry.get("body") if isinstance(entry.get("body"), dict) else {}
    raw_source = entry.get("system") or entry.get("source") or header.get("source") or ""
    source = _SOURCE_ALIAS.get(str(raw_source).lower().strip(), str(raw_source).lower().strip())
    level = entry.get("level") or body.get("level") or "info"
    action = entry.get("action") or body.get("action") or ""
    message = (
        entry.get("log_message")
        or entry.get("message")
        or body.get("log_message")
        or body.get("message")
        or ""
    )
    return {
        "source": source,
        "system": source,
        "level": str(level).lower().strip(),
        "message": message,
        "log_message": message,
        "action": str(action).lower().strip(),
        "@timestamp": entry.get("@timestamp") or body.get("@timestamp") or "",
        "correlation_id": entry.get("correlation_id") or header.get("correlation_id") or "",
    }


async def _get_monitoring_logs(limit: int = 100, hours: float = 24.0) -> dict:
    """Fetch recent logs from either the current or legacy Monitoring MCP shape.
    Also stores logs to local database for persistence during downtime.
    hours controls how far back the DB fallback looks when MCP is unavailable.
    """
    import log_store

    limit = min(max(int(limit or 100), 1), 1000)
    result = await _call_mcp("monitoring__get_recent_logs", {"limit": limit})
    raw_entries = []
    error = result.get("error") if isinstance(result, dict) else None
    if isinstance(result, dict):
        raw_entries = result.get("logs") or result.get("errors") or []

    if not raw_entries:
        fallback = await _call_mcp("monitoring__get_recent_errors", {"limit": min(limit, 200)})
        if isinstance(fallback, dict) and (fallback.get("errors") or fallback.get("logs")):
            raw_entries = fallback.get("errors") or fallback.get("logs") or []
            error = fallback.get("error")
        elif isinstance(fallback, dict) and fallback.get("error") and not error:
            error = fallback.get("error")

    mcp_had_data = bool(raw_entries)
    entries = [
        _normalize_log_entry(e) for e in raw_entries
        if isinstance(e, dict) and not _is_http_transport_success(e)
    ]

    if entries:
        log_store.store_logs_batch(entries)

    # Fall back to cached DB logs only when MCP returned nothing at all (not just noise-filtered)
    if not mcp_had_data:
        cached = log_store.get_recent_logs(limit=limit, hours=hours)
        if cached:
            for c in cached:
                if not c.get("@timestamp") and c.get("timestamp"):
                    c["@timestamp"] = c["timestamp"]
            entries = cached
            _log.warning("MCP monitoring unavailable, serving %d cached entries (hours=%.2f): %s",
                         len(entries), hours, error or "no data")
            error = "Showing cached logs (no live connection)"

    return {"logs": entries, "count": len(entries), "error": error}


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
    result = await _get_monitoring_logs(min(limit, 200))
    return {"errors": result["logs"], "count": result["count"], "error": result.get("error")}


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


@app.get("/api/monitoring/service/{service_id}")
async def monitoring_service_detail(service_id: str):
    """Rich per-service detail: uptime, 24h availability, health score, error density."""
    uptime_result, avail_result, scores_result = await asyncio.gather(
        _call_mcp("monitoring__get_service_uptime",        {"service": service_id}),
        _call_mcp("monitoring__get_service_availability",  {"service": service_id, "hours": 24}),
        _call_mcp("monitoring__get_health_scores"),
    )
    score_entry = next(
        (s for s in scores_result.get("scores", []) if s.get("service") == service_id),
        None,
    )
    return {
        "service":          service_id,
        "uptime_seconds":   uptime_result.get("uptime_seconds"),
        "uptime_human":     uptime_result.get("uptime_human"),
        "last_heartbeat":   uptime_result.get("last_heartbeat"),
        "availability_24h": avail_result.get("availability_pct"),
        "heartbeats_24h":   avail_result.get("heartbeats_received"),
        "health_score":     score_entry.get("health_score")  if score_entry else None,
        "error_density":    score_entry.get("error_density") if score_entry else None,
        "errors_24h":       round((score_entry.get("error_density", 0) or 0)
                                  * (score_entry.get("heartbeats", 0) or 0) / 1000.0)
                            if score_entry else None,
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


@app.get("/api/mcp/servers")
async def mcp_servers_detail():
    """Get detailed status of all MCP servers with live health checks."""
    from datetime import datetime
    result = await _call_mcp("monitoring__get_service_status")
    services_map = {s.get("service", ""): s for s in result.get("services", [])}
    
    servers = []
    for svc_id, meta in _SERVICE_METADATA.items():
        svc_status = services_map.get(svc_id, {})
        servers.append({
            "id": svc_id,
            "host": meta.get("host"),
            "port": meta.get("port"),
            "status": "online" if svc_status.get("live") else "offline",
            "live": svc_status.get("live", False),
            "last_seen": svc_status.get("last_seen", svc_status.get("last_heartbeat")),
            "uptime_seconds": svc_status.get("uptime_seconds"),
            "dependencies": meta.get("deps", []),
            "message": svc_status.get("message", ""),
        })
    
    return {"servers": servers, "timestamp": datetime.utcnow().isoformat() + "Z"}


@app.get("/api/logs/query")
async def logs_query(
    service: str = None,
    level: str = None,
    action: str = None,
    since: str = None,
    until: str = None,
    hours: float = None,
    limit: int = 200,
):
    """Unified log query: live (recent) or historical (time range). Falls back to DB cache."""
    import log_store
    from datetime import datetime, timedelta, timezone

    limit = min(max(int(limit or 200), 1), 500)

    # Derive `since` from `hours` if not given explicitly
    if since is None and hours is not None and hours > 0:
        since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat().replace("+00:00", "Z")

    mcp_args_extra: dict = {}
    if service:
        mcp_args_extra["service"] = service
    if level:
        mcp_args_extra["level"] = level
    if action:
        mcp_args_extra["action"] = action

    raw: list = []
    error: str | None = None

    if since:
        end = until or (datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
        mcp_result = await _call_mcp("monitoring__get_logs_in_timerange", {
            "start": since, "end": end, "limit": limit,
            **{k: v for k, v in mcp_args_extra.items() if k in ("level", "service")},
        })
    else:
        mcp_result = await _call_mcp("monitoring__get_recent_logs", {
            "limit": limit, **mcp_args_extra,
        })

    if isinstance(mcp_result, dict):
        raw = mcp_result.get("logs") or []
        error = mcp_result.get("error")

    from_live = bool(raw)  # MCP returned data (even if all filtered out as noise)
    entries = [
        _normalize_log_entry(e) for e in raw
        if isinstance(e, dict) and not _is_http_transport_success(e)
    ]
    if entries:
        log_store.store_logs_batch(entries)

    if not entries:
        cached = log_store.get_logs_by_filter(
            since=since, until=until,
            service=service, level=level if level else None,
            action=action, limit=limit,
        )
        for c in cached:
            if not c.get("@timestamp") and c.get("timestamp"):
                c["@timestamp"] = c["timestamp"]
        entries = cached
        if entries:
            _log.info("logs_query: MCP returned no entries, serving %d cached rows (since=%s)", len(entries), since)
            error = "Showing cached logs (live MCP unavailable)"

    # Apply action filter post-fetch when MCP doesn't support it natively
    if action and entries:
        entries = [e for e in entries if (e.get("action") or "").lower() == action.lower()]

    entries = _deduplicate_connection_noise(entries)

    return {
        "logs": entries,
        "count": len(entries),
        "source": "live" if from_live else "cache",
        "error": error,
    }


@app.get("/api/logs/cached")
async def cached_logs(limit: int = 100, service: str = None):
    """Get cached logs from local database (useful during monitoring downtime)."""
    import log_store
    from datetime import datetime
    
    limit = min(max(int(limit or 100), 1), 1000)
    
    if service:
        logs = log_store.get_logs_by_service(service.lower(), limit=limit, hours=24)
    else:
        logs = log_store.get_recent_logs(limit=limit, hours=24)
    
    summary = log_store.get_logs_summary(hours=24)
    
    return {
        "logs": logs,
        "count": len(logs),
        "summary": summary,
        "source": "local_cache",
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }


@app.delete("/api/logs/clear")
async def clear_logs():
    """Delete all locally cached logs from the database."""
    import log_store
    deleted = log_store.clear_all_logs()
    return {"deleted": deleted, "message": f"Cleared {deleted} log entries from local cache."}


# ── Service metadata — previously hardcoded in admin-flow.jsx ────────────────
_SERVICE_METADATA = {
    "chatbot":           { "host": "chatbot.shift.be",          "port": 8000,  "deps": ["nvidia-api", "rabbitmq", "mcp-servers"] },
    "crm":               { "host": "crm-prod-01.shift.be",      "port": 8080,  "deps": ["salesforce", "identity"] },
    "facturatie":        { "host": "facturatie-prod.shift.be",  "port": 8443,  "deps": ["mysql", "identity"] },
    "frontend":          { "host": "www.shift.be",              "port": 443,   "deps": ["nginx", "frontend-db"] },
    "kassa":             { "host": "kassa-prod.shift.be",       "port": 8090,  "deps": ["odoo", "facturatie"] },
    "mailing":           { "host": "mailing.shift.be",          "port": 8080,  "deps": ["rabbitmq", "sendgrid"] },
    "monitoring":        { "host": "monitoring-prod.shift.be",  "port": 8200,  "deps": ["elasticsearch"] },
    "identity-service":  { "host": "identity-prod.shift.be",    "port": 8443,  "deps": ["postgres"] },
    "frontend-mcp":      { "host": "frontend-mcp-service",      "port": 8006,  "deps": ["frontend-drupal", "frontend-db"] },
    "kassa-mcp":         { "host": "kassa-mcp-service",         "port": 8004,  "deps": ["kassa-web"] },
    "facturatie-mcp":    { "host": "facturatie-mcp-service",    "port": 8007,  "deps": ["fossbilling"] },
    "crm-mcp":           { "host": "crm-mcp-service",           "port": 8008,  "deps": ["crm"] },
    "monitoring-mcp":    { "host": "monitoring-mcp-service",    "port": 8005,  "deps": ["elasticsearch"] },
}


@app.get("/api/services/metadata")
async def services_metadata():
    """Complete service topology with host, port, and dependencies.
    
    Combines hardcoded metadata with live health status from monitoring.
    Used by Overview dashboard to display rich service cards.
    """
    status_result = await _call_mcp("monitoring__get_service_status")
    services = status_result.get("services", []) if isinstance(status_result, dict) else []
    
    # Remap last_heartbeat → last_seen if needed (same as monitoring_status endpoint)
    for svc in services:
        if "last_heartbeat" in svc and "last_seen" not in svc:
            svc["last_seen"] = svc.pop("last_heartbeat")
    
    # Build a health lookup
    health_by_svc = {s.get("service"): s for s in services}
    
    # Enrich metadata with live health
    enriched = []
    for svc_id, meta in _SERVICE_METADATA.items():
        health = health_by_svc.get(svc_id, {})
        enriched.append({
            "id": svc_id,
            "host": meta["host"],
            "port": meta["port"],
            "deps": meta["deps"],
            "status": health.get("status", "unknown"),
            "live": health.get("live", False),
            "uptime_seconds": health.get("uptime_seconds"),
            "last_seen": health.get("last_seen"),
        })
    
    # Also include services from monitoring that aren't in the hardcoded list (e.g., custom services)
    for svc in services:
        svc_id = svc.get("service")
        if svc_id and svc_id not in _SERVICE_METADATA:
            enriched.append({
                "id": svc_id,
                "host": "—",
                "port": 0,
                "deps": [],
                "status": svc.get("status", "unknown"),
                "live": svc.get("live", False),
                "uptime_seconds": svc.get("uptime_seconds"),
                "last_seen": svc.get("last_seen"),
            })
    
    return {"services": enriched, "count": len(enriched)}


@app.get("/api/mcp/tools")
async def list_mcp_tools():
    """All loaded MCP tools grouped by server label, with live connection status."""
    client = mcp_client.get()
    server_status = client.get_server_status()
    servers: dict[str, list[dict]] = {}
    for namespaced, (_c, tool, orig) in client._registry.items():
        label = namespaced.split("__")[0]
        servers.setdefault(label, []).append({
            "name": orig,
            "description": tool.description or "",
            "inputSchema": tool.inputSchema if tool.inputSchema else {"type": "object", "properties": {}},
        })
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
_INTER_SERVICE_KEYWORDS = (
    "published",
    "received",
    "sent ",
    "consumed",
    "processed:",
)


def _is_inter_service_message(msg: str) -> bool:
    """Return True only if the log message describes actual inter-service messaging.

    Startup logs, internal pollers, and status lines share action names with
    real message-passing actions but contain none of these keywords.
    """
    m = msg.lower()
    return any(k in m for k in _INTER_SERVICE_KEYWORDS)


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
        _get_monitoring_logs(limit, hours=hours),
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
        src    = (entry.get("system") or entry.get("source") or "").lower().strip()
        action = (entry.get("action", "") or "").lower().strip()
        level  = (entry.get("level", "") or "info").lower()
        msg    = (entry.get("log_message") or entry.get("message") or "")[:140]

        if src and ts > service_last_ts.get(src, ""):
            service_last_ts[src] = ts

        # Only classify as inter-service if the message text shows actual message
        # passing between services (Published/Sent/Received/processed:).
        # Startup logs, internal pollers, etc. use the same action names but
        # contain no inter-service keyword — they should not become flow edges.
        destinations = (
            _FLOW_ROUTES.get((src, action), [])
            if _is_inter_service_message(msg)
            else []
        )
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
async def get_session_messages(session_id: str, request: Request):
    """Return stored conversation messages for a session (used to restore chat UI)."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth

    # Verify ownership: stored identity_uuid must match requester
    stored_uuid = session_store.get_identity_uuid(session_id)
    if stored_uuid and stored_uuid != identity_uuid:
        _log.warning("FORBIDDEN: Admin %s tried to access session %s owned by %s", 
                     identity_uuid, session_id, stored_uuid)
        return JSONResponse({"error": "Forbidden: Session ownership mismatch"}, status_code=403)

    messages = session_store.get_messages_for_api(session_id)
    return {"messages": messages, "count": len(messages)}


# ── Conversation history (per-admin, DB-backed) ───────────────────────────────

def _get_auth(request: Request) -> tuple[str, str] | None:
    """Extract (email, identity_uuid) from session cookie. Returns None if missing/invalid."""
    token = request.cookies.get(_COOKIE)
    if not token:
        return None
    return verify_token(token)


@app.get("/api/conversations")
async def list_conversations(request: Request):
    """Return all conversations for the authenticated admin, ordered pinned-first then recent."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth
    if not identity_uuid:
        return JSONResponse({"error": "session too old — please log in again"}, status_code=401)
    convs = session_store.get_conversations(identity_uuid)
    return {"conversations": convs, "count": len(convs)}


@app.post("/api/conversations")
async def create_conversation(request: Request):
    """Create or update a conversation entry (called when first message is sent)."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth
    if not identity_uuid:
        return JSONResponse({"error": "session too old — please log in again"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    session_id = str(body.get("session_id", "")).strip()
    label = str(body.get("label", "")).strip()[:120]
    if not session_id or not label:
        return JSONResponse({"error": "session_id and label are required"}, status_code=400)
    session_store.upsert_conversation(session_id, identity_uuid, label)
    return {"ok": True}


@app.patch("/api/conversations/{session_id}/pin")
async def toggle_pin(session_id: str, request: Request):
    """Toggle pinned state for a conversation."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth
    if not identity_uuid:
        return JSONResponse({"error": "session too old — please log in again"}, status_code=401)
    try:
        body = await request.json()
        pinned = bool(body.get("pinned", True))
    except Exception:
        pinned = True
    ok = session_store.set_pinned(session_id, identity_uuid, pinned)
    if not ok:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return {"ok": True, "pinned": pinned}


@app.delete("/api/conversations/{session_id}")
async def delete_conversation(session_id: str, request: Request):
    """Delete a conversation and its message history."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth
    if not identity_uuid:
        return JSONResponse({"error": "session too old — please log in again"}, status_code=401)
    ok = session_store.delete_conversation(session_id, identity_uuid)
    if not ok:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return {"ok": True}


@app.put("/api/conversations/{session_id}/active")
async def set_active_conversation(session_id: str, request: Request):
    """Mark a conversation as active in the database."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth
    if not identity_uuid:
        return JSONResponse({"error": "session too old — please log in again"}, status_code=401)
    ok = session_store.set_active(session_id, identity_uuid)
    if not ok:
        return JSONResponse({"error": "conversation not found"}, status_code=404)
    return {"ok": True, "active_session_id": session_id}


@app.delete("/api/conversations/active")
async def deactivate_conversations(request: Request):
    """Deactivate all conversations for the authenticated admin in the database."""
    auth = _get_auth(request)
    if not auth:
        return JSONResponse({"error": "not authenticated"}, status_code=401)
    _, identity_uuid = auth
    if not identity_uuid:
        return JSONResponse({"error": "session too old — please log in again"}, status_code=401)
    session_store.set_active(None, identity_uuid)
    return {"ok": True}


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

        try:
            session_store.init_session(session_id, identity_uuid)
            # Proactively mark this session as active in the database upon successful connect/reconnect
            session_store.set_active(session_id, identity_uuid)
        except ValueError:
            await emit({"type": "error", "message": "Session belongs to a different user.", "recoverable": False})
            return
        _log.info("WS connected: session=%s identity=%s", session_id, identity_uuid)
        await emit({"type": "ready", "session_id": session_id})

        # Step 2: chat loop
        while True:
            try:
                raw = await websocket.receive_text()
                data = json.loads(raw)
            except json.JSONDecodeError:
                _log.warning("WS malformed JSON: session=%s", session_id)
                await emit({"type": "error", "message": "Invalid JSON", "recoverable": True})
                continue

            msg_type = data.get("type")
            if msg_type == "chat":
                message = str(data.get("message", "")).strip()
                if not message:
                    continue

                # Auto-upsert conversation metadata so it appears in "recent chats"
                # Label is either provided or derived from first message
                try:
                    # Check if this is the first message (to avoid constant re-labeling unless needed)
                    # Actually upsert_conversation is idempotent and updates last_active
                    label = data.get("label") or message[:40] + ("..." if len(message) > 40 else "")
                    session_store.upsert_conversation(session_id, identity_uuid, label)
                except Exception as e:
                    _log.error("Failed to auto-upsert conversation: %s", e)

                # Re-init session here to recover from a DB pool failure that may
                # have silently prevented init_session from persisting at WS connect time.
                # init_session is idempotent: it loads the existing session if present,
                # or creates a new one — so calling it again is always safe.
                try:
                    session_store.init_session(session_id, identity_uuid)
                except ValueError:
                    pass  # session already belongs to this user, nothing to do

                _log.info("CHAT: session=%s len=%d preview=%r", session_id, len(message), message[:80])
                try:
                    await agent.run_agent(session_id, message, emit)
                except Exception as exc:
                    _log.exception("Agent error: session=%s", session_id)
                    await emit({"type": "error", "message": str(exc), "recoverable": True})
            elif msg_type == "ping":
                await emit({"type": "pong"})
            else:
                _log.debug("WS unknown message type %r: session=%s", msg_type, session_id)

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
