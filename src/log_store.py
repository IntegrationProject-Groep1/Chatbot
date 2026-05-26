"""
Log persistence — stores recent logs in the shared PostgreSQL database.
Old logs are purged automatically (default: 7 days).
"""

import hashlib
import os
import threading
import time
from datetime import datetime, timedelta
import logging

import psycopg2
import psycopg2.pool

_log = logging.getLogger(__name__)

_DB_HOST = os.getenv("DB_HOST", "postgredb-service")
_DB_PORT = int(os.getenv("DB_PORT", "5432"))
_DB_USER = os.getenv("DB_USER", "")
_DB_PASS = os.getenv("DB_PASSWORD", "")
_DB_NAME = os.getenv("DB_NAME", "")

_pool: psycopg2.pool.ThreadedConnectionPool | None = None
_pool_lock = threading.Lock()
_pool_next_retry: float = 0.0
_RETRY_COOLDOWN = 60.0

# In-memory cache of the last clear timestamp (persisted to DB).
# store_logs_batch() skips any entry whose @timestamp predates this value
# so Elasticsearch re-polling never re-surfaces cleared entries.
_cleared_at: float = 0.0


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
                        CREATE TABLE IF NOT EXISTS chatbot_logs (
                            id             SERIAL PRIMARY KEY,
                            source         TEXT NOT NULL,
                            level          TEXT NOT NULL,
                            action         TEXT,
                            message        TEXT,
                            timestamp      TEXT NOT NULL,
                            correlation_id TEXT,
                            created_at     DOUBLE PRECISION NOT NULL,
                            UNIQUE (correlation_id)
                        )
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS chatbot_log_refresh (
                            service      TEXT PRIMARY KEY,
                            last_refresh DOUBLE PRECISION NOT NULL
                        )
                    """)
                conn.commit()
            finally:
                p.putconn(conn)
            _pool = p
        except Exception as e:
            _pool_next_retry = time.time() + _RETRY_COOLDOWN
            _log.error("log_store: PostgreSQL unavailable, retrying in %ds: %s", int(_RETRY_COOLDOWN), e)
    return _pool


def init_db():
    _get_pool()
    _load_cleared_at()


def _load_cleared_at():
    """Read the persisted cleared_at value from DB into memory on startup."""
    global _cleared_at
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT last_refresh FROM chatbot_log_refresh WHERE service = '__cleared__'"
                )
                row = cur.fetchone()
                if row:
                    _cleared_at = row[0]
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("_load_cleared_at failed: %s", e)


def get_cleared_at() -> float:
    return _cleared_at


def set_cleared_at(ts: float):
    global _cleared_at
    _cleared_at = ts
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO chatbot_log_refresh (service, last_refresh)
                    VALUES ('__cleared__', %s)
                    ON CONFLICT (service) DO UPDATE SET last_refresh = EXCLUDED.last_refresh
                """, (ts,))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("set_cleared_at failed: %s", e)



def _ensure_correlation_id(cid: str, source: str, ts: str, action: str, message: str) -> str:
    """Generate a deterministic ID for entries that don't have one, so deduplication works."""
    if cid:
        return cid
    raw = f"{source}|{ts}|{action}|{message[:120]}"
    return "gen-" + hashlib.md5(raw.encode()).hexdigest()


def store_logs_batch(entries: list):
    if not entries:
        return
    pool = _get_pool()
    if pool is None:
        return
    cutoff = _cleared_at  # entries with @timestamp before this are suppressed
    try:
        conn = pool.getconn()
        try:
            now = time.time()
            with conn.cursor() as cur:
                for e in entries:
                    ts     = e.get("@timestamp") or e.get("timestamp") or datetime.utcnow().isoformat() + "Z"
                    # Skip entries that predate the last cache clear.
                    if cutoff > 0:
                        try:
                            entry_epoch = datetime.fromisoformat(ts.rstrip("Z")).replace(
                                tzinfo=__import__("datetime").timezone.utc
                            ).timestamp()
                            if entry_epoch < cutoff:
                                continue
                        except Exception:
                            pass  # unparseable timestamp → keep the entry
                    src    = e.get("source", "").lower()
                    action = e.get("action", "").lower()
                    msg    = e.get("message") or e.get("log_message", "")
                    cid    = _ensure_correlation_id(e.get("correlation_id") or "", src, ts, action, msg)
                    cur.execute("""
                        INSERT INTO chatbot_logs
                            (source, level, action, message, timestamp, correlation_id, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (correlation_id) DO NOTHING
                    """, (src, e.get("level", "info").lower(), action, msg, ts, cid, now))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("store_logs_batch failed: %s", e)


def get_recent_logs(limit: int = 100, hours: int = 24) -> list:
    limit = min(max(int(limit or 100), 1), 1000)
    pool = _get_pool()
    if pool is None:
        return []
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT source, level, action, message, timestamp, correlation_id
                    FROM chatbot_logs
                    WHERE created_at > %s
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (time.time() - hours * 3600, limit))
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("get_recent_logs failed: %s", e)
        return []


def get_logs_by_filter(
    since: str = None,
    until: str = None,
    service: str = None,
    level: str = None,
    action: str = None,
    limit: int = 200,
) -> list:
    limit = min(max(int(limit or 200), 1), 1000)
    pool = _get_pool()
    if pool is None:
        return []
    try:
        conn = pool.getconn()
        try:
            conditions: list[str] = []
            params: list = []
            if since:
                conditions.append("timestamp >= %s")
                params.append(since)
            if until:
                conditions.append("timestamp <= %s")
                params.append(until)
            if service:
                conditions.append("source = %s")
                params.append(service.lower())
            if level:
                conditions.append("level = %s")
                params.append(level.lower())
            if action:
                conditions.append("action = %s")
                params.append(action.lower())
            where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            params.append(limit)
            with conn.cursor() as cur:
                cur.execute(f"""
                    SELECT source, level, action, message, timestamp, correlation_id
                    FROM chatbot_logs
                    {where}
                    ORDER BY timestamp DESC
                    LIMIT %s
                """, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("get_logs_by_filter failed: %s", e)
        return []


def get_logs_by_service(service: str, limit: int = 100, hours: int = 24) -> list:
    limit = min(max(int(limit or 100), 1), 1000)
    pool = _get_pool()
    if pool is None:
        return []
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT source, level, action, message, timestamp, correlation_id
                    FROM chatbot_logs
                    WHERE source = %s AND created_at > %s
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (service.lower(), time.time() - hours * 3600, limit))
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("get_logs_by_service failed: %s", e)
        return []


def get_logs_summary(hours: int = 24) -> dict:
    pool = _get_pool()
    if pool is None:
        return {}
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT source, level, COUNT(*) as count
                    FROM chatbot_logs
                    WHERE created_at > %s
                    GROUP BY source, level
                    ORDER BY count DESC
                """, (time.time() - hours * 3600,))
                result: dict = {}
                for source, level, count in cur.fetchall():
                    result.setdefault(source, {})[level] = count
                return result
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("get_logs_summary failed: %s", e)
        return {}


def mark_service_refreshed(service: str):
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO chatbot_log_refresh (service, last_refresh)
                    VALUES (%s, %s)
                    ON CONFLICT (service) DO UPDATE SET last_refresh = EXCLUDED.last_refresh
                """, (service.lower(), time.time()))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("mark_service_refreshed failed: %s", e)


def get_last_refresh(service: str) -> float:
    pool = _get_pool()
    if pool is None:
        return 0
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT last_refresh FROM chatbot_log_refresh WHERE service = %s", (service.lower(),))
                row = cur.fetchone()
                return row[0] if row else 0
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("get_last_refresh failed: %s", e)
        return 0


def cleanup_old_logs(hours: int = 168):
    """Remove logs older than N hours (default 7 days)."""
    pool = _get_pool()
    if pool is None:
        return
    cutoff = time.time() - hours * 3600
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM chatbot_logs WHERE created_at < %s", (cutoff,))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("cleanup_old_logs failed: %s", e)


def clear_all_logs() -> int:
    """Delete all rows from chatbot_logs and record the clear timestamp.

    Any Elasticsearch entries with @timestamp before this moment will be
    silently dropped by store_logs_batch() on subsequent live polls.
    """
    pool = _get_pool()
    if pool is None:
        return 0
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM chatbot_logs")
                deleted = cur.rowcount
            conn.commit()
            _log.info("clear_all_logs: deleted %d rows", deleted)
            set_cleared_at(time.time())
            return deleted
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("clear_all_logs failed: %s", e)
        return 0


try:
    init_db()
except Exception as e:
    _log.error("log_store: init failed: %s", e)
