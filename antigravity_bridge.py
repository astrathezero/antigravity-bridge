#!/usr/bin/env python3
"""Antigravity / agy OpenAI & Anthropic Compatible REST API Bridge Server.

Acts as a local REST API server (e.g. http://127.0.0.1:8000/v1) that translates
standard OpenAI /v1/chat/completions and Anthropic /v1/messages API requests
into local agy CLI execution.

Features:
- Dual API Format: OpenAI (/v1/chat/completions) + Anthropic (/v1/messages).
- Auto-detects local 'agy' CLI binary across Linux, macOS, and Windows.
- Supports model selection and reasoning effort flags (--model, --effort).
- Auto-fallbacks across multiple agy login profiles on rate limits.
- Secure by default: API Key auth support, Host header validation, input bounds checking.
- Requires no external pip dependencies (built on Python standard library).

Usage:
  python3 antigravity_bridge.py [--port 8000] [--host 127.0.0.1] [--api-key YOUR_KEY]
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import subprocess
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

MAX_BODY_SIZE = 32 * 1024 * 1024  # 32 MB limit

SUPPORTED_MODELS = {
    "gemini-3.6-flash-high": ("gemini-3.6-flash", "high"),
    "gemini-3.6-flash-medium": ("gemini-3.6-flash", "medium"),
    "gemini-3.6-flash-low": ("gemini-3.6-flash", "low"),
    "gemini-3.6-flash": ("gemini-3.6-flash", None),
    "gemini-3.5-flash-medium": ("gemini-3.5-flash", "medium"),
    "gemini-3.5-flash-low": ("gemini-3.5-flash", "low"),
    "gemini-3.5-flash": ("gemini-3.5-flash", None),
    "gemini-3.1-pro-high": ("gemini-3.1-pro", "high"),
    "gemini-3.1-pro-low": ("gemini-3.1-pro", "low"),
    "gemini-3.1-pro": ("gemini-3.1-pro", None),
    "claude-sonnet-4.6-thinking": ("claude-sonnet-4.6", None),
    "claude-sonnet-4.6": ("claude-sonnet-4.6", None),
    "claude-opus-4.6-thinking": ("claude-opus-4.6", None),
    "claude-opus-4.6": ("claude-opus-4.6", None),
    "gpt-oss-120b-medium": ("gpt-oss-120b", "medium"),
    "gpt-oss-120b": ("gpt-oss-120b", None),
}


def detect_cli_command() -> Tuple[str, str]:
    """Auto-detect available agy CLI binary for cross-platform execution.

    Returns:
        (cli_binary_name, command_template)
    """
    env_cmd = os.environ.get("ANTIGRAVITY_BRIDGE_CMD", "").strip()
    if env_cmd:
        binary = env_cmd.split()[0]
        return (binary, env_cmd)

    # 1. Search PATH (works on Linux, macOS, and Windows)
    agy_path = shutil.which("agy")
    if agy_path:
        return ("agy", f'"{agy_path}" --dangerously-skip-permissions')

    # 2. Check ~/.local/bin/agy (Linux/macOS) or Windows %USERPROFILE%\\.local\\bin\\agy.exe
    home = os.path.expanduser("~")
    local_bin = os.path.join(home, ".local", "bin", "agy.exe" if os.name == "nt" else "agy")
    if os.path.exists(local_bin) and os.access(local_bin, os.X_OK if os.name != "nt" else os.F_OK):
        return ("agy", f'"{local_bin}" --dangerously-skip-permissions')

    # Fallback to standard agy command name
    return ("agy", 'agy --dangerously-skip-permissions')


def normalize_tools(
    tools: Optional[List[Dict[str, Any]]] = None,
    functions: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Normalize OpenAI tools, legacy OpenAI functions, and Anthropic tools into unified schema list."""
    normalized: List[Dict[str, Any]] = []

    if tools and isinstance(tools, list):
        for t in tools:
            if not isinstance(t, dict):
                continue
            if t.get("type") == "function" and isinstance(t.get("function"), dict):
                fn = t["function"]
                normalized.append({
                    "name": fn.get("name", ""),
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {}),
                })
            elif "name" in t:
                # Anthropic tool format or direct tool definition
                normalized.append({
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema") or t.get("parameters", {}),
                })

    if functions and isinstance(functions, list):
        for fn in functions:
            if isinstance(fn, dict) and "name" in fn:
                # Avoid duplicate names if already added via tools
                if not any(item["name"] == fn.get("name") for item in normalized):
                    normalized.append({
                        "name": fn.get("name", ""),
                        "description": fn.get("description", ""),
                        "parameters": fn.get("parameters", {}),
                    })

    return normalized


def format_tools_to_system_prompt(
    tools: List[Dict[str, Any]],
    tool_choice: Optional[Any] = None,
) -> str:
    """Format normalized tools and instructions into system prompt text."""
    if not tools:
        return ""

    if isinstance(tool_choice, str) and tool_choice.lower() == "none":
        return ""

    forced_tool = None
    if isinstance(tool_choice, dict):
        if tool_choice.get("type") == "function" and isinstance(tool_choice.get("function"), dict):
            forced_tool = tool_choice["function"].get("name")
        elif tool_choice.get("type") == "tool":
            forced_tool = tool_choice.get("name")
        elif "name" in tool_choice:
            forced_tool = tool_choice.get("name")

    tools_json = json.dumps(tools, indent=2, ensure_ascii=False)

    lines = [
        "[Available Tools & Functions]",
        "You have access to the following tools/functions that you can call when needed:",
        "```json",
        tools_json,
        "```",
        "",
        "[Tool Calling Instructions]",
        "When you decide to call one or more tools, respond ONLY with a JSON object in this format:",
        "```json",
        "{",
        '  "tool_calls": [',
        "    {",
        '      "name": "function_name",',
        '      "arguments": { "parameter_name": "parameter_value" }',
        "    }",
        "  ]",
        "}",
        "```",
    ]

    if forced_tool:
        lines.append(f"CRITICAL: You MUST call the tool '{forced_tool}'.")
    elif isinstance(tool_choice, str) and tool_choice.lower() in ("required", "any"):
        lines.append("CRITICAL: You MUST call at least one tool from the available tools list.")
    else:
        lines.append("If no tool needs to be called to answer the user's request, respond normally with plain text.")

    lines.append("Do NOT output conversational filler before or after the JSON block when calling a tool.")
    return "\n".join(lines)


def _normalize_tool_call_item(
    item: Any,
    allowed_tools: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    """Normalize an extracted dictionary into standard tool call dict."""
    if not isinstance(item, dict):
        return None

    if item.get("type") == "function" and isinstance(item.get("function"), dict):
        item = item["function"]

    name = item.get("name") or item.get("function_name")
    if not name or not isinstance(name, str):
        return None

    name = name.strip()
    if allowed_tools:
        matched = next((t for t in allowed_tools if t.lower() == name.lower()), None)
        if matched:
            name = matched
        else:
            return None

    args = item.get("arguments") or item.get("parameters") or item.get("input") or {}
    if isinstance(args, str):
        try:
            args_dict = json.loads(args)
        except Exception:
            args_dict = {"raw_input": args}
    elif isinstance(args, dict):
        args_dict = args
    else:
        args_dict = {}

    call_id = item.get("id") or f"call_{uuid.uuid4().hex[:12]}"
    return {
        "id": call_id,
        "name": name,
        "arguments": args_dict,
    }


def _try_parse_tool_call_json(
    raw_str: str,
    allowed_tools: Optional[List[str]] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Attempt to parse a raw string as tool_calls JSON structure."""
    if not raw_str or not raw_str.strip():
        return None

    try:
        data = json.loads(raw_str)
    except Exception:
        return None

    tool_calls: List[Dict[str, Any]] = []

    if isinstance(data, dict):
        if "tool_calls" in data and isinstance(data["tool_calls"], list):
            for tc in data["tool_calls"]:
                item = _normalize_tool_call_item(tc, allowed_tools)
                if item:
                    tool_calls.append(item)
        elif "name" in data and ("arguments" in data or "parameters" in data or "input" in data):
            item = _normalize_tool_call_item(data, allowed_tools)
            if item:
                tool_calls.append(item)
        elif "function" in data and isinstance(data["function"], dict):
            item = _normalize_tool_call_item(data["function"], allowed_tools)
            if item:
                tool_calls.append(item)

    elif isinstance(data, list):
        for tc in data:
            item = _normalize_tool_call_item(tc, allowed_tools)
            if item:
                tool_calls.append(item)

    return tool_calls if tool_calls else None


def parse_tool_calls_from_response(
    output_text: str,
    allowed_tools: Optional[List[str]] = None,
) -> Tuple[Optional[str], Optional[List[Dict[str, Any]]]]:
    """Parse model output text to extract tool calls if present.

    Returns:
        (text_content, tool_calls_list)
    """
    if not output_text or not output_text.strip():
        return output_text, None

    text = output_text.strip()

    # 1. Regex search for ```json ... ``` or ``` ... ```
    code_block_matches = list(re.finditer(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE))
    for match in code_block_matches:
        candidate = match.group(1).strip()
        parsed = _try_parse_tool_call_json(candidate, allowed_tools)
        if parsed:
            prefix = text[:match.start()].strip()
            suffix = text[match.end():].strip()
            remaining_text = f"{prefix}\n{suffix}".strip() if (prefix or suffix) else None
            return remaining_text, parsed

    # 2. Search for XML style <tool_call>...</tool_call> or <function_call>...</function_call>
    xml_matches = list(re.finditer(r"<(?:tool_call|function_call)>\s*([\s\S]*?)\s*</(?:tool_call|function_call)>", text, re.IGNORECASE))
    if xml_matches:
        all_parsed: List[Dict[str, Any]] = []
        for match in xml_matches:
            candidate = match.group(1).strip()
            parsed = _try_parse_tool_call_json(candidate, allowed_tools)
            if parsed:
                all_parsed.extend(parsed)
        if all_parsed:
            clean_text = re.sub(r"<(?:tool_call|function_call)>[\s\S]*?</(?:tool_call|function_call)>", "", text, flags=re.IGNORECASE).strip()
            return clean_text or None, all_parsed

    # 3. Direct JSON parse on whole text
    parsed = _try_parse_tool_call_json(text, allowed_tools)
    if parsed:
        return None, parsed

    # 4. Search for { ... } object containing tool_calls or function names
    json_obj_matches = list(re.finditer(r"\{[\s\S]*\}", text))
    for match in json_obj_matches:
        candidate = match.group(0).strip()
        parsed = _try_parse_tool_call_json(candidate, allowed_tools)
        if parsed:
            prefix = text[:match.start()].strip()
            suffix = text[match.end():].strip()
            remaining_text = f"{prefix}\n{suffix}".strip() if (prefix or suffix) else None
            return remaining_text, parsed

    return output_text, None


def format_messages_to_prompt(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[Any] = None,
) -> str:
    """Format OpenAI/Anthropic messages list into a prompt string for CLI tools."""
    parts: List[str] = []

    # Prepend tool descriptions and instructions if tools are provided
    if tools:
        tool_prompt = format_tools_to_system_prompt(tools, tool_choice=tool_choice)
        if tool_prompt:
            parts.append(tool_prompt)

    if not messages:
        return "\n\n".join(parts)

    if len(messages) == 1 and isinstance(messages[0], dict) and messages[0].get("role") == "user" and not tools:
        content = messages[0].get("content") or ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "user")
        content = msg.get("content") or ""

        # Parse content blocks (Anthropic / OpenAI rich content)
        if isinstance(content, list):
            text_blocks: List[str] = []
            for c in content:
                if not isinstance(c, dict):
                    continue
                c_type = c.get("type")
                if c_type == "text":
                    text_blocks.append(c.get("text", ""))
                elif c_type == "tool_use":
                    # Anthropic assistant tool call block
                    t_name = c.get("name", "")
                    t_input = json.dumps(c.get("input", {}), ensure_ascii=False)
                    text_blocks.append(f"[Tool Call: {t_name}({t_input})]")
                elif c_type == "tool_result":
                    # Anthropic user tool result block
                    t_id = c.get("tool_use_id", "")
                    t_content = c.get("content", "")
                    is_err = " (ERROR)" if c.get("is_error") else ""
                    text_blocks.append(f"[Tool Result ({t_id}){is_err}]:\n{t_content}")
            content = "\n".join(text_blocks)
        elif not isinstance(content, str):
            content = str(content)

        if role == "system":
            parts.append(f"[System Instructions]\n{content}")
        elif role == "user":
            parts.append(f"[User]\n{content}")
        elif role == "assistant":
            tool_calls = msg.get("tool_calls")
            tc_text = ""
            if tool_calls and isinstance(tool_calls, list):
                tc_items = []
                for tc in tool_calls:
                    if isinstance(tc, dict):
                        fn = tc.get("function", {})
                        fn_name = fn.get("name", "")
                        fn_args = fn.get("arguments", "")
                        tc_items.append(f"[Tool Call: {fn_name}({fn_args})]")
                if tc_items:
                    tc_text = "\n" + "\n".join(tc_items)
            parts.append(f"[Assistant]\n{content}{tc_text}".strip())
        elif role == "tool":
            tool_id = msg.get("tool_call_id") or msg.get("name") or "tool"
            parts.append(f"[Tool Result ({tool_id})]\n{content}")
        elif role == "function":
            fn_name = msg.get("name") or "function"
            parts.append(f"[Function Result ({fn_name})]\n{content}")
        else:
            parts.append(f"[{str(role).capitalize()}]\n{content}")

    return "\n\n".join(parts)


def get_available_profiles() -> List[Optional[str]]:
    """Get list of available Antigravity / agy login profiles for fallback."""
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


def resolve_model_flags(model_name: Optional[str]) -> List[str]:
    """Parse model ID into --model and --effort CLI flags for agy safely."""
    flags: List[str] = []
    if not model_name:
        return flags

    model_clean = model_name.strip()
    model_lower = model_clean.lower()

    if model_lower in SUPPORTED_MODELS:
        real_model, effort = SUPPORTED_MODELS[model_lower]
        flags.extend(["--model", real_model])
        if effort:
            flags.extend(["--effort", effort])
        return flags

    effort = None
    if model_lower.endswith("-thinking"):
        model_lower = model_lower[:-9]

    if model_lower.endswith("-low"):
        effort = "low"
        model_lower = model_lower[:-4]
    elif model_lower.endswith("-medium"):
        effort = "medium"
        model_lower = model_lower[:-7]
    elif model_lower.endswith("-high"):
        effort = "high"
        model_lower = model_lower[:-5]

    if "gemini-3.6-flash" in model_lower:
        flags.extend(["--model", "gemini-3.6-flash"])
    elif "gemini-3.5-flash" in model_lower:
        flags.extend(["--model", "gemini-3.5-flash"])
    elif "gemini-3.1-pro" in model_lower:
        flags.extend(["--model", "gemini-3.1-pro"])
    elif "claude-sonnet-4.6" in model_lower:
        flags.extend(["--model", "claude-sonnet-4.6"])
    elif "claude-opus-4.6" in model_lower:
        flags.extend(["--model", "claude-opus-4.6"])
    elif "gpt-oss-120b" in model_lower:
        flags.extend(["--model", "gpt-oss-120b"])
    elif model_lower not in ("antigravity", "agy", "default", "local") and not model_clean.startswith("-"):
        flags.extend(["--model", model_clean])

    if effort:
        flags.extend(["--effort", effort])

    return flags


def parse_cmd_template(
    cmd_template: str,
    prompt_text: str,
    model_name: Optional[str] = None,
) -> Tuple[List[str], str]:
    """Parse command template into list of arguments for subprocess (shell=False)."""
    model_flags = resolve_model_flags(model_name)

    if "{prompt}" in cmd_template:
        sanitized_prompt = sanitize_prompt_for_cli(prompt_text)
        placeholder = "__PROMPT_PLACEHOLDER__"
        temp = (
            cmd_template.replace('"{prompt}"', placeholder)
            .replace("'{prompt}'", placeholder)
            .replace("{prompt}", placeholder)
        )
        parts = shlex.split(temp)
        if model_flags:
            parts = [parts[0]] + model_flags + parts[1:]
        argv = [sanitized_prompt if p == placeholder else p for p in parts]
        return argv, ""
    else:
        argv = shlex.split(cmd_template)
        if model_flags:
            argv = [argv[0]] + model_flags + argv[1:]
        if argv and argv[-1] in ("-p", "--print"):
            sanitized_prompt = sanitize_prompt_for_cli(prompt_text)
            argv.append(sanitized_prompt)
            return argv, ""
        # Stdin path: pass full prompt text via stdin without truncating
        return argv, prompt_text


def execute_cli_command(
    cmd_template: str,
    prompt_text: str,
    timeout: float = 180.0,
    profile: Optional[str] = None,
    model_name: Optional[str] = None,
) -> str:
    """Execute local CLI command with prompt substitution or stdin piping for a given profile."""
    argv, stdin_input = parse_cmd_template(cmd_template, prompt_text, model_name=model_name)

    log_str = " ".join(argv)[:120] if argv else cmd_template[:120]
    logger.info("Executing CLI command (profile=%s): %s", profile or "default", log_str)

    # Filtered environment to avoid leaking ambient secrets to CLI subprocess
    allowed_env_keys = {
        "PATH", "HOME", "LANG", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP",
        "ANTIGRAVITY_PROFILE", "ANTIGRAVITY_PROFILES", "ANTIGRAVITY_HOME",
    }
    env = {k: v for k, v in os.environ.items() if k in allowed_env_keys or k.startswith("ANTIGRAVITY_")}
    if profile:
        env["ANTIGRAVITY_PROFILE"] = profile

    proc = subprocess.Popen(
        argv,
        shell=False,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
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
    model_name: Optional[str] = None,
) -> Tuple[str, Optional[str]]:
    """Execute CLI command trying profiles sequentially until one succeeds."""
    if profiles is None:
        profiles = get_available_profiles()

    errors: List[str] = []
    per_profile_timeout = min(timeout, 120.0)

    for profile in profiles:
        try:
            logger.info("Attempting CLI execution with profile: %s (model=%s)", profile or "default", model_name or "default")
            output = execute_cli_command(
                cmd_template, prompt_text, timeout=per_profile_timeout, profile=profile, model_name=model_name
            )
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
    """HTTP Handler implementing OpenAI ChatCompletions & Anthropic Messages REST API."""
    protocol_version = "HTTP/1.1"

    def _authorized(self) -> bool:
        """Allow requests without blocking on API key authentication."""
        return True

    def _send_json_response(self, data: Dict[str, Any], status_code: int = 200) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if getattr(self.server, "enable_cors", False):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _send_cors_headers(self) -> None:
        self.send_response(204)
        if getattr(self.server, "enable_cors", False):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self._send_cors_headers()

    def do_GET(self) -> None:
        try:
            path = self.path.split("?")[0].rstrip("/")

            if path in ("", "/health"):
                self._send_json_response({
                    "status": "ok",
                    "service": "antigravity-bridge",
                })
                return

            if not self._authorized():
                self._send_json_response(
                    {"error": {"message": "Unauthorized API Key", "type": "invalid_request_error"}},
                    status_code=401,
                )
                return

            if path in ("/v1/models", "/models"):
                now_ts = int(time.time())
                models_list = [
                    {"id": m, "object": "model", "created": now_ts, "owned_by": "local"}
                    for m in SUPPORTED_MODELS.keys()
                ] + [
                    {"id": "antigravity", "object": "model", "created": now_ts, "owned_by": "local"},
                    {"id": "agy", "object": "model", "created": now_ts, "owned_by": "local"},
                ]
                self._send_json_response({
                    "object": "list",
                    "data": models_list,
                })
                return

            self._send_json_response({"error": "Not Found"}, status_code=404)
        except Exception as exc:
            logger.error("Unhandled Exception in do_GET: %s", exc)
            self._send_json_response(
                {"error": {"message": f"Internal Server Error: {exc}", "type": "api_error"}},
                status_code=500,
            )

    def do_POST(self) -> None:
        try:
            path = self.path.split("?")[0].rstrip("/")
            is_anthropic = path in ("/v1/messages", "/messages")
            is_openai = path in ("/v1/chat/completions", "/chat/completions")

            if not (is_openai or is_anthropic):
                self._send_json_response({"error": "Not Found"}, status_code=404)
                return

            if not self._authorized():
                self._send_json_response(
                    {"error": {"message": "Unauthorized API Key", "type": "invalid_request_error"}},
                    status_code=401,
                )
                return

            try:
                content_length = int(self.headers.get("Content-Length", 0))
            except (TypeError, ValueError):
                self._send_json_response(
                    {"error": {"message": "Invalid Content-Length header", "type": "invalid_request_error"}},
                    status_code=400,
                )
                return

            if content_length < 0 or content_length > MAX_BODY_SIZE:
                self._send_json_response(
                    {"error": {"message": f"Payload size exceeds maximum allowed size ({MAX_BODY_SIZE} bytes)", "type": "invalid_request_error"}},
                    status_code=413,
                )
                return

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
            if not isinstance(messages, list):
                self._send_json_response(
                    {"error": {"message": "'messages' field must be a list of message objects", "type": "invalid_request_error"}},
                    status_code=400,
                )
                return

            tools = req_json.get("tools")
            functions = req_json.get("functions")
            tool_choice = req_json.get("tool_choice")
            normalized_tools = normalize_tools(tools=tools, functions=functions)

            # Handle Anthropic system prompt format
            system_prompt = req_json.get("system")
            if system_prompt:
                if isinstance(system_prompt, list):
                    sys_str = "\n".join(s.get("text", "") for s in system_prompt if isinstance(s, dict))
                else:
                    sys_str = str(system_prompt)
                if sys_str.strip():
                    messages = [{"role": "system", "content": sys_str.strip()}] + messages

            model = req_json.get("model") or "antigravity"
            stream = req_json.get("stream", False)

            prompt_text = format_messages_to_prompt(
                messages,
                tools=normalized_tools if normalized_tools else None,
                tool_choice=tool_choice,
            )
            cli_bin, cmd_tpl = detect_cli_command()
            custom_tpl = getattr(self.server, "custom_cmd", None) or cmd_tpl
            configured_profiles = getattr(self.server, "profiles", None)

            try:
                output_text, used_profile = execute_cli_with_fallback(
                    custom_tpl, prompt_text, profiles=configured_profiles, model_name=model
                )
                logger.info("Successfully executed CLI using profile: %s (model=%s)", used_profile or "default", model)
            except Exception as exc:
                logger.error("All agy profile attempts failed: %s", exc)
                self._send_json_response(
                    {"error": {"message": str(exc), "type": "api_error"}},
                    status_code=500,
                )
                return

            created_ts = int(time.time())

            # Parse tool calls if tools were provided or output format matches tool call schema
            allowed_tool_names = [t["name"] for t in normalized_tools if t.get("name")] if normalized_tools else None
            content_text, parsed_tool_calls = parse_tool_calls_from_response(
                output_text,
                allowed_tools=allowed_tool_names if normalized_tools else None,
            )

            # --- Handle Anthropic API format (/v1/messages) ---
            if is_anthropic:
                msg_id = f"msg_{uuid.uuid4().hex}"

                if parsed_tool_calls:
                    anthropic_content: List[Dict[str, Any]] = []
                    if content_text:
                        anthropic_content.append({"type": "text", "text": content_text})
                    for tc in parsed_tool_calls:
                        tc_id = tc["id"]
                        if not tc_id.startswith("toolu_"):
                            tc_id = f"toolu_{uuid.uuid4().hex}"
                        anthropic_content.append({
                            "type": "tool_use",
                            "id": tc_id,
                            "name": tc["name"],
                            "input": tc["arguments"],
                        })
                    stop_reason = "tool_use"
                else:
                    anthropic_content = [{"type": "text", "text": output_text}]
                    stop_reason = "end_turn"

                if stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    if getattr(self.server, "enable_cors", False):
                        self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()

                    events: List[Tuple[str, Dict[str, Any]]] = [
                        ("message_start", {
                            "type": "message_start",
                            "message": {
                                "id": msg_id,
                                "type": "message",
                                "role": "assistant",
                                "model": model,
                                "content": [],
                                "stop_reason": None,
                                "stop_sequence": None,
                                "usage": {"input_tokens": len(prompt_text) // 4, "output_tokens": 1},
                            },
                        }),
                    ]

                    block_idx = 0
                    if content_text:
                        events.extend([
                            ("content_block_start", {"type": "content_block_start", "index": block_idx, "content_block": {"type": "text", "text": ""}}),
                            ("content_block_delta", {"type": "content_block_delta", "index": block_idx, "delta": {"type": "text_delta", "text": content_text}}),
                            ("content_block_stop", {"type": "content_block_stop", "index": block_idx}),
                        ])
                        block_idx += 1
                    elif not parsed_tool_calls:
                        events.extend([
                            ("content_block_start", {"type": "content_block_start", "index": block_idx, "content_block": {"type": "text", "text": ""}}),
                            ("content_block_delta", {"type": "content_block_delta", "index": block_idx, "delta": {"type": "text_delta", "text": output_text}}),
                            ("content_block_stop", {"type": "content_block_stop", "index": block_idx}),
                        ])
                        block_idx += 1

                    if parsed_tool_calls:
                        for tc in parsed_tool_calls:
                            tc_id = tc["id"]
                            if not tc_id.startswith("toolu_"):
                                tc_id = f"toolu_{tc_id.replace('call_', '')}"
                            events.extend([
                                ("content_block_start", {"type": "content_block_start", "index": block_idx, "content_block": {"type": "tool_use", "id": tc_id, "name": tc["name"], "input": {}}}),
                                ("content_block_delta", {"type": "content_block_delta", "index": block_idx, "delta": {"type": "input_json_delta", "partial_json": json.dumps(tc["arguments"], ensure_ascii=False)}}),
                                ("content_block_stop", {"type": "content_block_stop", "index": block_idx}),
                            ])
                            block_idx += 1

                    events.extend([
                        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": len(output_text) // 4}}),
                        ("message_stop", {"type": "message_stop"}),
                    ])

                    try:
                        for event_name, data in events:
                            self.wfile.write(f"event: {event_name}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        logger.warning("Client disconnected during Anthropic SSE stream")
                    return

                response_payload = {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": anthropic_content,
                    "stop_reason": stop_reason,
                    "stop_sequence": None,
                    "usage": {"input_tokens": len(prompt_text) // 4, "output_tokens": len(output_text) // 4},
                }
                self._send_json_response(response_payload)
                return

            # --- Handle OpenAI API format (/v1/chat/completions) ---
            completion_id = f"chatcmpl-ag-{uuid.uuid4().hex[:8]}"

            if parsed_tool_calls:
                openai_tool_calls = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": json.dumps(tc["arguments"], ensure_ascii=False),
                        },
                    }
                    for tc in parsed_tool_calls
                ]
                finish_reason = "tool_calls"
            else:
                openai_tool_calls = None
                finish_reason = "stop"

            if stream:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                if getattr(self.server, "enable_cors", False):
                    self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                if parsed_tool_calls:
                    chunk_start = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created_ts,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "role": "assistant",
                                    "content": content_text,
                                    "tool_calls": [
                                        {
                                            "index": idx,
                                            "id": tc["id"],
                                            "type": "function",
                                            "function": {
                                                "name": tc["name"],
                                                "arguments": json.dumps(tc["arguments"], ensure_ascii=False),
                                            },
                                        }
                                        for idx, tc in enumerate(parsed_tool_calls)
                                    ],
                                },
                                "finish_reason": None,
                            }
                        ],
                    }
                else:
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

                chunk_stop = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": finish_reason,
                        }
                    ],
                }
                try:
                    self.wfile.write(f"data: {json.dumps(chunk_start)}\n\n".encode("utf-8"))
                    self.wfile.write(f"data: {json.dumps(chunk_stop)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    logger.warning("Client disconnected during OpenAI SSE stream")
                return

            # Standard OpenAI non-streaming response
            message_obj: Dict[str, Any] = {
                "role": "assistant",
                "content": content_text if parsed_tool_calls else output_text,
            }
            if openai_tool_calls:
                message_obj["tool_calls"] = openai_tool_calls

            response_payload = {
                "id": completion_id,
                "object": "chat.completion",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": message_obj,
                        "finish_reason": finish_reason,
                    }
                ],
                "usage": {
                    "prompt_tokens": len(prompt_text) // 4,
                    "completion_tokens": len(output_text) // 4,
                    "total_tokens": (len(prompt_text) + len(output_text)) // 4,
                },
            }

            self._send_json_response(response_payload)
        except Exception as exc:
            logger.error("Unhandled Exception in do_POST: %s", exc)
            self._send_json_response(
                {"error": {"message": f"Internal Server Error: {exc}", "type": "api_error"}},
                status_code=500,
            )


def main():
    parser = argparse.ArgumentParser(
        description="Antigravity / agy OpenAI & Anthropic compatible API Bridge Server"
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host address to bind to (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--cmd", default=None, help="Custom CLI command template (e.g. 'agy -p \"{prompt}\"')")
    parser.add_argument("--profiles", default=None, help="Comma-separated list of profile names to try for fallback")
    parser.add_argument("--api-key", default=os.environ.get("ANTIGRAVITY_BRIDGE_API_KEY"), help="API Key for authentication")
    parser.add_argument("--enable-cors", action="store_true", help="Enable wildcard CORS headers (Access-Control-Allow-Origin: *)")

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
    server.api_key = args.api_key
    server.enable_cors = args.enable_cors

    if server.api_key:
        logger.info("API Key Authentication: ENABLED")
    else:
        logger.info("API Key Authentication: DISABLED (Unauthenticated local requests allowed)")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down server...")
        server.server_close()


if __name__ == "__main__":
    main()
