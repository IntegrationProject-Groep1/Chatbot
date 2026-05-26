import json
import logging
import os
import re
import threading
import time
from datetime import date as _date

_log = logging.getLogger(__name__)

import psycopg2
import psycopg2.pool

_sessions: dict[str, dict] = {}
_lock = threading.Lock()
_TTL = int(os.getenv("SESSION_TTL_SECONDS", "604800"))  # 7 days

_DB_HOST = os.getenv("DB_HOST", "postgredb-service")
_DB_PORT = int(os.getenv("DB_PORT", "5432"))
_DB_USER = os.getenv("DB_USER", "")
_DB_PASS = os.getenv("DB_PASSWORD", "")
_DB_NAME = os.getenv("DB_NAME", "")

# ── System prompt — orchestrator (A2A architecture) ─────────────────────────────
_SYSTEM_TEMPLATE = (
    "You are an admin assistant for the Shift Festival event management platform. "
    "Administrator UUID: {identity_uuid}. "
    "CRITICAL: This UUID identifies the logged-in admin — NEVER use it as a target for write or delete operations. "
    "Respond in the same language the admin uses (Dutch or English). "
    "Today's date is {today}.\n\n"

    "## Architecture — you are the orchestrator\n"
    "Delegate ALL read queries to the appropriate specialist sub-agent(s). "
    "Each sub-agent has deep knowledge of its service and only its tools.\n\n"
    "| Sub-agent | Service | Handles |\n"
    "|---|---|---|\n"
    "| `ask_crm` | CRM (Salesforce) | Members, wallet status, CRM activity, member search |\n"
    "| `ask_frontend` | Frontend (Drupal) | Sessions, schedule, enrollments, attendees, website users |\n"
    "| `ask_facturatie` | Facturatie (FossBilling) | Invoices, billing, authoritative revenue totals |\n"
    "| `ask_kassa` | Kassa (Odoo POS) | Live wallet balance, POS orders, live consumption |\n"
    "| `ask_monitoring` | Monitoring (Elasticsearch) | Service health, error logs, metrics |\n\n"

    "## Routing rules\n"
    "- **User/member lookup** → `ask_crm` first (gets profile + master_uuid). Pass master_uuid as `context` to follow-up sub-agents.\n"
    "- **Never guess emails** — if you only have a name, tell ask_crm to search by name.\n"
    "- **Profile lookup** → do NOT call ask_kassa unless admin explicitly asks about wallet/balance.\n"
    "- **Financial totals** → `ask_facturatie`. Live POS wallet/balance → `ask_kassa`.\n"
    "- **Enrollments** → `ask_frontend` (ask for all attendee master_uuids). Then call `batch_get_crm_members` with the returned UUIDs to resolve real names.\n"
    "- **Activity/history** → `ask_crm`. Technical/error logs → `ask_monitoring`.\n"
    "- **Multi-service** → ALWAYS call multiple sub-agents simultaneously in a SINGLE parallel response when the question touches 2+ services. NEVER call them one by one sequentially — that wastes time.\n"
    "- **BOUNDARY** → only query services the admin explicitly named. Never add diagnostic calls unless asked.\n\n"

    "## Write operations — local tools (always confirm before executing)\n"
    "These tools bypass sub-agents and act directly across all services:\n"
    "- New user → `create_user` ONLY. Required: email, first_name, last_name, user_type. Ask if any are missing — never guess.\n"
    "- Delete user → `delete_user` ONLY.\n"
    "- Wallet balance correction → `admin_set_wallet_balance` ONLY.\n"
    "- Wallet lease grant → `grant_wallet_lease`. Lease return → `return_wallet_lease`.\n"
    "For any write: state what/who is affected and ask admin to type 'ja' to confirm or 'nee' to cancel. "
    "If 'nee': abandon the action entirely — never re-propose it.\n\n"

    "## Output\n"
    "Lead with the answer. No preamble ('Based on...', 'I retrieved...'). "
    "3+ records → markdown table. Single value → 1-2 sentences, bold the key figure. "
    "Amounts → €X,XXX.XX. Dates → readable ('vrijdag 23 mei'). "
    "Hide raw UUIDs and technical field names in list/summary answers where they are noise. Show them when displaying detailed info about a specific user or member. "
    "Nonsensical or very short input → ask for clarification, call no tools.\n"
)

# ── PostgreSQL persistence ───────────────────────────────────────────────────

_pool: psycopg2.pool.ThreadedConnectionPool | None = None
_pool_lock = threading.Lock()
_pool_next_retry: float = 0.0
_RETRY_COOLDOWN = 60.0


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool | None:
    global _pool, _pool_next_retry
    if _pool is not None:
        return _pool
    if not _DB_USER:
        return None
    if time.time() < _pool_next_retry:
        return None
    with _pool_lock:
        if _pool is not None:
            return _pool
        if time.time() < _pool_next_retry:
            return None
        try:
            p = psycopg2.pool.ThreadedConnectionPool(
                1, 5,
                host=_DB_HOST, port=_DB_PORT,
                user=_DB_USER, password=_DB_PASS, dbname=_DB_NAME,
            )
            conn = p.getconn()
            try:
                with conn.cursor() as cur:
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS chatbot_sessions (
                            session_id    TEXT PRIMARY KEY,
                            identity_uuid TEXT NOT NULL,
                            messages      TEXT NOT NULL,
                            pending_write TEXT,
                            last_active   DOUBLE PRECISION NOT NULL
                        )
                    """)
                    cur.execute("""
                        ALTER TABLE chatbot_sessions
                        ADD COLUMN IF NOT EXISTS pending_write TEXT
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS chatbot_conversations (
                            session_id    TEXT PRIMARY KEY,
                            identity_uuid TEXT NOT NULL,
                            label         TEXT NOT NULL,
                            created_at    DOUBLE PRECISION NOT NULL,
                            last_active   DOUBLE PRECISION NOT NULL,
                            pinned        BOOLEAN NOT NULL DEFAULT FALSE
                        )
                    """)
                    cur.execute("""
                        ALTER TABLE chatbot_conversations
                        ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE
                    """)
                    cur.execute("""
                        CREATE INDEX IF NOT EXISTS idx_conv_identity
                        ON chatbot_conversations (identity_uuid, last_active DESC)
                    """)
                conn.commit()
            finally:
                p.putconn(conn)
            _pool = p
        except Exception as e:
            _pool_next_retry = time.time() + _RETRY_COOLDOWN
            import logging as _lg
            _lg.getLogger(__name__).error(
                "session_store: PostgreSQL unavailable, retrying in %ds: %s", int(_RETRY_COOLDOWN), e
            )
    return _pool


def _persist(session_id: str, identity_uuid: str, messages: list, last_active: float, pending_write: dict | None = None) -> None:
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO chatbot_sessions (session_id, identity_uuid, messages, pending_write, last_active)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (session_id) DO UPDATE SET
                        identity_uuid = EXCLUDED.identity_uuid,
                        messages      = EXCLUDED.messages,
                        pending_write = EXCLUDED.pending_write,
                        last_active   = EXCLUDED.last_active
                """, (session_id, identity_uuid, json.dumps(messages), 
                      json.dumps(pending_write) if pending_write else None, last_active))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("_persist failed for session %s: %s", session_id, e)


def _load_from_db(session_id: str) -> dict | None:
    """Load a session directly from the database."""
    pool = _get_pool()
    if pool is None:
        return None
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT identity_uuid, messages, last_active, pending_write FROM chatbot_sessions WHERE session_id = %s AND last_active > %s",
                    (session_id, time.time() - _TTL),
                )
                row = cur.fetchone()
                if row:
                    return {
                        "identity_uuid": row[0],
                        "messages": json.loads(row[1]),
                        "last_active": row[2],
                        "pending_write": json.loads(row[3]) if row[3] else None,
                    }
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("_load_from_db failed for session %s: %s", session_id, e)
    return None

# ── Public API ──────────────────────────────────────────────────────────────


def _refresh_date(messages: list) -> None:
    """Update the date in the system message to today (called on every WS connect)."""
    today = _date.today().isoformat()
    for m in messages:
        if m.get("role") == "system":
            m["content"] = re.sub(
                r"Today's date is \d{4}-\d{2}-\d{2}\.",
                f"Today's date is {today}.",
                m["content"],
            )
            break


def init_session(session_id: str, identity_uuid: str) -> None:
    # Always try to load from DB or create new — no global memory dict
    session = _load_from_db(session_id)
    if session:
        stored_uuid = session.get("identity_uuid", "")
        if stored_uuid and stored_uuid != identity_uuid:
            raise ValueError(
                f"Session {session_id} belongs to a different user — reconnect rejected"
            )
        msgs = session["messages"]
        _refresh_date(msgs)
        _persist(session_id, stored_uuid or identity_uuid, msgs, time.time(), session.get("pending_write"))
        return

    # Brand new session
    messages = [{"role": "system", "content": _SYSTEM_TEMPLATE.format(
        identity_uuid=identity_uuid,
        today=_date.today().isoformat(),
    )}]
    _persist(session_id, identity_uuid, messages, time.time())


def get_identity_uuid(session_id: str) -> str:
    session = _load_from_db(session_id)
    return session.get("identity_uuid", "") if session else ""


def append(session_id: str, message: dict) -> None:
    session = _load_from_db(session_id)
    if not session:
        # Session not in DB — the pool was likely unavailable during init_session.
        # Try to auto-recover: extract identity_uuid from the message if present
        # (only user messages carry it indirectly via the WS identify flow, so we
        # can't recover here). Log the drop so it appears in server logs.
        _log.warning(
            "append: session %s not found in DB (pool failure during init?), "
            "message dropped: role=%s",
            session_id, message.get("role"),
        )
        return
    msgs = session["messages"]
    msgs.append(message)
    _persist(session_id, session["identity_uuid"], msgs, time.time(), session.get("pending_write"))


def get(session_id: str) -> list[dict]:
    session = _load_from_db(session_id)
    return list(session.get("messages", [])) if session else []


def remove_pending_tool_results(session_id: str) -> None:
    """Remove tool messages with pending_confirmation or blocked status from session history.
    Called before re-executing a confirmed write tool so the history doesn't contain duplicate results.
    """
    session = _load_from_db(session_id)
    if not session:
        return
    import json as _json
    filtered = []
    for m in session["messages"]:
        if m.get("role") == "tool":
            try:
                content = _json.loads(m.get("content", "{}"))
                if content.get("status") in ("pending_confirmation", "blocked"):
                    continue
            except Exception:
                pass
        filtered.append(m)
    if len(filtered) != len(session["messages"]):
        _persist(session_id, session["identity_uuid"], filtered, time.time(), session.get("pending_write"))


def set_pending_write(session_id: str, tool_call: dict | None) -> None:
    """Persist a tool call blocked by the write-gate."""
    session = _load_from_db(session_id)
    if not session:
        return
    _persist(session_id, session["identity_uuid"], session["messages"], time.time(), tool_call)


def get_pending_write(session_id: str) -> dict | None:
    """Retrieve the pending tool call for a session."""
    session = _load_from_db(session_id)
    return session.get("pending_write") if session else None


def get_messages_for_api(session_id: str) -> list[dict]:
    """Return only user/assistant text exchanges for restoring the chat UI.

    Tool call messages and tool result messages are internal plumbing and are
    intentionally excluded — they show as blank or raw JSON in the chat and
    don't help the admin read back the conversation.
    """
    msgs = get(session_id)
    result = []
    for m in msgs:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue  # skip system, tool, and any unknown roles

        content = m.get("content")
        if isinstance(content, list):
            text = " ".join(
                block.get("text", "") for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        else:
            text = str(content) if content else ""

        text = text.strip()
        if not text:
            continue  # skip tool-call-only assistant messages (no visible text)

        result.append({"role": role, "text": text})
    return result


def cleanup_expired() -> None:
    now = time.time()
    with _lock:
        expired = [sid for sid, data in _sessions.items() if now - data["last_active"] > _TTL]
        for sid in expired:
            del _sessions[sid]
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM chatbot_sessions WHERE last_active < %s", (now - _TTL,))
                cur.execute("DELETE FROM chatbot_conversations WHERE last_active < %s AND pinned = FALSE", (now - _TTL,))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("cleanup_old_sessions failed: %s", e)


# ── Conversation metadata (per-admin, cross-device) ─────────────────────────

def upsert_conversation(session_id: str, identity_uuid: str, label: str) -> None:
    pool = _get_pool()
    if pool is None:
        return
    now = time.time()
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                # Atomically deactivate all other conversations for this user
                cur.execute("""
                    UPDATE chatbot_conversations
                    SET active = FALSE
                    WHERE identity_uuid = %s
                """, (identity_uuid,))
                # Insert or update the current conversation and mark it as active
                cur.execute("""
                    INSERT INTO chatbot_conversations
                        (session_id, identity_uuid, label, created_at, last_active, pinned, active)
                    VALUES (%s, %s, %s, %s, %s, FALSE, TRUE)
                    ON CONFLICT (session_id) DO UPDATE SET
                        label       = EXCLUDED.label,
                        last_active = EXCLUDED.last_active,
                        active      = TRUE
                """, (session_id, identity_uuid, label, now, now))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("upsert_conversation failed for session %s: %s", session_id, e)


def get_conversations(identity_uuid: str) -> list[dict]:
    pool = _get_pool()
    if pool is None:
        return []
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT session_id, label, created_at, last_active, pinned, active
                    FROM chatbot_conversations
                    WHERE identity_uuid = %s
                    ORDER BY pinned DESC, last_active DESC
                    LIMIT 50
                """, (identity_uuid,))
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("get_conversations failed for uuid %s: %s", identity_uuid, e)
        return []


def set_active(session_id: str | None, identity_uuid: str) -> bool:
    pool = _get_pool()
    if pool is None:
        return False
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE chatbot_conversations
                    SET active = FALSE
                    WHERE identity_uuid = %s
                """, (identity_uuid,))
                updated = False
                if session_id:
                    cur.execute("""
                        UPDATE chatbot_conversations
                        SET active = TRUE
                        WHERE session_id = %s AND identity_uuid = %s
                    """, (session_id, identity_uuid))
                    updated = cur.rowcount > 0
            conn.commit()
            return updated if session_id else True
        finally:
            pool.putconn(conn)
    except Exception as e:
        import logging as _lg
        _lg.getLogger(__name__).warning("set_active failed for session %s: %s", session_id, e)
        return False


def set_pinned(session_id: str, identity_uuid: str, pinned: bool) -> bool:
    pool = _get_pool()
    if pool is None:
        return False
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    UPDATE chatbot_conversations
                    SET pinned = %s
                    WHERE session_id = %s AND identity_uuid = %s
                """, (pinned, session_id, identity_uuid))
                updated = cur.rowcount > 0
            conn.commit()
            return updated
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("set_pinned failed for session %s: %s", session_id, e)
        return False


def delete_conversation(session_id: str, identity_uuid: str) -> bool:
    pool = _get_pool()
    if pool is None:
        return False
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM chatbot_conversations WHERE session_id = %s AND identity_uuid = %s",
                    (session_id, identity_uuid),
                )
                deleted = cur.rowcount > 0
                if deleted:
                    cur.execute("DELETE FROM chatbot_sessions WHERE session_id = %s", (session_id,))
            conn.commit()
            with _lock:
                _sessions.pop(session_id, None)
            return deleted
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.warning("delete_conversation failed for session %s: %s", session_id, e)
        return False
