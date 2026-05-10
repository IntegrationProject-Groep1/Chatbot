import unittest

from src.chatbot_mcp_server import ChatbotMCPServer, JSONRPCMCPAdapter


class FakeLLMClient:
    def __init__(self):
        self.calls = []

    def answer_question(self, question: str, event_context: str | None = None) -> str:
        self.calls.append((question, event_context))
        return "Mocked answer"


class ChatbotMCPServerTests(unittest.TestCase):
    def test_tools_list_contains_expected_tool(self):
        server = ChatbotMCPServer(FakeLLMClient())

        tools = server.tools_list()["tools"]

        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["name"], "ask_event_assistant")

    def test_call_tool_uses_llm_client(self):
        client = FakeLLMClient()
        server = ChatbotMCPServer(client)

        result = server.call_tool(
            "ask_event_assistant",
            {"question": "Where is the event?", "event_context": "Room A"},
        )

        self.assertEqual(client.calls, [("Where is the event?", "Room A")])
        self.assertEqual(result["content"][0]["text"], "Mocked answer")

    def test_call_tool_requires_non_empty_question(self):
        server = ChatbotMCPServer(FakeLLMClient())

        with self.assertRaises(ValueError):
            server.call_tool("ask_event_assistant", {"question": "   "})


class JSONRPCMCPAdapterTests(unittest.TestCase):
    def test_tools_call_returns_jsonrpc_result(self):
        adapter = JSONRPCMCPAdapter(ChatbotMCPServer(FakeLLMClient()))

        response = adapter.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "ask_event_assistant",
                    "arguments": {"question": "What time does it start?"},
                },
            }
        )

        self.assertEqual(response["id"], 1)
        self.assertIn("result", response)
        self.assertEqual(response["result"]["content"][0]["text"], "Mocked answer")


if __name__ == "__main__":
    unittest.main()
