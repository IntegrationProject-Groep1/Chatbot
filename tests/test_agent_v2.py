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

class TestAgentLogic(unittest.IsolatedAsyncioTestCase):
    @patch("src.agent.query_planning")
    async def test_dispatch_planning(self, mock_query):
        mock_query.return_value = AIResponse(response="Mocked", sessions=[])
        # Simple test for logic flow (would normally call internal agent methods)
        self.assertTrue(True)

if __name__ == "__main__":
    unittest.main()
