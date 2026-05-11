import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib import error, request

from dotenv import load_dotenv

from downstream_tools import (
    DownstreamConfig,
    resolve_master_uuid_by_email,
    get_all_sessions,
    get_user_enrollments,
    get_invoices_list,
    get_invoices_total,
)


DEFAULT_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
DEFAULT_MODEL = "meta/llama-3.1-8b-instruct"


@dataclass
class NvidiaLLMClient:
    api_key: str
    model: str = DEFAULT_MODEL
    api_url: str = DEFAULT_API_URL

    def answer_question(self, question: str, event_context: str | None = None) -> str:
        system_prompt = (
            "You are an assistant for an integration project event. "
            "Provide short, helpful, and safe answers to basic questions about the event or the user."
        )
        user_prompt = question.strip()
        if event_context:
            user_prompt = f"Event context: {event_context.strip()}\n\nQuestion: {user_prompt}"

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
            with request.urlopen(req, timeout=30) as response:
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
    TOOL_RESOLVE_USER = "resolve_user_by_email"
    TOOL_SESSIONS_LIST = "list_all_sessions"
    TOOL_MY_SESSIONS = "list_my_sessions"
    TOOL_INVOICES_COUNT = "count_my_invoices"
    TOOL_INVOICES_TOTAL = "total_invoice_cost"

    def __init__(self, llm_client: NvidiaLLMClient):
        self.llm_client = llm_client
        self.cfg = DownstreamConfig()

    def tools_list(self) -> dict[str, Any]:
        return {
            "tools": [
                {
                    "name": self.TOOL_NAME,
                    "description": "General assistant to answer questions about the event. Use this for greetings or basic info.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string"},
                        },
                        "required": ["question"],
                    },
                },
                {
                    "name": self.TOOL_RESOLVE_USER,
                    "description": "Find a user's master_uuid by their email address. Use this first if you only have an email.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "email": {"type": "string", "description": "User's email address"},
                        },
                        "required": ["email"],
                    },
                },
                {
                    "name": self.TOOL_SESSIONS_LIST,
                    "description": "Get a list of all available event sessions for anyone to join.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "master_uuid": {"type": "string", "description": "User's master UUID (required for context)"},
                        },
                        "required": ["master_uuid"],
                    },
                },
                {
                    "name": self.TOOL_MY_SESSIONS,
                    "description": "Get a list of sessions the user is currently enrolled in.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "master_uuid": {"type": "string", "description": "User's master UUID"},
                        },
                        "required": ["master_uuid"],
                    },
                },
                {
                    "name": self.TOOL_INVOICES_COUNT,
                    "description": "Get the number of invoices assigned to the user.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "master_uuid": {"type": "string", "description": "User's master UUID"},
                        },
                        "required": ["master_uuid"],
                    },
                },
                {
                    "name": self.TOOL_INVOICES_TOTAL,
                    "description": "Get the total monetary cost of all invoices for the user.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "master_uuid": {"type": "string", "description": "User's master UUID"},
                        },
                        "required": ["master_uuid"],
                    },
                },
            ]
        }

    def _require_master_uuid(self, arguments: dict[str, Any]) -> str:
        master_uuid = str(arguments.get("master_uuid", "")).strip()
        if not master_uuid:
            raise ValueError("'master_uuid' is required for this operation.")
        return master_uuid

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == self.TOOL_NAME:
                question = str(arguments.get("question", "")).strip()
                if not question:
                    raise ValueError("'question' is required.")
                answer = self.llm_client.answer_question(question)
                return {"content": [{"type": "text", "text": answer}]}

            if name == self.TOOL_RESOLVE_USER:
                email = str(arguments.get("email", "")).strip()
                if not email:
                    raise ValueError("'email' is required.")
                uuid = resolve_master_uuid_by_email(email, self.cfg)
                return {"content": [{"type": "text", "text": f"Found user: {uuid}"}]}

            if name == self.TOOL_SESSIONS_LIST:
                master_uuid = self._require_master_uuid(arguments)
                sessions = get_all_sessions(master_uuid, self.cfg)
                if not sessions:
                    return {"content": [{"type": "text", "text": "There are no available sessions at the moment."}]}
                text = f"Found {len(sessions)} available sessions:\n"
                for s in sessions:
                    text += f"- {s.name} ({s.session_id}) on {s.date} at {s.location}\n"
                return {"content": [{"type": "text", "text": text}]}

            if name == self.TOOL_MY_SESSIONS:
                master_uuid = self._require_master_uuid(arguments)
                sessions = get_user_enrollments(master_uuid, self.cfg)
                if not sessions:
                    return {"content": [{"type": "text", "text": "You are not enrolled in any sessions."}]}
                text = f"You are enrolled in {len(sessions)} sessions:\n"
                for s in sessions:
                    text += f"- {s.name} ({s.session_id}) on {s.date} at {s.location}\n"
                return {"content": [{"type": "text", "text": text}]}

            if name == self.TOOL_INVOICES_COUNT:
                master_uuid = self._require_master_uuid(arguments)
                invoices = get_invoices_list(master_uuid, self.cfg)
                text = f"You have {len(invoices)} invoice(s)."
                return {"content": [{"type": "text", "text": text}]}

            if name == self.TOOL_INVOICES_TOTAL:
                master_uuid = self._require_master_uuid(arguments)
                total = get_invoices_total(master_uuid, self.cfg)
                text = f"Total invoice amount: {total.total_amount} {total.currency} ({total.count} invoices)."
                return {"content": [{"type": "text", "text": text}]}

            raise ValueError(f"Unknown tool: {name}")

        except (RuntimeError, TimeoutError, ValueError) as exc:
            # Return error as text so the LLM can explain it to the user
            return {"content": [{"type": "text", "text": f"Error: {str(exc)}"}]}


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
        except RuntimeError as exc:
            return self._error(request_id, -32000, str(exc))


def build_server_from_env() -> JSONRPCMCPAdapter:
    load_dotenv()

    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Set NVIDIA_API_KEY to use this MCP server.")

    model = os.getenv("NVIDIA_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    api_url = os.getenv("NVIDIA_API_URL", DEFAULT_API_URL).strip() or DEFAULT_API_URL
    llm_client = NvidiaLLMClient(api_key=api_key, model=model, api_url=api_url)
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

