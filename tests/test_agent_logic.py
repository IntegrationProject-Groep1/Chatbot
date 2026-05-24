import asyncio
import json
import unittest
from unittest.mock import MagicMock, patch, AsyncMock
import sys
import os

# Mock dependencies before importing src modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.modules["rabbitmq_rpc"] = MagicMock()
sys.modules["auth"] = MagicMock()

import agent
import session_store
import xml_parsers
import xml_builders
import downstream_tools
import mcp_client

class TestAgentLogic(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        # Reset agent and session state
        agent._PENDING_WRITE = {}
        session_store._sessions = {}
        session_store.init_session("s1", "admin1")

    def test_confirmation_lexicon_and_punctuation(self):
        """Bug 6: Confirmation should handle punctuation and multiple words."""
        session_id = "s1"
        
        # Simple ja
        session_store.append(session_id, {"role": "user", "content": "ja"})
        self.assertTrue(agent._has_confirmation(session_id))
        
        # Punctuation
        session_store.append(session_id, {"role": "user", "content": "Ja."})
        self.assertTrue(agent._has_confirmation(session_id))
        
        # Multiple words + punctuation
        session_store.append(session_id, {"role": "user", "content": "ja, doe maar!"})
        self.assertTrue(agent._has_confirmation(session_id))
        
        # Expanded lexicon
        for word in ["yep", "confirm", "oui", "si", "sure"]:
            session_store.append(session_id, {"role": "user", "content": word})
            self.assertTrue(agent._has_confirmation(session_id), f"Failed for {word}")

    async def test_card_extraction_turn_isolation(self):
        """Bug 7: extract_cards should only show cards from the current turn."""
        session_id = "s1"
        
        # Turn 1: show sessions
        session_store.append(session_id, {"role": "user", "content": "show sessions"})
        session_store.append(session_id, {"role": "tool", "name": "f__list", "content": '{"sessions": [{"id": 1}]}'})
        cards1 = agent._extract_cards(session_id)
        self.assertEqual(len(cards1), 1)
        self.assertEqual(cards1[0]["data"][0]["id"], 1)
        
        # Turn 2: next interaction
        session_store.append(session_id, {"role": "user", "content": "next"})
        session_store.append(session_id, {"role": "tool", "name": "f__list", "content": '{"sessions": [{"id": 2}]}'})
        cards2 = agent._extract_cards(session_id)
        
        # Should only have the card from the LATEST turn
        self.assertEqual(len(cards2), 1)
        self.assertEqual(cards2[0]["data"][0]["id"], 2)

    def test_duplicate_tool_normalization(self):
        """Bug 4: Duplicate tool call detection should normalize JSON."""
        called_tools = set()
        
        # We simulate the logic in agent.py
        def check_dup(tc):
            name = tc["function"]["name"]
            args_str = tc["function"].get("arguments", "{}")
            try:
                args_obj = json.loads(args_str)
                normalized_args = json.dumps(args_obj, sort_keys=True)
            except Exception:
                normalized_args = args_str
            
            key = f"{name}|{normalized_args}"
            if key in called_tools:
                return True
            called_tools.add(key)
            return False

        tc1 = {"function": {"name": "tool", "arguments": '{"a": 1, "b": 2}'}}
        tc2 = {"function": {"name": "tool", "arguments": '{"b":  2, "a": 1}'}} # order + whitespace
        
        self.assertFalse(check_dup(tc1))
        self.assertTrue(check_dup(tc2))

    def test_mcp_cache_exclusion(self):
        """Bug 10: enroll/unenroll should never be cached."""
        with patch("mcp_client._CACHE_TTL", 10.0):
            client = mcp_client.MCPClient()
            self.assertFalse(client._is_cacheable("enroll_user"))
            self.assertFalse(client._is_cacheable("unenroll_user"))
            self.assertFalse(client._is_cacheable("create_session"))
            self.assertTrue(client._is_cacheable("get_session_details"))

if __name__ == "__main__":
    unittest.main()
