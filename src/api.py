import asyncio
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import mcp_client
import session_store
import agent

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")


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
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")

# ── Admin auth (disabled — see src/auth.py for setup instructions) ──────────
# from auth import AdminAuthMiddleware, verify_credentials, create_token, _COOKIE   # AUTH
# app.add_middleware(AdminAuthMiddleware)                                             # AUTH
#
# @app.get("/admin/login")
# async def admin_login_page():
#     return FileResponse(os.path.join(_STATIC_DIR, "admin-login.html"))
#
# @app.post("/api/admin/login")
# async def admin_login(request: Request):
#     try:
#         body = await request.json()
#     except Exception:
#         return JSONResponse({"error": "invalid JSON"}, status_code=400)
#     username = str(body.get("username", "")).strip()
#     password = str(body.get("password", "")).strip()
#     if not username or not password:
#         return JSONResponse({"error": "username and password are required"}, status_code=400)
#     if not verify_credentials(username, password):
#         return JSONResponse({"error": "Invalid credentials"}, status_code=401)
#     token = create_token(username)
#     resp = JSONResponse({"ok": True, "user": username})
#     resp.set_cookie(_COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 8)
#     return resp
#
# @app.post("/api/admin/logout")
# async def admin_logout():
#     resp = JSONResponse({"ok": True})
#     resp.delete_cookie(_COOKIE)
#     return resp
# ────────────────────────────────────────────────────────────────────────────


@app.get("/")
async def root():
    index = os.path.join(_STATIC_DIR, "index.html")
    if os.path.exists(index):
        return FileResponse(index)
    return FileResponse(os.path.join(_STATIC_DIR, "test.html"))


@app.post("/api/identify")
async def identify(request: Request):
    """Resolve admin email → identity UUID via the identity service."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)

    email = str(body.get("email", "")).strip().lower()
    if not email:
        return JSONResponse({"error": "email is required"}, status_code=400)

    try:
        from downstream_tools import resolve_identity_by_email, DownstreamConfig
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        user = await loop.run_in_executor(None, resolve_identity_by_email, email, cfg)
        return {"identity_uuid": user.identity_uuid, "email": user.email}
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
    """All loaded MCP tools grouped by server label."""
    client = mcp_client.get()
    servers: dict[str, list[str]] = {}
    for namespaced, (_c, tool, orig) in client._registry.items():
        label = namespaced.split("__")[0]
        servers.setdefault(label, []).append(orig)
    return {
        "servers": [
            {"id": label, "tools": tools, "count": len(tools)}
            for label, tools in servers.items()
        ],
        "total_tools": sum(len(t) for t in servers.values()),
    }


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
        await emit({"type": "ready", "session_id": session_id})

        # Step 2: chat loop
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)

            if data.get("type") == "chat":
                message = str(data.get("message", "")).strip()
                if not message:
                    continue
                try:
                    await agent.run_agent(session_id, message, emit)
                except Exception as exc:
                    await emit({"type": "error", "message": str(exc), "recoverable": True})

    except asyncio.TimeoutError:
        await emit({"type": "error", "message": "Authentication timeout.", "recoverable": False})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await emit({"type": "error", "message": str(exc), "recoverable": False})
        except Exception:
            pass
