"""
Admin authentication — cookie helpers used by /api/identify and /api/me.

SETUP:
  Add to env (or K8s secrets):
    ADMIN_SECRET=<run: python -c "import secrets; print(secrets.token_hex(32))">
    ADMIN_CREDENTIALS=you@shiftfestival.be:YourPassword,other@shiftfestival.be:OtherPass

  ADMIN_CREDENTIALS: comma-separated "email:password" pairs.
  ADMIN_SECRET:      random 32-byte hex — signs the session cookie.

  If ADMIN_CREDENTIALS is not set, the password field is ignored and any
  email known to the identity service can log in.
"""

import base64
import hashlib
import hmac
import os
import time

_SECRET: bytes = os.getenv("ADMIN_SECRET", "change-me-before-enabling").encode()
_CREDS_RAW: str = os.getenv("ADMIN_CREDENTIALS", "")
_TOKEN_TTL: int = 60 * 60 * 8   # 8 hours
_COOKIE: str = "admin_token"

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


