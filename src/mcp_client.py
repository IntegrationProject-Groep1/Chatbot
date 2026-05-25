import asyncio
import json
import logging
import os
import time
from typing import Any

_log = logging.getLogger(__name__)

_CACHE_TTL = float(os.getenv("MCP_CACHE_TTL", "0"))   # seconds; 0 to disable (default off — DB is source of truth)
_NO_CACHE = (
    "create", "update", "delete", "refund", "write", "send", "post",
    "patch", "remove", "set_", "enroll", "unenroll"
)

_instance: "MCPClient | None" = None

_HEALTH_INTERVAL = int(os.getenv("MCP_HEALTH_INTERVAL", "30"))   # seconds between health checks
_RECONNECT_BACKOFF = [2, 5, 15, 30]                               # seconds to wait between retries


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
        self._health_task: asyncio.Task | None = None
        self._server_health: dict[str, bool] = {}        # label → confirmed-alive

    async def _connect_server(self, label: str, url: str) -> None:
        """Connect to one MCP server and register its tools. Idempotent — tears down existing connection first."""
        from fastmcp import Client
        from fastmcp.client.transports import StreamableHttpTransport

        old_client = self._label_clients.pop(label, None)
        if old_client is not None:
            try:
                await old_client.__aexit__(None, None, None)
            except Exception as e:
                _log.debug("MCP [%s] session teardown: %s (ignored)", label, e)
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
        self._server_health[label] = True
        _log.info("MCP [%s] connected — %d tools: %s", label, len(tools), [t.name for t in tools])

    async def _reconnect_with_backoff(self, label: str) -> None:
        """Keep retrying to reconnect a single server using exponential backoff."""
        url = self._servers.get(label)
        if not url:
            return
        for wait in _RECONNECT_BACKOFF:
            await asyncio.sleep(wait)
            try:
                await self._connect_server(label, url)
                _log.info("MCP [%s] reconnected successfully", label)
                return
            except Exception as exc:
                _log.warning("MCP [%s] reconnect attempt failed (retrying in %ss): %s", label, wait, exc)
        _log.error("MCP [%s] could not reconnect after all retries — will retry at next health check", label)

    async def _ping(self, label: str, url: str) -> bool:
        """Lightweight HTTP check to the MCP base URL."""
        try:
            import httpx
            async with httpx.AsyncClient(timeout=4.0) as http:
                # 1. Try HEAD request to base URL (fastest, most generic)
                r = await http.head(url)
                if r.status_code < 500:
                    return True
                
                # 2. Try GET to /health as fallback
                health_url = url.rstrip("/").rsplit("/mcp", 1)[0] + "/health" if "/mcp" in url else url
                r = await http.get(health_url)
                return r.status_code < 500
        except Exception:
            return False

    async def _health_loop(self) -> None:
        """Background task: ping every MCP server periodically and reconnect if dead."""
        while True:
            await asyncio.sleep(_HEALTH_INTERVAL)
            for label, url in list(self._servers.items()):
                alive = await self._ping(label, url)
                if alive:
                    if not self._server_health.get(label):
                        # Was down, now reachable — reconnect to refresh session
                        try:
                            await self._connect_server(label, url)
                            _log.info("MCP [%s] recovered", label)
                        except Exception as exc:
                            _log.warning("MCP [%s] ping ok but reconnect failed: %s", label, exc)
                            self._server_health[label] = False
                    else:
                        self._server_health[label] = True
                else:
                    if self._server_health.get(label, True):
                        _log.warning("MCP [%s] health check failed — marking offline", label)
                    self._server_health[label] = False

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
                self._server_health[label] = False

        self._health_task = asyncio.create_task(self._health_loop())

    async def close(self) -> None:
        if self._health_task:
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass
            self._health_task = None
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
        On session/connection errors, reconnects once and retries immediately."""
        if name not in self._registry:
            return json.dumps({"error": f"Tool '{name}' not found in any MCP server"})

        for attempt in range(2):
            label, _, original_name = self._registry[name]
            client = self._label_clients.get(label)
            if client is None:
                return json.dumps({"error": f"No active connection for server '{label}'"})
            try:
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
                    result_str = text
                except (json.JSONDecodeError, TypeError):
                    result_str = json.dumps({"result": text})
                return result_str
            except asyncio.TimeoutError:
                return json.dumps({"error": f"Tool '{name}' timed out after {timeout}s", "status": "timeout"})
            except Exception as exc:
                err_str = str(exc).lower()
                # Match errors that indicate the MCP session/transport was reset,
                # not just any message containing common words like "connection".
                is_session_error = any(k in err_str for k in (
                    "session terminated", "session closed", "session not found",
                    "connection reset", "connection refused", "connection closed",
                    "eof", "broken pipe", "404",
                ))
                if attempt == 0 and is_session_error and label in self._servers:
                    _log.warning("MCP [%s] session lost (%s) — reconnecting…", label, exc)
                    try:
                        await self._connect_server(label, self._servers[label])
                        continue
                    except Exception as reconnect_exc:
                        _log.warning("MCP [%s] reconnect failed: %s", label, reconnect_exc)
                        # Kick off background backoff reconnect so it recovers without user waiting
                        asyncio.create_task(self._reconnect_with_backoff(label))
                return json.dumps({"error": str(exc), "status": "error"})

        return json.dumps({"error": "Tool call failed after reconnect attempt", "status": "error"})

    def get_server_status(self) -> dict[str, bool]:
        """Return {label: connected} for every configured MCP server.
        Uses last-confirmed health rather than mere client presence."""
        return {label: bool(self._server_health.get(label)) for label in self._servers}

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
