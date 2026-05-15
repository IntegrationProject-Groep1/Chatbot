# Facturatie MCP Server — Implementation Guide

One Python file. FossBilling REST API. Send us the URL when done.

---

## What you are building

```
Admin → Chatbot → MCP client → [YOUR SERVER] → FossBilling REST API
```

You call the FossBilling API you already have. We call your MCP server.

---

## 1. Install

```bash
pip install fastmcp httpx
```

---

## 2. Environment variables

```env
BILLING_API_URL=https://facturatie.desiderius.me/api
BILLING_API_USERNAME=admin
BILLING_API_TOKEN=your-fossbilling-api-token
PORT=8002
```

> **Where to find the API token:** FossBilling admin panel → Profile → API token

---

## 3. The MCP server file

Create `facturatie_mcp_server.py`:

```python
"""
Facturatie MCP Server — exposes FossBilling invoice data as MCP tools.
Run: python facturatie_mcp_server.py
"""
import os
from typing import Any

import httpx
from fastmcp import FastMCP

mcp = FastMCP("facturatie")

_API_URL  = os.getenv("BILLING_API_URL", "https://facturatie.desiderius.me/api")
_USERNAME = os.getenv("BILLING_API_USERNAME", "admin")
_TOKEN    = os.getenv("BILLING_API_TOKEN", "")

_http = httpx.AsyncClient(
    base_url=_API_URL,
    auth=(_USERNAME, _TOKEN),
    timeout=15.0,
)


async def _fb(endpoint: str, params: dict | None = None) -> dict:
    """GET a FossBilling admin endpoint."""
    resp = await _http.get(endpoint, params=params)
    resp.raise_for_status()
    data = resp.json()
    # FossBilling wraps responses: {"result": ..., "error": null}
    if data.get("error"):
        raise RuntimeError(f"FossBilling error: {data['error']}")
    return data.get("result", data)


async def _fb_post(endpoint: str, body: dict) -> dict:
    """POST to a FossBilling admin endpoint."""
    resp = await _http.post(endpoint, json=body)
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise RuntimeError(f"FossBilling error: {data['error']}")
    return data.get("result", data)


# ── Tools ──────────────────────────────────────────────────────────────────────

@mcp.tool()
async def get_all_invoices(status: str | None = None) -> dict[str, Any]:
    """
    Get all invoices. Optional status filter: 'paid', 'unpaid', 'cancelled'.
    Returns invoice list with amounts, dates, and client info.
    """
    try:
        params: dict = {"per_page": 200}
        if status:
            params["status"] = status

        result = await _fb("/admin/invoice/get_list", params)

        # result is {"list": [...], "total": N, "pages": N, "page": N}
        items = result.get("list", result) if isinstance(result, dict) else result
        invoices = [
            {
                "invoice_id": str(inv.get("id")),
                "client_id": inv.get("client_id"),
                "client_email": inv.get("client", {}).get("email") if isinstance(inv.get("client"), dict) else None,
                "amount": inv.get("total"),
                "currency": inv.get("currency", "EUR"),
                "status": inv.get("status"),
                "date": inv.get("created_at"),
                "paid_at": inv.get("paid_at"),
                "due_date": inv.get("due_date"),
            }
            for inv in (items if isinstance(items, list) else [])
        ]
        return {
            "invoices": invoices,
            "count": len(invoices),
            "total_pages": result.get("pages") if isinstance(result, dict) else None,
        }
    except Exception as exc:
        return {"error": f"FossBilling unavailable: {exc}", "invoices": [], "count": 0}


@mcp.tool()
async def get_revenue_summary(period: str | None = None) -> dict[str, Any]:
    """
    Get revenue totals from paid invoices.
    period: optional filter — 'today', 'this_month', 'this_year' or a year like '2026'.
    Returns total revenue, invoice count, and currency.
    """
    try:
        params: dict = {"status": "paid", "per_page": 1000}
        result = await _fb("/admin/invoice/get_list", params)
        items = result.get("list", []) if isinstance(result, dict) else []

        from datetime import datetime, date
        today = date.today()

        def in_period(inv: dict) -> bool:
            if not period:
                return True
            ts = inv.get("paid_at") or inv.get("created_at", "")
            try:
                dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).date()
            except Exception:
                return False
            if period == "today":
                return dt == today
            if period == "this_month":
                return dt.year == today.year and dt.month == today.month
            if period == "this_year":
                return dt.year == today.year
            # Treat as year number
            try:
                return dt.year == int(period)
            except ValueError:
                return True

        filtered = [inv for inv in items if in_period(inv)]
        total = sum(float(inv.get("total", 0)) for inv in filtered)
        currency = filtered[0].get("currency", "EUR") if filtered else "EUR"

        return {
            "total_revenue": round(total, 2),
            "invoice_count": len(filtered),
            "currency": currency,
            "period": period or "all time",
        }
    except Exception as exc:
        return {"error": f"FossBilling unavailable: {exc}", "total_revenue": 0, "invoice_count": 0}


@mcp.tool()
async def get_overdue_invoices() -> dict[str, Any]:
    """
    Get all unpaid invoices that are past their due date.
    Returns a list of overdue invoices with client info and amounts.
    """
    try:
        result = await _fb("/admin/invoice/get_list", {"status": "unpaid", "per_page": 500})
        items = result.get("list", []) if isinstance(result, dict) else []

        from datetime import date
        today = date.today()

        overdue = []
        for inv in items:
            due = inv.get("due_date")
            if due:
                try:
                    due_date = date.fromisoformat(str(due)[:10])
                    if due_date < today:
                        overdue.append({
                            "invoice_id": str(inv.get("id")),
                            "client_email": inv.get("client", {}).get("email") if isinstance(inv.get("client"), dict) else None,
                            "amount": inv.get("total"),
                            "currency": inv.get("currency", "EUR"),
                            "due_date": str(due_date),
                            "days_overdue": (today - due_date).days,
                        })
                except Exception:
                    pass

        overdue.sort(key=lambda x: x["days_overdue"], reverse=True)
        return {"invoices": overdue, "count": len(overdue)}
    except Exception as exc:
        return {"error": f"FossBilling unavailable: {exc}", "invoices": [], "count": 0}


@mcp.tool()
async def send_invoice_reminder(invoice_id: str) -> dict[str, Any]:
    """
    Send a payment reminder email for an unpaid invoice.
    invoice_id: the FossBilling invoice ID (number).

    NOTE: This is a WRITE operation. The chatbot will ask for confirmation before calling this.
    """
    try:
        result = await _fb_post("/admin/invoice/send_reminder", {"id": int(invoice_id)})
        return {
            "success": True,
            "invoice_id": invoice_id,
            "message": f"Reminder sent for invoice #{invoice_id}.",
            "result": result,
        }
    except Exception as exc:
        return {"error": f"Failed to send reminder: {exc}", "success": False}


# ── Run ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8002"))
    print(f"Starting Facturatie MCP server on port {port}...")
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
```

---

## 4. How to run it

```bash
export BILLING_API_URL=https://facturatie.desiderius.me/api
export BILLING_API_USERNAME=admin
export BILLING_API_TOKEN=your-token
python facturatie_mcp_server.py
```

Test:
```bash
curl http://localhost:8002/mcp
```

---

## 5. Checklist before calling it done

- [ ] Server starts without errors
- [ ] `curl http://your-host:8002/mcp` returns HTTP 200
- [ ] `get_all_invoices()` returns real invoices
- [ ] `get_overdue_invoices()` returns invoices with a past due date
- [ ] `get_revenue_summary(period="this_month")` returns a non-zero total if paid invoices exist

---

## 6. What to send us

```
facturatie@http://your-host:8002/mcp
```

We add that one line to `MCP_SERVERS` and restart. Done.

---

## 7. Notes

- **FossBilling API** uses HTTP Basic Auth (`username:api_token`). The token is from your admin profile, not your password.
- **Invoice statuses** in FossBilling: `paid`, `unpaid`, `cancelled`.
- **`send_invoice_reminder`** — check if FossBilling has this endpoint at `/admin/invoice/send_reminder`. If the endpoint name differs in your version, update it. Alternatively, FossBilling can trigger reminders via cron — in that case you can remove this tool.
- **Pagination** — the tools fetch up to 1000 invoices. If you have more, add pagination support.
