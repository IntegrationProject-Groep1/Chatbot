"""
Admin authentication — HTTP cookie-based login.

HOW TO ENABLE:
  1. Add these to your .env:
       ADMIN_SECRET=<run: python -c "import secrets; print(secrets.token_hex(32))">
       ADMIN_CREDENTIALS=alice:mypassword,bob:otherpassword
  2. In src/api.py, uncomment the three lines marked "# AUTH".
  3. Restart the server. Unauthenticated browsers are redirected to /admin/login.

ADMIN_CREDENTIALS: comma-separated "username:password" pairs (plain text in .env).
ADMIN_SECRET:      random 32-byte hex string — used to sign session tokens.
"""

import base64
import hashlib
import hmac
import os
import time

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

_SECRET: bytes = os.getenv("ADMIN_SECRET", "change-me-before-enabling").encode()
_CREDS_RAW: str = os.getenv("ADMIN_CREDENTIALS", "")
_TOKEN_TTL: int = 60 * 60 * 8   # 8 hours
_COOKIE: str = "admin_token"

# Paths that are always reachable without a token
_PUBLIC_PREFIXES = ("/health", "/api/admin/login", "/api/admin/logout", "/admin/login", "/static/")


def _parse_creds() -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in _CREDS_RAW.split(","):
        entry = entry.strip()
        if ":" in entry:
            user, pw = entry.split(":", 1)
            result[user.strip()] = pw.strip()
    return result


def verify_credentials(username: str, password: str) -> bool:
    creds = _parse_creds()
    stored = creds.get(username.strip(), "")
    if not stored:
        return False
    return hmac.compare_digest(stored.encode(), password.encode())


def _sign(payload: str) -> str:
    return hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()


def create_token(username: str) -> str:
    ts = str(int(time.time()))
    payload = f"{username}:{ts}"
    raw = f"{payload}:{_sign(payload)}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def verify_token(token: str) -> str | None:
    """Return username if token is valid and unexpired, else None."""
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        parts = raw.rsplit(":", 2)      # split from right: [username, ts, sig]
        if len(parts) != 3:
            return None
        username, ts, sig = parts
        payload = f"{username}:{ts}"
        if not hmac.compare_digest(_sign(payload), sig):
            return None
        if time.time() - int(ts) > _TOKEN_TTL:
            return None
        return username
    except Exception:
        return None


def _is_public(path: str) -> bool:
    return any(path == p or path.startswith(p) for p in _PUBLIC_PREFIXES)


class AdminAuthMiddleware(BaseHTTPMiddleware):
    """Reject unauthenticated requests: API → 401, pages → redirect to /admin/login."""

    async def dispatch(self, request: Request, call_next):
        if _is_public(request.url.path):
            return await call_next(request)

        token = request.cookies.get(_COOKIE)
        if token and verify_token(token):
            return await call_next(request)

        is_api = request.url.path.startswith("/api/") or request.url.path.startswith("/ws/")
        if is_api:
            return JSONResponse({"error": "Unauthorized — please log in at /admin/login"}, status_code=401)
        return RedirectResponse(url="/admin/login")
