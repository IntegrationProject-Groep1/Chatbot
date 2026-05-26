"""
Stateless per-MCP sub-agents for the A2A architecture.

Each sub-agent:
  - Receives a natural language query + optional context string (e.g. known master_uuid)
  - Runs a focused tool-use loop with only its MCP label's tools
  - Returns a natural language answer string to the orchestrator

The orchestrator (agent.py) calls these via the ask_<label> local tools.
Sub-agents never call each other — cross-service synthesis is the orchestrator's job.
"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

import mcp_client

_log = logging.getLogger(__name__)
_TZ = ZoneInfo("Europe/Brussels")
_MODEL = os.getenv("SUB_AGENT_MODEL", os.getenv("NVIDIA_MODEL", "meta/llama-3.1-8b-instruct"))
_API_URL = os.getenv("NVIDIA_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
_API_KEY = os.getenv("NVIDIA_API_SUBMODEL_KEY") or os.getenv("NVIDIA_API_KEY", "")
_HEADERS = {"Authorization": f"Bearer {_API_KEY}", "Content-Type": "application/json"}

_MAX_LOOPS = 5

_SYSTEM_PROMPTS: dict[str, str] = {
    "frontend": (
        "You are a specialist agent for the Frontend service (Drupal). "
        "You have tools for sessions, schedule, enrollments, attendees, and website user accounts. "
        "Use your tools to answer the query. "
        "When asked for attendees or enrolled users, include their raw master_uuid values in your response — "
        "the orchestrator needs these to resolve real names via the CRM. "
        "IMPORTANT: When listing sessions, limit your answer to 10 results maximum unless the admin explicitly asks for more. Summarise the rest as '...and X more'. "
        "Return a clean, concise answer. No unnecessary JSON. No technical Drupal field names."
    ),
    "crm": (
        "You are a specialist agent for the CRM service (Salesforce). "
        "You have tools for member profiles, wallet status, CRM activity/tasks, and member search. "
        "Use your tools to answer the query. "
        "Always include the master_uuid in your response so the orchestrator can use it for cross-service lookups. "
        "Format wallet amounts as €X,XXX.XX. No raw Salesforce field names like 'Master_UUID__c'. "
        "Return a clean, concise answer."
    ),
    "kassa": (
        "You are a specialist agent for the Kassa service (Odoo POS). "
        "You have tools for live wallet balances, POS orders, sales summaries, and refunds. "
        "Use your tools to answer the query. "
        "Format amounts as €X,XXX.XX. Never show raw UUIDs or master_uuid values. "
        "Return a clean, concise answer. No raw JSON."
    ),
    "facturatie": (
        "You are a specialist agent for the Facturatie service (FossBilling). "
        "You have tools for invoices, billing accounts, revenue totals, and company billing. "
        "Use your tools to answer the query. "
        "Format amounts as €X,XXX.XX. Never show raw UUIDs or master_uuid values. "
        "Return a clean, concise answer. No raw JSON."
    ),
    "monitoring": (
        "You are a specialist agent for the Monitoring service (Elasticsearch). "
        "You have tools for service health checks, error logs, metrics, and heartbeats. "
        "Use your tools to answer the query. "
        "Never show raw UUIDs or master_uuid values. "
        "Return a clean, concise answer. No raw JSON."
    ),
}


def _get_tools_for_label(label: str) -> list[dict]:
    """Return tool definitions scoped to a single MCP label."""
    try:
        client = mcp_client.get()
    except RuntimeError:
        return []
    return [
        t for t in client.get_tool_definitions()
        if t["function"]["name"].startswith(f"{label}__")
    ]


def _parse_inline_tool_calls(content: str) -> list[dict]:
    """Fallback: detect tool calls emitted as JSON code blocks in the content string."""
    import hashlib as _hashlib
    matches = re.findall(r"```(?:json)?\s*(\{[\s\S]+?\})\s*```", content)
    tool_calls = []
    for raw in matches:
        try:
            obj = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue
        name = obj.get("name") or (obj.get("function") or {}).get("name")
        if not name:
            continue
        params = obj.get("parameters") or obj.get("arguments") or obj.get("args") or {}
        if isinstance(params, str):
            try:
                params = json.loads(params)
            except Exception:
                params = {}
        uid = _hashlib.md5(raw.encode()).hexdigest()[:10]
        tool_calls.append({
            "id": f"sub-inline-{uid}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(params)},
        })
    return tool_calls


async def _call_sub_llm(messages: list[dict], tools: list[dict]) -> dict:
    """Streaming LLM call for a sub-agent — accumulates tokens, returns a complete message dict."""
    sanitized = []
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            if not (m.get("content") or "").strip():
                m = {k: v for k, v in m.items() if k != "content"}
        sanitized.append(m)

    payload: dict = {
        "model": _MODEL,
        "messages": sanitized,
        "temperature": 0.2,
        "max_tokens": 512,
        "stream": True,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    backoff = 1.0
    for attempt in range(3):
        full_content = ""
        tool_calls_acc: dict[int, dict] = {}
        try:
            async with httpx.AsyncClient(timeout=120.0) as http:
                async with http.stream("POST", _API_URL, json=payload, headers=_HEADERS) as resp:
                    if (resp.status_code == 429 or resp.status_code >= 500) and attempt < 2:
                        await resp.aread()
                        await asyncio.sleep(backoff)
                        backoff *= 2.0
                        continue
                    resp.raise_for_status()
                    async for raw in resp.aiter_lines():
                        if not raw.startswith("data: "):
                            continue
                        chunk_str = raw[6:].strip()
                        if chunk_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(chunk_str)
                        except json.JSONDecodeError:
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta", {})
                        if delta.get("content"):
                            full_content += delta["content"]
                        for tc in delta.get("tool_calls", []):
                            idx = tc.get("index", 0)
                            if idx not in tool_calls_acc:
                                tool_calls_acc[idx] = {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
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
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            if attempt < 2:
                _log.warning("Sub-agent LLM attempt %d failed: %s", attempt + 1, exc)
                await asyncio.sleep(backoff)
                backoff *= 2.0
                continue
            raise

    raise RuntimeError("Sub-agent LLM call failed after retries")


async def run_sub_agent(
    label: str,
    query: str,
    context: str = "",
    emit=None,
) -> str:
    """
    Run a stateless sub-agent for a specific MCP label.

    Args:
        label:   MCP server label (e.g. 'frontend', 'crm', 'kassa')
        query:   Natural language question from the orchestrator
        context: Optional key facts the orchestrator already knows (e.g. master_uuid, email)
        emit:    Optional async callable to send events to the WebSocket client for live progress

    Returns:
        Natural language answer string. The orchestrator appends this to its context.
    """
    import time as _time

    async def _emit(event: dict) -> None:
        if emit:
            try:
                await emit(event)
            except Exception:
                pass  # never let emit errors kill the sub-agent

    tools = _get_tools_for_label(label)
    if not tools:
        return f"The {label} service has no available tools — it may be disconnected or not configured."

    sys_prompt = _SYSTEM_PROMPTS.get(
        label, f"You are a specialist agent for the {label} service. Use your tools to answer the query."
    )
    now = datetime.now(_TZ)
    sys_prompt += f"\nCurrent date/time: {now.strftime('%Y-%m-%d %H:%M')} (Brussels)."

    user_content = f"Context: {context}\n\nQuery: {query}" if context else query

    messages: list[dict] = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_content},
    ]

    client = mcp_client.get()
    called: set[str] = set()

    for loop_idx in range(_MAX_LOOPS):
        await _emit({"type": "status", "status": f"sub_agent_{label}", "step": loop_idx + 1})

        try:
            response = await _call_sub_llm(messages, tools)
        except Exception as exc:
            _log.warning("Sub-agent [%s] loop %d LLM error: %s", label, loop_idx + 1, exc)
            return f"The {label} agent encountered an error: {exc}"

        tool_calls = response.get("tool_calls") or []

        # Inline tool-call fallback (some model variants emit JSON in content)
        if not tool_calls and response.get("content"):
            inline = _parse_inline_tool_calls(response["content"])
            if inline:
                _log.info("Sub-agent [%s] fallback: %d inline tool call(s) detected", label, len(inline))
                tool_calls = inline
                response = {**response, "content": None}

        if not tool_calls:
            answer = (response.get("content") or "").strip()
            return answer or f"The {label} agent returned no result."

        messages.append({
            "role": "assistant",
            "content": response.get("content"),
            "tool_calls": tool_calls,
        })

        for tc in tool_calls:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"].get("arguments", "{}"))
            except json.JSONDecodeError:
                args = {}

            key = f"{name}|{json.dumps(args, sort_keys=True)}"
            if key in called:
                result_str = json.dumps({"error": "Duplicate tool call skipped"})
            else:
                called.add(key)
                _log.debug("Sub-agent [%s] calling tool: %s args=%s", label, name, args)
                # Emit tool_start so the flow graph and event log light up
                call_id = tc.get("id", name)
                await _emit({
                    "type": "tool_start",
                    "tool": name,
                    "label": name.replace("__", " › ").replace("_", " ").title(),
                    "call_id": call_id,
                    "arguments": args,
                })
                t0 = _time.time()
                try:
                    result_str = await client.call_tool(name, args)
                except Exception as exc:
                    result_str = json.dumps({"error": str(exc), "status": "error"})
                duration = int((_time.time() - t0) * 1000)
                await _emit({
                    "type": "tool_complete",
                    "tool": name,
                    "duration_ms": duration,
                    "call_id": call_id,
                    "result_preview": result_str[:120] if isinstance(result_str, str) else "",
                })

            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "name": name,
                "content": result_str,
            })

    return f"The {label} agent reached maximum reasoning depth without completing."
