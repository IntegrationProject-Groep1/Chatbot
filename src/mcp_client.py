import json
import logging
import os
from typing import Any

_log = logging.getLogger(__name__)

_instance: "MCPClient | None" = None


def _parse_servers() -> dict[str, str]:
    """Parse MCP_SERVERS='sessions@http://host:8001/mcp,crm@http://host:8003/mcp' → {label: url}"""
    raw = os.getenv("MCP_SERVERS", "")
    result: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if "@" not in entry:
            continue
        label, url = entry.split("@", 1)
        result[label.strip()] = url.strip()
    return result


class MCPClient:
    def __init__(self) -> None:
        self._servers: dict[str, str] = {}          # label → url
        self._label_clients: dict[str, Any] = {}    # label → client
        # namespaced_name → (label, tool, original_tool_name)
        self._registry: dict[str, tuple[str, Any, str]] = {}

    async def _connect_server(self, label: str, url: str) -> None:
        """Connect to one MCP server and register its tools. Idempotent — tears down any existing connection first."""
        from fastmcp import Client
        from fastmcp.client.transports import StreamableHttpTransport

        # Tear down existing connection for this label if present
        old_client = self._label_clients.pop(label, None)
        if old_client is not None:
            try:
                await old_client.__aexit__(None, None, None)
            except Exception:
                pass
        # Remove stale registry entries for this label
        stale = [k for k in self._registry if k.startswith(f"{label}__")]
        for k in stale:
            del self._registry[k]

        client = Client(StreamableHttpTransport(url))
        await client.__aenter__()
        self._label_clients[label] = client
        tools = await client.list_tools()
        for tool in tools:
            namespaced = f"{label}__{tool.name}"
            self._registry[namespaced] = (label, tool, tool.name)
        _log.info("MCP [%s] connected — %d tools: %s", label, len(tools), [t.name for t in tools])

    async def init(self) -> None:
        self._servers = _parse_servers()
        if not self._servers:
            _log.warning("MCP_SERVERS not configured — no MCP tools loaded")
            return

        for label, url in self._servers.items():
            try:
                await self._connect_server(label, url)
            except Exception as exc:
                _log.warning("MCP [%s] unavailable at %s: %s", label, url, exc)

    async def close(self) -> None:
        for client in self._label_clients.values():
            try:
                await client.__aexit__(None, None, None)
            except Exception:
                pass
        self._label_clients.clear()
        self._registry.clear()

    def get_tool_definitions(self) -> list[dict]:
        """Return discovered tools in NVIDIA/OpenAI function-calling format."""
        return [
            {
                "type": "function",
                "function": {
                    "name": namespaced,
                    "description": tool.description or "",
                    "parameters": tool.inputSchema if tool.inputSchema else {"type": "object", "properties": {}},
                },
            }
            for namespaced, (_, tool, _orig) in self._registry.items()
        ]

    async def call_tool(self, name: str, args: dict, timeout: float = 30.0) -> str:
        """Call a tool by name (namespaced as label__tool_name). Always returns a JSON string.
        On session/connection errors, reconnects once and retries."""
        if name not in self._registry:
            return json.dumps({"error": f"Tool '{name}' not found in any MCP server"})

        for attempt in range(2):
            label, _, original_name = self._registry[name]
            client = self._label_clients.get(label)
            if client is None:
                return json.dumps({"error": f"No active connection for server '{label}'"})
            try:
                import asyncio
                result = await asyncio.wait_for(
                    client.call_tool(original_name, args),
                    timeout=timeout,
                )
                if getattr(result, 'is_error', None) or getattr(result, 'isError', None):
                    error_text = next(
                        (block.text for block in (result.content or []) if hasattr(block, "text")),
                        "Tool returned an error",
                    )
                    return json.dumps({"error": error_text, "status": "error"})
                if not result.content:
                    return json.dumps({"status": "ok", "data": []})
                first = result.content[0]
                if not hasattr(first, "text"):
                    return json.dumps({"result": str(first)})
                text = first.text
                try:
                    json.loads(text)
                    return text
                except (json.JSONDecodeError, TypeError):
                    return json.dumps({"result": text})
            except asyncio.TimeoutError:
                return json.dumps({"error": f"Tool '{name}' timed out after {timeout}s", "status": "timeout"})
            except Exception as exc:
                err_str = str(exc).lower()
                is_session_error = any(k in err_str for k in ("session", "terminated", "closed", "connection", "404", "reconnect"))
                if attempt == 0 and is_session_error and label in self._servers:
                    _log.warning("MCP [%s] session lost (%s) — reconnecting…", label, exc)
                    try:
                        await self._connect_server(label, self._servers[label])
                        continue  # retry with fresh connection
                    except Exception as reconnect_exc:
                        _log.warning("MCP [%s] reconnect failed: %s", label, reconnect_exc)
                return json.dumps({"error": str(exc), "status": "error"})

        return json.dumps({"error": "Tool call failed after reconnect attempt", "status": "error"})

    def has_tools(self) -> bool:
        return bool(self._registry)


async def init() -> MCPClient:
    global _instance
    _instance = MCPClient()
    await _instance.init()
    return _instance


async def close() -> None:
    global _instance
    if _instance:
        await _instance.close()
        _instance = None


def get() -> MCPClient:
    if _instance is None:
        raise RuntimeError("MCPClient not initialised — call mcp_client.init() at app startup")
    return _instance
