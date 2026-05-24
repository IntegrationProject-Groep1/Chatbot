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

# ── Write-tool gate ──────────────────────────────────────────────────────────
_WRITE_PREFIXES = (
    "update_", "delete_", "cancel_", "create_",
    "mark_", "set_", "process_refund", "topup_",
    "enroll_", "unenroll_",
)
_CONFIRM_WORDS = frozenset({
    "ja", "yes", "ok", "bevestig", "confirm", "proceed",
    "doorgaan", "akkoord", "goedgekeurd", "approved", "sure", "zeker",
    "do it", "doe het", "go ahead",
})


def _is_write_tool(tool_name: str) -> bool:
    bare = tool_name.split("__")[-1].lower()
    return any(bare.startswith(p) for p in _WRITE_PREFIXES)


def _has_confirmation(session_id: str) -> bool:
    """True if the most recent user message is a short explicit confirmation."""
    for msg in reversed(session_store.get(session_id)):
        if msg.get("role") == "user":
            text = (msg.get("content") or "").lower().strip().rstrip("!.?")
            words = set(text.split())
            return bool(len(words) <= 8 and words & _CONFIRM_WORDS)
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
    return None


async def _call_llama(messages: list[dict], emit: Callable | None = None) -> dict:
    """Stream a completion from the NVIDIA API.

    When `emit` is provided, text tokens are forwarded to the client in real-time.
    Tool-call rounds suppress token emission (the model is not producing prose).
    Returns a reconstructed message dict compatible with the old non-streaming shape.
    """
    tools = _LOCAL_TOOLS + mcp_client.get().get_tool_definitions()
    payload: dict = {
        "model": _MODEL,
        "messages": messages,
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


async def _execute_tool(tool_call: dict, session_id: str, emit: Callable) -> tuple[str, str, bool]:
    """
    Execute a tool call. Returns (call_id, result_json, should_continue_loop).
    should_continue_loop=False means stop the agent loop immediately.
    """
    name = tool_call["function"]["name"]
    call_id = tool_call["id"]

    raw_args = tool_call["function"].get("arguments", "{}")
    args = json.loads(raw_args) if raw_args else {}

    await emit({"type": "tool_start", "tool": name, "label": name.replace("_", " ").title(), "call_id": call_id, "arguments": args})
    t0 = time.time()

    identity_uuid = session_store.get_identity_uuid(session_id)

    # ── Write-tool gate: require explicit admin confirmation ─────────────────
    if _is_write_tool(name) and not _has_confirmation(session_id):
        _log.info("WRITE BLOCKED pending confirmation: tool=%s session=%s args=%s",
                  name, session_id, args)
        await emit({
            "type": "confirm_required",
            "tool": name,
            "label": name.split("__")[-1].replace("_", " ").title(),
            "arguments": args,
            "call_id": call_id,
        })
        duration = int((time.time() - t0) * 1000)
        await emit({"type": "tool_complete", "tool": name, "duration_ms": duration,
                    "call_id": call_id, "result_preview": '{"status":"pending_confirmation"}'})
        return call_id, json.dumps({
            "status": "pending_confirmation",
            "message": "Admin confirmation required. Ask the admin to type 'ja' to confirm or 'nee' to cancel.",
        }), False  # Stop loop, don't continue

    try:
        # Handle local tools without going through MCP
        local_result = await _handle_local_tool(name, args)
        if local_result is not None:
            duration = int((time.time() - t0) * 1000)
            await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "call_id": call_id, "result_preview": local_result[:120]})
            return call_id, local_result, True

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
        return call_id, result, True
    except Exception as exc:
        duration = int((time.time() - t0) * 1000)
        _log.warning("TOOL ERROR: %s duration=%dms error=%s session=%s", name, duration, exc, session_id)
        await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "error": str(exc), "call_id": call_id})
        return call_id, json.dumps({"error": str(exc), "status": "error"}), True


async def _stream_text(text: str, emit: Callable) -> None:
    words = text.split(" ")
    for i, word in enumerate(words):
        token = word if i == len(words) - 1 else word + " "
        await emit({"type": "stream_token", "token": token})
        await asyncio.sleep(0.03)


def _extract_cards(session_id: str) -> list[dict]:
    """Extract structured data from tool results to render as UI cards."""
    events = []
    seen: set[str] = set()
    for msg in session_store.get(session_id):
        if msg.get("role") != "tool":
            continue
        try:
            data = json.loads(msg.get("content", "{}"))
        except (json.JSONDecodeError, TypeError):
            continue
        if "sessions" in data and data["sessions"] and "session" not in seen:
            events.append({"type": "cards", "card_type": "session", "data": data["sessions"]})
            seen.add("session")
        if "invoices" in data and data["invoices"] and "invoice" not in seen:
            events.append({"type": "cards", "card_type": "invoice", "data": data["invoices"]})
            seen.add("invoice")
        if "total_amount" in data and "total" not in seen:
            events.append({"type": "cards", "card_type": "invoice_total", "data": data})
            seen.add("total")
        if "services" in data and data["services"] and "services" not in seen:
            events.append({"type": "cards", "card_type": "service_status", "data": data["services"]})
            seen.add("services")
        if "errors" in data and data["errors"] and "errors" not in seen:
            events.append({"type": "cards", "card_type": "error_log", "data": data["errors"]})
            seen.add("errors")
        if "members" in data and data["members"] and "members" not in seen:
            events.append({"type": "cards", "card_type": "member", "data": data["members"]})
            seen.add("members")
        if "orders" in data and data["orders"] and "orders" not in seen:
            events.append({"type": "cards", "card_type": "order", "data": data["orders"]})
            seen.add("orders")
        # Wallet data — CRM (Wallet_Status__c / wallet_status) or Kassa live balance
        data_keys_lower = {k.lower() for k in data.keys()}
        if any("wallet" in k for k in data_keys_lower) and "wallet" not in seen:
            events.append({"type": "cards", "card_type": "wallet", "data": data})
            seen.add("wallet")
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

    # Track (tool_name|args) pairs across ALL loop iterations so the same failing
    # call is never retried with identical arguments in the same conversation turn.
    called_tools: set[str] = set()

    for loop_idx in range(MAX_LOOPS):
        messages = session_store.get(session_id)

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
            key = tc["function"]["name"] + "|" + tc["function"].get("arguments", "{}")
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

            await emit({"type": "status", "status": "executing_tools", "count": len(tool_calls)})

            results = await asyncio.gather(
                *[_execute_tool(tc, session_id, emit) for tc in tool_calls],
                return_exceptions=True,
            )

            should_stop = False
            for tc, result in zip(tool_calls, results):
                if isinstance(result, Exception):
                    call_id = tc["id"]
                    content = json.dumps({"error": str(result), "status": "error"})
                    should_continue = True
                else:
                    call_id, content, should_continue = result
                    if not should_continue:
                        should_stop = True

                session_store.append(session_id, {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": tc["function"]["name"],
                    "content": content,
                })

            if should_stop:
                await emit({"type": "done"})
                return

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
