import unittest
from unittest.mock import MagicMock, patch
from src.xml_parsers import parse_ai_response, AIResponse, Session, Invoice
from src.xml_builders import build_ai_query_request

class TestXMLProcessing(unittest.TestCase):
    def test_build_ai_query(self):
        identity_uuid = "test-uuid"
        scope = "personal"
        query = "What sessions do I have?"
        xml = build_ai_query_request(identity_uuid, scope, query)
        
        self.assertIn(identity_uuid, xml)
        self.assertIn(scope, xml)
        self.assertIn(query, xml)
        self.assertIn("<type>ai_query</type>", xml)

    def test_parse_ai_response_with_data(self):
        xml = """<message>
            <header><source>planning</source></header>
            <body>
                <status>ok</status>
                <response>Found 1 session.</response>
                <data>
                    <session>
                        <session_id>s1</session_id>
                        <name>Workshop</name>
                        <date>2026-05-20T09:00:00Z</date>
                        <location>Room A</location>
                    </session>
                </data>
            </body>
        </message>"""
        response = parse_ai_response(xml)
        self.assertEqual(response.response, "Found 1 session.")
        self.assertEqual(len(response.sessions), 1)
        self.assertEqual(response.sessions[0].name, "Workshop")

class TestMCPClient(unittest.TestCase):
    def setUp(self):
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

    def test_tool_definitions_format(self):
        """MCPClient.get_tool_definitions() returns correct NVIDIA/OpenAI format."""
        from unittest.mock import MagicMock
        from mcp_client import MCPClient

        client = MCPClient()
        tool = MagicMock()
        tool.name = "get_all_sessions"
        tool.description = "Get all sessions"
        tool.inputSchema = {"type": "object", "properties": {"status": {"type": "string"}}, "required": []}
        client._registry["planning__get_all_sessions"] = (MagicMock(), tool, "get_all_sessions")

        defs = client.get_tool_definitions()
        self.assertEqual(len(defs), 1)
        d = defs[0]
        self.assertEqual(d["type"], "function")
        self.assertEqual(d["function"]["name"], "planning__get_all_sessions")
        self.assertEqual(d["function"]["description"], "Get all sessions")
        self.assertIn("parameters", d["function"])

    def test_tool_definitions_empty(self):
        """MCPClient with no servers returns empty tool list."""
        from mcp_client import MCPClient
        client = MCPClient()
        self.assertEqual(client.get_tool_definitions(), [])
        self.assertFalse(client.has_tools())

    def test_parse_mcp_servers_env(self):
        """_parse_servers correctly parses label@url pairs."""
        import os
        os.environ["MCP_SERVERS"] = "sessions@http://localhost:8001/mcp,monitoring@http://localhost:8005/mcp"
        import importlib, mcp_client
        importlib.reload(mcp_client)
        from mcp_client import _parse_servers
        servers = _parse_servers()
        self.assertEqual(servers.get("sessions"), "http://localhost:8001/mcp")
        self.assertEqual(servers.get("monitoring"), "http://localhost:8005/mcp")
        os.environ.pop("MCP_SERVERS", None)

if __name__ == "__main__":
    unittest.main()
