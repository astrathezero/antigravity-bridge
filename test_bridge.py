#!/usr/bin/env python3
"""
Antigravity Bridge - Interactive & Automated Live Test Suite
============================================================
Zero-dependency test tool to verify all Bridge server functionalities:
1. Server Health Check & Profile Quota Status (GET /health)
2. Model Registry & Availability (GET /v1/models)
3. Web Extension Bridge Connection & Active Profiles (GET /extension/status)
4. OpenAI Chat Completions with Flash Thinking (POST /v1/chat/completions)
5. Anthropic Messages Compatibility (POST /v1/messages)
6. Dynamic Multi-Channel Routing (auto / cli / web)
7. SSE Streaming Tokens

Usage Examples:
  python3 test_bridge.py                    # Run full interactive test
  python3 test_bridge.py --all              # Run all diagnostic checks
  python3 test_bridge.py --health           # Check server & profiles status
  python3 test_bridge.py --models           # List registered models
  python3 test_bridge.py --extension        # Check browser extension connection
  python3 test_bridge.py --chat "Hello!"    # Quick test prompt
  python3 test_bridge.py --chat "2+2=?" --stream
  python3 test_bridge.py --chat "Hello" --channel web   # Force Web Extension
  python3 test_bridge.py --chat "Hello" --channel cli   # Force CLI
  python3 test_bridge.py --anthropic        # Test Anthropic /v1/messages format
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

# Color helpers
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def print_header(title: str) -> None:
    line = "━" * 68
    print(f"\n{CYAN}{BOLD}┏{line}┓{RESET}")
    print(f"{CYAN}{BOLD}┃  {title.ljust(66)}┃{RESET}")
    print(f"{CYAN}{BOLD}┗{line}┛{RESET}\n")


def print_ok(msg: str) -> None:
    print(f"  {GREEN}{BOLD}[✓ OK]{RESET} {msg}")


def print_warn(msg: str) -> None:
    print(f"  {YELLOW}{BOLD}[⚠ WARN]{RESET} {msg}")


def print_err(msg: str) -> None:
    print(f"  {RED}{BOLD}[✗ ERR]{RESET} {msg}")


def print_info(msg: str) -> None:
    print(f"  {BLUE}[ℹ INFO]{RESET} {msg}")


class BridgeClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8000", api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self, is_json: bool = True) -> Dict[str, str]:
        headers = {}
        if is_json:
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def get(self, endpoint: str) -> Dict[str, Any]:
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        req = urllib.request.Request(url, headers=self._headers(is_json=False), method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def post(self, endpoint: str, payload: Dict[str, Any], timeout: float = 600.0) -> Dict[str, Any]:
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=self._headers(is_json=True), method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def stream_chat(self, payload: Dict[str, Any], timeout: float = 600.0):
        url = f"{self.base_url}/v1/chat/completions"
        payload["stream"] = True
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=self._headers(is_json=True), method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line or not line.startswith("data:"):
                    continue
                data_part = line[5:].strip()
                if data_part == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_part)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield content
                except Exception:
                    continue


# ---------------------------------------------------------------------------
# Test Functions
# ---------------------------------------------------------------------------

def test_health(client: BridgeClient) -> bool:
    print_header("1. Health Check & Profile Pool Status (/health)")
    try:
        t0 = time.time()
        data = client.get("/health")
        latency = (time.time() - t0) * 1000
        print_ok(f"Bridge server is ONLINE at {client.base_url} (HTTP 200, latency: {latency:.1f}ms)")

        status = data.get("status", "UNKNOWN")
        avail = data.get("available_profiles_count", 0)
        total = data.get("total_profiles_count", 0)
        print_info(f"Server Status: {BOLD}{status}{RESET} • Available Profiles: {GREEN}{avail}/{total}{RESET}")

        profiles = data.get("profiles", {})
        ready_count = 0
        cooldown_count = 0
        disabled_count = 0

        for name, p_info in profiles.items():
            st = p_info.get("status", "OK")
            gem_rem = p_info.get("gemini_cooldown_seconds_remaining", 0)
            email = p_info.get("account_email") or "Unknown"
            cli_on = "🟢 CLI" if p_info.get("cli_enabled", True) else "⚪ No-CLI"
            web_on = "🟢 Web" if p_info.get("web_enabled", True) else "⚪ No-Web"
            web_conn = "🔌 Connected" if p_info.get("web_connected", False) else "Standby"

            if st == "DISABLED":
                disabled_count += 1
                status_str = f"{DIM}DISABLED{RESET}"
            elif gem_rem > 0:
                cooldown_count += 1
                hours = gem_rem // 3600
                mins = (gem_rem % 3600) // 60
                status_str = f"{YELLOW}Cooldown ({hours}h{mins}m remaining){RESET}"
            else:
                ready_count += 1
                status_str = f"{GREEN}READY (100%){RESET}"

            print(f"    • {BOLD}{name.ljust(18)}{RESET} [{cli_on}|{web_on}] {web_conn.ljust(13)} {status_str} ({email})")

        print(f"\n  📊 Summary: {GREEN}{ready_count} Ready{RESET} | {YELLOW}{cooldown_count} in Cooldown{RESET} | {DIM}{disabled_count} Disabled{RESET}")
        return True
    except Exception as e:
        print_err(f"Health check failed: {e}")
        return False


def test_models(client: BridgeClient) -> bool:
    print_header("2. Model Registry & Thinking Capabilities (/v1/models)")
    try:
        t0 = time.time()
        data = client.get("/v1/models")
        latency = (time.time() - t0) * 1000
        models = [m.get("id") for m in data.get("data", [])]
        print_ok(f"Retrieved {len(models)} supported models (latency: {latency:.1f}ms)")

        # Verify key models
        key_models = [
            ("gemini-3.8-flash-thinking", "Primary Thinking Flash (Antigravity CLI / Engine)"),
            ("gemini-3.8-flash", "Gemini 3.8 Flash (Standard)"),
            ("gemini-2.0-flash-thinking", "Gemini 2.0 Flash Thinking (Web Dropdown / Fallback)"),
            ("gemini-web", "Dedicated Gemini Web Channel (Direct Extension)"),
            ("claude-sonnet-4.6-thinking", "Tier 1 Cooldown Fallback (Anthropic Sonnet)"),
        ]

        print()
        all_ok = True
        for mid, desc in key_models:
            if mid in models:
                print_ok(f"{BOLD}{mid.ljust(30)}{RESET} ➔ {desc}")
            else:
                print_warn(f"{mid.ljust(30)} ➔ MISSING from /v1/models")
                all_ok = False
        return all_ok
    except Exception as e:
        print_err(f"Models check failed: {e}")
        return False


def test_extension_status(client: BridgeClient) -> bool:
    print_header("3. Gemini Web Extension Bridge Status (/extension/status)")
    try:
        data = client.get("/extension/status")
        connected_count = data.get("connected_clients_count", 0)
        connected_profiles = data.get("connected_profiles", [])
        active_jobs = data.get("active_jobs_count", 0)

        if connected_count > 0:
            print_ok(f"Browser Extension is CONNECTED! Active Clients: {connected_count}, Jobs in flight: {active_jobs}")
            print_info(f"Connected Profiles: {BOLD}{', '.join(connected_profiles)}{RESET}")
            for c in data.get("clients", []):
                print(f"    • Client ID: {c.get('client_id')} | Profile: {c.get('profile')} | Tab: {c.get('tab_id')} | URL: {c.get('url')}")
        else:
            print_info(f"No Chrome Extension tabs currently connected on {client.base_url}.")
            print_info("👉 To connect: Open Chrome with the Antigravity extension enabled on https://gemini.google.com")

            # Check if Docker bridge has connected extension clients
            if ":8000" in client.base_url:
                d_url = get_docker_bridge_url()
                try:
                    d_client = BridgeClient(base_url=d_url)
                    d_data = d_client.get("/extension/status")
                    if d_data.get("connected_clients_count", 0) > 0:
                        print()
                        print_ok(f"💡 Found {d_data.get('connected_clients_count')} extension connection(s) on Docker Bridge ({d_url})!")
                        print_info(f"👉 Run with: {BOLD}python3 test_bridge.py --docker --extension{RESET}")
                except Exception:
                    pass
        return True
    except Exception as e:
        print_err(f"Extension status check failed: {e}")
        return False


def test_chat_completion(
    client: BridgeClient,
    model: str = "gemini-3.8-flash-thinking",
    prompt: str = "Explain quantum computing in 2 brief sentences.",
    channel: str = "auto",
    stream: bool = False,
) -> bool:
    print_header(f"4. OpenAI Chat Completion ({model} • Channel: {channel})")
    print_info(f"Prompt: \"{prompt}\"")
    print_info(f"Streaming: {'Enabled' if stream else 'Disabled'}")

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a helpful and concise AI assistant."},
            {"role": "user", "content": prompt},
        ],
        "channel": channel,
    }

    t0 = time.time()
    try:
        if stream:
            print(f"\n{CYAN}{BOLD}--- Streaming Response Start ---{RESET}")
            sys.stdout.flush()
            for token in client.stream_chat(payload):
                sys.stdout.write(token)
                sys.stdout.flush()
            print(f"\n{CYAN}{BOLD}--- Streaming Response End ---{RESET}")
            elapsed = time.time() - t0
            print_ok(f"Stream finished successfully in {elapsed:.2f}s")
            return True
        else:
            print_info("Sending request (waiting for model reasoning and generation)...")
            res = client.post("/v1/chat/completions", payload)
            elapsed = time.time() - t0
            choice = res.get("choices", [{}])[0]
            msg = choice.get("message", {})
            content = msg.get("content", "")
            effective_model = res.get("model", model)

            print_ok(f"Response received in {elapsed:.2f}s (Effective Model: {BOLD}{effective_model}{RESET})")
            print(f"\n{CYAN}{BOLD}--- Model Response ---{RESET}\n")
            print(content.strip())
            print(f"\n{CYAN}{BOLD}----------------------{RESET}")

            # Extract reasoning/thinking block if present
            if "<think>" in content and "</think>" in content:
                print_ok("Reasoning process (<think>...</think>) detected and properly parsed!")

            usage = res.get("usage", {})
            if usage:
                print_info(f"Tokens: prompt={usage.get('prompt_tokens', 0)}, completion={usage.get('completion_tokens', 0)}")
            return True
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print_err(f"HTTP Error {e.code}: {err_body}")
        return False
    except Exception as e:
        print_err(f"Execution failed: {e}")
        return False


def test_anthropic_messages(
    client: BridgeClient,
    model: str = "gemini-3.8-flash-thinking",
    prompt: str = "Say 'Anthropic Messages API bridge test passed' in exactly 6 words.",
) -> bool:
    print_header(f"5. Anthropic Messages API Test (/v1/messages • {model})")
    payload = {
        "model": model,
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": prompt}
        ]
    }

    t0 = time.time()
    try:
        res = client.post("/v1/messages", payload)
        elapsed = time.time() - t0
        content_blocks = res.get("content", [])
        text = "".join(b.get("text", "") for b in content_blocks if b.get("type") == "text")
        print_ok(f"Anthropic format responded in {elapsed:.2f}s (Role: {res.get('role')})")
        print(f"  Response: \"{text.strip()}\"")
        return True
    except Exception as e:
        print_err(f"Anthropic test failed: {e}")
        return False


def get_docker_bridge_url() -> str:
    """Resolve Docker bridge port from deploy/.env (default: 8080)."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy", ".env")
    port = 8080
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("BRIDGE_PORT="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val.isdigit():
                            port = int(val)
                            break
        except Exception:
            pass
    return f"http://127.0.0.1:{port}"


# ---------------------------------------------------------------------------
# Interactive Menu & Entrypoint
# ---------------------------------------------------------------------------

def run_interactive(client: BridgeClient) -> None:
    while True:
        target_name = "Docker Container" if ":8080" in client.base_url else "Local Host"
        print_header(f"Antigravity Bridge Diagnostics | Target: {client.base_url} ({target_name})")
        print("  1. 🩺 Full System Health & Quota Overview")
        print("  2. 🤖 List Registered Models")
        print("  3. 🔌 Check Browser Web Extension Status")
        print("  4. ⚡ Test Chat Completion (gemini-3.8-flash-thinking)")
        print("  5. 🌊 Test Chat Streaming (SSE Real-time Tokens)")
        print("  6. 🌐 Test Web Extension Channel (channel='web')")
        print("  7. 🖥️  Test CLI Channel (channel='cli')")
        print("  8. 🅰️  Test Anthropic Messages Endpoint (/v1/messages)")
        print("  9. 🚀 Run ALL Tests Sequentially")
        print(f"  T. 🔄 Toggle Target (Current: {client.base_url} → Switch to {'Local :8000' if ':8080' in client.base_url else 'Docker :8080'})")
        print("  0. 🚪 Exit")
        print()

        try:
            choice = input(f"{BOLD}Select an option [0-9, T]: {RESET}").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            break

        if choice == "1":
            test_health(client)
        elif choice == "2":
            test_models(client)
        elif choice == "3":
            test_extension_status(client)
        elif choice == "4":
            test_chat_completion(client, model="gemini-3.8-flash-thinking")
        elif choice == "5":
            test_chat_completion(client, model="gemini-3.8-flash-thinking", stream=True)
        elif choice == "6":
            test_chat_completion(client, model="gemini-web", channel="web")
        elif choice == "7":
            test_chat_completion(client, model="gemini-3.8-flash", channel="cli")
        elif choice == "8":
            test_anthropic_messages(client)
        elif choice == "9":
            test_health(client)
            test_models(client)
            test_extension_status(client)
            test_chat_completion(client)
            test_anthropic_messages(client)
        elif choice.lower() == "t":
            if ":8080" in client.base_url:
                client.base_url = "http://127.0.0.1:8000"
            else:
                client.base_url = get_docker_bridge_url()
            print_ok(f"Switched target bridge to: {client.base_url}")
        elif choice in ("0", "q", "exit"):
            print("\nGoodbye!\n")
            break
        else:
            print_warn("Invalid option, please try again.")

        input(f"\n{DIM}Press [Enter] to continue...{RESET}")


def main():
    docker_url = get_docker_bridge_url()

    parser = argparse.ArgumentParser(description="Antigravity Bridge Automated & Interactive Test Client")
    parser.add_argument("--url", default=None, help="Base URL of Antigravity Bridge (e.g. http://127.0.0.1:8000)")
    parser.add_argument("--port", type=int, default=None, help="Target port on 127.0.0.1 (e.g. 8080 for Docker, 8000 for Local)")
    parser.add_argument("--docker", action="store_true", help=f"Target the Docker bridge container ({docker_url})")
    parser.add_argument("--key", default=os.environ.get("ANTIGRAVITY_API_KEY"), help="Optional API Key for authentication")
    parser.add_argument("--all", action="store_true", help="Run all diagnostic tests non-interactively")
    parser.add_argument("--health", action="store_true", help="Run health & quota check only")
    parser.add_argument("--models", action="store_true", help="List supported models only")
    parser.add_argument("--extension", action="store_true", help="Check Web Extension connection status only")
    parser.add_argument("--chat", nargs="?", const="Explain AI agents in 2 sentences.", help="Send chat completion test prompt")
    parser.add_argument("--model", default="gemini-3.8-flash-thinking", help="Model name to test")
    parser.add_argument("--channel", default="auto", choices=["auto", "cli", "web"], help="Execution channel")
    parser.add_argument("--stream", action="store_true", help="Enable SSE token streaming")
    parser.add_argument("--anthropic", action="store_true", help="Test Anthropic /v1/messages format")

    args = parser.parse_args()

    # Determine target URL
    if args.docker:
        target_url = docker_url
    elif args.port:
        target_url = f"http://127.0.0.1:{args.port}"
    elif args.url:
        target_url = args.url
    else:
        target_url = os.environ.get("ANTIGRAVITY_BASE_URL", "http://127.0.0.1:8000")

    client = BridgeClient(base_url=target_url, api_key=args.key)

    # Specific flag checks
    if args.health:
        test_health(client)
        return
    if args.models:
        test_models(client)
        return
    if args.extension:
        test_extension_status(client)
        return
    if args.chat:
        test_chat_completion(client, model=args.model, prompt=args.chat, channel=args.channel, stream=args.stream)
        return
    if args.anthropic:
        test_anthropic_messages(client, model=args.model)
        return
    if args.all:
        test_health(client)
        test_models(client)
        test_extension_status(client)
        test_chat_completion(client, model=args.model)
        test_anthropic_messages(client, model=args.model)
        return

    # Default to interactive menu
    run_interactive(client)


if __name__ == "__main__":
    main()
