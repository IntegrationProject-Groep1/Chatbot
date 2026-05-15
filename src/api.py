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


@app.get("/health")
async def health():
    return {"status": "ok"}


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
