#!/usr/bin/env python
"""
Quick test script for Chatbot MCP Server
Tests the basic MCP interface and downstream integrations
"""
import json
import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from chatbot_mcp_server import build_server_from_env, JSONRPCMCPAdapter


def test_initialize():
    """Test MCP initialization"""
    try:
        adapter = build_server_from_env()
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        }
        response = adapter.handle(payload)
        assert response.get("result", {}).get("serverInfo", {}).get("name") == "integration-chatbot-mcp"
        print("✓ MCP Initialize works")
        return True
    except Exception as e:
        print(f"✗ MCP Initialize failed: {e}")
        return False


def test_tools_list():
    """Test MCP tools list"""
    try:
        adapter = build_server_from_env()
        payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }
        response = adapter.handle(payload)
        tools = response.get("result", {}).get("tools", [])
        
        tool_names = {t.get("name") for t in tools}
        expected = {
            "ask_event_assistant",
            "list_all_sessions",
            "list_my_sessions",
            "count_my_invoices",
            "total_invoice_cost",
        }
        
        if expected.issubset(tool_names):
            print(f"✓ Tools list works ({len(tools)} tools found)")
            return True
        else:
            missing = expected - tool_names
            print(f"✗ Missing tools: {missing}")
            return False
    except Exception as e:
        print(f"✗ Tools list failed: {e}")
        return False


def test_ask_question():
    """Test basic LLM question"""
    try:
        adapter = build_server_from_env()
        payload = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "ask_event_assistant",
                "arguments": {
                    "question": "What is an integration project?"
                }
            }
        }
        response = adapter.handle(payload)
        
        if "error" in response:
            print(f"✗ LLM question failed: {response['error'].get('message')}")
            return False
        
        content = response.get("result", {}).get("content", [])
        if content and content[0].get("type") == "text":
            answer = content[0].get("text", "")
            print(f"✓ LLM question works (got {len(answer)} chars)")
            return True
        else:
            print("✗ LLM question: no text response")
            return False
    except Exception as e:
        print(f"✗ LLM question failed: {e}")
        return False


def main():
    print("=" * 60)
    print("Chatbot MCP Server - Quick Test")
    print("=" * 60)
    
    # Check NVIDIA_API_KEY
    if not os.getenv("NVIDIA_API_KEY"):
        print("\n⚠ NVIDIA_API_KEY not set!")
        print("  Get a free key: https://integrate.api.nvidia.com/")
        print("  Then: export NVIDIA_API_KEY='your-key-here'")
        return 1
    
    print("\n[1/4] Testing MCP initialization...")
    test1 = test_initialize()
    
    print("\n[2/4] Testing tools list...")
    test2 = test_tools_list()
    
    print("\n[3/4] Testing LLM question (NVIDIA API)...")
    test3 = test_ask_question()
    
    print("\n[4/4] Downstream services (requires RabbitMQ)...")
    print("  - Sessions: needs planning.exchange queue")
    print("  - Invoices: needs facturatie.rpc queue")
    print("  - Identity: needs identity.rpc queue")
    print("  → Configure in .env and test separately")
    
    print("\n" + "=" * 60)
    if test1 and test2 and test3:
        print("✓ All basic tests passed!")
        print("\nNext steps:")
        print("  1. Configure downstream service queues in .env")
        print("  2. Ensure Planning and Facturatie services are running")
        print("  3. Test full integration with: python test_integration.py")
        return 0
    else:
        print("✗ Some tests failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
