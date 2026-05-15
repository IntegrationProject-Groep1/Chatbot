import asyncio
import json
import os
import time
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


async def _call_llama(messages: list[dict]) -> dict:
    tools = mcp_client.get().get_tool_definitions()
    payload: dict = {
        "model": _MODEL,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 1024,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(_API_URL, json=payload, headers=_HEADERS)
        resp.raise_for_status()
    return resp.json()["choices"][0]["message"]


async def _execute_tool(tool_call: dict, session_id: str, emit: Callable) -> tuple[str, str]:
    name = tool_call["function"]["name"]
    call_id = tool_call["id"]

    raw_args = tool_call["function"].get("arguments", "{}")
    args = json.loads(raw_args) if raw_args else {}

    await emit({"type": "tool_start", "tool": name, "label": name.replace("_", " ").title(), "call_id": call_id, "arguments": args})
    t0 = time.time()

    identity_uuid = session_store.get_identity_uuid(session_id)

    try:

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
    return events


def _build_suggestions(session_id: str) -> list[str]:
    tools_called = {msg.get("name") for msg in session_store.get(session_id) if msg.get("role") == "tool"}
    suggestions: list[str] = []
    if any("session" in t for t in tools_called):
        suggestions.append("Show attendance for a specific session")
    if any("invoice" in t or "facturatie" in t for t in tools_called):
        suggestions.append("Show overdue invoices")
    if any("service" in t or "monitor" in t or "error" in t or "alert" in t for t in tools_called):
        suggestions.append("Show recent error logs")
    if any("member" in t or "crm" in t for t in tools_called):
        suggestions.append("Look up a specific member")
    if not suggestions:
        suggestions = ["Show all active sessions", "Which services are currently down?"]
    suggestions.append("What else can I help with?")
    return suggestions[:3]


async def run_agent(session_id: str, user_message: str, emit: Callable) -> None:
    session_store.append(session_id, {"role": "user", "content": user_message})

    called_tools: set[str] = set()  # (name, args_json) pairs already executed this turn

    for loop_idx in range(MAX_LOOPS):
        messages = session_store.get(session_id)

        await emit({"type": "status", "status": "thinking", "step": loop_idx + 1})

        try:
            response_msg = await _call_llama(messages)
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
            if not final_text:
                # LLM returned no text — summarise tool results or give a fallback
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

            await emit({"type": "status", "status": "responding"})
            await _stream_text(final_text, emit)

            for card_event in _extract_cards(session_id):
                await emit(card_event)

            await emit({"type": "suggestions", "items": _build_suggestions(session_id)})
            await emit({"type": "done"})
            return

    await emit({"type": "error", "message": "Maximum reasoning depth reached.", "recoverable": True})
