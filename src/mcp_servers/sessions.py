"""
Sessions MCP Server — queries Drupal JSON:API for event session data.

Session data moved from Planning team's DB to the Drupal frontend.
Run standalone: python -m src.mcp_servers.sessions
or: fastmcp run src/mcp_servers/sessions.py:mcp --transport streamable-http --port 8001
"""
import os
from typing import Any

import httpx
from fastmcp import FastMCP

mcp = FastMCP("sessions")

_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:30020")
_JSONAPI = f"{_BASE_URL}/jsonapi"


def _session_from_node(node: dict) -> dict:
    attr = node.get("attributes", {})
    return {
        "session_id": node.get("id"),
        "drupal_id": attr.get("drupal_internal__nid"),
        "name": attr.get("title"),
        "date": attr.get("field_date") or attr.get("field_session_date"),
        "location": attr.get("field_location"),
        "capacity": attr.get("field_capacity"),
        "description": attr.get("field_description", {}).get("value") if isinstance(attr.get("field_description"), dict) else attr.get("field_description"),
        "status": attr.get("field_status") or attr.get("status"),
    }


@mcp.tool()
async def get_all_sessions(status: str | None = None) -> dict[str, Any]:
    """Get all event sessions. Optional status filter (e.g. 'active', 'cancelled')."""
    params: dict[str, str] = {"page[limit]": "100"}
    if status:
        params["filter[field_status]"] = status
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{_JSONAPI}/node/session", params=params)
        resp.raise_for_status()
    data = resp.json().get("data", [])
    sessions = [_session_from_node(n) for n in data]
    return {"sessions": sessions, "count": len(sessions)}


@mcp.tool()
async def get_session_detail(session_id: str) -> dict[str, Any]:
    """Get full detail for a single session by its UUID."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{_JSONAPI}/node/session/{session_id}")
        resp.raise_for_status()
    node = resp.json().get("data", {})
    return _session_from_node(node)


@mcp.tool()
async def get_session_attendance(session_id: str) -> dict[str, Any]:
    """Get the list of registered attendees for a session."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{_JSONAPI}/node/session/{session_id}",
            params={"include": "field_registered_users,field_registrations"},
        )
        resp.raise_for_status()
    body = resp.json()
    included = body.get("included", [])
    attendees = [
        {
            "uuid": item.get("id"),
            "name": item.get("attributes", {}).get("name") or item.get("attributes", {}).get("field_full_name"),
            "email": item.get("attributes", {}).get("mail"),
        }
        for item in included
        if item.get("type", "").startswith("user--")
    ]
    node_attr = body.get("data", {}).get("attributes", {})
    return {
        "session_id": session_id,
        "session_name": node_attr.get("title"),
        "capacity": node_attr.get("field_capacity"),
        "registered": len(attendees),
        "attendees": attendees,
    }


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=int(os.getenv("PORT", "8001")))
