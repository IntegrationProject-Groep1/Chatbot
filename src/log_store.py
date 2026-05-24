"""
Log persistence — stores recent logs in the shared PostgreSQL database.
Old logs are purged automatically (default: 7 days).
"""

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


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool | None:
    global _pool
    if _pool is not None:
        return _pool
    if not _DB_USER:
        return None
    with _pool_lock:
        if _pool is None:
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
                _log.error("log_store: failed to connect to PostgreSQL: %s", e)
    return _pool


def init_db():
    _get_pool()


def store_log(source: str, level: str = "info", action: str = "", message: str = "",
              timestamp: str = "", correlation_id: str = ""):
    if not timestamp:
        timestamp = datetime.utcnow().isoformat() + "Z"
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO chatbot_logs
                        (source, level, action, message, timestamp, correlation_id, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (correlation_id) DO NOTHING
                """, (source, level, action, message, timestamp, correlation_id or None, time.time()))
            conn.commit()
        finally:
            pool.putconn(conn)
    except Exception as e:
        _log.error("store_log failed: %s", e)


def store_logs_batch(entries: list):
    if not entries:
        return
    pool = _get_pool()
    if pool is None:
        return
    try:
        conn = pool.getconn()
        try:
            now = time.time()
            with conn.cursor() as cur:
                for e in entries:
                    ts = e.get("@timestamp") or e.get("timestamp") or datetime.utcnow().isoformat() + "Z"
                    cur.execute("""
                        INSERT INTO chatbot_logs
                            (source, level, action, message, timestamp, correlation_id, created_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (correlation_id) DO NOTHING
                    """, (
                        e.get("source", "").lower(),
                        e.get("level", "info").lower(),
                        e.get("action", "").lower(),
                        e.get("message") or e.get("log_message", ""),
                        ts,
                        e.get("correlation_id") or None,
                        now,
                    ))
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


try:
    init_db()
except Exception as e:
    _log.error("log_store: init failed: %s", e)
