# CRM MCP Server — Implementation Guide

One Python file. Salesforce REST API via `simple-salesforce`. Send us the URL when done.

---

## What you are building

```
Admin → Chatbot → MCP client → [YOUR SERVER] → Salesforce REST API (Member__c, Consumption__c)
```

---

## 1. Install

```bash
pip install fastmcp simple-salesforce
```

> Use `simple-salesforce` (Python) — easier than porting your Node.js jsforce logic.
> Your existing OAuth2 credentials work as-is.

---

## 2. Environment variables

```env
SF_INSTANCE_URL=https://your-org.salesforce.com
SF_CLIENT_ID=your-connected-app-client-id
SF_CLIENT_SECRET=your-connected-app-client-secret
SF_REFRESH_TOKEN=your-refresh-token
SF_API_VERSION=v60.0
PORT=8003
```

> These are the same values already in your Node.js `.env`.

---

## 3. The MCP server file

Create `crm_mcp_server.py`:

```python
"""
CRM MCP Server — exposes Salesforce Member and Consumption data as MCP tools.
Run: python crm_mcp_server.py
"""
import os
from typing import Any

import requests
from fastmcp import FastMCP
from simple_salesforce import Salesforce, SalesforceAuthenticationFailed

mcp = FastMCP("crm")

_INSTANCE_URL   = os.getenv("SF_INSTANCE_URL", "")
_CLIENT_ID      = os.getenv("SF_CLIENT_ID", "")
_CLIENT_SECRET  = os.getenv("SF_CLIENT_SECRET", "")
_REFRESH_TOKEN  = os.getenv("SF_REFRESH_TOKEN", "")
_API_VERSION    = os.getenv("SF_API_VERSION", "v60.0")

_sf: Salesforce | None = None


def _get_sf() -> Salesforce:
    """Get or refresh Salesforce connection."""
    global _sf
    if _sf is not None:
        return _sf

    # Exchange refresh token for access token
    token_resp = requests.post(
        "https://login.salesforce.com/services/oauth2/token",
        data={
            "grant_type": "refresh_token",
            "client_id": _CLIENT_ID,
            "client_secret": _CLIENT_SECRET,
            "refresh_token": _REFRESH_TOKEN,
        },
        timeout=15,
    )
    token_resp.raise_for_status()
    token_data = token_resp.json()

    _sf = Salesforce(
        instance_url=token_data.get("instance_url", _INSTANCE_URL),
        session_id=token_data["access_token"],
        version=_API_VERSION.lstrip("v"),
    )
    return _sf


def _reset_sf() -> None:
    global _sf
    _sf = None


# ── Tools ──────────────────────────────────────────────────────────────────────

@mcp.tool()
def search_members(query: str) -> dict[str, Any]:
    """
    Search members by name or email. Returns matching Member__c records.
    query: partial name or email address to search for.
    """
    try:
        sf = _get_sf()
        # SOSL search across name and email fields
        sosl = f"FIND {{{query}}} IN ALL FIELDS RETURNING Member__c(Id, Master_UUID__c, Email__c, First_Name__c, Last_Name__c, Status__c, Wallet_Balance__c, Payment_Status__c) LIMIT 20"
        results = sf.search(sosl)
        records = results.get("searchRecords", [])
        members = [
            {
                "id": r.get("Id"),
                "master_uuid": r.get("Master_UUID__c"),
                "email": r.get("Email__c"),
                "first_name": r.get("First_Name__c"),
                "last_name": r.get("Last_Name__c"),
                "status": r.get("Status__c"),
                "wallet_balance": r.get("Wallet_Balance__c"),
                "payment_status": r.get("Payment_Status__c"),
            }
            for r in records
        ]
        return {"members": members, "count": len(members)}
    except SalesforceAuthenticationFailed:
        _reset_sf()
        return {"error": "Salesforce auth failed — retrying next call", "members": [], "count": 0}
    except Exception as exc:
        return {"error": f"Salesforce unavailable: {exc}", "members": [], "count": 0}


@mcp.tool()
def get_member_detail(master_uuid: str) -> dict[str, Any]:
    """
    Get the full CRM profile for a member by their master UUID.
    master_uuid: the identity service UUID for the member.
    """
    try:
        sf = _get_sf()
        result = sf.query(
            f"""
            SELECT Id, Master_UUID__c, Email__c, First_Name__c, Last_Name__c,
                   Birthdate__c, User_Type__c, Street__c, House_Number__c,
                   Postal_Code__c, City__c, Country_Code__c, Badge_ID__c,
                   Company_Name__c, VAT_Number__c, Wallet_Balance__c,
                   Wallet_Status__c, Payment_Status__c, Status__c,
                   Last_Invoice_URL__c, Last_Invoice_Due_Date__c,
                   Last_Invoice_Number__c, Last_Sync_At__c
            FROM Member__c
            WHERE Master_UUID__c = '{master_uuid}'
            LIMIT 1
            """
        )
        records = result.get("records", [])
        if not records:
            return {"error": f"No member found with UUID {master_uuid}"}
        r = records[0]
        return {
            "id": r.get("Id"),
            "master_uuid": r.get("Master_UUID__c"),
            "email": r.get("Email__c"),
            "first_name": r.get("First_Name__c"),
            "last_name": r.get("Last_Name__c"),
            "birthdate": r.get("Birthdate__c"),
            "user_type": r.get("User_Type__c"),
            "address": {
                "street": r.get("Street__c"),
                "house_number": r.get("House_Number__c"),
                "postal_code": r.get("Postal_Code__c"),
                "city": r.get("City__c"),
                "country": r.get("Country_Code__c"),
            },
            "badge_id": r.get("Badge_ID__c"),
            "company_name": r.get("Company_Name__c"),
            "vat_number": r.get("VAT_Number__c"),
            "wallet_balance": r.get("Wallet_Balance__c"),
            "wallet_status": r.get("Wallet_Status__c"),
            "payment_status": r.get("Payment_Status__c"),
            "status": r.get("Status__c"),
            "last_invoice_url": r.get("Last_Invoice_URL__c"),
            "last_invoice_due": r.get("Last_Invoice_Due_Date__c"),
            "last_invoice_number": r.get("Last_Invoice_Number__c"),
            "last_sync": r.get("Last_Sync_At__c"),
        }
    except SalesforceAuthenticationFailed:
        _reset_sf()
        return {"error": "Salesforce auth failed — retrying next call"}
    except Exception as exc:
        return {"error": f"Salesforce unavailable: {exc}"}


@mcp.tool()
def get_registration_stats() -> dict[str, Any]:
    """
    Get registration statistics: total members, breakdown by status and user type.
    """
    try:
        sf = _get_sf()

        total_result = sf.query("SELECT COUNT() FROM Member__c")
        total = total_result.get("totalSize", 0)

        by_status = sf.query(
            "SELECT Status__c, COUNT(Id) cnt FROM Member__c GROUP BY Status__c"
        )
        by_type = sf.query(
            "SELECT User_Type__c, COUNT(Id) cnt FROM Member__c GROUP BY User_Type__c"
        )

        return {
            "total_members": total,
            "by_status": [
                {"status": r.get("Status__c", "unknown"), "count": r.get("cnt", 0)}
                for r in by_status.get("records", [])
            ],
            "by_type": [
                {"type": r.get("User_Type__c", "unknown"), "count": r.get("cnt", 0)}
                for r in by_type.get("records", [])
            ],
        }
    except SalesforceAuthenticationFailed:
        _reset_sf()
        return {"error": "Salesforce auth failed — retrying next call", "total_members": 0}
    except Exception as exc:
        return {"error": f"Salesforce unavailable: {exc}", "total_members": 0}


@mcp.tool()
def get_consumption_summary(master_uuid: str | None = None) -> dict[str, Any]:
    """
    Get consumption (POS purchase) records.
    master_uuid: optional — if provided, returns only that member's consumptions.
    Otherwise returns a summary of recent consumptions across all members.
    """
    try:
        sf = _get_sf()

        where = f"WHERE Member__r.Master_UUID__c = '{master_uuid}'" if master_uuid else ""
        result = sf.query(
            f"""
            SELECT Consumption_ID__c, Product_Name__c, Quantity__c,
                   Total_Amount__c, Price_Per_Unit__c, VAT_Rate__c,
                   Member__r.Email__c, Member__r.Master_UUID__c
            FROM Consumption__c
            {where}
            ORDER BY CreatedDate DESC
            LIMIT 50
            """
        )
        records = result.get("records", [])
        consumptions = [
            {
                "consumption_id": r.get("Consumption_ID__c"),
                "product": r.get("Product_Name__c"),
                "quantity": r.get("Quantity__c"),
                "total_amount": r.get("Total_Amount__c"),
                "price_per_unit": r.get("Price_Per_Unit__c"),
                "vat_rate": r.get("VAT_Rate__c"),
                "member_email": (r.get("Member__r") or {}).get("Email__c"),
                "member_uuid": (r.get("Member__r") or {}).get("Master_UUID__c"),
            }
            for r in records
        ]
        total_spent = sum(float(c["total_amount"] or 0) for c in consumptions)
        return {"consumptions": consumptions, "count": len(consumptions), "total_amount": round(total_spent, 2)}
    except SalesforceAuthenticationFailed:
        _reset_sf()
        return {"error": "Salesforce auth failed — retrying next call", "consumptions": [], "count": 0}
    except Exception as exc:
        return {"error": f"Salesforce unavailable: {exc}", "consumptions": [], "count": 0}


# ── Run ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8003"))
    print(f"Starting CRM MCP server on port {port}...")
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
```

---

## 4. How to run it

```bash
export SF_INSTANCE_URL=https://your-org.salesforce.com
export SF_CLIENT_ID=...
export SF_CLIENT_SECRET=...
export SF_REFRESH_TOKEN=...
python crm_mcp_server.py
```

Test:
```bash
curl http://localhost:8003/mcp
```

---

## 5. Checklist before calling it done

- [ ] Server starts without errors
- [ ] `curl http://your-host:8003/mcp` returns HTTP 200
- [ ] `get_registration_stats()` returns a non-zero total
- [ ] `search_members("test")` returns results if test members exist
- [ ] `get_member_detail("some-uuid")` returns a full profile

---

## 6. What to send us

```
crm@http://your-host:8003/mcp
```

We add that one line to `MCP_SERVERS` and restart. Done.

---

## 7. Notes

- **Auth:** `simple-salesforce` handles the OAuth2 access token. If the token
  expires, the `_reset_sf()` function forces a re-auth on the next call.
- **Salesforce object names** match your existing code exactly:
  `Member__c`, `Consumption__c` with all the same custom fields.
- **SOSL vs SOQL:** `search_members` uses SOSL (full-text search across fields).
  All other tools use SOQL (structured queries). Both are supported by `simple-salesforce`.
- **Write tools:** not included here because admin edits to member records in
  Salesforce are sensitive. Add them only when explicitly needed.
