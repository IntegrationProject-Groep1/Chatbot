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

class TestMCPClient(unittest.IsolatedAsyncioTestCase):
    async def test_in_process_sessions_server(self):
        """MCP client discovers tools from the sessions server in-process."""
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
        from fastmcp import Client
        from mcp_servers.sessions import mcp as sessions_mcp

        async with Client(sessions_mcp) as client:
            tools = await client.list_tools()
            names = [t.name for t in tools]
            self.assertIn("get_all_sessions", names)
            self.assertIn("get_session_detail", names)
            self.assertIn("get_session_attendance", names)

    async def test_mcp_client_tool_definitions(self):
        """MCPClient.get_tool_definitions() returns NVIDIA-format dicts."""
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
        import mcp_client
        from fastmcp import Client
        from mcp_servers.sessions import mcp as sessions_mcp

        client = mcp_client.MCPClient()
        fc = Client(sessions_mcp)
        await fc.__aenter__()
        tools = await fc.list_tools()
        client._clients.append(fc)
        for tool in tools:
            client._registry[tool.name] = (fc, tool)

        defs = client.get_tool_definitions()
        self.assertTrue(len(defs) >= 3)
        for d in defs:
            self.assertEqual(d["type"], "function")
            self.assertIn("name", d["function"])
            self.assertIn("parameters", d["function"])

if __name__ == "__main__":
    unittest.main()
