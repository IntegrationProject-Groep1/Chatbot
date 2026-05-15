# Kassa MCP Server — Implementation Guide

This document tells you **exactly** what to build. Follow it step by step.
When done, send us your server URL and we add it to the chatbot in one line.

---

## What you are building

A small Python HTTP server (one file) that exposes your Odoo data as
**MCP tools**. The chatbot connects to it at startup, discovers the tools,
and calls them when an admin asks a question like "What were today's sales?"

```
Admin → Chatbot → MCP client → [YOUR SERVER] → Odoo XML-RPC → Odoo DB
```

You do **not** touch any chatbot code. You do **not** add XML or message queues.
You write one Python file, run it, and give us the URL.

---

## 1. Install dependencies

```bash
pip install fastmcp httpx
```

That is all. `fastmcp` is the MCP server framework. `httpx` is optional (only
needed if you prefer HTTP over XML-RPC — see note below). Odoo XML-RPC uses
Python's built-in `xmlrpc.client`, no extra install required.

---

## 2. Environment variables your server needs

Create a `.env` file (or set these in your deployment):

```env
ODOO_URL=https://kassa.desiderius.me
ODOO_DB=your_database_name        # ask infra for the exact DB name
ODOO_USER=your_api_user@email.com # dedicated read-only API user recommended
ODOO_PASS=your_api_password
PORT=8004                         # port the MCP server listens on
```

> **How to find your DB name:** log in to Odoo → Settings → About → shows
> database name. Or ask infra.

---

## 3. The MCP server file

Create `kassa_mcp_server.py`:

```python
"""
Kassa MCP Server — exposes Odoo POS data as MCP tools.
Run: python kassa_mcp_server.py
"""
import os
import xmlrpc.client
from datetime import datetime, timezone
from typing import Any

from fastmcp import FastMCP

mcp = FastMCP("kassa")

# ── Odoo connection ────────────────────────────────────────────────────────────
_URL      = os.getenv("ODOO_URL", "https://kassa.desiderius.me")
_DB       = os.getenv("ODOO_DB", "")
_USER     = os.getenv("ODOO_USER", "")
_PASSWORD = os.getenv("ODOO_PASS", "")

_uid: int | None = None


def _get_uid() -> int:
    """Authenticate once and cache the uid."""
    global _uid
    if _uid is None:
        common = xmlrpc.client.ServerProxy(f"{_URL}/xmlrpc/2/common")
        _uid = common.authenticate(_DB, _USER, _PASSWORD, {})
        if not _uid:
            raise RuntimeError("Odoo authentication failed — check ODOO_USER / ODOO_PASSWORD")
    return _uid


def _odoo(model: str, method: str, args: list, kwargs: dict | None = None) -> Any:
    """Execute an Odoo XML-RPC call. Resets uid cache on auth failure."""
    global _uid
    models = xmlrpc.client.ServerProxy(f"{_URL}/xmlrpc/2/object")
    try:
        return models.execute_kw(_DB, _get_uid(), _PASSWORD, model, method, args, kwargs or {})
    except xmlrpc.client.Fault as exc:
        if "Access Denied" in str(exc):
            _uid = None  # force re-auth on next call
        raise


# ── Tools ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def get_sales_summary(date_from: str | None = None, date_to: str | None = None) -> dict[str, Any]:
    """
    Get a sales revenue summary from the POS.
    date_from / date_to: optional ISO date strings, e.g. '2026-05-01'.
    Returns total revenue, number of orders, and a breakdown by day.
    """
    domain: list = [["state", "in", ["paid", "done", "invoiced"]]]
    if date_from:
        domain.append(["date_order", ">=", f"{date_from} 00:00:00"])
    if date_to:
        domain.append(["date_order", "<=", f"{date_to} 23:59:59"])

    try:
        orders = _odoo("pos.order", "search_read", [domain], {
            "fields": ["name", "amount_total", "date_order", "state"],
            "limit": 5000,
        })

        total_revenue = sum(o["amount_total"] for o in orders)
        by_day: dict[str, float] = {}
        for o in orders:
            day = o["date_order"][:10]  # YYYY-MM-DD
            by_day[day] = round(by_day.get(day, 0) + o["amount_total"], 2)

        return {
            "total_revenue": round(total_revenue, 2),
            "order_count": len(orders),
            "currency": "EUR",
            "period": {"from": date_from, "to": date_to},
            "by_day": [{"date": d, "revenue": r} for d, r in sorted(by_day.items())],
        }
    except Exception as exc:
        return {"error": f"Odoo unavailable: {exc}", "total_revenue": 0, "order_count": 0}


@mcp.tool()
def get_recent_orders(limit: int = 20) -> dict[str, Any]:
    """
    Get the most recent POS orders.
    limit: how many orders to return (default 20, max 100).
    """
    limit = min(limit, 100)
    try:
        orders = _odoo("pos.order", "search_read",
            [[["state", "in", ["paid", "done", "invoiced"]]]],
            {
                "fields": ["name", "amount_total", "date_order", "state", "partner_id"],
                "limit": limit,
                "order": "date_order desc",
            },
        )

        return {
            "orders": [
                {
                    "order_id": o["name"],
                    "total": o["amount_total"],
                    "date": o["date_order"],
                    "status": o["state"],
                    "customer": o["partner_id"][1] if o["partner_id"] else None,
                }
                for o in orders
            ],
            "count": len(orders),
        }
    except Exception as exc:
        return {"error": f"Odoo unavailable: {exc}", "orders": [], "count": 0}


@mcp.tool()
def get_all_wallets() -> dict[str, Any]:
    """
    Get an overview of all active wallet balances.
    Returns customers with a positive wallet balance, ordered by balance descending.
    Uses the custom x_wallet_balance field on res.partner (Kassa-specific, NOT loyalty.card).
    """
    try:
        partners = _odoo("res.partner", "search_read",
            [[["x_wallet_balance", ">", 0]]],
            {
                "fields": [
                    "name", "x_user_id", "x_badge_id",
                    "x_wallet_balance", "x_pending_topup_balance",
                    "x_outstanding_amount", "x_payment_status",
                ],
                "limit": 200,
                "order": "x_wallet_balance desc",
            },
        )
        total_balance = sum(p.get("x_wallet_balance", 0) for p in partners)
        wallets = [
            {
                "customer": p["name"],
                "master_uuid": p.get("x_user_id") or None,
                "badge_id": p.get("x_badge_id") or None,
                "balance": p.get("x_wallet_balance", 0),
                "pending_topup": p.get("x_pending_topup_balance", 0),
                "outstanding_amount": p.get("x_outstanding_amount", 0),
                "payment_status": p.get("x_payment_status") or None,
            }
            for p in partners
        ]
        return {"wallets": wallets, "count": len(wallets), "total_balance": round(total_balance, 2), "currency": "EUR"}
    except Exception as exc:
        return {"error": f"Odoo unavailable: {exc}", "wallets": [], "count": 0}


@mcp.tool()
def process_refund(order_id: str, reason: str) -> dict[str, Any]:
    """
    Issue a refund for a POS order.
    order_id: the order name/reference (e.g. 'POS/2026/0042').
    reason: written reason for the refund (required).

    NOTE: This is a WRITE operation. The chatbot will always ask the admin
    to confirm before calling this tool.
    """
    if not reason or not reason.strip():
        return {"error": "A reason is required to process a refund.", "success": False}

    try:
        # Find order by name
        ids = _odoo("pos.order", "search", [[["name", "=", order_id]]])
        if not ids:
            return {"error": f"Order '{order_id}' not found.", "success": False}

        # Odoo POS refund method (built-in since Odoo 14)
        result = _odoo("pos.order", "refund", [ids])

        return {
            "success": True,
            "order_id": order_id,
            "reason": reason,
            "refund_result": result,
            "message": f"Refund initiated for order {order_id}.",
        }
    except Exception as exc:
        return {"error": f"Refund failed: {exc}", "success": False}


# ── Run ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8004"))
    print(f"Starting Kassa MCP server on port {port}...")
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
```

---

## 4. How to run it

```bash
# With a .env file
pip install python-dotenv
python -c "from dotenv import load_dotenv; load_dotenv()" && python kassa_mcp_server.py

# Or export variables manually
export ODOO_URL=https://kassa.desiderius.me
export ODOO_DB=your_db
export ODOO_USER=api@example.com
export ODOO_PASSWORD=secret
python kassa_mcp_server.py
```

You should see:
```
Starting Kassa MCP server on port 8004...
INFO: Uvicorn running on http://0.0.0.0:8004
```

Test it is alive:
```bash
curl http://localhost:8004/mcp
```

---

## 5. Deploy it (Kubernetes)

Add a deployment to your cluster. Minimal example:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-kassa
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-kassa
  template:
    metadata:
      labels:
        app: mcp-kassa
    spec:
      containers:
        - name: mcp-kassa
          image: python:3.11-slim
          command: ["sh", "-c", "pip install fastmcp && python /app/kassa_mcp_server.py"]
          ports:
            - containerPort: 8004
          env:
            - name: ODOO_URL
              value: "https://kassa.desiderius.me"
            - name: ODOO_DB
              valueFrom:
                secretKeyRef:
                  name: odoo-credentials
                  key: db
            - name: ODOO_USER
              valueFrom:
                secretKeyRef:
                  name: odoo-credentials
                  key: user
            - name: ODOO_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: odoo-credentials
                  key: password
---
apiVersion: v1
kind: Service
metadata:
  name: mcp-kassa
spec:
  selector:
    app: mcp-kassa
  ports:
    - port: 8004
      targetPort: 8004
```

---

## 6. What to send us when it is running

Send us **one line** — the URL where your MCP server is reachable from inside
the cluster (or publicly):

```
kassa@http://mcp-kassa:8004/mcp
```

We add that to `MCP_SERVERS` in our `.env` and restart. Done.

---

## 7. Checklist before calling it done

- [ ] `python kassa_mcp_server.py` starts without errors
- [ ] `curl http://your-host:8004/mcp` returns an HTTP 200
- [ ] Calling `get_recent_orders()` returns real Odoo data (not `{"error": ...}`)
- [ ] Calling `get_sales_summary()` returns a non-zero total if there are paid orders
- [ ] Calling `get_all_wallets()` works (or returns a clear error if Loyalty module is not installed)
- [ ] `process_refund` is tested with a real order reference in a staging environment

---

## 8. Notes

- **Authentication is cached** — the server authenticates to Odoo once at startup
  and reuses the uid. If the session expires it re-authenticates automatically.
- **Read-only Odoo user recommended** — create a dedicated Odoo user with only
  the permissions needed (POS read, loyalty read). Do not use the admin password.
- **`process_refund` is a write tool** — the chatbot will always show a
  confirmation prompt to the admin before calling it. You do not need to add
  extra safety logic on your side.
- **Odoo version** — the code targets Odoo 16/17. If you are on an older version,
  `loyalty.card` may not exist — `get_all_wallets` will return a clear error
  message instead of crashing.
- **`pos.order` states** — `paid`, `done`, and `invoiced` all mean completed.
  `draft` means open/in-progress. `cancel` means cancelled. The tools filter
  for completed orders by default.
