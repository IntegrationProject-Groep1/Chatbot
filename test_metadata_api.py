#!/usr/bin/env python3
"""Test the new /api/services/metadata endpoint"""

import sys
import json
sys.path.insert(0, 'src')

# Quick validation of the metadata structure
from api import _SERVICE_METADATA

def test_metadata_structure():
    print("Testing _SERVICE_METADATA structure...")
    
    required_keys = {"host", "port", "deps"}
    for svc_id, meta in _SERVICE_METADATA.items():
        if not all(k in meta for k in required_keys):
            print(f"✗ {svc_id}: missing keys {required_keys - set(meta.keys())}")
            return False
        if not isinstance(meta.get("deps"), list):
            print(f"✗ {svc_id}: deps is not a list")
            return False
        print(f"✓ {svc_id}: {meta['host']}:{meta['port']} ({len(meta['deps'])} deps)")
    
    print(f"\n✓ All {len(_SERVICE_METADATA)} services have valid metadata")
    return True

if __name__ == "__main__":
    success = test_metadata_structure()
    sys.exit(0 if success else 1)
