import asyncio
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import session_store
import agent

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(300)
        session_store.cleanup_expired()


app = FastAPI(title="Event Chatbot API", lifespan=_lifespan)
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/")
async def root():
    return FileResponse(os.path.join(_STATIC_DIR, "test.html"))


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
