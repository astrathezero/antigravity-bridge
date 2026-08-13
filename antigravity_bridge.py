#!/usr/bin/env python3
"""Antigravity / agy OpenAI-Compatible API Bridge Server.

Acts as a local OpenAI REST API server (e.g. http://127.0.0.1:8000/v1) that translates
standard /v1/chat/completions requests into local CLI execution (antigravity / agy).

Features:
- Auto-detects whether 'antigravity' or 'agy' CLI binary is installed in PATH.
- Supports /v1/chat/completions (JSON & Server-Sent Events streaming).
- Supports /v1/models and /health endpoints.
- Auto-fallbacks across multiple agy login profiles.
- Requires no external pip dependencies (built on Python standard library).

Usage:
  python3 antigravity_bridge.py [--port 8000] [--host 127.0.0.1]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from typing import Any, Dict, List, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("antigravity_bridge")


def detect_cli_command() -> Tuple[str, str]:
    """Auto-detect available local CLI binary and command template.

    Returns:
        (cli_binary_name, command_template)
    """
    env_cmd = os.environ.get("ANTIGRAVITY_BRIDGE_CMD", "").strip()
    if env_cmd:
        binary = env_cmd.split()[0]
        return (binary, env_cmd)

    # Check ~/.local/bin/agy explicitly before PATH
    home_local_agy = os.path.expanduser("~/.local/bin/agy")
    if os.path.exists(home_local_agy) and os.access(home_local_agy, os.X_OK):
        return ("agy", f'{home_local_agy} --dangerously-skip-permissions -p "{{prompt}}"')

    agy_path = shutil.which("agy")
    if agy_path:
        return ("agy", 'agy --dangerously-skip-permissions -p "{prompt}"')

    anti_path = shutil.which("antigravity")
    if anti_path and anti_path != "/usr/bin/antigravity":
        return ("antigravity", 'antigravity --dangerously-skip-permissions -p "{prompt}"')

    # Fallback default
    return ("agy", 'agy --dangerously-skip-permissions -p "{prompt}"')


def format_messages_to_prompt(messages: List[Dict[str, Any]]) -> str:
    """Format OpenAI messages list into a prompt string for CLI tools."""
    if not messages:
        return ""

    if len(messages) == 1 and messages[0].get("role") == "user":
        content = messages[0].get("content") or ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )

    parts: List[str] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content") or ""
        if isinstance(content, list):
            content = "\n".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        elif not isinstance(content, str):
            content = str(content)

        if role == "system":
            parts.append(f"[System Instructions]\n{content}")
        elif role == "user":
            parts.append(f"[User]\n{content}")
        elif role == "assistant":
            tool_calls = msg.get("tool_calls")
            tc_text = f"\nTool Calls: {json.dumps(tool_calls)}" if tool_calls else ""
            parts.append(f"[Assistant]\n{content}{tc_text}")
        elif role == "tool":
            parts.append(f"[Tool Result]\n{content}")
        else:
            parts.append(f"[{role.capitalize()}]\n{content}")

    return "\n\n".join(parts)


def get_available_profiles() -> List[Optional[str]]:
    """Get list of available Antigravity / agy login profiles for fallback.

    Checks ANTIGRAVITY_PROFILES env var (comma-separated), or scans
    ~/.config/antigravity/profiles/ directory.
    If no extra profiles are found, returns [None] (default profile).
    """
    env_profiles = os.environ.get("ANTIGRAVITY_PROFILES", "").strip()
    if env_profiles:
        profiles = [p.strip() for p in env_profiles.split(",") if p.strip()]
        if profiles:
            return profiles

    profiles_dir = os.path.expanduser("~/.config/antigravity/profiles")
    if os.path.exists(profiles_dir) and os.path.isdir(profiles_dir):
        found = [
            d for d in sorted(os.listdir(profiles_dir))
            if os.path.isdir(os.path.join(profiles_dir, d)) and not d.startswith(".")
        ]
        if found:
            active = os.environ.get("ANTIGRAVITY_PROFILE", "").strip()
            if active and active in found:
                found.remove(active)
                found.insert(0, active)
            return found

    active = os.environ.get("ANTIGRAVITY_PROFILE", "").strip()
    return [active] if active else [None]


def sanitize_prompt_for_cli(prompt_text: str, max_bytes: int = 115000) -> str:
    """Ensure prompt string fits within OS single CLI argument limits (115KB)."""
    encoded = prompt_text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return prompt_text

    logger.warning("Prompt size (%d bytes) exceeds CLI arg limit (%d bytes). Truncating context...", len(encoded), max_bytes)

    head_size = max_bytes // 3
    tail_size = (max_bytes * 2) // 3 - 100

    head_str = encoded[:head_size].decode("utf-8", errors="ignore")
    tail_str = encoded[-tail_size:].decode("utf-8", errors="ignore")

    return f"{head_str}\n\n...[Middle context truncated for CLI argument limits]...\n\n{tail_str}"


def parse_cmd_template(cmd_template: str, prompt_text: str) -> Tuple[List[str], str]:
    """Parse command template into list of arguments for subprocess (shell=False)."""
    sanitized_prompt = sanitize_prompt_for_cli(prompt_text)
    if "{prompt}" in cmd_template:
        placeholder = "__PROMPT_PLACEHOLDER__"
        temp = (
            cmd_template.replace('"{prompt}"', placeholder)
            .replace("'{prompt}'", placeholder)
            .replace("{prompt}", placeholder)
        )
        parts = shlex.split(temp)
        argv = [sanitized_prompt if p == placeholder else p for p in parts]
        return argv, ""
    else:
        argv = shlex.split(cmd_template)
        if argv and argv[-1] in ("-p", "--print"):
            argv.append(sanitized_prompt)
            return argv, ""
        return argv, sanitized_prompt


def execute_cli_command(
    cmd_template: str,
    prompt_text: str,
    timeout: float = 180.0,
    profile: Optional[str] = None,
) -> str:
    """Execute local CLI command with prompt substitution or stdin piping for a given profile."""
    argv, stdin_input = parse_cmd_template(cmd_template, prompt_text)

    log_str = " ".join(argv)[:120] if argv else cmd_template[:120]
    logger.info("Executing CLI command (profile=%s): %s", profile or "default", log_str)

    env = os.environ.copy()
    if profile:
        env["ANTIGRAVITY_PROFILE"] = profile

    proc = subprocess.Popen(
        argv,
        shell=False,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        stdout_data, stderr_data = proc.communicate(input=stdin_input, timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout_data, stderr_data = proc.communicate()
        raise RuntimeError(f"CLI Execution Timeout (profile={profile or 'default'})")

    if proc.returncode != 0:
        err_msg = stderr_data.strip() or stdout_data.strip() or f"Exit code {proc.returncode}"
        logger.error("CLI execution failed for profile '%s' (code %d): %s", profile or "default", proc.returncode, err_msg)
        raise RuntimeError(f"CLI Execution Error (profile={profile or 'default'}): {err_msg}")

    output_text = stdout_data.strip() or stderr_data.strip()
    if not output_text:
        err_hint = stderr_data.strip() or stdout_data.strip() or "Empty stdout/stderr"
        logger.error("CLI execution returned empty output for profile '%s': %s", profile or "default", err_hint)
        raise RuntimeError(f"CLI Execution returned empty output for profile '{profile or 'default'}': {err_hint}")

    return output_text


def execute_cli_with_fallback(
    cmd_template: str,
    prompt_text: str,
    timeout: float = 180.0,
    profiles: Optional[List[Optional[str]]] = None,
) -> Tuple[str, Optional[str]]:
    """Execute CLI command trying profiles sequentially until one succeeds."""
    if profiles is None:
        profiles = get_available_profiles()

    errors: List[str] = []
    for profile in profiles:
        try:
            logger.info("Attempting CLI execution with profile: %s", profile or "default")
            output = execute_cli_command(cmd_template, prompt_text, timeout=timeout, profile=profile)
            return output, profile
        except Exception as exc:
            logger.warning("Profile '%s' execution failed: %s", profile or "default", exc)
            errors.append(f"Profile '{profile or 'default'}': {exc}")

    raise RuntimeError(f"All agy profile execution attempts failed. Details: {'; '.join(errors)}")


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Multi-threaded HTTP server for handling concurrent API calls."""
    daemon_threads = True
    allow_reuse_address = True


class AntigravityBridgeHandler(BaseHTTPRequestHandler):
    """HTTP Handler implementing OpenAI ChatCompletions REST API."""

    def _send_json_response(self, data: Dict[str, Any], status_code: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_cors_headers(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self._send_cors_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0].rstrip("/")

        if path in ("", "/health"):
            cli_bin, cmd_tpl = detect_cli_command()
            self._send_json_response({
                "status": "ok",
                "service": "antigravity-bridge",
                "cli_detected": cli_bin,
                "command_template": cmd_tpl,
                "available_profiles": get_available_profiles(),
            })
            return

        if path in ("/v1/models", "/models"):
            cli_bin, _ = detect_cli_command()
            self._send_json_response({
                "object": "list",
                "data": [
                    {
                        "id": "antigravity",
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "local",
                    },
                    {
                        "id": "agy",
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "local",
                    },
                    {
                        "id": cli_bin,
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "local",
                    },
                ],
            })
            return

        self._send_json_response({"error": "Not Found"}, status_code=404)

    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/")

        if path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json_response({"error": "Not Found"}, status_code=404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body_data = self.rfile.read(content_length)

        try:
            req_json = json.loads(body_data.decode("utf-8"))
        except Exception as exc:
            self._send_json_response(
                {"error": {"message": f"Invalid JSON payload: {exc}", "type": "invalid_request_error"}},
                status_code=400,
            )
            return

        messages = req_json.get("messages", [])
        model = req_json.get("model") or "antigravity"
        stream = req_json.get("stream", False)

        prompt_text = format_messages_to_prompt(messages)
        cli_bin, cmd_tpl = detect_cli_command()
        custom_tpl = getattr(self.server, "custom_cmd", None) or cmd_tpl
        configured_profiles = getattr(self.server, "profiles", None)

        try:
            output_text, used_profile = execute_cli_with_fallback(
                custom_tpl, prompt_text, profiles=configured_profiles
            )
            logger.info("Successfully executed CLI using profile: %s", used_profile or "default")
        except Exception as exc:
            logger.error("All agy profile attempts failed: %s", exc)
            self._send_json_response(
                {"error": {"message": str(exc), "type": "api_error"}},
                status_code=500,
            )
            return

        completion_id = f"chatcmpl-ag-{uuid.uuid4().hex[:8]}"
        created_ts = int(time.time())

        if stream:
            # Send Server-Sent Events (SSE) stream
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            chunk_start = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": output_text},
                        "finish_reason": None,
                    }
                ],
            }
            self.wfile.write(f"data: {json.dumps(chunk_start)}\n\n".encode("utf-8"))
            self.wfile.flush()

            chunk_stop = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }
                ],
            }
            self.wfile.write(f"data: {json.dumps(chunk_stop)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return

        # Standard non-streaming JSON response
        response_payload = {
            "id": completion_id,
            "object": "chat.completion",
            "created": created_ts,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": output_text,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": len(prompt_text) // 4,
                "completion_tokens": len(output_text) // 4,
                "total_tokens": (len(prompt_text) + len(output_text)) // 4,
            },
        }

        self._send_json_response(response_payload)


def main():
    parser = argparse.ArgumentParser(
        description="Antigravity / agy OpenAI-compatible API Bridge Server"
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host address to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--cmd", default=None, help="Custom CLI command template (e.g. 'agy -p \"{prompt}\"')")
    parser.add_argument("--profiles", default=None, help="Comma-separated list of profile names to try for fallback")

    args = parser.parse_args()

    cli_bin, cmd_tpl = detect_cli_command()
    effective_cmd = args.cmd or cmd_tpl

    configured_profiles = [p.strip() for p in args.profiles.split(",") if p.strip()] if args.profiles else get_available_profiles()

    logger.info("Starting Antigravity API Bridge Server...")
    logger.info("Detected CLI Binary: %s", cli_bin)
    logger.info("Command Template:   %s", effective_cmd)
    logger.info("Configured Profiles: %s", configured_profiles)
    logger.info("Listening on:       http://%s:%d/v1", args.host, args.port)

    server = ThreadedHTTPServer((args.host, args.port), AntigravityBridgeHandler)
    server.custom_cmd = effective_cmd
    server.profiles = configured_profiles

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server...")
        server.server_close()


if __name__ == "__main__":
    main()
