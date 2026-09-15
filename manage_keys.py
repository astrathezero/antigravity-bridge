#!/usr/bin/env python3
"""Antigravity Bridge - API Key Management CLI Script.

Standalone helper script to manage client & agent API keys stored in .env.

Usage:
  python3 manage_keys.py list                     List all active API keys and assigned agent labels
  python3 manage_keys.py create [label]           Generate and save a new secure API key to .env
  python3 manage_keys.py add <label> <key>        Register an existing custom API key for an agent
  python3 manage_keys.py revoke <label|key>       Revoke and remove an API key from .env
  python3 manage_keys.py test <key> [options]     Test authentication with an API key against running server

Examples:
  python3 manage_keys.py create agent-cursor
  python3 manage_keys.py create agent-hermes
  python3 manage_keys.py add client-app sk-custom-key-12345
  python3 manage_keys.py list
  python3 manage_keys.py test sk-agv-xxxxxxxx
  python3 manage_keys.py revoke agent-cursor
"""

import sys
import os

# Add script directory to sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from antigravity_bridge import handle_key_cli
except ImportError:
    import antigravity_bridge
    handle_key_cli = antigravity_bridge.handle_key_cli

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        args = ["list"]
    sys.exit(handle_key_cli(args))
