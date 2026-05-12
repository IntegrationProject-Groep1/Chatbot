import asyncio
import json
import os
import time
from typing import Callable

import httpx
from dotenv import load_dotenv

import session_store
from downstream_tools import DownstreamConfig, query_planning, query_facturatie

load_dotenv()

_API_KEY = os.getenv("NVIDIA_API_KEY", "")
_MODEL = os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct")
_API_URL = os.getenv("NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
_HEADERS = {"Authorization": f"Bearer {_API_KEY}", "Content-Type": "application/json"}

MAX_LOOPS = 6

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "ask_planning",
            "description": (
                "Ask the Planning service a question about sessions or enrollments. "
                "Use scope='public' for questions about all available sessions. "
                "Use scope='personal' for questions about the sessions this specific user is enrolled in."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The question to ask the Planning service, in natural language.",
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["public", "personal"],
                        "description": (
                            "public = data available to everyone (all sessions). "
                            "personal = data specific to this user only (enrolled sessions)."
                        ),
                    },
                },
                "required": ["query", "scope"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_facturatie",
            "description": (
                "Ask the Facturatie service a question about invoices or billing for the current user. "
                "Always personal — invoice data is never public."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The question to ask the Facturatie service, in natural language.",
                    },
                },
                "required": ["query"],
            },
        },
    },
]

_SERVICE_META = {
    "ask_planning":   ("Planning Service",   "planning"),
    "ask_facturatie": ("Facturatie Service", "facturatie"),
}


async def _call_llama(messages: list[dict]) -> dict:
    payload = {
        "model": _MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.3,
        "max_tokens": 1024,
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(_API_URL, json=payload, headers=_HEADERS)
        resp.raise_for_status()
    return resp.json()["choices"][0]["message"]


def _dispatch_tool(name: str, args: dict, identity_uuid: str, cfg: DownstreamConfig) -> dict:
    """
    Synchronous tool execution — runs in a thread via run_in_executor.
    Returns a dict that is JSON-serialised and fed back to Llama as the tool result.
    Structured data (sessions, invoices, total) is included so _extract_cards still works.
    """
    if name == "ask_planning":
        result = query_planning(identity_uuid, args["scope"], args["query"], cfg)
        out: dict = {"response": result.response}
        if result.sessions:
            out["sessions"] = [
                {
                    "session_id": s.session_id, 
                    "name": s.name, 
                    "date": s.date, 
                    "location": s.location,
                    "description": s.description
                }
                for s in result.sessions
            ]
        if result.invoices:
            out["invoices"] = [
                {"invoice_id": i.invoice_id, "amount": i.amount, "date": i.date, "status": i.status}
                for i in result.invoices
            ]
        if result.total:
            out["total_amount"] = result.total.total_amount
            out["currency"] = result.total.currency
            out["count"] = result.total.count
        return out

    if name == "ask_facturatie":
        result = query_facturatie(identity_uuid, args["query"], cfg)
        out = {"response": result.response}
        if result.invoices:
            out["invoices"] = [
                {"invoice_id": i.invoice_id, "amount": i.amount, "date": i.date, "status": i.status}
                for i in result.invoices
            ]
        if result.total:
            out["total_amount"] = result.total.total_amount
            out["currency"] = result.total.currency
            out["count"] = result.total.count
        return out

    raise ValueError(f"Unknown tool: {name}")


async def _execute_tool(tool_call: dict, session_id: str, emit: Callable) -> tuple[str, str]:
    name = tool_call["function"]["name"]
    label, service = _SERVICE_META.get(name, (name, "unknown"))

    await emit({"type": "tool_start", "tool": name, "label": label, "service": service})
    t0 = time.time()

    identity_uuid = session_store.get_identity_uuid(session_id)
    cfg = DownstreamConfig()

    try:
        args = json.loads(tool_call["function"].get("arguments", "{}"))
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _dispatch_tool, name, args, identity_uuid, cfg)
        duration = int((time.time() - t0) * 1000)
        await emit({"type": "tool_complete", "tool": name, "label": label, "service": service, "duration_ms": duration})
        return tool_call["id"], json.dumps(result, ensure_ascii=False)
    except Exception as exc:
        duration = int((time.time() - t0) * 1000)
        await emit({"type": "tool_complete", "tool": name, "label": label, "service": service, "duration_ms": duration, "error": str(exc)})
        return tool_call["id"], json.dumps({"error": str(exc)})


async def _stream_text(text: str, emit: Callable) -> None:
    words = text.split(" ")
    for i, word in enumerate(words):
        token = word if i == len(words) - 1 else word + " "
        await emit({"type": "stream_token", "token": token})
        await asyncio.sleep(0.03)


def _extract_cards(session_id: str) -> list[dict]:
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
    return events


def _build_suggestions(session_id: str) -> list[str]:
    tools_called = {msg.get("name") for msg in session_store.get(session_id) if msg.get("role") == "tool"}
    suggestions = []
    if "ask_planning" in tools_called:
        suggestions.append("Tell me more about a specific session")
    if "ask_facturatie" in tools_called:
        suggestions.append("Show me my invoice details")
    if not suggestions:
        suggestions = ["What sessions are available?", "What are my upcoming sessions?"]
    suggestions.append("What else can you help me with?")
    return suggestions[:3]


async def run_agent(session_id: str, user_message: str, emit: Callable) -> None:
    session_store.append(session_id, {"role": "user", "content": user_message})

    for _ in range(MAX_LOOPS):
        messages = session_store.get(session_id)

        try:
            response_msg = await _call_llama(messages)
        except httpx.HTTPStatusError as exc:
            await emit({"type": "error", "message": f"AI service error ({exc.response.status_code})", "recoverable": True})
            return
        except Exception as exc:
            await emit({"type": "error", "message": f"AI service unavailable: {exc}", "recoverable": True})
            return

        tool_calls = response_msg.get("tool_calls") or []

        if tool_calls:
            session_store.append(session_id, {
                "role": "assistant",
                "content": response_msg.get("content"),
                "tool_calls": tool_calls,
            })

            results = await asyncio.gather(
                *[_execute_tool(tc, session_id, emit) for tc in tool_calls],
                return_exceptions=True,
            )

            for tc, result in zip(tool_calls, results):
                if isinstance(result, Exception):
                    call_id = tc["id"]
                    content = json.dumps({"error": str(result)})
                else:
                    call_id, content = result

                session_store.append(session_id, {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": tc["function"]["name"],
                    "content": content,
                })

        else:
            final_text = (response_msg.get("content") or "").strip()
            session_store.append(session_id, {"role": "assistant", "content": final_text})

            await _stream_text(final_text, emit)

            for card_event in _extract_cards(session_id):
                await emit(card_event)

            await emit({"type": "suggestions", "items": _build_suggestions(session_id)})
            await emit({"type": "done"})
            return

    await emit({"type": "error", "message": "Too many reasoning steps. Please try again.", "recoverable": True})
