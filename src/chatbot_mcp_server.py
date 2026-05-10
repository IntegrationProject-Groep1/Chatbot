import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib import error, request


API_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
DEFAULT_MODEL = "meta/llama-3.1-8b-instruct"


@dataclass
class NvidiaLLMClient:
    api_key: str
    model: str = DEFAULT_MODEL
    api_url: str = API_URL

    def answer_question(self, question: str, event_context: str | None = None) -> str:
        system_prompt = (
            "You are an assistant for an integration project event. "
            "Provide short, helpful, and safe answers to basic questions about the event or the user."
        )
        user_prompt = question.strip()
        if event_context:
            user_prompt = f"Event context: {event_context.strip()}\\n\\nQuestion: {user_prompt}"

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.2,
            "top_p": 0.7,
            "max_tokens": 400,
            "stream": False,
        }

        req = request.Request(
            self.api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with request.urlopen(req, timeout=60) as response:
                body = response.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"NVIDIA API request failed ({exc.code}): {detail}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Could not reach NVIDIA API: {exc.reason}") from exc

        parsed = json.loads(body)
        choices = parsed.get("choices", [])
        if not choices:
            raise RuntimeError("NVIDIA API returned no choices.")

        message = choices[0].get("message", {})
        content = message.get("content", "").strip()
        if not content:
            raise RuntimeError("NVIDIA API returned an empty response.")

        return content


class ChatbotMCPServer:
    TOOL_NAME = "ask_event_assistant"

    def __init__(self, llm_client: NvidiaLLMClient):
        self.llm_client = llm_client

    def tools_list(self) -> dict[str, Any]:
        return {
            "tools": [
                {
                    "name": self.TOOL_NAME,
                    "description": "Answer basic questions about the event or the user.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string"},
                            "event_context": {"type": "string"},
                        },
                        "required": ["question"],
                    },
                }
            ]
        }

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name != self.TOOL_NAME:
            raise ValueError(f"Unknown tool: {name}")

        question = str(arguments.get("question", "")).strip()
        if not question:
            raise ValueError("'question' is required and must be non-empty.")

        event_context = arguments.get("event_context")
        if event_context is not None:
            event_context = str(event_context)

        answer = self.llm_client.answer_question(question, event_context)
        return {"content": [{"type": "text", "text": answer}]}


class JSONRPCMCPAdapter:
    def __init__(self, server: ChatbotMCPServer):
        self.server = server

    def _response(self, request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def _error(self, request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        }

    def handle(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = payload.get("id")
        method = payload.get("method")
        params = payload.get("params", {})

        try:
            if method == "initialize":
                return self._response(
                    request_id,
                    {
                        "protocolVersion": "2024-11-05",
                        "serverInfo": {"name": "integration-chatbot-mcp", "version": "0.1.0"},
                        "capabilities": {"tools": {}},
                    },
                )

            if method == "tools/list":
                return self._response(request_id, self.server.tools_list())

            if method == "tools/call":
                name = params.get("name")
                arguments = params.get("arguments", {})
                if not isinstance(arguments, dict):
                    raise ValueError("'arguments' must be an object.")
                return self._response(request_id, self.server.call_tool(name, arguments))

            if method == "notifications/initialized":
                return {}

            return self._error(request_id, -32601, f"Method not found: {method}")
        except ValueError as exc:
            return self._error(request_id, -32602, str(exc))
        except Exception as exc:  # pragma: no cover
            return self._error(request_id, -32000, str(exc))


def build_server_from_env() -> JSONRPCMCPAdapter:
    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Set NVIDIA_API_KEY to use this MCP server.")

    model = os.getenv("NVIDIA_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    llm_client = NvidiaLLMClient(api_key=api_key, model=model)
    return JSONRPCMCPAdapter(ChatbotMCPServer(llm_client))


def run_stdio_server() -> None:
    adapter = build_server_from_env()

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            payload = json.loads(raw_line)
            response = adapter.handle(payload)
        except json.JSONDecodeError:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Parse error"},
            }

        if response:
            print(json.dumps(response), flush=True)


if __name__ == "__main__":
    run_stdio_server()
