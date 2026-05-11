#!/usr/bin/env python
"""
Integration test for downstream services (Planning, Facturatie)
Requires RabbitMQ running and downstream services listening on their queues
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from chatbot_mcp_server import build_server_from_env


def test_sessions_with_mock_uuid():
    """Test list_all_sessions with a dummy master_uuid"""
    print("\n[Integration] Testing list_all_sessions...")
    try:
        adapter = build_server_from_env()
        
        # Use a dummy UUID (will fail if Planning service not running)
        dummy_uuid = "550e8400-e29b-41d4-a716-446655440000"
        
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "list_all_sessions",
                "arguments": {
                    "master_uuid": dummy_uuid
                }
            }
        }
        response = adapter.handle(payload)
        
        if "error" in response:
            error_msg = response['error'].get('message', 'Unknown error')
            print(f"  ✗ Failed: {error_msg}")
            print("    → Check if Planning service is running on planning.exchange")
            return False
        
        content = response.get("result", {}).get("content", [])
        if content:
            text = content[0].get("text", "")
            print(f"  ✓ Got response: {text[:100]}...")
            return True
        return False
        
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False


def test_invoices_with_mock_uuid():
    """Test total_invoice_cost with a dummy master_uuid"""
    print("\n[Integration] Testing total_invoice_cost...")
    try:
        adapter = build_server_from_env()
        
        dummy_uuid = "550e8400-e29b-41d4-a716-446655440000"
        
        payload = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "total_invoice_cost",
                "arguments": {
                    "master_uuid": dummy_uuid
                }
            }
        }
        response = adapter.handle(payload)
        
        if "error" in response:
            error_msg = response['error'].get('message', 'Unknown error')
            print(f"  ✗ Failed: {error_msg}")
            print("    → Check if Facturatie service is running on facturatie.rpc")
            return False
        
        content = response.get("result", {}).get("content", [])
        if content:
            text = content[0].get("text", "")
            print(f"  ✓ Got response: {text[:100]}...")
            return True
        return False
        
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False


def test_resolve_user():
    """Test resolve_user_by_email"""
    print("\n[Integration] Testing resolve_user_by_email...")
    try:
        adapter = build_server_from_env()
        payload = {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "tools/call",
            "params": {
                "name": "resolve_user_by_email",
                "arguments": {
                    "email": "test@example.com"
                }
            }
        }
        response = adapter.handle(payload)
        content = response.get("result", {}).get("content", [])
        if content:
            print(f"  ✓ Response: {content[0].get('text')}")
            return True
        return False
    except Exception as e:
        print(f"  ✗ Exception: {e}")
        return False

def main():
    print("=" * 60)
    print("Chatbot MCP - Integration Test v2.0")
    print("=" * 60)
    
    if not os.getenv("NVIDIA_API_KEY"):
        print("✗ NVIDIA_API_KEY not set in .env")
        return 1
    
    print("\n⚠ Requirements:")
    print("  - RabbitMQ running")
    print("  - Downstream services (Planning, Facturatie, Identity) running")
    
    test0 = test_resolve_user()
    test1 = test_sessions_with_mock_uuid()
    test2 = test_invoices_with_mock_uuid()
    
    print("\n" + "=" * 60)
    if test0 and test1 and test2:
        print("✓ All integration tests passed!")
        return 0
    else:
        print("✗ Some integration tests failed. Check if services are running.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
