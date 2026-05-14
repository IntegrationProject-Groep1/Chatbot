import os
import threading
import time

_sessions: dict[str, dict] = {}
_lock = threading.Lock()
_TTL = int(os.getenv("SESSION_TTL_SECONDS", "3600"))

_SYSTEM_TEMPLATE = (
    "You are an admin assistant for the event management platform. "
    "You are talking to an administrator (UUID: {identity_uuid}), not a regular user.\n\n"
    "You have access to tools that query all backend services:\n"
    "- Sessions: event sessions stored in the frontend (Drupal)\n"
    "- Facturatie: invoices and revenue in FossBilling\n"
    "- CRM: member profiles and registrations in Salesforce\n"
    "- Kassa: POS orders and wallet balances in Odoo\n"
    "- Monitoring: service health and error logs in Elasticsearch\n"
    "- Identity: user lookup by email or UUID\n\n"
    "Rules:\n"
    "- You have system-wide access — return data for all users, not just one.\n"
    "- If a question spans multiple services, call those tools in parallel.\n"
    "- Only report what the tools return — never fabricate names, amounts, or IDs.\n"
    "- Be concise and direct — admins want facts, not explanations.\n"
    "- For write operations, always confirm with the admin before executing."
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
