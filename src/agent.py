import asyncio
import json
import os
import time
from datetime import datetime, timezone
from typing import Callable

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

MAX_LOOPS = 6

_LOCAL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_date",
            "description": "Returns today's date and current time. Call this before answering any question that involves 'today', 'this week', 'this month', 'now', or any relative date.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    }
]

def _handle_local_tool(name: str) -> str | None:
    if name == "get_current_date":
        now = datetime.now()
        return json.dumps({
            "date": now.strftime("%Y-%m-%d"),
            "day_of_week": now.strftime("%A"),
            "time": now.strftime("%H:%M"),
            "month": now.strftime("%B %Y"),
            "week_start": (now - __import__("datetime").timedelta(days=now.weekday())).strftime("%Y-%m-%d"),
            "month_start": now.strftime("%Y-%m-01"),
        })
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
        "max_tokens": 1024,
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
    name = tool_call["function"]["name"]
    call_id = tool_call["id"]

    raw_args = tool_call["function"].get("arguments", "{}")
    args = json.loads(raw_args) if raw_args else {}

    await emit({"type": "tool_start", "tool": name, "label": name.replace("_", " ").title(), "call_id": call_id, "arguments": args})
    t0 = time.time()

    identity_uuid = session_store.get_identity_uuid(session_id)

    try:
        # Handle local tools without going through MCP
        local_result = _handle_local_tool(name)
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

        result = await mcp_client.get().call_tool(name, args)

        duration = int((time.time() - t0) * 1000)
        preview = result[:300] if isinstance(result, str) else ""
        await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "call_id": call_id, "result_preview": preview})
        return call_id, result
    except Exception as exc:
        duration = int((time.time() - t0) * 1000)
        await emit({"type": "tool_complete", "tool": name, "duration_ms": duration, "error": str(exc), "call_id": call_id})
        return call_id, json.dumps({"error": str(exc), "status": "error"})


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

    for loop_idx in range(MAX_LOOPS):
        called_tools: set[str] = set()  # reset each loop so the LLM can re-call tools with fresh data
        messages = session_store.get(session_id)

        await emit({"type": "status", "status": "thinking", "step": loop_idx + 1})

        # Pass emit only when there are no pending tool results — i.e. the LLM
        # might be producing a final answer we want to stream to the client.
        # On rounds where tool results are present, we still pass emit; the
        # is_tool_response guard inside _call_llama suppresses token emission.
        try:
            response_msg = await _call_llama(messages, emit=emit)
        except Exception as exc:
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
