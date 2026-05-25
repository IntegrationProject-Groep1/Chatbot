import asyncio
import json
import os
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Callable

_TZ = ZoneInfo("Europe/Brussels")

import httpx
from dotenv import load_dotenv

import mcp_client
import session_store
from rabbitmq_rpc import publish_audit_event

load_dotenv()

_API_KEY = os.getenv("NVIDIA_API_KEY", "")
_MODEL = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")
_API_URL = os.getenv("NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
_HEADERS = {"Authorization": f"Bearer {_API_KEY}", "Content-Type": "application/json"}

import logging

_log = logging.getLogger(__name__)

MAX_LOOPS = 6

import re
import hashlib

# ── Write-tool gate ──────────────────────────────────────────────────────────
_WRITE_PREFIXES = (
    "update_", "delete_", "cancel_", "create_",
    "mark_", "set_", "process_refund", "topup_",
    "enroll_", "unenroll_",
    "grant_",   # grant_wallet_lease
    "return_",  # return_wallet_lease
    "admin_",   # admin_set_wallet_balance
)
_CONFIRM_WORDS_SINGLE = frozenset({
    "ja", "yes", "ok", "bevestig", "confirm", "proceed",
    "doorgaan", "akkoord", "goedgekeurd", "approved", "sure", "zeker",
    "yep", "yup", "jep", "oui", "si",
})
_CONFIRM_PHRASES = frozenset({
    "do it", "doe het", "go ahead", "ga door",
})

def _is_write_tool(tool_name: str) -> bool:
    bare = tool_name.split("__")[-1].lower()
    return any(bare.startswith(p) for p in _WRITE_PREFIXES)


def _has_confirmation(session_id: str) -> bool:
    """True if the most recent user message is a short, explicit confirmation."""
    for msg in reversed(session_store.get(session_id)):
        if msg.get("role") == "user":
            text = (msg.get("content") or "").lower().strip()
            # Remove trailing punctuation for the whole phrase check
            phrase = text.rstrip("!.?")
            if len(phrase.split()) > 8:
                return False
            # Split into words and strip ALL punctuation from each word
            words = {re.sub(r'[^\w]', '', w) for w in phrase.split()}
            return bool(words & _CONFIRM_WORDS_SINGLE or phrase in _CONFIRM_PHRASES)
    return False

_LOCAL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_date",
            "description": "Returns today's date and current time. Call this before answering any question that involves 'today', 'this week', 'this month', 'now', or any relative date.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_mcp_server_status",
            "description": (
                "Returns which MCP servers (frontend, kassa, crm, facturatie, monitoring) are "
                "currently connected and reachable by the chatbot. "
                "ALWAYS call this tool when the admin asks which services are online/offline, "
                "or before claiming any service is available. "
                "Do NOT rely on monitoring heartbeats alone for connection status."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "batch_get_crm_members",
            "description": (
                "Look up multiple CRM member profiles in parallel by master UUID. "
                "Use this after getting a list of UUIDs (e.g. from frontend__get_session_attendees) "
                "to resolve all names/details at once instead of calling crm__get_member one by one. "
                "Max 20 UUIDs per call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "master_uuids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of master UUIDs to look up (max 20)",
                    }
                },
                "required": ["master_uuids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "batch_get_crm_members_by_email",
            "description": (
                "Look up multiple CRM member profiles in parallel by email address. "
                "Use this when you have a list of emails (e.g. from Facturatie invoice results) "
                "and need all their CRM profiles at once. Max 20 emails per call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "emails": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of email addresses to look up (max 20)",
                    }
                },
                "required": ["emails"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_user",
            "description": (
                "Delete a user from the identity service and trigger the UserDeleted cascade across ALL services "
                "(CRM, Kassa, Facturatie, Frontend). WRITE OPERATION — confirm with admin before calling. "
                "ALWAYS resolve the master_uuid via crm__get_member_by_email first — never guess it. "
                "This is irreversible: the user is removed from identity, CRM is soft-deleted, "
                "Kassa wallet is zeroed, Facturatie invoices are cancelled, and frontend enrollments are removed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "master_uuid": {
                        "type": "string",
                        "description": "The user's master_uuid from the identity/CRM system. Resolve via crm__get_member_by_email first.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Written reason for deletion (required for audit trail). Example: 'GDPR erasure request — confirmed by user'.",
                    },
                },
                "required": ["master_uuid", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_user",
            "description": (
                "Create a new user across ALL services in the correct order. WRITE OPERATION — confirm first. "
                "Step 1: registers with the Identity service → gets master_uuid (idempotent — safe if user already exists). "
                "Step 2: creates CRM member (Salesforce) with that UUID. "
                "Step 3: creates Drupal account linked to that UUID so enrollments work. "
                "Step 4: Identity's UserCreated event notifies Kassa + Facturatie automatically. "
                "ALWAYS use this tool — never call crm__create_member + frontend__create_user separately, "
                "as those do NOT link the master_uuid and will break enrollments and cross-service lookups."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "email":        {"type": "string", "description": "Email address (must be unique across all systems)."},
                    "first_name":   {"type": "string", "description": "First name."},
                    "last_name":    {"type": "string", "description": "Last name."},
                    "user_type":    {"type": "string", "enum": ["Bedrijf", "Particulier"], "description": "'Particulier' for individual, 'Bedrijf' for company."},
                    "username":     {"type": "string", "description": "Drupal login username (no spaces). Defaults to the email prefix if not provided."},
                    "company_name": {"type": "string", "description": "Company name — required when user_type is 'Bedrijf'."},
                },
                "required": ["email", "first_name", "last_name", "user_type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grant_wallet_lease",
            "description": (
                "Admin manually grants Kassa live wallet control for a member when the badge scan did not trigger "
                "the automatic lease flow. WRITE OPERATION — confirm with admin before calling. "
                "Pre-flight: ALWAYS call crm__get_member_wallet first — abort if Wallet_Status__c is already 'Leased'. "
                "This tool: (1) sets Wallet_Status__c='Leased' in Salesforce via CRM MCP, "
                "(2) publishes wallet_lease_grant XML to kassa.incoming so Kassa activates the live wallet."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "master_uuid": {
                        "type": "string",
                        "description": "Member's Master_UUID__c. Resolve via crm__get_member_by_email — never guess.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reason for manual lease grant. Example: 'Badge scan failed at gate — manual grant by admin'.",
                    },
                },
                "required": ["master_uuid", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "return_wallet_lease",
            "description": (
                "Admin manually returns wallet lease authority from Kassa back to CRM when an event ends "
                "or the badge-out scan was missed. WRITE OPERATION — confirm with admin before calling. "
                "Pre-flight: ALWAYS call crm__get_member_wallet first — abort if Wallet_Status__c is NOT 'Leased'. "
                "This tool: (1) reads live final balance from Kassa, "
                "(2) publishes wallet_lease_return XML to kassa.exchange so CRM reconciles the balance in Salesforce."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "master_uuid": {
                        "type": "string",
                        "description": "Member's Master_UUID__c. Resolve via crm__get_member_by_email — never guess.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reason for manual lease return. Example: 'Event ended — admin forced lease close'.",
                    },
                },
                "required": ["master_uuid", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "admin_set_wallet_balance",
            "description": (
                "Admin correction: set absolute wallet balance for a member AND broadcast the change to all services. "
                "WRITE OPERATION — confirm with admin before calling. "
                "Use this instead of kassa__set_wallet_balance directly — this wrapper calls Kassa AND then "
                "publishes wallet_balance_update XML to kassa.exchange so Frontend and CRM both reflect the new value. "
                "kassa__set_wallet_balance alone does NOT broadcast the update."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "master_uuid": {
                        "type": "string",
                        "description": "Member's Master_UUID__c. Resolve via crm__get_member_by_email — never guess.",
                    },
                    "amount": {
                        "type": "number",
                        "description": "New wallet balance in EUR (≥ 0). Replaces the current balance.",
                        "minimum": 0,
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reason for balance correction. Example: 'Refund for cancelled event — €25 credit'.",
                    },
                },
                "required": ["master_uuid", "amount", "reason"],
            },
        },
    },
]


async def _batch_crm_lookup(tool_name: str, arg_key: str, values: list[str]) -> str:
    client = mcp_client.get()
    capped = values[:20]
    tasks = [client.call_tool(tool_name, {arg_key: v}) for v in capped]
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)
    members, errors = [], []
    for v, r in zip(capped, raw_results):
        if isinstance(r, Exception):
            errors.append({arg_key: v, "error": str(r)})
            continue
        try:
            data = json.loads(r)
            if data.get("error"):
                errors.append({arg_key: v, "error": data["error"]})
            else:
                members.append(data)
        except Exception:
            errors.append({arg_key: v, "error": "parse error"})
    return json.dumps({"members": members, "count": len(members), "errors": errors})


async def _handle_local_tool(name: str, args: dict) -> str | None:
    if name == "get_current_date":
        now = datetime.now(_TZ)
        return json.dumps({
            "date": now.strftime("%Y-%m-%d"),
            "day_of_week": now.strftime("%A"),
            "time": now.strftime("%H:%M"),
            "month": now.strftime("%B %Y"),
            "week_start": (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d"),
            "month_start": now.strftime("%Y-%m-01"),
        })
    if name == "get_mcp_server_status":
        try:
            client = mcp_client.get()
            status = client.get_server_status()
            connected = [label for label, ok in status.items() if ok]
            disconnected = [label for label, ok in status.items() if not ok]
            return json.dumps({
                "servers": status,
                "connected_count": len(connected),
                "disconnected_count": len(disconnected),
                "connected": connected,
                "disconnected": disconnected,
                "note": "This reflects live MCP socket connections, not Elasticsearch heartbeats.",
            })
        except Exception as exc:
            return json.dumps({"error": str(exc)})
    if name == "batch_get_crm_members":
        uuids = args.get("master_uuids", [])
        if not uuids:
            return json.dumps({"error": "master_uuids list is empty"})
        return await _batch_crm_lookup("crm__get_member", "master_uuid", uuids)
    if name == "batch_get_crm_members_by_email":
        emails = args.get("emails", [])
        if not emails:
            return json.dumps({"error": "emails list is empty"})
        return await _batch_crm_lookup("crm__get_member_by_email", "email", emails)
    if name == "delete_user":
        master_uuid = args.get("master_uuid", "").strip()
        reason = args.get("reason", "").strip()
        if not master_uuid:
            return json.dumps({"error": "master_uuid is required", "success": False})
        if not reason:
            return json.dumps({"error": "reason is required", "success": False})
        from downstream_tools import delete_identity_user, DownstreamConfig
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, delete_identity_user, master_uuid, reason, cfg)
        return json.dumps(result)
    if name == "create_user":
        email      = args.get("email", "").strip().lower()
        first_name = args.get("first_name", "").strip()
        last_name  = args.get("last_name", "").strip()
        user_type  = args.get("user_type", "").strip()
        username   = args.get("username", "").strip() or email.split("@")[0]
        company    = args.get("company_name", "").strip() or None
        if not all([email, first_name, last_name, user_type]):
            return json.dumps({"error": "email, first_name, last_name, and user_type are all required.", "success": False})
        from downstream_tools import create_identity_user, DownstreamConfig
        cfg = DownstreamConfig()
        loop = asyncio.get_event_loop()
        # Step 1: register with Identity → get master_uuid (also fires UserCreated fanout to Kassa + Facturatie)
        identity_result = await loop.run_in_executor(None, create_identity_user, email, cfg)
        if not identity_result.get("success"):
            return json.dumps({"error": f"Identity service: {identity_result.get('error')}", "success": False})
        master_uuid = identity_result["master_uuid"]
        client = mcp_client.get()
        # Step 2: create CRM member with the correct master_uuid
        crm_args: dict = {
            "first_name": first_name, "last_name": last_name,
            "email": email, "user_type": user_type, "master_uuid": master_uuid,
        }
        if company:
            crm_args["company_name"] = company
        try:
            crm_raw = await client.call_tool("crm__create_member", crm_args)
            crm_result = json.loads(crm_raw)
        except Exception as exc:
            crm_result = {"error": str(exc)}
        # Step 3: create Drupal account with master_uuid stored in users_data
        try:
            fe_raw = await client.call_tool("frontend__create_user", {
                "name": username, "email": email,
                "first_name": first_name, "last_name": last_name,
                "master_uuid": master_uuid,
            })
            fe_result = json.loads(fe_raw)
        except Exception as exc:
            fe_result = {"error": str(exc)}
        publish_audit_event("user.created", {
            "master_uuid": master_uuid, "email": email,
            "first_name": first_name, "last_name": last_name,
        })
        return json.dumps({
            "success": True,
            "master_uuid": master_uuid,
            "email": email,
            "crm": crm_result,
            "drupal": fe_result,
            "kassa_facturatie": "Notified automatically via Identity UserCreated event.",
            "message": f"User {first_name} {last_name} ({email}) created across all services. master_uuid: {master_uuid}",
        })
    if name == "grant_wallet_lease":
        master_uuid = args.get("master_uuid", "").strip()
        reason = args.get("reason", "").strip()
        if not master_uuid or not reason:
            return json.dumps({"error": "master_uuid and reason are required", "success": False})
        client = mcp_client.get()
        # Step 1: Read current wallet state from CRM
        try:
            wallet_raw = await client.call_tool("crm__get_member_wallet", {"master_uuid": master_uuid})
            wallet = json.loads(wallet_raw)
        except Exception as exc:
            return json.dumps({"error": f"Failed to read wallet from CRM: {exc}", "success": False})
        if wallet.get("error"):
            return json.dumps({"error": wallet["error"], "success": False})
        if wallet.get("Wallet_Status__c") == "Leased":
            return json.dumps({
                "error": (
                    f"Wallet is already Leased (lease_id={wallet.get('Last_Lease_ID__c')}). "
                    "Cannot grant a second lease. Use crm__list_active_leases to review."
                ),
                "success": False,
            })
        current_balance = float(wallet.get("Wallet_Balance__c") or 0.0)
        import uuid as _uuid_mod
        lease_id = f"LEASE-ADMIN-{_uuid_mod.uuid4().hex[:8].upper()}"
        # Step 2: Set Wallet_Status__c='Leased' in Salesforce via CRM MCP
        try:
            update_raw = await client.call_tool("crm__update_member_wallet", {
                "master_uuid": master_uuid,
                "wallet_status": "Leased",
                "reason": reason,
            })
            update = json.loads(update_raw)
        except Exception as exc:
            return json.dumps({"error": f"CRM wallet update failed: {exc}", "success": False})
        if update.get("error"):
            return json.dumps({"error": update["error"], "success": False})
        # Step 3: Publish wallet_lease_grant XML to kassa.incoming
        from xml_builders import build_wallet_lease_grant
        from rabbitmq_rpc import publish_xml_to_queue
        xml = build_wallet_lease_grant(master_uuid=master_uuid, current_balance=current_balance, lease_id=lease_id)
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, publish_xml_to_queue, "kassa.incoming", xml)
        publish_audit_event("wallet.lease_granted", {
            "master_uuid": master_uuid, "lease_id": lease_id,
            "balance": current_balance, "reason": reason,
        })
        return json.dumps({
            "success": True,
            "master_uuid": master_uuid,
            "lease_id": lease_id,
            "balance_sent_to_kassa": current_balance,
            "message": f"Wallet lease granted. Kassa notified with balance €{current_balance:.2f}. Lease ID: {lease_id}.",
        })
    if name == "return_wallet_lease":
        master_uuid = args.get("master_uuid", "").strip()
        reason = args.get("reason", "").strip()
        if not master_uuid or not reason:
            return json.dumps({"error": "master_uuid and reason are required", "success": False})
        client = mcp_client.get()
        # Step 1: Confirm wallet is currently Leased
        try:
            crm_raw = await client.call_tool("crm__get_member_wallet", {"master_uuid": master_uuid})
            crm_wallet = json.loads(crm_raw)
        except Exception as exc:
            return json.dumps({"error": f"Failed to read wallet from CRM: {exc}", "success": False})
        if crm_wallet.get("error"):
            return json.dumps({"error": crm_wallet["error"], "success": False})
        if crm_wallet.get("Wallet_Status__c") != "Leased":
            return json.dumps({
                "error": (
                    f"Wallet is not currently Leased (status={crm_wallet.get('Wallet_Status__c')}). "
                    "Nothing to return."
                ),
                "success": False,
            })
        lease_id = crm_wallet.get("Last_Lease_ID__c") or "UNKNOWN"
        # Step 2: Read live final balance from Kassa
        try:
            kassa_raw = await client.call_tool("kassa__get_wallet_by_master_uuid", {"master_uuid": master_uuid})
            kassa_wallet = json.loads(kassa_raw)
        except Exception as exc:
            return json.dumps({"error": f"Failed to read live wallet from Kassa: {exc}", "success": False})
        if kassa_wallet.get("error"):
            return json.dumps({"error": kassa_wallet["error"], "success": False})
        final_balance = float(
            kassa_wallet.get("wallet_balance") or kassa_wallet.get("x_wallet_balance") or 0.0
        )
        # Step 3: Publish wallet_lease_return XML via kassa.exchange so CRM receiver picks it up
        from xml_builders import build_wallet_lease_return
        from rabbitmq_rpc import publish_xml_to_exchange
        xml = build_wallet_lease_return(
            master_uuid=master_uuid, final_balance=final_balance, lease_id=lease_id
        )
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, publish_xml_to_exchange, "kassa.exchange", "kassa.to.crm.wallet_lease_return", xml
        )
        publish_audit_event("wallet.lease_returned", {
            "master_uuid": master_uuid, "final_balance": final_balance,
            "lease_id": lease_id, "reason": reason,
        })
        return json.dumps({
            "success": True,
            "master_uuid": master_uuid,
            "final_balance": final_balance,
            "lease_id": lease_id,
            "message": f"Wallet lease returned. CRM notified with final balance €{final_balance:.2f}.",
        })
    if name == "admin_set_wallet_balance":
        master_uuid = args.get("master_uuid", "").strip()
        amount = args.get("amount")
        reason = args.get("reason", "").strip()
        if not master_uuid or amount is None or not reason:
            return json.dumps({"error": "master_uuid, amount, and reason are required", "success": False})
        client = mcp_client.get()
        # Step 1: Call Kassa to set balance in Odoo
        try:
            kassa_raw = await client.call_tool("kassa__set_wallet_balance", {
                "master_uuid": master_uuid, "amount": amount, "reason": reason,
            })
            kassa_result = json.loads(kassa_raw)
        except Exception as exc:
            return json.dumps({"error": f"Kassa balance update failed: {exc}", "success": False})
        if kassa_result.get("error"):
            return json.dumps(kassa_result)
        new_balance = float(kassa_result.get("new_balance") or amount)
        # Step 2: Broadcast wallet_balance_update to Frontend and CRM via kassa.exchange
        from xml_builders import build_wallet_balance_update
        from rabbitmq_rpc import publish_xml_to_exchange
        xml = build_wallet_balance_update(master_uuid=master_uuid, new_balance=new_balance, authority="chatbot")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None, publish_xml_to_exchange, "kassa.exchange", "kassa.frontend.wallet", xml
        )
        publish_audit_event("wallet.balance_corrected", {
            "master_uuid": master_uuid, "new_balance": new_balance, "reason": reason,
        })
        return json.dumps({
            **kassa_result,
            "broadcast_sent": True,
            "message": (kassa_result.get("message") or "") + " Balance broadcast to all services.",
        })
    return None


async def _call_llama(messages: list[dict], emit: Callable | None = None) -> dict:
    """Stream a completion from the NVIDIA API.

    When `emit` is provided, text tokens are forwarded to the client in real-time.
    Tool-call rounds suppress token emission (the model is not producing prose).
    Returns a reconstructed message dict compatible with the old non-streaming shape.
    """
    tools = _LOCAL_TOOLS + mcp_client.get().get_tool_definitions()

    # The NVIDIA LLaMA endpoint rejects assistant messages where content is
    # null, empty, or whitespace-only alongside tool_calls.
    def _sanitize(msgs: list[dict]) -> list[dict]:
        result = []
        for m in msgs:
            if m.get("role") == "assistant" and m.get("tool_calls"):
                if not (m.get("content") or "").strip():
                    m = {k: v for k, v in m.items() if k != "content"}
            result.append(m)
        return result

    payload: dict = {
        "model": _MODEL,
        "messages": _sanitize(messages),
        "temperature": 0.3,
        "max_tokens": 4096,
        "stream": True,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    full_content = ""
    tool_calls_acc: dict[int, dict] = {}
    is_tool_response = False  # becomes True as soon as we see a tool_call delta

    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream("POST", _API_URL, json=payload, headers=_HEADERS) as resp:
            resp.raise_for_status()
            async for raw in resp.aiter_lines():
                if not raw.startswith("data: "):
                    continue
                payload_str = raw[6:].strip()
                if payload_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload_str)
                except json.JSONDecodeError:
                    continue

                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta", {})

                # Detect tool call as early as possible
                if delta.get("tool_calls"):
                    is_tool_response = True

                # Accumulate and optionally stream text
                if delta.get("content"):
                    full_content += delta["content"]
                    if emit and not is_tool_response:
                        await emit({"type": "stream_token", "token": delta["content"]})

                # Accumulate tool call fragments (streamed in pieces)
                for tc in delta.get("tool_calls", []):
                    idx = tc.get("index", 0)
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        }
                    if tc.get("id"):
                        tool_calls_acc[idx]["id"] = tc["id"]
                    fn = tc.get("function", {})
                    if fn.get("name"):
                        tool_calls_acc[idx]["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        tool_calls_acc[idx]["function"]["arguments"] += fn["arguments"]

    result: dict = {"content": full_content or None}
    if tool_calls_acc:
        result["tool_calls"] = [tool_calls_acc[i] for i in sorted(tool_calls_acc)]
    return result


async def _execute_tool(tool_call: dict, session_id: str, emit: Callable) -> tuple[str, str]:
    """Execute a tool call. Returns (call_id, result_json)."""
    name = tool_call["function"]["name"]
    call_id = tool_call["id"]

    raw_args = tool_call["function"].get("arguments", "{}")
    try:
        args = json.loads(raw_args) if raw_args else {}
    except json.JSONDecodeError:
        _log.warning("Malformed tool arguments JSON for %s: %r", tool_call["function"]["name"], raw_args)
        args = {}

    await emit({"type": "tool_start", "tool": name, "label": name.replace("_", " ").title(), "call_id": call_id, "arguments": args})
    t0 = time.time()
    identity_uuid = session_store.get_identity_uuid(session_id)

    try:
        local_result = await _handle_local_tool(name, args)
        if local_result is not None:
            duration = int((time.time() - t0) * 1000)
            await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "call_id": call_id, "result_preview": local_result[:120]})
            return call_id, local_result

        publish_audit_event(f"tool_called.{name}", {
            "session_id": session_id,
            "identity_uuid": identity_uuid,
            "tool": name,
            "arguments": args,
            "timestamp": time.time(),
        })

        _log.debug("TOOL CALL: %s args=%s session=%s", name, args, session_id)
        result = await mcp_client.get().call_tool(name, args)

        duration = int((time.time() - t0) * 1000)
        preview = result[:300] if isinstance(result, str) else ""
        _log.info("TOOL OK: %s duration=%dms session=%s", name, duration, session_id)
        await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "call_id": call_id, "result_preview": preview})
        return call_id, result
    except Exception as exc:
        duration = int((time.time() - t0) * 1000)
        _log.warning("TOOL ERROR: %s duration=%dms error=%s session=%s", name, duration, exc, session_id)
        await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "error": str(exc), "call_id": call_id})
        return call_id, json.dumps({"error": str(exc), "status": "error"})


async def _stream_text(text: str, emit: Callable) -> None:
    words = text.split(" ")
    for i, word in enumerate(words):
        token = word if i == len(words) - 1 else word + " "
        await emit({"type": "stream_token", "token": token})
        await asyncio.sleep(0.03)


def _extract_cards(session_id: str) -> list[dict]:
    """Extract structured data from the CURRENT TURN'S tool results to render as UI cards."""
    msgs = session_store.get(session_id)
    # Find the last user message index
    last_user_idx = -1
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].get("role") == "user":
            last_user_idx = i
            break

    turn_msgs = msgs[last_user_idx + 1:] if last_user_idx != -1 else msgs
    
    events = []
    seen: set[str] = set()
    for msg in turn_msgs:
        if msg.get("role") != "tool":
            continue
        try:
            content = msg.get("content", "{}")
            if not content or not content.strip():
                continue
            data = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            continue
        
        if not isinstance(data, dict):
            continue

        # Helper to hash content for deduplication (prevent identical cards in one turn)
        def add_card(card_type, card_data):
            content_hash = hashlib.md5(json.dumps(card_data, sort_keys=True).encode()).hexdigest()
            key = f"{card_type}:{content_hash}"
            if key not in seen:
                events.append({"type": "cards", "card_type": card_type, "data": card_data})
                seen.add(key)

        if "sessions" in data and data["sessions"]:
            add_card("session", data["sessions"])
        if "invoices" in data and data["invoices"]:
            add_card("invoice", data["invoices"])
        if "total_amount" in data:
            add_card("invoice_total", data)
        if "services" in data and data["services"]:
            add_card("service_status", data["services"])
        if "errors" in data and data["errors"]:
            add_card("error_log", data["errors"])
        if "members" in data and data["members"]:
            add_card("member", data["members"])
        if "orders" in data and data["orders"]:
            add_card("order", data["orders"])
        
        data_keys_lower = {k.lower() for k in data.keys()}
        if any("wallet" in k for k in data_keys_lower):
            add_card("wallet", data)
            
    return events


def _build_suggestions(session_id: str) -> list[str]:
    _FOLLOW_UPS: dict[str, list[str]] = {
        "crm":        ["Show wallet balance for this member", "List all active members", "Show recent CRM tasks"],
        "facturatie": ["Show overdue invoices", "Total revenue this month", "List all invoices for this client"],
        "kassa":      ["Revenue breakdown by day", "List recent orders", "Show refunds this week"],
        "frontend":   ["Show all sessions this week", "Attendance for this session", "List all website users"],
        "monitoring": ["Which services are degraded?", "Recent error logs", "Heartbeat timeline for a service"],
    }
    used: set[str] = set()
    for msg in session_store.get(session_id):
        if msg.get("role") == "tool":
            name = msg.get("name", "")
            ns = name.split("__")[0] if "__" in name else ""
            if ns:
                used.add(ns)
    suggestions: list[str] = []
    for ns in used:
        suggestions.extend(_FOLLOW_UPS.get(ns, []))
    if not suggestions:
        suggestions = [
            "Show all active sessions for this week",
            "Which services are degraded right now?",
            "Revenue from the Kassa today",
            "Recent error logs across all services",
        ]
    return suggestions[:4]


async def run_agent(session_id: str, user_message: str, emit: Callable) -> None:
    session_store.append(session_id, {"role": "user", "content": user_message})

    # ── Re-execute a pending write if admin just confirmed ───────────────────
    pending_tc = session_store.get_pending_write(session_id)
    if _has_confirmation(session_id) and pending_tc:
        # Clear pending write from DB (stateless)
        session_store.set_pending_write(session_id, None)

        # Remove the pending_confirmation/blocked placeholders so the real result doesn't duplicate them.
        session_store.remove_pending_tool_results(session_id)

        tc = pending_tc
        name = tc["function"]["name"]
        await emit({"type": "status", "status": "executing_tools", "count": 1})
        # The assistant message with tool_calls was already appended when the write was blocked —
        # do NOT append it again here or the LLM will see it twice.
        call_id, result = await _execute_tool(tc, session_id, emit)
        session_store.append(session_id, {
            "role": "tool", "tool_call_id": call_id, "name": name, "content": result
        })
        # Fall through — LLM summarises the result in the main loop
    elif not _has_confirmation(session_id):
        # Clear any stale pending write (user changed topic or typed "nee")
        session_store.set_pending_write(session_id, None)

    # Track (tool_name|normalised_args) to prevent identical retries within one turn
    called_tools: set[str] = set()

    for loop_idx in range(MAX_LOOPS):
        messages = session_store.get(session_id)

        # Guard: if the session has no messages the DB was unavailable during init_session.
        # Sending an empty list to NVIDIA causes a 400. Emit a clear error instead.
        if not messages:
            _log.error("run_agent: session %s has no context (DB unavailable during session init?)", session_id)
            await emit({"type": "error", "message": "Sessie data niet beschikbaar — ververs de pagina om opnieuw te verbinden.", "recoverable": False})
            return

        # Inject live date into the system message for this call — never stored, always fresh
        now = datetime.now(_TZ)
        week_start = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
        date_line = (
            f"\nCurrent date: {now.strftime('%Y-%m-%d')} ({now.strftime('%A')})"
            f", time: {now.strftime('%H:%M')}"
            f", week starts: {week_start}"
            f", month starts: {now.strftime('%Y-%m-01')}."
        )
        if messages and messages[0].get("role") == "system":
            messages = [{**messages[0], "content": messages[0]["content"] + date_line}, *messages[1:]]

        await emit({"type": "status", "status": "thinking", "step": loop_idx + 1})
        _log.debug("LLM round %d: session=%s messages=%d", loop_idx + 1, session_id, len(messages))

        try:
            t_llm = time.time()
            response_msg = await _call_llama(messages, emit=emit)
            _log.info("LLM round %d done: session=%s tools=%d duration=%.1fs",
                      loop_idx + 1, session_id,
                      len(response_msg.get("tool_calls") or []),
                      time.time() - t_llm)
        except Exception as exc:
            _log.exception("LLM error: session=%s round=%d", session_id, loop_idx + 1)
            await emit({"type": "error", "message": f"AI error: {exc}", "recoverable": True})
            return

        tool_calls = response_msg.get("tool_calls") or []

        # Drop any tool calls the LLM is repeating with identical arguments
        deduped: list[dict] = []
        for tc in tool_calls:
            name = tc["function"]["name"]
            args_str = tc["function"].get("arguments", "{}")
            try:
                # Normalize JSON to prevent duplicates due to whitespace/key order
                args_obj = json.loads(args_str)
                normalized_args = json.dumps(args_obj, sort_keys=True)
            except Exception:
                normalized_args = args_str
            
            key = f"{name}|{normalized_args}"
            if key not in called_tools:
                called_tools.add(key)
                deduped.append(tc)
        tool_calls = deduped

        thought = (response_msg.get("content") or "").strip()
        if thought and tool_calls:
            await emit({"type": "agent_thought", "text": thought, "step": loop_idx + 1})

        if tool_calls:
            session_store.append(session_id, {
                "role": "assistant",
                "content": response_msg.get("content"),
                "tool_calls": tool_calls,
            })

            # ── Write-tool gate: require explicit admin confirmation ─────────────────
            write_calls = [tc for tc in tool_calls if _is_write_tool(tc["function"]["name"])]
            if write_calls and not _has_confirmation(session_id):
                tc = write_calls[0]
                name = tc["function"]["name"]
                call_id = tc["id"]
                try:
                    args = json.loads(tc["function"].get("arguments", "{}"))
                except json.JSONDecodeError:
                    args = {}

                # Persist pending write to DB (stateless)
                session_store.set_pending_write(session_id, tc)
                _log.info("WRITE BLOCKED pending confirmation: tool=%s session=%s", name, session_id)
                
                await emit({
                    "type": "confirm_required",
                    "tool": name,
                    "label": name.split("__")[-1].replace("_", " ").title(),
                    "arguments": args,
                    "call_id": call_id,
                })
                
                # Report "pending" result for the blocked tool
                session_store.append(session_id, {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": json.dumps({
                        "status": "pending_confirmation",
                        "message": "Admin confirmation required. Ask the admin to type 'ja' to confirm or 'nee' to cancel.",
                    })
                })
                # For any other tools in the same batch, we also need to provide tool results 
                # or the LLM history will be invalid (missing tool responses).
                for other_tc in tool_calls:
                    if other_tc["id"] != call_id:
                        session_store.append(session_id, {
                            "role": "tool",
                            "tool_call_id": other_tc["id"],
                            "name": other_tc["function"]["name"],
                            "content": json.dumps({"status": "blocked", "message": "Batch blocked due to pending confirmation of another tool."})
                        })
                
                await emit({"type": "done"})
                return

            await emit({"type": "status", "status": "executing_tools", "count": len(tool_calls)})

            results = await asyncio.gather(
                *[_execute_tool(tc, session_id, emit) for tc in tool_calls],
                return_exceptions=True,
            )

            for tc, result in zip(tool_calls, results):
                if isinstance(result, Exception):
                    call_id = tc["id"]
                    content = json.dumps({"error": str(result), "status": "error"})
                else:
                    call_id, content = result

                session_store.append(session_id, {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": tc["function"]["name"],
                    "content": content,
                })

            continue

        else:
            final_text = (response_msg.get("content") or "").strip()
            streamed = bool(final_text)  # tokens already sent by _call_llama

            if not final_text:
                # LLM returned no text — build a fallback and stream it explicitly
                tool_msgs = [m for m in session_store.get(session_id) if m.get("role") == "tool"]
                if tool_msgs:
                    try:
                        last = json.loads(tool_msgs[-1].get("content", "{}"))
                        if last.get("error"):
                            final_text = f"The service returned an error: {last['error']}"
                        elif last.get("count") == 0 or (isinstance(last.get("sessions"), list) and not last["sessions"]):
                            final_text = "No results were found. The service may be unavailable or there is no data to show."
                        else:
                            final_text = "Done. See the results above."
                    except Exception:
                        final_text = "The request completed but no summary was returned."
                else:
                    final_text = "I'm not sure how to help with that. Try asking about sessions, invoices, members, orders, or service health."

            session_store.append(session_id, {"role": "assistant", "content": final_text})

            if not streamed:
                await _stream_text(final_text, emit)

            for card_event in _extract_cards(session_id):
                await emit(card_event)

            await emit({"type": "suggestions", "items": _build_suggestions(session_id)})
            await emit({"type": "done"})
            return

    await emit({"type": "error", "message": "Maximum reasoning depth reached.", "recoverable": True})
