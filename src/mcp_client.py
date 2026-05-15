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
        self._clients: list[Any] = []
        # namespaced_name → (client, tool, original_tool_name)
        self._registry: dict[str, tuple[Any, Any, str]] = {}

    async def init(self) -> None:
        from fastmcp import Client

        servers = _parse_servers()
        if not servers:
            _log.warning("MCP_SERVERS not configured — no MCP tools loaded")
            return

        for label, url in servers.items():
            try:
                from fastmcp.client.transports import StreamableHttpTransport
                client = Client(StreamableHttpTransport(url))
                await client.__aenter__()
                self._clients.append(client)  # append before list_tools so close() always runs
                tools = await client.list_tools()
                for tool in tools:
                    namespaced = f"{label}__{tool.name}"
                    self._registry[namespaced] = (client, tool, tool.name)
                _log.info("MCP [%s] connected — %d tools: %s", label, len(tools), [t.name for t in tools])
            except Exception as exc:
                _log.warning("MCP [%s] unavailable at %s: %s", label, url, exc)

    async def close(self) -> None:
        for client in self._clients:
            try:
                await client.__aexit__(None, None, None)
            except Exception:
                pass
        self._clients.clear()
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

    async def call_tool(self, name: str, args: dict) -> str:
        """Call a tool by name (namespaced as label__tool_name). Always returns a JSON string."""
        if name not in self._registry:
            return json.dumps({"error": f"Tool '{name}' not found in any MCP server"})
        client, _, original_name = self._registry[name]
        try:
            result = await client.call_tool(original_name, args)
            # result is CallToolResult: .content is list[TextContent|ImageContent], .isError is bool
            if getattr(result, 'is_error', None) or getattr(result, 'isError', None):
                return json.dumps({"error": "Tool returned an error", "status": "error"})
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
        except Exception as exc:
            return json.dumps({"error": str(exc), "status": "error"})

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
