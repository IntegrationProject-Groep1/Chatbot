import os
import threading
import time

_sessions: dict[str, dict] = {}
_lock = threading.Lock()
_TTL = int(os.getenv("SESSION_TTL_SECONDS", "3600"))

_SYSTEM_TEMPLATE = (
    "You are a smart event assistant built into the event management portal. "
    "The logged-in user's identity UUID is: {identity_uuid}. "
    "You have access to two backend services via RabbitMQ:\n"
    "- Planning Service: manages event sessions and user enrollments\n"
    "- Facturatie Service: handles invoices and billing\n\n"
    "Rules:\n"
    "- Never ask the user who they are — you already know their identity.\n"
    "- If the user asks about both sessions and invoices, call those tools in parallel.\n"
    "- Only report what the tools return — never fabricate session names, amounts, or IDs.\n"
    "- Keep responses warm, concise, and helpful.\n"
    "- When you show data, briefly explain what it means for the user."
)


def init_session(session_id: str, identity_uuid: str) -> None:
    with _lock:
        _sessions[session_id] = {
            "messages": [{"role": "system", "content": _SYSTEM_TEMPLATE.format(identity_uuid=identity_uuid)}],
            "identity_uuid": identity_uuid,
            "last_active": time.time(),
        }


def get_identity_uuid(session_id: str) -> str:
    with _lock:
        return _sessions.get(session_id, {}).get("identity_uuid", "")


def append(session_id: str, message: dict) -> None:
    with _lock:
        if session_id in _sessions:
            _sessions[session_id]["messages"].append(message)
            _sessions[session_id]["last_active"] = time.time()


def get(session_id: str) -> list[dict]:
    with _lock:
        return list(_sessions.get(session_id, {}).get("messages", []))


def cleanup_expired() -> None:
    now = time.time()
    with _lock:
        expired = [sid for sid, data in _sessions.items() if now - data["last_active"] > _TTL]
        for sid in expired:
            del _sessions[sid]
