"""
Log persistence layer — stores recent logs in SQLite with 2-hour refresh schedule.
Prevents the "no logs" display when services are idle.
"""

import os
import sqlite3
import json
import threading
import time
from datetime import datetime, timedelta
import logging

_log = logging.getLogger(__name__)

_DB_PATH = os.getenv("LOG_DB", os.path.join(os.path.dirname(__file__), "..", "logs.db"))
_lock = threading.Lock()
_cleanup_thread = None

def init_db():
    """Initialize log storage schema."""
    with _lock:
        conn = sqlite3.connect(_DB_PATH)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                level TEXT NOT NULL,
                action TEXT,
                message TEXT,
                timestamp TEXT NOT NULL,
                correlation_id TEXT,
                created_at REAL NOT NULL,
                UNIQUE(correlation_id) ON CONFLICT IGNORE
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS log_refresh (
                service TEXT PRIMARY KEY,
                last_refresh REAL NOT NULL
            )
        """)
        conn.commit()
        conn.close()

def store_log(source: str, level: str = "info", action: str = "", message: str = "", 
              timestamp: str = "", correlation_id: str = ""):
    """Store a single log entry."""
    if not timestamp:
        timestamp = datetime.utcnow().isoformat() + "Z"
    
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            conn.execute("""
                INSERT OR IGNORE INTO logs (source, level, action, message, timestamp, correlation_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (source, level, action, message, timestamp, correlation_id, time.time()))
            conn.commit()
            conn.close()
    except Exception as e:
        _log.error(f"Failed to store log: {e}")

def store_logs_batch(entries: list):
    """Store multiple log entries efficiently."""
    if not entries:
        return
    
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            now = time.time()
            for e in entries:
                timestamp = e.get("@timestamp") or e.get("timestamp") or datetime.utcnow().isoformat() + "Z"
                conn.execute("""
                    INSERT OR IGNORE INTO logs (source, level, action, message, timestamp, correlation_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    e.get("source", "").lower(),
                    e.get("level", "info").lower(),
                    e.get("action", "").lower(),
                    e.get("message") or e.get("log_message", ""),
                    timestamp,
                    e.get("correlation_id", ""),
                    now
                ))
            conn.commit()
            conn.close()
    except Exception as e:
        _log.error(f"Failed to store log batch: {e}")

def get_recent_logs(limit: int = 100, hours: int = 24) -> list:
    """Get recently stored logs, optionally filtered by time window."""
    limit = min(max(int(limit or 100), 1), 1000)
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT source, level, action, message, timestamp, correlation_id
                FROM logs
                WHERE created_at > ?
                ORDER BY created_at DESC
                LIMIT ?
            """, (time.time() - (hours * 3600), limit)).fetchall()
            conn.close()
            return [dict(r) for r in rows]
    except Exception as e:
        _log.error(f"Failed to get recent logs: {e}")
        return []

def get_logs_by_service(service: str, limit: int = 100, hours: int = 24) -> list:
    """Get logs from a specific service."""
    limit = min(max(int(limit or 100), 1), 1000)
    
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT source, level, action, message, timestamp, correlation_id
                FROM logs
                WHERE source = ? AND created_at > ?
                ORDER BY created_at DESC
                LIMIT ?
            """, (service.lower(), time.time() - (hours * 3600), limit)).fetchall()
            conn.close()
            return [dict(r) for r in rows]
    except Exception as e:
        _log.error(f"Failed to get logs for service {service}: {e}")
        return []

def get_logs_summary(hours: int = 24) -> dict:
    """Get summary of logs by service and level."""
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            rows = conn.execute("""
                SELECT source, level, COUNT(*) as count
                FROM logs
                WHERE created_at > ?
                GROUP BY source, level
                ORDER BY count DESC
            """, (time.time() - (hours * 3600),)).fetchall()
            conn.close()
            
            result = {}
            for source, level, count in rows:
                if source not in result:
                    result[source] = {}
                result[source][level] = count
            return result
    except Exception as e:
        _log.error(f"Failed to get logs summary: {e}")
        return {}

def mark_service_refreshed(service: str):
    """Mark a service's logs as recently refreshed (timestamp-only, no new logs)."""
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            conn.execute("""
                INSERT OR REPLACE INTO log_refresh (service, last_refresh)
                VALUES (?, ?)
            """, (service.lower(), time.time()))
            conn.commit()
            conn.close()
    except Exception as e:
        _log.error(f"Failed to mark service refreshed: {e}")

def get_last_refresh(service: str) -> float:
    """Get timestamp of last refresh for a service."""
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            row = conn.execute("""
                SELECT last_refresh FROM log_refresh WHERE service = ?
            """, (service.lower(),)).fetchone()
            conn.close()
            return row[0] if row else 0
    except Exception as e:
        _log.error(f"Failed to get last refresh: {e}")
        return 0

def cleanup_old_logs(hours: int = 168):  # 7 days default
    """Remove logs older than N hours."""
    cutoff = time.time() - (hours * 3600)
    try:
        with _lock:
            conn = sqlite3.connect(_DB_PATH)
            conn.execute("DELETE FROM logs WHERE created_at < ?", (cutoff,))
            conn.commit()
            conn.close()
    except Exception as e:
        _log.error(f"Failed to cleanup old logs: {e}")

# Initialize on import
try:
    init_db()
except Exception as e:
    _log.error(f"Failed to initialize log database: {e}")
