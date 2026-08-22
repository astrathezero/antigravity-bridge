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
import base64
import hmac
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any, Dict, List, Optional, Set, Tuple


def load_dotenv(paths: Optional[List[str]] = None) -> None:
    """Lightweight zero-dependency .env file parser and loader."""
    if paths is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        paths = [
            os.path.join(script_dir, ".env"),
            os.path.join(os.getcwd(), ".env"),
            os.path.expanduser("~/.config/antigravity/bridge.env"),
            os.path.expanduser("~/.config/antigravity/.env"),
            os.path.expanduser("~/.env"),
        ]

    for p in paths:
        if os.path.exists(p) and os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("'\"")
                        if k and k not in os.environ:
                            os.environ[k] = v
            except Exception:
                pass


# Auto-load private environment configuration if present
load_dotenv()

logger = logging.getLogger("antigravity_bridge")

MAX_BODY_SIZE = 32 * 1024 * 1024  # 32 MB limit
MAX_CLI_ARG_BYTES = 350000        # 350KB safe CLI argument limit (macOS ARG_MAX=1MB, Linux ARG_MAX=2MB)

DEFAULT_PROFILE_TIMEOUT = 180.0      # Default execution timeout per profile attempt in seconds
DEFAULT_TOTAL_TIMEOUT = 480.0       # Total execution timeout across all profile fallback attempts in seconds

DEFAULT_IMAGE_ROUTER_URL = os.environ.get("ANTIGRAVITY_IMAGE_ROUTER_URL", "https://aiapirouter.mrserm.com/v1")
DEFAULT_IMAGE_ROUTER_KEY = os.environ.get("ANTIGRAVITY_IMAGE_ROUTER_KEY", "sk-36a01df06cfa9e5f-5mbqa9-11db659b")
DEFAULT_QUOTA_CACHE_FILE = os.path.expanduser("~/.config/antigravity/quota_cache.json")
DEFAULT_QUOTA_WINDOW_SECONDS = 10800.0  # 3-hour sliding window for Google Gemini quota
DEFAULT_FLASH_QUOTA_CAPACITY = 50       # Baseline 50 requests capacity per 3h window for Flash

SUPPORTED_MODELS = {
    "gemini-3.7-flash": ("gemini-3.7-flash", "high"),
    "gemini-3.7-flash-high": ("gemini-3.7-flash", "high"),
    "gemini-3.7-flash-medium": ("gemini-3.7-flash", "medium"),
    "gemini-3.7-flash-low": ("gemini-3.7-flash", "low"),
    "gemini-3.6-flash-high": ("gemini-3.6-flash", "high"),
    "gemini-3.6-flash-medium": ("gemini-3.6-flash", "medium"),
    "gemini-3.6-flash-low": ("gemini-3.6-flash", "low"),
    "gemini-3.6-flash": ("gemini-3.6-flash", None),
    "gemini-3.5-flash-medium": ("gemini-3.5-flash", "medium"),
    "gemini-3.5-flash-low": ("gemini-3.5-flash", "low"),
    "gemini-3.5-flash": ("gemini-3.5-flash", None),
    "gemini-3.1-pro-high": ("gemini-3.1-pro", "high"),
    "gemini-3.1-pro-low": ("gemini-3.1-pro", "low"),
    "gemini-3.1-pro": ("gemini-3.1-pro", "high"),
    "gemini-3.1-flash-image": ("ag/gemini-3.1-flash-image", None),
    "gemini-image": ("ag/gemini-3.1-flash-image", None),
    "imagen-3": ("ag/gemini-3.1-flash-image", None),
    "nano-banana": ("ag/gemini-3.1-flash-image", None),
    "claude-sonnet-4.6-thinking": ("claude-sonnet-4.6", None),
    "claude-sonnet-4.6": ("claude-sonnet-4.6", None),
    "claude-opus-4.6-thinking": ("claude-opus-4.6", None),
    "claude-opus-4.6": ("claude-opus-4.6", None),
    "gpt-oss-120b-medium": ("gpt-oss-120b", "medium"),
    "gpt-oss-120b": ("gpt-oss-120b", None),
    "imagen-3.0-generate-002": ("ag/gemini-3.1-flash-image", None),
    "imagen-3.0-fast-generate-001": ("ag/gemini-3.1-flash-image", None),
}

MODEL_CONTEXT_LIMITS = {
    # Gemini Flash Models (1M tokens)
    "gemini-3.7-flash": 1000000,
    "gemini-3.7-flash-high": 1000000,
    "gemini-3.7-flash-medium": 1000000,
    "gemini-3.7-flash-low": 1000000,
    "gemini-3.6-flash-high": 1000000,
    "gemini-3.6-flash-medium": 1000000,
    "gemini-3.6-flash-low": 1000000,
    "gemini-3.6-flash": 1000000,
    "gemini-3.5-flash-medium": 1000000,
    "gemini-3.5-flash-low": 1000000,
    "gemini-3.5-flash": 1000000,
    # Gemini Pro Models (2M tokens)
    "gemini-3.1-pro-high": 2000000,
    "gemini-3.1-pro-low": 2000000,
    "gemini-3.1-pro": 2000000,
    # Anthropic Claude Models (200k tokens)
    "claude-sonnet-4.6-thinking": 200000,
    "claude-sonnet-4.6": 200000,
    "claude-opus-4.6-thinking": 200000,
    "claude-opus-4.6": 200000,
    # GPT-OSS 120B Models (128k tokens)
    "gpt-oss-120b-medium": 128000,
    "gpt-oss-120b": 128000,
    # Default CLI fallback
    "antigravity": 1000000,
    "agy": 1000000,
}

IMAGE_SIZE_TO_ASPECT_RATIO = {
    "1024x1024": "1:1",
    "512x512": "1:1",
    "1792x1024": "16:9",
    "1920x1080": "16:9",
    "1280x720": "16:9",
    "16:9": "16:9",
    "1024x1792": "9:16",
    "1080x1920": "9:16",
    "720x1280": "9:16",
    "9:16": "9:16",
    "1024x768": "4:3",
    "4:3": "4:3",
    "768x1024": "3:4",
    "3:4": "3:4",
}



def is_image_model(model_name: Optional[str]) -> bool:
    """Check if model is an image generation model."""
    if not model_name:
        return False
    m = model_name.lower().strip()
    return (
        m in (
            "gemini-3.1-flash-image", "ag/gemini-3.1-flash-image",
            "gemini-image", "imagen-3", "nano-banana", "gemini-imagen"
        )
        or m.endswith("-image")
        or "imagen" in m
        or "banana" in m
    )


def generate_image_via_router(
    prompt: str,
    model_name: str = "ag/gemini-3.1-flash-image",
    router_url: str = DEFAULT_IMAGE_ROUTER_URL,
    router_key: str = DEFAULT_IMAGE_ROUTER_KEY,
    timeout: int = 60,
) -> Tuple[str, Optional[str]]:
    """Generate image using 9router / aiapirouter backend.

    Returns:
        (markdown_image_content, raw_b64_string)
    """
    upstream_model = model_name if model_name.startswith("ag/") else f"ag/{model_name}"
    if upstream_model not in ("ag/gemini-3.1-flash-image",):
        upstream_model = "ag/gemini-3.1-flash-image"

    # 1. Try /images/generations endpoint on router
    img_endpoint = f"{router_url.rstrip('/')}/images/generations"
    headers = {
        "Authorization": f"Bearer {router_key}",
        "Content-Type": "application/json",
        "User-Agent": "AntigravityBridge/1.0",
    }
    payload = {
        "model": upstream_model,
        "prompt": prompt,
        "n": 1,
    }

    try:
        req = urllib.request.Request(img_endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            items = data.get("data", [])
            if items and items[0].get("b64_json"):
                b64 = items[0]["b64_json"]
                return f"\n![image](data:image/jpeg;base64,{b64})", b64
    except Exception as exc:
        logger.warning("Router /images/generations call failed (%s), falling back to /chat/completions...", exc)

    # 2. Fallback to /chat/completions on router
    chat_endpoint = f"{router_url.rstrip('/')}/chat/completions"
    chat_payload = {
        "model": upstream_model,
        "messages": [
            {"role": "user", "content": prompt}
        ],
    }
    req = urllib.request.Request(chat_endpoint, data=json.dumps(chat_payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        choices = data.get("choices", [])
        if choices:
            content = choices[0].get("message", {}).get("content", "")
            b64_match = re.search(r"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)", content)
            b64 = b64_match.group(1) if b64_match else None
            return content, b64

    raise RuntimeError("Failed to retrieve generated image from router")



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
        return ("agy", f'"{agy_path}" --dangerously-skip-permissions -p "{{prompt}}"')

    # 2. Check ~/.local/bin/agy (Linux/macOS) or Windows %USERPROFILE%\.local\bin\agy.exe
    home = os.path.expanduser("~")
    local_bin = os.path.join(home, ".local", "bin", "agy.exe" if os.name == "nt" else "agy")
    if os.path.exists(local_bin) and os.access(local_bin, os.X_OK if os.name != "nt" else os.F_OK):
        return ("agy", f'"{local_bin}" --dangerously-skip-permissions -p "{{prompt}}"')

    # Fallback to standard agy command name
    return ("agy", 'agy --dangerously-skip-permissions -p "{prompt}"')


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


def compact_tool_output(content: Any, max_chars: int = 1500) -> Any:
    """Intelligently compact a tool output string or structured content to avoid context bloat."""
    if isinstance(content, str):
        if len(content) <= max_chars:
            return content
        head_len = int(max_chars * 0.55)
        tail_len = max(0, max_chars - head_len - 80)
        orig_len = len(content)
        head_part = content[:head_len]
        tail_part = content[-tail_len:] if tail_len > 0 else ""
        return f"{head_part}\n\n... [Tool output truncated: original {orig_len} chars -> compacted to {max_chars} chars] ...\n\n{tail_part}"
    elif isinstance(content, list):
        new_list = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                txt = item.get("text", "")
                if len(txt) > max_chars:
                    item_copy = dict(item)
                    item_copy["text"] = compact_tool_output(txt, max_chars=max_chars)
                    new_list.append(item_copy)
                else:
                    new_list.append(item)
            else:
                new_list.append(item)
        return new_list
    return content


def compact_messages(
    messages: List[Dict[str, Any]],
    max_total_chars: Optional[int] = None,
    recent_keep_count: int = 4,
) -> List[Dict[str, Any]]:
    """Intelligently compact conversation messages to prevent context bloat, token exhaustion, and CLI timeouts.

    Multi-Tier Strategy:
    1. System Messages: Preserved intact (up to 12K chars each).
    2. Kickoff Goal: Preserve the original user goal up to 3,000 chars.
    3. Recent Messages: Preserve last N messages (default: 4) with soft tool compaction (2,500 chars).
    4. Older Middle Messages: Aggressively compact tool results (800 chars) and text (1,200 chars).
    5. Progressive Slicing: If total chars exceed budget, progressively prune oldest intermediate turns.
    6. Safety Cap: Proportionally scale down largest remaining turns if still exceeding budget.
    """
    if not messages:
        return []

    if max_total_chars is None:
        try:
            max_total_chars = int(os.environ.get("ANTIGRAVITY_MAX_PROMPT_CHARS", "40000"))
        except Exception:
            max_total_chars = 40000

    def estimate_chars(msg_list: List[Dict[str, Any]]) -> int:
        total = 0
        for m in msg_list:
            c = m.get("content")
            if isinstance(c, str):
                total += len(c)
            elif isinstance(c, list):
                for item in c:
                    if isinstance(item, dict) and "text" in item:
                        total += len(str(item["text"]))
            elif c is not None:
                total += len(str(c))
        return total

    system_msgs: List[Dict[str, Any]] = []
    non_system_msgs: List[Dict[str, Any]] = []

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "system":
            sys_copy = dict(msg)
            c_sys = sys_copy.get("content", "")
            if isinstance(c_sys, str) and len(c_sys) > 12000:
                sys_copy["content"] = compact_tool_output(c_sys, max_chars=12000)
            system_msgs.append(sys_copy)
        else:
            non_system_msgs.append(msg)

    if not non_system_msgs:
        return system_msgs

    # Single or few messages: apply individual message compaction
    if len(non_system_msgs) <= recent_keep_count:
        compacted_non_sys: List[Dict[str, Any]] = []
        for m in non_system_msgs:
            m_copy = dict(m)
            role = m_copy.get("role")
            if role == "tool" or m_copy.get("tool_call_id"):
                m_copy["content"] = compact_tool_output(m_copy.get("content", ""), max_chars=2500)
            elif isinstance(m_copy.get("content"), list):
                m_copy["content"] = compact_tool_output(m_copy.get("content"), max_chars=2500)
            elif isinstance(m_copy.get("content"), str) and len(m_copy["content"]) > 4000:
                m_copy["content"] = compact_tool_output(m_copy["content"], max_chars=3500)
            compacted_non_sys.append(m_copy)

        assembled = system_msgs + compacted_non_sys
        if estimate_chars(assembled) <= max_total_chars:
            return assembled

        # If still exceeding, scale down largest content
        for m in compacted_non_sys:
            c = m.get("content", "")
            if isinstance(c, str) and len(c) > 2000:
                m["content"] = compact_tool_output(c, max_chars=1800)
        return system_msgs + compacted_non_sys

    # We have older middle messages: non_system_msgs[0] is kickoff, non_system_msgs[-recent_keep_count:] is recent
    first_msg = dict(non_system_msgs[0])
    if first_msg.get("role") == "tool":
        first_msg["content"] = compact_tool_output(first_msg.get("content", ""), max_chars=1500)
    elif isinstance(first_msg.get("content"), list):
        first_msg["content"] = compact_tool_output(first_msg.get("content"), max_chars=1500)
    elif isinstance(first_msg.get("content"), str) and len(first_msg["content"]) > 3000:
        first_msg["content"] = compact_tool_output(first_msg["content"], max_chars=2500)

    middle_msgs = non_system_msgs[1:-recent_keep_count]
    recent_msgs = non_system_msgs[-recent_keep_count:]

    # Compact middle messages aggressively (800 chars for tool, 1200 chars for text)
    compacted_middle: List[Dict[str, Any]] = []
    for m in middle_msgs:
        m_copy = dict(m)
        role = m_copy.get("role")
        if role == "tool" or m_copy.get("tool_call_id"):
            m_copy["content"] = compact_tool_output(m_copy.get("content", ""), max_chars=800)
        elif isinstance(m_copy.get("content"), str):
            c_str = m_copy["content"]
            if len(c_str) > 1500:
                m_copy["content"] = compact_tool_output(c_str, max_chars=1200)
        elif isinstance(m_copy.get("content"), list):
            m_copy["content"] = compact_tool_output(m_copy.get("content"), max_chars=800)
        compacted_middle.append(m_copy)

    # Compact recent messages softly (2500 chars for tool, 3500 chars for text)
    compacted_recent: List[Dict[str, Any]] = []
    for m in recent_msgs:
        m_copy = dict(m)
        role = m_copy.get("role")
        if role == "tool" or m_copy.get("tool_call_id"):
            m_copy["content"] = compact_tool_output(m_copy.get("content", ""), max_chars=2500)
        elif isinstance(m_copy.get("content"), list):
            m_copy["content"] = compact_tool_output(m_copy.get("content"), max_chars=2500)
        elif isinstance(m_copy.get("content"), str) and len(m_copy["content"]) > 4000:
            m_copy["content"] = compact_tool_output(m_copy["content"], max_chars=3500)
        compacted_recent.append(m_copy)

    assembled = system_msgs + [first_msg] + compacted_middle + compacted_recent
    total_len = estimate_chars(assembled)

    # If still exceeding max_total_chars, prune oldest middle messages progressively
    pruned_count = 0
    while total_len > max_total_chars and len(compacted_middle) > 0:
        step_prune = min(2, len(compacted_middle))
        compacted_middle = compacted_middle[step_prune:]
        pruned_count += step_prune
        assembled = system_msgs + [first_msg] + [
            {"role": "user", "content": f"[... {pruned_count} older conversation turns compacted to optimize reasoning latency ...]"}
        ] + compacted_middle + compacted_recent
        total_len = estimate_chars(assembled)

    # Final safety pass: if still exceeding max_total_chars, scale down recent messages
    if total_len > max_total_chars:
        for m in compacted_recent:
            c = m.get("content", "")
            if isinstance(c, str) and len(c) > 1500:
                m["content"] = compact_tool_output(c, max_chars=1200)
        assembled = system_msgs + [first_msg] + (
            [{"role": "user", "content": f"[... {pruned_count} older conversation turns compacted to optimize reasoning latency ...]"}]
            if pruned_count > 0 else []
        ) + compacted_middle + compacted_recent

    return assembled


def format_messages_to_prompt(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[Any] = None,
    max_prompt_chars: Optional[int] = None,
) -> str:
    """Format OpenAI/Anthropic messages list into a prompt string for CLI tools with auto-compaction."""
    if max_prompt_chars is None:
        try:
            max_prompt_chars = int(os.environ.get("ANTIGRAVITY_MAX_PROMPT_CHARS", "40000"))
        except Exception:
            max_prompt_chars = 40000

    parts: List[str] = []

    # Prepend tool descriptions and instructions if tools are provided
    if tools:
        tool_prompt = format_tools_to_system_prompt(tools, tool_choice=tool_choice)
        if tool_prompt:
            parts.append(tool_prompt)

    if not messages:
        return "\n\n".join(parts)

    compacted_messages = compact_messages(messages, max_total_chars=max_prompt_chars)

    if len(compacted_messages) == 1 and isinstance(compacted_messages[0], dict) and compacted_messages[0].get("role") == "user" and not tools:
        content = compacted_messages[0].get("content") or ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_items = []
            for c in content:
                if isinstance(c, dict):
                    if c.get("type") == "text":
                        text_items.append(c.get("text", ""))
                    elif c.get("type") == "tool_result":
                        res_content = c.get("content", "")
                        if isinstance(res_content, list):
                            res_content = "\n".join(
                                rc.get("text", "") for rc in res_content if isinstance(rc, dict) and rc.get("type") == "text"
                            )
                        text_items.append(f"[Tool '{c.get('tool_use_id', '')}' Result]:\n{res_content}")
            return "\n".join(text_items)

    for msg in compacted_messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "user")
        content = msg.get("content") or ""
        msg_tool_calls = msg.get("tool_calls")

        if isinstance(content, list):
            text_parts = []
            tool_call_parts = []
            for c in content:
                if not isinstance(c, dict):
                    continue
                c_type = c.get("type")
                if c_type == "text":
                    text_parts.append(c.get("text", ""))
                elif c_type == "tool_use":
                    tool_call_parts.append({
                        "name": c.get("name"),
                        "arguments": c.get("input", {}),
                        "id": c.get("id"),
                    })
                elif c_type == "tool_result":
                    res_content = c.get("content", "")
                    if isinstance(res_content, list):
                        res_content = "\n".join(
                            rc.get("text", "") for rc in res_content if isinstance(rc, dict) and rc.get("type") == "text"
                        )
                    text_parts.append(f"[Tool '{c.get('tool_use_id', '')}' Result]:\n{res_content}")
                elif c_type == "image":
                    text_parts.append("[Image attached]")
            content = "\n".join(text_parts)
            if tool_call_parts and not msg_tool_calls:
                msg_tool_calls = tool_call_parts
        elif not isinstance(content, str):
            content = str(content)

        if role == "system":
            parts.append(f"[System Instructions]\n{content}")
        elif role == "user":
            parts.append(f"[User]\n{content}")
        elif role == "assistant":
            tc_text = f"\nTool Calls: {json.dumps(msg_tool_calls, ensure_ascii=False)}" if msg_tool_calls else ""
            parts.append(f"[Assistant]\n{content}{tc_text}")
        elif role == "tool":
            parts.append(f"[Tool Result]\n{content}")
        else:
            parts.append(f"[{str(role).capitalize()}]\n{content}")

    return "\n\n".join(parts)


QUOTA_ERROR_PATTERNS = [
    re.compile(r"individual\s+quota", re.I),
    re.compile(r"upgrade\s+your\s+subscription", re.I),
    re.compile(r"resets?\s+in\s+", re.I),
    re.compile(r"quota\s*(reached|exceeded|exhausted|limit|capacity)", re.I),
    re.compile(r"resource_exhausted", re.I),
    re.compile(r"resourceexhausted", re.I),
    re.compile(r"rate\s*limit", re.I),
    re.compile(r"ratelimit", re.I),
    re.compile(r"too\s*many\s*requests", re.I),
    re.compile(r"\b429\b"),
    re.compile(r"insufficient_quota", re.I),
    re.compile(r"exceeded\s+your\s+current\s+quota", re.I),
    re.compile(r"out\s+of\s+credits?", re.I),
    re.compile(r"credit\s+balance", re.I),
    re.compile(r"capacity\s+error", re.I),
    re.compile(r"model\s+overloaded", re.I),
    re.compile(r"overloaded", re.I),
    re.compile(r"\b503\b.*unavailable", re.I),
    re.compile(r"temporarily\s+unavailable", re.I),
    re.compile(r"usage\s+limit", re.I),
    re.compile(r"per-minute\s+quota", re.I),
    re.compile(r"daily\s+quota", re.I),
]


def is_quota_or_rate_limit_error(error_msg: str) -> bool:
    """Check if an error string matches known quota or rate limit patterns."""
    if not error_msg:
        return False
    lower = error_msg.lower()
    if "resets in" in lower or "individual quota" in lower or "upgrade your subscription" in lower:
        return True
    if "quota reached" in lower or "quota exceeded" in lower or "quota limit" in lower:
        return True
    if "rate limit" in lower or "resource_exhausted" in lower or "resourceexhausted" in lower:
        return True
    for pat in QUOTA_ERROR_PATTERNS:
        if pat.search(error_msg):
            return True
    return False


def get_available_profiles() -> List[Optional[str]]:
    """Get list of available Antigravity / agy login profiles for fallback."""
    env_profiles = os.environ.get("ANTIGRAVITY_PROFILES", "").strip()
    if env_profiles:
        profiles = [p.strip() for p in env_profiles.split(",") if p.strip()]
        if profiles:
            return profiles

    cfg_file = os.path.expanduser("~/.config/antigravity/bridge_config.json")
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                configured = cfg.get("profiles")
                if configured and isinstance(configured, list) and len(configured) > 0:
                    return [str(p).strip() for p in configured if p]
        except Exception:
            pass

    profiles_dir = os.path.expanduser("~/.config/antigravity/profiles")
    if os.path.exists(profiles_dir) and os.path.isdir(profiles_dir):
        found = [
            d for d in sorted(os.listdir(profiles_dir))
            if os.path.isdir(os.path.join(profiles_dir, d))
            and not d.startswith(".")
            and not d.endswith(".disabled")
            and not d.endswith(".bak")
        ]
        if found:
            active = os.environ.get("ANTIGRAVITY_PROFILE", "").strip()
            if active and active in found:
                found.remove(active)
                found.insert(0, active)
            return found

    active = os.environ.get("ANTIGRAVITY_PROFILE", "").strip()
    return [active] if active else [None]


def parse_quota_reset_seconds(error_message: str) -> Optional[float]:
    """Extract exact cooldown duration in seconds from error message (e.g. 'Resets in 74h7m25s.', 'Resets in 19h 37m', 'Retry after 60s')."""
    if not error_message:
        return None

    # 1. Standard Google Gemini format: "Resets in 74h7m25s", "Resets in 88h27m35s", "Resets in 1d 2h 3m 4s"
    match = re.search(
        r"Resets?\s+in\s+(?:(\d+)\s*(?:d|days?)\s*)?(?:(\d+)\s*(?:h|hours?|hrs?)\s*)?(?:(\d+)\s*(?:m|minutes?|mins?)\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|seconds?|secs?)?)?",
        error_message,
        re.IGNORECASE,
    )
    if match and any(match.groups()):
        d_str, h_str, m_str, s_str = match.groups()
        total_sec = 0.0
        if d_str:
            total_sec += float(d_str) * 86400
        if h_str:
            total_sec += float(h_str) * 3600
        if m_str:
            total_sec += float(m_str) * 60
        if s_str:
            total_sec += float(s_str)
        if total_sec > 0:
            return total_sec

    # 2. Retry-After / Retry in N seconds
    retry_match = re.search(r"(?:retry[-_\s]*after|try\s+again\s+in|wait)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds|m|min|minutes|h|hours)?", error_message, re.IGNORECASE)
    if retry_match:
        val_str, unit_str = retry_match.groups()
        val = float(val_str)
        unit = (unit_str or "s").lower()
        if unit.startswith("h"):
            return val * 3600
        elif unit.startswith("m"):
            return val * 60
        return val

    return None


def format_cooldown_duration(seconds: float) -> str:
    """Format seconds into human-readable duration (e.g. '74h 7m 25s', '12m 30s', '45s')."""
    if seconds <= 0:
        return "ready"
    s = int(seconds)
    days = s // 86400
    hours = (s % 86400) // 3600
    minutes = (s % 3600) // 60
    secs = s % 60
    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0:
        parts.append(f"{minutes}m")
    if secs > 0 or not parts:
        parts.append(f"{secs}s")
    return " ".join(parts)


def get_disabled_profiles() -> Set[str]:
    """Get set of profiles configured to be permanently disabled."""
    disabled: Set[str] = set()
    env_val = os.environ.get("ANTIGRAVITY_DISABLED_PROFILES", "").strip()
    if env_val:
        disabled.update(p.strip() for p in env_val.split(",") if p.strip())

    cfg_file = os.path.expanduser("~/.config/antigravity/bridge_config.json")
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                raw = cfg.get("disabled_profiles")
                if raw is None:
                    raw = cfg.get("disabled")
                if isinstance(raw, list):
                    disabled.update(str(p).strip() for p in raw if p)
                elif isinstance(raw, str):
                    disabled.update(p.strip() for p in raw.split(",") if p.strip())
        except Exception:
            pass
    return disabled


def persist_disabled_profile(profile: str, disabled: bool = True) -> None:
    """Persist or remove a profile from ~/.config/antigravity/bridge_config.json disabled_profiles list."""
    if not profile:
        return
    cfg_file = os.path.expanduser("~/.config/antigravity/bridge_config.json")
    try:
        data: Dict[str, Any] = {}
        if os.path.exists(cfg_file):
            try:
                with open(cfg_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                data = {}
        if not isinstance(data, dict):
            data = {}

        dis_list = data.get("disabled_profiles")
        if dis_list is None:
            dis_list = data.get("disabled", [])
        if not isinstance(dis_list, list):
            dis_list = [str(dis_list)] if dis_list else []
        dis_set = set(str(p).strip() for p in dis_list if p)

        if disabled:
            dis_set.add(profile.strip())
        else:
            dis_set.discard(profile.strip())

        data["disabled_profiles"] = sorted(list(dis_set))
        os.makedirs(os.path.dirname(cfg_file), exist_ok=True)
        with open(cfg_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as exc:
        logger.warning("Failed to persist disabled profile '%s' to %s: %s", profile, cfg_file, exc)


class ProfileManager:
    """Thread-safe manager for tracking profile quota states, cooldowns, and smart routing."""

    def __init__(
        self,
        profiles: Optional[List[Optional[str]]] = None,
        cache_file: str = DEFAULT_QUOTA_CACHE_FILE,
        default_cooldown: float = 300.0,
        max_cooldown: float = 1800.0,
        concurrency_per_profile: int = 1,
    ):
        self.cache_file = os.path.expanduser(cache_file)
        self.default_cooldown = default_cooldown
        self.max_cooldown = max_cooldown
        self.concurrency_per_profile = max(1, int(concurrency_per_profile))
        self.lock = threading.Lock()
        self.current_idx = 0
        self._profiles: List[Optional[str]] = profiles if profiles is not None else get_available_profiles()
        self.state: Dict[str, Dict[str, Any]] = {}
        self.in_flight: Dict[str, int] = {}
        self.load_cache()

    def set_profiles(self, profiles: List[Optional[str]]) -> None:
        """Update active profile list while preserving state and enforcing disabled state."""
        with self.lock:
            self._profiles = list(profiles)
            disabled_set = get_disabled_profiles()
            for p in self._profiles:
                key = p or "default"
                if key not in self.in_flight:
                    self.in_flight[key] = 0
                if key not in self.state:
                    is_dis = key in disabled_set
                    self.state[key] = {
                        "status": "DISABLED" if is_dis else "OK",
                        "exhausted_until": int(time.time() + 315360000) if is_dis else 0,
                        "last_checked": 0,
                        "last_used": 0,
                        "last_reason": "Configured as permanently disabled" if is_dis else "",
                        "consecutive_errors": 0,
                        "success_count": 0,
                        "window_requests": 0,
                        "window_start": 0,
                    }

    def load_cache(self) -> None:
        """Load cached quota states from disk and enforce persistent disabled states."""
        with self.lock:
            disabled_set = get_disabled_profiles()
            for p in self._profiles:
                key = p or "default"
                if key not in self.in_flight:
                    self.in_flight[key] = 0
                if key not in self.state:
                    is_dis = key in disabled_set
                    self.state[key] = {
                        "status": "DISABLED" if is_dis else "OK",
                        "exhausted_until": int(time.time() + 315360000) if is_dis else 0,
                        "last_checked": 0,
                        "last_used": 0,
                        "last_reason": "Configured as permanently disabled" if is_dis else "",
                        "consecutive_errors": 0,
                        "success_count": 0,
                        "window_requests": 0,
                        "window_start": 0,
                    }

            if os.path.exists(self.cache_file) and os.path.getsize(self.cache_file) > 0:
                try:
                    with open(self.cache_file, "r", encoding="utf-8") as f:
                        saved = json.load(f)
                    if isinstance(saved, dict):
                        for k, v in saved.items():
                            if isinstance(v, dict):
                                if k not in self.state:
                                    self.state[k] = {
                                        "status": "OK",
                                        "exhausted_until": 0,
                                        "last_checked": 0,
                                        "last_used": 0,
                                        "last_reason": "",
                                        "consecutive_errors": 0,
                                        "success_count": 0,
                                        "window_requests": 0,
                                        "window_start": 0,
                                    }
                                self.state[k].update(v)
                except Exception as exc:
                    logger.warning("Failed to load quota cache from %s: %s", self.cache_file, exc)

            # Enforce persistent disabled profiles from config / env
            for dis_k in disabled_set:
                if dis_k in self.state:
                    self.state[dis_k]["status"] = "DISABLED"
                    self.state[dis_k]["exhausted_until"] = max(
                        self.state[dis_k].get("exhausted_until", 0),
                        int(time.time() + 315360000),
                    )
                    if not self.state[dis_k].get("last_reason"):
                        self.state[dis_k]["last_reason"] = "Configured as permanently disabled"

    def save_cache(self) -> None:
        """Persist quota states to disk atomically."""
        try:
            cache_dir = os.path.dirname(os.path.abspath(self.cache_file))
            if cache_dir:
                os.makedirs(cache_dir, exist_ok=True)
            tmp_file = f"{self.cache_file}.tmp.{os.getpid()}"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(self.state, f, indent=2)
            os.replace(tmp_file, self.cache_file)
        except Exception as exc:
            logger.warning("Failed to save quota cache to %s: %s", self.cache_file, exc)

    def is_in_cooldown(self, profile: Optional[str]) -> bool:
        """Check if a profile is currently in cooldown."""
        key = profile or "default"
        info = self.state.get(key, {})
        exhausted_until = info.get("exhausted_until", 0)
        return time.time() < exhausted_until

    def mark_exhausted(
        self,
        profile: Optional[str],
        reason: str,
        cooldown_seconds: Optional[float] = None,
        duration: Optional[float] = None,
    ) -> None:
        """Mark a profile as exhausted and enter cooldown with exponential backoff or exact reset time."""
        if cooldown_seconds is None and duration is not None:
            cooldown_seconds = duration

        key = profile or "default"
        now = time.time()
        with self.lock:
            if key not in self.state:
                self.state[key] = {
                    "status": "OK",
                    "exhausted_until": 0,
                    "last_checked": 0,
                    "last_used": 0,
                    "last_reason": "",
                    "consecutive_errors": 0,
                    "success_count": 0,
                }
            err_count = self.state[key].get("consecutive_errors", 0) + 1
            self.state[key]["consecutive_errors"] = err_count

            if cooldown_seconds is None:
                parsed_cooldown = parse_quota_reset_seconds(reason)
                if parsed_cooldown:
                    duration = parsed_cooldown
                else:
                    multiplier = min(2 ** (err_count - 1), 8)
                    duration = min(self.default_cooldown * multiplier, self.max_cooldown)
            else:
                duration = cooldown_seconds

            self.state[key]["status"] = "EXHAUSTED"
            self.state[key]["exhausted_until"] = int(now + duration)
            self.state[key]["last_checked"] = int(now)
            self.state[key]["last_reason"] = reason
            self.state[key]["window_requests"] = DEFAULT_FLASH_QUOTA_CAPACITY
            self.save_cache()

        logger.warning(
            "[QUOTA EXHAUSTED] Profile '%s' marked EXHAUSTED for %ds (until %s). Reason: %s",
            key,
            int(duration),
            time.strftime("%H:%M:%S", time.localtime(now + duration)),
            reason[:120],
        )

    def mark_error(self, profile: Optional[str], reason: str) -> None:
        """Mark general error (e.g. timeout or non-quota CLI failure)."""
        key = profile or "default"
        now = time.time()
        with self.lock:
            if key not in self.state:
                self.state[key] = {
                    "status": "OK",
                    "exhausted_until": 0,
                    "last_checked": 0,
                    "last_used": 0,
                    "last_reason": "",
                    "consecutive_errors": 0,
                    "success_count": 0,
                    "window_requests": 0,
                    "window_start": 0,
                }
            err_count = self.state[key].get("consecutive_errors", 0) + 1
            self.state[key]["consecutive_errors"] = err_count
            self.state[key]["last_checked"] = int(now)
            self.state[key]["last_reason"] = reason

            # Apply short temporary backoff (30s on 1st error, exponential up to max_cooldown) so healthy profiles get prioritized
            duration = min(30.0 * (2 ** (err_count - 1)), self.max_cooldown)
            self.state[key]["status"] = "ERROR_COOLDOWN"
            self.state[key]["exhausted_until"] = int(now + duration)
            self.save_cache()

    def mark_success(self, profile: Optional[str]) -> None:
        """Mark profile execution success, update window counters and reset error count."""
        key = profile or "default"
        now = time.time()
        with self.lock:
            if key not in self.state:
                self.state[key] = {
                    "status": "OK",
                    "exhausted_until": 0,
                    "last_checked": 0,
                    "last_used": 0,
                    "last_reason": "",
                    "consecutive_errors": 0,
                    "success_count": 0,
                    "window_requests": 0,
                    "window_start": 0,
                }
            self.state[key]["status"] = "OK"
            self.state[key]["exhausted_until"] = 0
            self.state[key]["consecutive_errors"] = 0
            self.state[key]["success_count"] = self.state[key].get("success_count", 0) + 1

            w_start = self.state[key].get("window_start", 0)
            if now - w_start > DEFAULT_QUOTA_WINDOW_SECONDS:
                self.state[key]["window_start"] = int(now)
                self.state[key]["window_requests"] = 1
            else:
                self.state[key]["window_requests"] = self.state[key].get("window_requests", 0) + 1

            self.state[key]["last_used"] = int(now)
            self.state[key]["last_checked"] = int(now)
            self.save_cache()

    def mark_disabled(
        self,
        profile: Optional[str],
        reason: str = "Manually disabled by user",
        persist: bool = True,
    ) -> None:
        """Manually disable a profile indefinitely until re-enabled."""
        key = profile or "default"
        with self.lock:
            if key not in self.state:
                self.state[key] = {
                    "status": "OK",
                    "exhausted_until": 0,
                    "last_checked": 0,
                    "last_used": 0,
                    "last_reason": "",
                    "consecutive_errors": 0,
                    "success_count": 0,
                    "window_requests": 0,
                    "window_start": 0,
                }
            self.state[key]["status"] = "DISABLED"
            self.state[key]["exhausted_until"] = int(time.time() + 315360000)  # 10 years
            self.state[key]["last_reason"] = reason
            self.save_cache()
        if persist and profile:
            persist_disabled_profile(profile, disabled=True)
        logger.info("Profile '%s' has been DISABLED manually (persisted).", key)

    def enable(self, profile: Optional[str]) -> None:
        """Re-enable a disabled profile or reset cooldown."""
        if profile:
            persist_disabled_profile(profile, disabled=False)
        self.reset_all(profile)
        logger.info("Profile '%s' has been ENABLED.", profile or "all")

    def reset_all(self, profile: Optional[str] = None) -> None:
        """Reset cooldown, error states, and session quota window for a given profile or all profiles."""
        now = time.time()
        with self.lock:
            if profile:
                key = profile
                if key in self.state:
                    self.state[key]["status"] = "OK"
                    self.state[key]["exhausted_until"] = 0
                    self.state[key]["consecutive_errors"] = 0
                    self.state[key]["window_requests"] = 0
                    self.state[key]["window_start"] = int(now)
            else:
                for k in self.state:
                    # Do NOT reset manually disabled profiles during bulk reset
                    if self.state[k].get("status") == "DISABLED":
                        continue
                    self.state[k]["status"] = "OK"
                    self.state[k]["exhausted_until"] = 0
                    self.state[k]["consecutive_errors"] = 0
                    self.state[k]["window_requests"] = 0
                    self.state[k]["window_start"] = int(now)
            self.save_cache()

    def get_ordered_profiles(self) -> List[Optional[str]]:
        """Return candidate profiles ordered by availability:
        1. Ready / Healthy profiles (authenticated & not in cooldown), rotated round-robin.
        2. Recovering profiles (cooldown timestamp expired).
        3. Exhausted profiles (sorted by earliest cooldown expiration).
        4. Unauthenticated profiles (last resort).
        """
        now = time.time()
        with self.lock:
            profiles = list(self._profiles)
            ready: List[Optional[str]] = []
            recovering: List[Optional[str]] = []
            exhausted: List[Tuple[float, Optional[str]]] = []
            unauthenticated: List[Optional[str]] = []

            for p in profiles:
                key = p or "default"
                info = self.state.get(key, {})
                status = info.get("status", "OK")
                if status == "DISABLED":
                    continue

                exhausted_until = info.get("exhausted_until", 0)
                if exhausted_until > 0 and now < exhausted_until:
                    exhausted.append((exhausted_until, p))
                    continue

                # Filter unauthenticated profiles so they don't block healthy profiles
                email = get_profile_account_email(p)
                if email == "Not Logged In" and p is not None and not info.get("success_count", 0):
                    unauthenticated.append(p)
                    continue

                if status in ("EXHAUSTED", "RATE_LIMITED", "ERROR_COOLDOWN"):
                    recovering.append(p)
                else:
                    ready.append(p)

            # Round-robin among ready profiles
            if ready:
                idx = self.current_idx % len(ready)
                ready = ready[idx:] + ready[:idx]
                self.current_idx = (idx + 1) % len(ready)

            # Exhausted profiles sorted by earliest cooldown expiration
            exhausted.sort(key=lambda x: x[0])
            exhausted_profiles = [p for _, p in exhausted]

            # Complete prioritized fallback chain across ALL configured profiles:
            # 1. Ready & healthy profiles (rotated round-robin)
            # 2. Recovering profiles (cooldown expired / temporary error backoff)
            # 3. Unauthenticated / untested profiles
            # 4. Exhausted profiles (last resort fallback, earliest reset first)
            all_ordered = ready + recovering + unauthenticated + exhausted_profiles
            return all_ordered if all_ordered else [None]

    def acquire_profile(self, candidates: Optional[List[Optional[str]]] = None) -> Optional[str]:
        """Atomically select and acquire an idle/available candidate profile with free in-flight lease."""
        with self.lock:
            target_list = list(candidates) if candidates is not None else self.get_ordered_profiles()
            now = time.time()
            # 1. Prefer ready candidates where in_flight < concurrency_per_profile
            available = [
                p for p in target_list
                if self.in_flight.get(p or "default", 0) < self.concurrency_per_profile
                and self.state.get(p or "default", {}).get("status") != "DISABLED"
                and (self.state.get(p or "default", {}).get("exhausted_until", 0) == 0 or now >= self.state.get(p or "default", {}).get("exhausted_until", 0))
            ]
            if available:
                if candidates is not None:
                    chosen = available[0]
                else:
                    chosen = available[self.current_idx % len(available)]
                    self.current_idx = (self.current_idx + 1) % len(available)
                key = chosen or "default"
                self.in_flight[key] = self.in_flight.get(key, 0) + 1
                return chosen

            # 2. Fallback to recovering/exhausted candidates if free in-flight capacity
            recovering_available = [
                p for p in target_list
                if self.in_flight.get(p or "default", 0) < self.concurrency_per_profile
                and self.state.get(p or "default", {}).get("status") != "DISABLED"
            ]
            if recovering_available:
                chosen = recovering_available[0]
                key = chosen or "default"
                self.in_flight[key] = self.in_flight.get(key, 0) + 1
                return chosen

            return None

    def acquire_specific_profile(self, profile: Optional[str]) -> None:
        """Increment in-flight count for a specific profile."""
        with self.lock:
            key = profile or "default"
            self.in_flight[key] = self.in_flight.get(key, 0) + 1

    def release_profile(self, profile: Optional[str]) -> None:
        """Atomically release an in-flight lease for a profile."""
        with self.lock:
            key = profile or "default"
            if key in self.in_flight:
                self.in_flight[key] = max(0, self.in_flight[key] - 1)

    def get_in_flight(self, profile: Optional[str]) -> int:
        """Get current in-flight count for a profile."""
        with self.lock:
            return self.in_flight.get(profile or "default", 0)

    def get_total_in_flight(self) -> int:
        """Get total in-flight requests across all profiles."""
        with self.lock:
            return sum(self.in_flight.values())

    def get_estimated_quota_percent(self, profile: Optional[str]) -> int:
        """Calculate rough remaining quota % (0-100%) based on Gemini Flash session budget."""
        key = profile or "default"
        info = self.state.get(key, {})
        status = info.get("status", "OK")
        if status == "DISABLED":
            return 0
        now = time.time()
        ex_until = info.get("exhausted_until", 0)
        if ex_until > now:
            return 0
        w_start = info.get("window_start", 0)
        if now - w_start > DEFAULT_QUOTA_WINDOW_SECONDS:
            return 100
        reqs = info.get("window_requests", 0)
        used_ratio = min(1.0, reqs / float(DEFAULT_FLASH_QUOTA_CAPACITY))
        # Keep between 5% and 100% when active, 0% when exhausted
        pct = max(5, int((1.0 - used_ratio) * 100))
        return pct

    def get_status_summary(self) -> Dict[str, Any]:
        """Return full status summary of all profiles including quota percentage and concurrency metrics."""
        now = time.time()
        with self.lock:
            res: Dict[str, Any] = {}
            for p in self._profiles:
                key = p or "default"
                info = dict(self.state.get(key, {}))
                exhausted_until = info.get("exhausted_until", 0)
                cooldown_left = max(0, int(exhausted_until - now))
                is_avail = (cooldown_left == 0 and info.get("status") != "DISABLED")
                info["available"] = is_avail
                info["cooldown_seconds_remaining"] = cooldown_left
                info["in_flight"] = self.in_flight.get(key, 0)
                info["max_concurrency"] = self.concurrency_per_profile

                if info.get("status") == "DISABLED" or cooldown_left > 0:
                    quota_pct = 0
                else:
                    w_start = info.get("window_start", 0)
                    if now - w_start > DEFAULT_QUOTA_WINDOW_SECONDS:
                        quota_pct = 100
                    else:
                        reqs = info.get("window_requests", 0)
                        quota_pct = max(5, int((1.0 - min(1.0, reqs / float(DEFAULT_FLASH_QUOTA_CAPACITY))) * 100))
                info["estimated_quota_percent"] = quota_pct
                res[key] = info
            return res

    def build_profile_quota_banner(self, used_profile: Optional[str] = None) -> str:
        """Build a clean, informative markdown footer showing active profile, account, estimated quota %, and quota pool status."""
        now = time.time()
        with self.lock:
            key = used_profile or "default"
            email = get_profile_account_email(used_profile)
            email_info = f" (`{email}`)" if email and email != "Not Logged In" else ""
            stat = self.state.get(key, {})
            succ = stat.get("success_count", 0)

            # Profile quota %
            quota_pct = self.get_estimated_quota_percent(used_profile)

            total_profiles = list(self._profiles)
            total_count = len(total_profiles)

            ready_list: List[str] = []
            cooldown_list: List[Tuple[str, int]] = []
            disabled_list: List[str] = []

            for p in total_profiles:
                pk = p or "default"
                info = self.state.get(pk, {})
                st = info.get("status", "OK")
                if st == "DISABLED":
                    disabled_list.append(pk)
                    continue
                ex_until = info.get("exhausted_until", 0)
                if ex_until > now:
                    rem = int(ex_until - now)
                    cooldown_list.append((pk, rem))
                else:
                    ready_list.append(pk)

            enabled_count = max(1, total_count - len(disabled_list))
            ready_count = len(ready_list)
            pool_pct = int((ready_count / float(enabled_count)) * 100) if enabled_count > 0 else 0

            lines = [
                "",
                "---",
                f"> ⚡ **Antigravity Profile:** `{key}`{email_info} | 🔋 **Quota:** ~**{quota_pct}%** (Flash Est.)",
            ]

            if total_count > 1:
                pool_parts = [f"🟢 **{ready_count}/{enabled_count}** Ready (**{pool_pct}%** Capacity)"]
                if cooldown_list:
                    pool_parts.append(f"🔴 **{len(cooldown_list)}** in Cooldown")
                if disabled_list:
                    pool_parts.append(f"⚪ **{len(disabled_list)}** Disabled")
                lines.append(f"> 📊 **Quota Pool:** {' • '.join(pool_parts)}")
                if cooldown_list:
                    cd_items = [f"`{p}` (⏳ {format_cooldown_duration(rem)})" for p, rem in sorted(cooldown_list, key=lambda x: x[1])]
                    lines.append(f"> ⏳ **In Cooldown:** {', '.join(cd_items)}")
            else:
                status_desc = "🟢 Ready" if key in ready_list else "🔴 In Cooldown"
                lines.append(f"> 📊 **Quota Status:** {status_desc} (~{quota_pct}%)")

            return "\n".join(lines)


GLOBAL_PROFILE_MANAGER = ProfileManager()


def get_os_type() -> str:
    """Return normalized OS string: 'darwin', 'linux', or 'windows'."""
    if sys.platform == "darwin":
        return "darwin"
    elif sys.platform.startswith("linux"):
        return "linux"
    elif sys.platform in ("win32", "cygwin"):
        return "windows"
    return sys.platform


def get_auth_sync_directories() -> List[str]:
    """Return all directories where agy or antigravity reads/writes auth files based on the OS."""
    os_type = get_os_type()
    dirs = [
        os.path.expanduser("~/.gemini"),
        os.path.expanduser("~/.gemini/antigravity-cli"),
        os.path.expanduser("~/.config/antigravity"),
        os.path.expanduser("~/.config/gemini"),
    ]
    if os_type == "darwin":
        dirs.append(os.path.expanduser("~/Library/Application Support/Antigravity"))
    elif os_type == "windows":
        user_profile = os.environ.get("USERPROFILE", os.path.expanduser("~"))
        app_data = os.environ.get("APPDATA", os.path.join(user_profile, "AppData", "Roaming"))
        local_app_data = os.environ.get("LOCALAPPDATA", os.path.join(user_profile, "AppData", "Local"))
        dirs.extend([
            os.path.join(user_profile, ".gemini"),
            os.path.join(user_profile, ".gemini", "antigravity-cli"),
            os.path.join(app_data, "antigravity"),
            os.path.join(local_app_data, "antigravity"),
        ])
    seen = set()
    result = []
    for d in dirs:
        norm = os.path.abspath(d)
        if norm not in seen:
            seen.add(norm)
            result.append(d)
    return result


def inject_os_keyring_token(raw_oauth_str: str) -> bool:
    """Inject OAuth token into OS-specific Keyring (macOS Keychain, Linux secret-tool, etc.)."""
    os_type = get_os_type()
    b64_val = "go-keyring-base64:" + base64.b64encode(raw_oauth_str.encode("utf-8")).decode("utf-8")

    if os_type == "darwin":
        try:
            res = subprocess.call(
                ["security", "add-generic-password", "-U", "-s", "gemini", "-a", "antigravity", "-w", b64_val],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return res == 0
        except Exception as e:
            logger.debug("macOS Keychain injection error: %s", e)
            return False

    elif os_type == "linux":
        if shutil.which("secret-tool"):
            try:
                p = subprocess.Popen(
                    ["secret-tool", "store", "--label=Antigravity", "service", "gemini", "account", "antigravity"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                p.communicate(input=b64_val.encode("utf-8"), timeout=2.0)
                return p.returncode == 0
            except Exception as e:
                logger.debug("Linux secret-tool injection error: %s", e)
                return False
    return False


def extract_os_keyring_token() -> Optional[Dict[str, Any]]:
    """Extract OAuth token from OS-specific Keyring (macOS Keychain, Linux secret-tool, etc.)."""
    os_type = get_os_type()
    if os_type == "darwin":
        try:
            out = subprocess.check_output(
                ["security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
                stderr=subprocess.DEVNULL,
            ).decode("utf-8").strip()
            if out.startswith("go-keyring-base64:"):
                raw_b64 = out[len("go-keyring-base64:"):]
                return json.loads(base64.b64decode(raw_b64).decode("utf-8"))
        except Exception as exc:
            logger.debug("macOS Keychain extraction error: %s", exc)
    elif os_type == "linux":
        if shutil.which("secret-tool"):
            try:
                out = subprocess.check_output(
                    ["secret-tool", "lookup", "service", "gemini", "account", "antigravity"],
                    stderr=subprocess.DEVNULL,
                ).decode("utf-8").strip()
                if out.startswith("go-keyring-base64:"):
                    raw_b64 = out[len("go-keyring-base64:"):]
                    return json.loads(base64.b64decode(raw_b64).decode("utf-8"))
            except Exception as exc:
                logger.debug("Linux secret-tool lookup error: %s", exc)
    return None


def extract_os_file_token() -> Optional[Dict[str, Any]]:
    """Extract OAuth token from OS filesystem fallbacks (antigravity-oauth-token or oauth_creds.json)."""
    sync_dirs = get_auth_sync_directories()
    for td in sync_dirs:
        tok_file = os.path.join(td, "antigravity-oauth-token")
        if os.path.exists(tok_file):
            try:
                with open(tok_file, "r", encoding="utf-8") as f:
                    d = json.load(f)
                    tok = d.get("token") or d
                    if tok.get("access_token") or tok.get("refresh_token"):
                        return d
            except Exception:
                pass

        oauth_file = os.path.join(td, "oauth_creds.json")
        if os.path.exists(oauth_file):
            try:
                with open(oauth_file, "r", encoding="utf-8") as f:
                    d = json.load(f)
                    tok = d.get("token") or d
                    if tok.get("access_token") or tok.get("refresh_token"):
                        return d
            except Exception:
                pass
    return None


def sync_profile_to_system(profile_name: str) -> Tuple[str, str]:
    """Sync active profile credentials to all OS-specific auth directories and system keyrings."""
    profile_dir = os.path.expanduser(f"~/.config/antigravity/profiles/{profile_name}")
    if not os.path.exists(profile_dir):
        alt_dir = os.path.expanduser(f"~/.config/antigravity/{profile_name}")
        if os.path.exists(alt_dir) and os.path.isdir(alt_dir):
            profile_dir = alt_dir

    token_preview = "N/A"
    email_preview = "N/A"

    if not os.path.exists(profile_dir) or not os.path.isdir(profile_dir):
        return email_preview, token_preview

    target_dirs = get_auth_sync_directories()
    for td in target_dirs:
        os.makedirs(td, exist_ok=True)

    # 1. Copy JSON & token files
    for f in ("oauth_creds.json", "google_accounts.json", "state.json", "settings.json", "antigravity-oauth-token"):
        src = os.path.join(profile_dir, f)
        if os.path.exists(src):
            for td in target_dirs:
                dst = os.path.join(td, f)
                if os.path.abspath(src) != os.path.abspath(dst):
                    try:
                        shutil.copy2(src, dst)
                    except Exception as e:
                        logger.debug("Failed copying %s to %s: %s", src, dst, e)

            if f == "google_accounts.json":
                try:
                    with open(src, "r", encoding="utf-8") as g_file:
                        g_data = json.load(g_file)
                        email_preview = g_data.get("active", "unknown")
                except Exception:
                    pass
            elif f == "oauth_creds.json":
                try:
                    with open(src, "r", encoding="utf-8") as o_file:
                        o_data = json.load(o_file)
                        t = o_data.get("access_token") or (o_data.get("token", {}).get("access_token") if isinstance(o_data.get("token"), dict) else "")
                        if t:
                            token_preview = f"{t[:12]}...{t[-6:]}" if len(t) > 20 else t
                except Exception:
                    pass

    # 2. Generate and write antigravity-oauth-token (fallback for headless Linux)
    oauth_file = os.path.join(profile_dir, "oauth_creds.json")
    if os.path.exists(oauth_file):
        try:
            with open(oauth_file, "r", encoding="utf-8") as o_f:
                raw_content = o_f.read()
                o_data = json.loads(raw_content)

            raw_tok = o_data.get("token") if isinstance(o_data.get("token"), dict) else o_data
            auth_meth = o_data.get("auth_method", "consumer")
            token_obj = {
                "token": {
                    "access_token": raw_tok.get("access_token", ""),
                    "token_type": raw_tok.get("token_type", "Bearer"),
                    "refresh_token": raw_tok.get("refresh_token", ""),
                    "expiry": raw_tok.get("expiry", "2026-08-18T23:59:59+07:00"),
                },
                "auth_method": auth_meth,
            }
            tok_json_str = json.dumps(token_obj)
            for td in target_dirs:
                try:
                    with open(os.path.join(td, "antigravity-oauth-token"), "w", encoding="utf-8") as aot_f:
                        aot_f.write(tok_json_str)
                except Exception:
                    pass

            # 3. Inject into system Keyring / macOS Keychain
            inject_os_keyring_token(raw_content)
        except Exception as e:
            logger.debug("Failed preparing tokens for sync: %s", e)

    # 4. Clean stale conversations / projects cache
    for sf in (
        "default-cli-project.json", "default_project_id.txt", "jetski_state.pbtxt",
        "conversation_summaries.db", "history.jsonl"
    ):
        src_sf = os.path.join(profile_dir, sf)
        for td in target_dirs:
            dst_sf = os.path.join(td, sf)
            if os.path.abspath(src_sf) != os.path.abspath(dst_sf):
                if os.path.exists(src_sf):
                    try:
                        shutil.copy2(src_sf, dst_sf)
                    except Exception:
                        pass
                elif os.path.exists(dst_sf):
                    try:
                        os.remove(dst_sf)
                    except Exception:
                        pass

    return email_preview, token_preview


def refresh_profile_token(profile: Optional[str], agy_exec: Optional[str] = None) -> Tuple[bool, str]:
    """Actively refresh OAuth access token for a profile using its refresh token."""
    p = profile
    p_dir = os.path.expanduser(f"~/.config/antigravity/profiles/{p}") if p else os.path.expanduser("~/.gemini")
    if p and not os.path.exists(p_dir):
        alt = os.path.expanduser(f"~/.config/antigravity/{p}")
        if os.path.exists(alt):
            p_dir = alt

    oauth_file = os.path.join(p_dir, "oauth_creds.json")
    if not os.path.exists(oauth_file):
        return False, f"oauth_creds.json missing at {p_dir}"

    try:
        with open(oauth_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, f"Failed reading {oauth_file}: {e}"

    refresh_tok = data.get("refresh_token") or (data.get("token", {}).get("refresh_token") if isinstance(data.get("token"), dict) else None)
    if not refresh_tok:
        return False, "refresh_token is missing"

    if agy_exec is None:
        cli_bin, _ = detect_cli_command()
        agy_exec = cli_bin if os.path.isabs(cli_bin) else shutil.which("agy") or "agy"

    if sys.platform == "darwin":
        keyring_payload = {
            "token": {
                "access_token": "",
                "refresh_token": refresh_tok,
                "token_type": "Bearer",
                "expiry": "2020-01-01T00:00:00Z"
            },
            "auth_method": "consumer"
        }
        b64_val = "go-keyring-base64:" + base64.b64encode(json.dumps(keyring_payload).encode()).decode()
        subprocess.call(["security", "add-generic-password", "-U", "-s", "gemini", "-a", "antigravity", "-w", b64_val])

        # Execute agy to trigger Google auto-refresh
        subprocess.call([agy_exec, "--dangerously-skip-permissions", "-p", "hi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        try:
            out = subprocess.check_output(["security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"]).decode().strip()
            raw = out.replace("go-keyring-base64:", "")
            fresh_d = json.loads(base64.b64decode(raw).decode())
            new_access_tok = fresh_d.get("token", {}).get("access_token") or fresh_d.get("access_token")
            exp = fresh_d.get("token", {}).get("expiry", "")
            if new_access_tok:
                data["access_token"] = new_access_tok
                if "token" in data and isinstance(data["token"], dict):
                    data["token"]["access_token"] = new_access_tok
                    data["token"]["expiry"] = exp
                with open(oauth_file, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
                with open(os.path.join(p_dir, "antigravity-oauth-token"), "w", encoding="utf-8") as f:
                    json.dump({"token": data.get("token", data), "auth_method": data.get("auth_method", "consumer")}, f, indent=2)
                return True, f"New Access Token generated (expires {exp})"
            else:
                return False, "Google rejected refresh_token (account may need re-login)"
        except Exception as e:
            return False, f"Keyring error: {e}"
    else:
        # Linux & Windows OS handling: Prepare expired token payload in antigravity-oauth-token
        fallback_payload = {
            "token": {
                "access_token": "",
                "refresh_token": refresh_tok,
                "token_type": "Bearer",
                "expiry": "2020-01-01T00:00:00Z"
            },
            "auth_method": "consumer"
        }
        for td in get_auth_sync_directories():
            os.makedirs(td, exist_ok=True)
            try:
                with open(os.path.join(td, "antigravity-oauth-token"), "w", encoding="utf-8") as a_f:
                    json.dump(fallback_payload, a_f)
            except Exception:
                pass

        # Execute agy to trigger Google auto-refresh
        subprocess.call([agy_exec, "--dangerously-skip-permissions", "-p", "hi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        token_found = False
        for td in get_auth_sync_directories():
            tok_path = os.path.join(td, "antigravity-oauth-token")
            if os.path.exists(tok_path):
                try:
                    with open(tok_path, "r", encoding="utf-8") as tf:
                        fresh_d = json.load(tf)
                    new_access_tok = fresh_d.get("token", {}).get("access_token") or fresh_d.get("access_token")
                    exp = fresh_d.get("token", {}).get("expiry", "")
                    if new_access_tok:
                        data["access_token"] = new_access_tok
                        if "token" in data and isinstance(data["token"], dict):
                            data["token"]["access_token"] = new_access_tok
                            data["token"]["expiry"] = exp
                        with open(oauth_file, "w", encoding="utf-8") as f:
                            json.dump(data, f, indent=2)
                        with open(os.path.join(p_dir, "antigravity-oauth-token"), "w", encoding="utf-8") as f:
                            json.dump({"token": data.get("token", data), "auth_method": data.get("auth_method", "consumer")}, f, indent=2)
                        return True, f"New Access Token generated (expires {exp})"
                except Exception:
                    pass

        return True, "Token refresh executed via agy"


def start_token_refresh_daemon(
    server: Any,
    interval_seconds: float = 3300.0,
    initial_delay: Optional[float] = None,
) -> Optional[threading.Thread]:
    """Start background worker thread that automatically refreshes OAuth tokens for all profiles every 55 minutes."""
    if interval_seconds <= 0:
        return None

    shutdown_event = getattr(server, "_shutdown_event", None)
    if shutdown_event is None:
        shutdown_event = threading.Event()
        server._shutdown_event = shutdown_event

    def _worker():
        interval_min = int(interval_seconds // 60)
        logger.info("Background OAuth Token Auto-Refresher started (interval: %d min)", interval_min)

        # Wait initial delay or full interval before first background refresh
        first_wait = initial_delay if initial_delay is not None else interval_seconds
        if shutdown_event.wait(timeout=first_wait):
            return

        while not shutdown_event.is_set():
            try:
                profiles = list(getattr(server, "profiles", []))
                if not profiles:
                    profiles = get_available_profiles()
                logger.info("[AUTO-REFRESH] ⏰ Starting scheduled %d-minute OAuth token refresh for %d profile(s)...", interval_min, len(profiles))
                succ = 0
                for p in profiles:
                    ok, msg = refresh_profile_token(p)
                    if ok:
                        succ += 1
                        logger.info("[AUTO-REFRESH] Profile '%s': %s", p or "default", msg)
                    else:
                        logger.warning("[AUTO-REFRESH] Profile '%s' refresh failed: %s", p or "default", msg)
                logger.info("[AUTO-REFRESH] Scheduled refresh completed (%d/%d profiles refreshed successfully).", succ, len(profiles))
            except Exception as exc:
                logger.error("[AUTO-REFRESH] Error during scheduled token refresh: %s", exc)

            if shutdown_event.wait(timeout=interval_seconds):
                break

    thread = threading.Thread(target=_worker, name="TokenRefreshDaemon", daemon=True)
    thread.start()
    return thread


def probe_profile(
    profile: Optional[str],
    cmd_template: Optional[str] = None,
    model_name: Optional[str] = None,
    timeout: float = 35.0,
    prompt: Optional[str] = None,
) -> Tuple[bool, str, str]:
    """Perform a realistic active health check (probe) for a profile by generating real response tokens."""
    _, default_tpl = detect_cli_command()
    tpl = cmd_template or default_tpl
    test_prompt = prompt or (
        "Explain in 2 clear bullet points why Fibonacci series with memoization is O(N) time complexity."
    )
    try:
        start_t = time.time()
        output = execute_cli_command(tpl, test_prompt, timeout=timeout, profile=profile, model_name=model_name)
        duration = round(time.time() - start_t, 2)
        if is_quota_or_rate_limit_error(output):
            return False, output, ""
        return True, f"Passed active check ({duration}s)", output
    except Exception as exc:
        return False, str(exc), ""


def sanitize_prompt_for_cli(prompt_text: str, max_bytes: Optional[int] = None) -> str:
    """Ensure prompt string fits within fast, responsive CLI execution limits (default 350KB) with clean boundary-aware truncation."""
    if max_bytes is None:
        try:
            max_bytes = int(os.environ.get("ANTIGRAVITY_MAX_PROMPT_BYTES", str(MAX_CLI_ARG_BYTES)))
        except Exception:
            max_bytes = MAX_CLI_ARG_BYTES

    encoded = prompt_text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return prompt_text

    logger.warning("Prompt size (%d bytes) exceeds limit (%d bytes). Applying boundary-aware truncation...", len(encoded), max_bytes)

    head_size = int(max_bytes * 0.35)
    tail_size = max(0, max_bytes - head_size - 200)

    head_str = encoded[:head_size].decode("utf-8", errors="ignore")
    tail_str = encoded[-tail_size:].decode("utf-8", errors="ignore")

    # Clean up cutoffs at section boundaries / newlines
    if "\n\n[" in head_str:
        head_str = head_str.rsplit("\n\n[", 1)[0]
    elif "\n" in head_str:
        head_str = head_str.rsplit("\n", 1)[0]

    if "\n\n[" in tail_str:
        tail_str = "[" + tail_str.split("\n\n[", 1)[1]
    elif "\n" in tail_str:
        tail_str = tail_str.split("\n", 1)[1]

    return f"{head_str}\n\n... [Middle context truncated: prompt sliced to {max_bytes} bytes for fast model reasoning] ...\n\n{tail_str}"


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

    if "gemini-3.7-flash" in model_lower:
        flags.extend(["--model", "gemini-3.7-flash"])
        if not effort:
            effort = "medium"

    elif "gemini-3.6-flash" in model_lower:
        flags.extend(["--model", "gemini-3.6-flash"])
    elif "gemini-3.5-flash" in model_lower:
        flags.extend(["--model", "gemini-3.5-flash"])
    elif "gemini-3.1-pro" in model_lower:
        flags.extend(["--model", "gemini-3.1-pro"])
        if not effort:
            effort = "high"
    elif "claude-sonnet-4.6" in model_lower or "claude-3-7-sonnet" in model_lower:
        flags.extend(["--model", "Claude Sonnet 4.6 (Thinking)"])
    elif "claude-opus-4.6" in model_lower:
        flags.extend(["--model", "Claude Opus 4.6 (Thinking)"])
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
    prompt_bytes_len = len(prompt_text.encode("utf-8"))

    if "{prompt}" in cmd_template:
        placeholder = "__PROMPT_PLACEHOLDER__"
        temp = (
            cmd_template.replace('"{prompt}"', placeholder)
            .replace("'{prompt}'", placeholder)
            .replace("{prompt}", placeholder)
        )
        parts = shlex.split(temp)
        if model_flags:
            parts = [parts[0]] + model_flags + parts[1:]

        if prompt_bytes_len > MAX_CLI_ARG_BYTES:
            final_prompt = sanitize_prompt_for_cli(prompt_text, max_bytes=MAX_CLI_ARG_BYTES)
        else:
            final_prompt = prompt_text

        argv = [final_prompt if p == placeholder else p for p in parts]
        return argv, ""
    else:
        argv = shlex.split(cmd_template)
        if model_flags:
            argv = [argv[0]] + model_flags + argv[1:]

        if argv and argv[-1] in ("-p", "--print", "--prompt"):
            if prompt_bytes_len > MAX_CLI_ARG_BYTES:
                final_prompt = sanitize_prompt_for_cli(prompt_text, max_bytes=MAX_CLI_ARG_BYTES)
            else:
                final_prompt = prompt_text
            argv.append(final_prompt)
            return argv, ""

        # Default Stdin path: pass full prompt text via stdin for non-print CLI commands
        return argv, prompt_text


MAC_KEYCHAIN_LOCK = threading.Lock()


def get_profile_sandbox_dir(profile_name: Optional[str]) -> str:
    """Create and prepare an isolated sandbox directory for a profile's CLI executions.
    Guarantees zero lock/file collisions (SQLite, lock files, auth files) during concurrent runs.
    """
    key = profile_name or "default"
    sandbox_base = os.path.expanduser(f"~/.config/antigravity/sandboxes/{key}")
    gemini_dir = os.path.join(sandbox_base, ".gemini")
    gemini_cli_dir = os.path.join(sandbox_base, ".gemini", "antigravity-cli")
    config_dir = os.path.join(sandbox_base, ".config", "antigravity")
    config_gemini = os.path.join(sandbox_base, ".config", "gemini")

    target_dirs = [gemini_dir, gemini_cli_dir, config_dir, config_gemini, sandbox_base]
    for td in target_dirs:
        os.makedirs(td, exist_ok=True)

    # Source profile directory
    src_dir = os.path.expanduser(f"~/.config/antigravity/profiles/{key}") if profile_name else os.path.expanduser("~/.gemini")
    if profile_name and not os.path.exists(src_dir):
        alt = os.path.expanduser(f"~/.config/antigravity/{key}")
        if os.path.exists(alt):
            src_dir = alt

    # Sync auth files into sandbox
    if os.path.exists(src_dir) and os.path.isdir(src_dir):
        for fname in ("oauth_creds.json", "google_accounts.json", "state.json", "settings.json", "antigravity-oauth-token"):
            src_file = os.path.join(src_dir, fname)
            if os.path.exists(src_file):
                for dest_d in target_dirs:
                    dst_file = os.path.join(dest_d, fname)
                    try:
                        if not os.path.exists(dst_file) or os.path.getmtime(src_file) > os.path.getmtime(dst_file):
                            shutil.copy2(src_file, dst_file)
                    except Exception:
                        pass

        # Generate antigravity-oauth-token inside sandbox if oauth_creds.json is present
        oauth_file = os.path.join(src_dir, "oauth_creds.json")
        if os.path.exists(oauth_file):
            try:
                with open(oauth_file, "r", encoding="utf-8") as o_f:
                    raw_content = o_f.read()
                    o_data = json.loads(raw_content)
                raw_tok = o_data.get("token") if isinstance(o_data.get("token"), dict) else o_data
                auth_meth = o_data.get("auth_method", "consumer")
                token_obj = {
                    "token": {
                        "access_token": raw_tok.get("access_token", ""),
                        "token_type": raw_tok.get("token_type", "Bearer"),
                        "refresh_token": raw_tok.get("refresh_token", ""),
                        "expiry": raw_tok.get("expiry", "2026-08-18T23:59:59+07:00"),
                    },
                    "auth_method": auth_meth,
                }
                tok_json_str = json.dumps(token_obj)
                for td in target_dirs:
                    try:
                        dst_tok = os.path.join(td, "antigravity-oauth-token")
                        if not os.path.exists(dst_tok) or os.path.getmtime(oauth_file) > os.path.getmtime(dst_tok):
                            with open(dst_tok, "w", encoding="utf-8") as aot_f:
                                aot_f.write(tok_json_str)
                    except Exception:
                        pass
            except Exception:
                pass

    # Clean stale lock and cache files from sandbox
    for lock_name in ("update.lock", "knowledge.lock", "jetski_state.pbtxt", "default-cli-project.json", "default_project_id.txt"):
        for td in (gemini_dir, sandbox_base):
            lp = os.path.join(td, lock_name)
            if os.path.exists(lp):
                try:
                    os.remove(lp)
                except Exception:
                    pass

    return sandbox_base


def detect_local_proxy() -> Optional[str]:
    """Detect if an explicit proxy is configured in env or if local HTTP/SOCKS5 proxy is listening."""
    if os.environ.get("ANTIGRAVITY_NO_PROXY", "").lower() in ("1", "true", "yes") or \
       os.environ.get("DISABLE_PROXY", "").lower() in ("1", "true", "yes") or \
       os.environ.get("NO_PROXY") == "*":
        return None

    for env_var in ("ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        val = os.environ.get(env_var, "").strip()
        if val:
            return val

    # 1. Check local HTTP CONNECT proxies (Privoxy on 8118, tinyproxy on 8888)
    for host in ("127.0.0.1", "localhost", "::1"):
        for port in (8118, 8888, 8080):
            try:
                af = socket.AF_INET6 if ":" in host else socket.AF_INET
                s = socket.socket(af, socket.SOCK_STREAM)
                s.settimeout(0.5)
                res = s.connect_ex((host, port))
                s.close()
                if res == 0:
                    return f"http://127.0.0.1:{port}"
            except Exception:
                pass

    # 2. Check local SOCKS5 proxies (WARP on 40000, Shadowsocks on 1080, Clash on 7890)
    for host in ("127.0.0.1", "localhost", "::1"):
        for port in (40000, 1080, 7890):
            try:
                af = socket.AF_INET6 if ":" in host else socket.AF_INET
                s = socket.socket(af, socket.SOCK_STREAM)
                s.settimeout(0.5)
                res = s.connect_ex((host, port))
                s.close()
                if res == 0:
                    return f"socks5://127.0.0.1:{port}"
            except Exception:
                pass

    return None


def execute_cli_command(
    cmd_template: str,
    prompt_text: str,
    timeout: float = DEFAULT_PROFILE_TIMEOUT,
    profile: Optional[str] = None,
    model_name: Optional[str] = None,
) -> str:
    """Execute local CLI command with prompt substitution or stdin piping for a given profile in an isolated sandbox."""
    argv, stdin_input = parse_cmd_template(cmd_template, prompt_text, model_name=model_name)

    log_str = " ".join(argv)[:120] if argv else cmd_template[:120]
    logger.info("Executing CLI command (profile=%s, timeout=%.1fs): %s", profile or "default", timeout, log_str)

    sandbox_dir = get_profile_sandbox_dir(profile)

    # Filtered environment with isolated HOME and XDG variables
    allowed_env_keys = {
        "PATH", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL",
        "SYSTEMROOT", "TEMP", "TMP",
        "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK",
        "ANTIGRAVITY_PROFILE", "ANTIGRAVITY_PROFILES", "ANTIGRAVITY_HOME",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy",
    }
    env = {k: v for k, v in os.environ.items() if k in allowed_env_keys or k.startswith("ANTIGRAVITY_")}
    env["HOME"] = sandbox_dir
    env["USERPROFILE"] = sandbox_dir
    env["XDG_CONFIG_HOME"] = os.path.join(sandbox_dir, ".config")
    env["XDG_DATA_HOME"] = os.path.join(sandbox_dir, ".local", "share")
    env["XDG_CACHE_HOME"] = os.path.join(sandbox_dir, ".cache")
    if profile:
        env["ANTIGRAVITY_PROFILE"] = profile

    proxy_url = detect_local_proxy()
    if proxy_url:
        env["ALL_PROXY"] = proxy_url
        env["all_proxy"] = proxy_url
        env["HTTPS_PROXY"] = proxy_url
        env["https_proxy"] = proxy_url
        env["HTTP_PROXY"] = proxy_url
        env["http_proxy"] = proxy_url
        env["NO_PROXY"] = "127.0.0.1,localhost,::1"
        env["no_proxy"] = "127.0.0.1,localhost,::1"
        logger.info("[PROXY] Active Outbound Proxy: %s (Bypassing 127.0.0.1,localhost)", proxy_url)

    if profile:
        email_preview, token_preview = sync_profile_to_system(profile)
        profile_dir = os.path.expanduser(f"~/.config/antigravity/profiles/{profile}")
        if not os.path.exists(profile_dir):
            alt_dir = os.path.expanduser(f"~/.config/antigravity/{profile}")
            if os.path.exists(alt_dir) and os.path.isdir(alt_dir):
                profile_dir = alt_dir

        if os.path.exists(profile_dir) and os.path.isdir(profile_dir):
            logger.info(
                "[PROFILE SWAP] Activated profile '%s' (OS: %s) | Email: %s | Token: %s | Source: %s",
                profile,
                get_os_type(),
                email_preview,
                token_preview,
                profile_dir,
            )
        else:
            logger.warning("[PROFILE SWAP] Profile directory not found for '%s' (checked %s)", profile, profile_dir)

    temp_prompt_file: Optional[str] = None
    stdin_file_handle = None
    try:
        if stdin_input:
            stdin_bytes = stdin_input.encode("utf-8")
            if len(stdin_bytes) > MAX_CLI_ARG_BYTES:
                temp_prompt_file = os.path.join(
                    sandbox_dir,
                    f".prompt_{os.getpid()}_{threading.get_ident()}_{int(time.time()*1000)}.tmp",
                )
                with open(temp_prompt_file, "w", encoding="utf-8") as f:
                    f.write(stdin_input)
                stdin_file_handle = open(temp_prompt_file, "r", encoding="utf-8")
                proc_stdin = stdin_file_handle
                comm_input = None
            else:
                proc_stdin = subprocess.PIPE
                comm_input = stdin_input
        else:
            proc_stdin = subprocess.PIPE
            comm_input = None

        proc = subprocess.Popen(
            argv,
            cwd=sandbox_dir,
            shell=False,
            stdin=proc_stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        try:
            stdout_data, stderr_data = proc.communicate(input=comm_input, timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                stdout_data, stderr_data = proc.communicate(timeout=2.0)
            except Exception:
                pass
            logger.error("CLI execution timed out after %.1fs for profile '%s'", timeout, profile or "default")
            raise RuntimeError(f"CLI Execution Timeout after {timeout:.1f}s (profile={profile or 'default'})")
    finally:
        if stdin_file_handle:
            try:
                stdin_file_handle.close()
            except Exception:
                pass
        if temp_prompt_file and os.path.exists(temp_prompt_file):
            try:
                os.remove(temp_prompt_file)
            except Exception:
                pass

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
    timeout: float = DEFAULT_PROFILE_TIMEOUT,
    total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
    profiles: Optional[List[Optional[str]]] = None,
    model_name: Optional[str] = None,
    profile_manager: Optional[ProfileManager] = None,
) -> Tuple[str, Optional[str]]:
    """Execute CLI command trying profiles dynamically in parallel-safe worker pool until one succeeds or total timeout budget is reached."""
    mgr = profile_manager or GLOBAL_PROFILE_MANAGER
    if profiles is not None:
        mgr.set_profiles(profiles)

    candidate_profiles = mgr.get_ordered_profiles()
    errors: List[str] = []
    tried_profiles: set = set()
    start_time = time.time()

    for _ in range(len(candidate_profiles)):
        elapsed = time.time() - start_time
        remaining_budget = total_timeout - elapsed
        if remaining_budget <= 0:
            logger.warning(
                "Total fallback timeout budget (%.1fs) reached after trying %d profile(s)",
                total_timeout,
                len(tried_profiles),
            )
            errors.append(f"Total fallback timeout budget ({total_timeout:.0f}s) exceeded")
            break

        available_candidates = [p for p in candidate_profiles if p not in tried_profiles]
        if not available_candidates:
            break

        profile = mgr.acquire_profile(available_candidates)
        if profile is None and available_candidates:
            profile = available_candidates[0]
            mgr.acquire_specific_profile(profile)

        tried_profiles.add(profile)
        profile_key = profile or "default"
        is_cooldown = mgr.is_in_cooldown(profile)
        in_flight_count = mgr.get_in_flight(profile)

        attempt_timeout = max(1.0, min(timeout, remaining_budget))

        if is_cooldown:
            logger.warning(
                "Skipping fallback profile in cooldown: %s (model=%s, in_flight=%d, timeout=%.1fs)",
                profile_key,
                model_name or "default",
                in_flight_count,
                attempt_timeout,
            )
            errors.append(f"Profile '{profile_key}' is in cooldown (exhausted). Skipping.")
            mgr.release_profile(profile)
            continue
        else:
            logger.info(
                "Attempting CLI execution with profile: %s (model=%s, in_flight=%d, timeout=%.1fs)",
                profile_key,
                model_name or "default",
                in_flight_count,
                attempt_timeout,
            )

        try:
            output = execute_cli_command(
                cmd_template,
                prompt_text,
                timeout=attempt_timeout,
                profile=profile,
                model_name=model_name,
            )
            mgr.mark_success(profile)
            return output, profile
        except Exception as exc:
            err_str = str(exc)
            logger.warning("Profile '%s' execution failed: %s", profile_key, exc)
            if "authentication required" in err_str.lower() or "not signed in" in err_str.lower():
                mgr.mark_exhausted(profile, err_str, cooldown_seconds=3600.0)
            elif is_quota_or_rate_limit_error(err_str):
                mgr.mark_exhausted(profile, err_str)
            else:
                mgr.mark_error(profile, err_str)
            errors.append(f"Profile '{profile_key}': {exc}")
        finally:
            mgr.release_profile(profile)

    raise RuntimeError(f"All agy profile execution attempts failed. Details: {'; '.join(errors)}")


def resolve_gemini_api_key(client_key: Optional[str] = None) -> Optional[str]:
    """Resolve Google Gemini API key from client auth header, env, or .env files."""
    if client_key and (client_key.startswith("AIza") or len(client_key) > 30):
        return client_key

    allowed_keys = {"GEMINI_API_KEY", "GOOGLE_API_KEY", "IMAGEN_API_KEY", "ANTIGRAVITY_BRIDGE_GEMINI_KEY"}
    for env_k, env_v in os.environ.items():
        if env_k.upper() in allowed_keys and (env_v.strip().startswith("AIza") or len(env_v.strip()) > 30):
            return env_v.strip()

    # Search common .env locations
    for env_file in (
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
        os.path.expanduser("~/antigravity-bridge/.env"),
        os.path.expanduser("~/.hermes/.env"),
        os.path.expanduser("~/astra_social_ai/.env"),
        os.path.expanduser("~/.env"),
    ):
        if os.path.exists(env_file):
            try:
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        k = k.strip().upper()
                        v = v.strip().strip("'\"")
                        if k in allowed_keys and (v.startswith("AIza") or len(v) > 30):
                            return v
            except Exception:
                pass

    return None


def generate_image_with_imagen(
    prompt: str,
    model: str = "imagen-3.0-generate-002",
    sample_count: int = 1,
    aspect_ratio: str = "1:1",
    output_mime_type: str = "image/jpeg",
    api_key: Optional[str] = None,
    timeout: float = 120.0,
) -> List[Dict[str, Any]]:
    """Call Google AI Imagen 3 REST API endpoint to generate images and return OpenAI format data list."""
    if not api_key:
        raise RuntimeError("No valid Google AI Studio API key (AIza...) found")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:predict"
    payload = {
        "instances": [{"prompt": prompt}],
        "parameters": {
            "sampleCount": sample_count,
            "aspectRatio": aspect_ratio,
            "outputOptions": {"mimeType": output_mime_type},
        },
    }

    req_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=req_bytes,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    logger.info("Calling Google Imagen 3 API (model=%s, aspect_ratio=%s, count=%d)...", model, aspect_ratio, sample_count)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    predictions = data.get("predictions", [])
    if not predictions:
        raise RuntimeError("Google Imagen API returned no image predictions")

    results: List[Dict[str, Any]] = []
    for pred in predictions:
        b64_img = pred.get("bytesBase64Encoded")
        if b64_img:
            results.append({"b64_json": b64_img, "revised_prompt": prompt})

    if not results:
        raise RuntimeError("No valid base64 image data found in Google Imagen response")

    return results


def generate_image_with_agy(
    prompt: str,
    aspect_ratio: str = "1:1",
    cmd_template: Optional[str] = None,
    profiles: Optional[List[Optional[str]]] = None,
) -> List[Dict[str, Any]]:
    """Use local agy CLI with generate_image tool / prompt and return base64 result."""
    if not cmd_template:
        _, cmd_template = detect_cli_command()
    if profiles is None:
        profiles = get_available_profiles()

    start_ts = time.time()
    target_file = f"/tmp/agy_img_{uuid.uuid4().hex[:8]}.png"
    agy_prompt = (
        f"You are an AI assistant. Write and execute a Python script or use tools to create/render the image for: \"{prompt}\" "
        f"with aspect ratio '{aspect_ratio}'. Save the resulting image directly to '{target_file}'. "
        f"You MUST ensure '{target_file}' is saved on disk. Output the exact saved path: {target_file}"
    )

    logger.info("Calling agy CLI for image generation (target=%s, prompt: %s)...", target_file, prompt[:80])
    try:
        output_text, used_profile = execute_cli_with_fallback(
            cmd_template,
            agy_prompt,
            timeout=60.0,
            total_timeout=120.0,
            profiles=profiles,
            model_name="gemini-3.7-flash-low",
        )
        logger.info("agy CLI finished with profile '%s'. Output: %s", used_profile or "default", output_text[:200])
    except Exception as exc:
        logger.error("agy CLI execution error during image generation: %s", exc)
        raise RuntimeError(f"agy CLI image generation failed: {exc}")

    # 0. Check explicit target_file
    if os.path.isfile(target_file) and os.path.getsize(target_file) > 0:
        try:
            with open(target_file, "rb") as f:
                img_bytes = f.read()
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            logger.info("Found image at explicit target path: %s (%d bytes)", target_file, len(img_bytes))
            return [{"b64_json": b64, "revised_prompt": prompt}]
        except Exception as e:
            logger.warning("Failed to read explicit target_file %s: %s", target_file, e)

    # 1. Check for Base64 image data in response text (e.g. data:image/png;base64,...)
    b64_matches = re.findall(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]{100,})', output_text)
    if b64_matches:
        logger.info("Found base64 data URI in agy output (%d chars)", len(b64_matches[0]))
        return [{"b64_json": b64_matches[0], "revised_prompt": prompt}]

    # 2. Check for file paths in output text
    # Matches patterns like /path/to/img.png, ~/.gemini/.../img.png, ./img.png
    path_candidates = re.findall(r'([~/\.][\w\.\-_/ ]+\.(?:png|jpg|jpeg|webp))', output_text)
    for p_str in path_candidates:
        clean_p = p_str.strip().strip("'\"()[]<>")
        expanded = os.path.abspath(os.path.expanduser(clean_p))
        if os.path.isfile(expanded) and os.path.getsize(expanded) > 0:
            try:
                with open(expanded, "rb") as f:
                    img_bytes = f.read()
                b64 = base64.b64encode(img_bytes).decode("utf-8")
                logger.info("Found image from output path: %s (%d bytes)", expanded, len(img_bytes))
                return [{"b64_json": b64, "revised_prompt": prompt}]
            except Exception as e:
                logger.warning("Failed to read image at %s: %s", expanded, e)

    # 3. Search directories for newly created images (mtime >= start_ts - 10)
    search_dirs = [
        os.getcwd(),
        "/tmp",
        os.path.expanduser("~/.gemini"),
        os.path.expanduser("~/.cache"),
        os.path.expanduser("~/antigravity-bridge"),
    ]

    recent_files: List[Tuple[float, str]] = []
    for d in search_dirs:
        if not os.path.exists(d):
            continue
        try:
            for root, _, files in os.walk(d):
                if ".git" in root or "node_modules" in root:
                    continue
                for fname in files:
                    if fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                        full_path = os.path.join(root, fname)
                        try:
                            st = os.stat(full_path)
                            if st.st_mtime >= start_ts - 10 and st.st_size > 0:
                                recent_files.append((st.st_mtime, full_path))
                        except Exception:
                            pass
        except Exception as e:
            logger.debug("Error walking %s: %s", d, e)

    if recent_files:
        recent_files.sort(key=lambda x: x[0], reverse=True)
        newest_file = recent_files[0][1]
        try:
            with open(newest_file, "rb") as f:
                img_bytes = f.read()
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            logger.info("Found newly generated image on filesystem: %s (%d bytes)", newest_file, len(img_bytes))
            return [{"b64_json": b64, "revised_prompt": prompt}]
        except Exception as e:
            logger.error("Failed to read found image %s: %s", newest_file, e)

    logger.error("No image file or base64 data found. agy output preview: %s", output_text[:300])
    raise RuntimeError(f"No image was generated by agy CLI (output: {output_text[:160]})")





class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):

    """Multi-threaded HTTP server for handling concurrent API calls."""
    daemon_threads = True
    allow_reuse_address = True


class SSEHeartbeat:
    """Sends periodic SSE comment pings (: keep-alive) to prevent gateways/clients from timing out during long CLI executions."""
    def __init__(self, wfile: Any, interval: float = 3.0):
        self.wfile = wfile
        self.interval = interval
        self.running = True
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        while self.running:
            time.sleep(self.interval)
            if not self.running:
                break
            try:
                with self.lock:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
            except Exception:
                break

    def stop(self) -> None:
        self.running = False


class AntigravityBridgeHandler(BaseHTTPRequestHandler):
    """HTTP Handler implementing OpenAI ChatCompletions & Anthropic Messages REST API."""
    protocol_version = "HTTP/1.1"

    def _authorized(self) -> bool:
        """Validate Authorization / x-api-key header against server configured api_key if set."""
        expected_key = getattr(self.server, "api_key", None)
        if not expected_key:
            # If server has no --api-key configured, allow all requests
            return True

        # Check standard Authorization: Bearer <key>
        auth_header = self.headers.get("Authorization", "").strip()
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
            if token == expected_key:
                return True

        # Check Anthropic x-api-key: <key>
        x_key = self.headers.get("x-api-key", "").strip()
        if x_key and x_key == expected_key:
            return True

        # Check generic api-key: <key>
        generic_key = self.headers.get("api-key", "").strip()
        if generic_key and generic_key == expected_key:
            return True

        return False

    def _send_json_response(self, data: Dict[str, Any], status_code: int = 200, extra_headers: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for hk, hv in extra_headers.items():
                self.send_header(hk, hv)
        if getattr(self.server, "enable_cors", False):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()
        self.wfile.write(body)

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
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                active_profiles = pm.get_ordered_profiles()
                active_p = active_profiles[0] if active_profiles else None
                total_profiles = len(pm._profiles)
                self._send_json_response({
                    "status": "ok",
                    "service": "antigravity-bridge",
                    "active_profile": active_p or "default",
                    "concurrency": {
                        "active_in_flight": pm.get_total_in_flight(),
                        "max_pool_capacity": total_profiles * pm.concurrency_per_profile,
                        "concurrency_per_profile": pm.concurrency_per_profile,
                    },
                    "profiles": pm.get_status_summary(),
                })
                return

            if not self._authorized():
                self._send_json_response(
                    {"error": {"message": "Unauthorized API Key", "type": "invalid_request_error"}},
                    status_code=401,
                )
                return

            if path in ("/v1/profiles", "/profiles"):
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                total_profiles = len(pm._profiles)
                self._send_json_response({
                    "object": "list",
                    "concurrency": {
                        "active_in_flight": pm.get_total_in_flight(),
                        "max_pool_capacity": total_profiles * pm.concurrency_per_profile,
                        "concurrency_per_profile": pm.concurrency_per_profile,
                    },
                    "profiles": pm.get_status_summary(),
                })
                return

            if path in ("/v1/models", "/models"):
                now_ts = int(time.time())
                models_list = [
                    {
                        "id": m,
                        "object": "model",
                        "created": now_ts,
                        "owned_by": "local",
                        "context_window": MODEL_CONTEXT_LIMITS.get(m),
                    }
                    for m in SUPPORTED_MODELS.keys()
                ] + [
                    {"id": "antigravity", "object": "model", "created": now_ts, "owned_by": "local", "context_window": 1000000},
                    {"id": "agy", "object": "model", "created": now_ts, "owned_by": "local", "context_window": 1000000},
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
            is_image_gen = path in ("/v1/images/generations", "/images/generations")
            is_profiles_reset = path in ("/v1/profiles/reset", "/profiles/reset")
            is_profiles_check = path in ("/v1/profiles/check", "/profiles/check")
            is_profiles_config = path in ("/v1/profiles/config", "/profiles/config", "/v1/config", "/config")
            is_profiles_disable = path in ("/v1/profiles/disable", "/profiles/disable")
            is_profiles_enable = path in ("/v1/profiles/enable", "/profiles/enable")

            if not (is_openai or is_anthropic or is_image_gen or is_profiles_reset or is_profiles_check or is_profiles_config or is_profiles_disable or is_profiles_enable):
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

            if content_length > 0:
                body_data = self.rfile.read(content_length)
                try:
                    req_json = json.loads(body_data.decode("utf-8"))
                except Exception as exc:
                    self._send_json_response(
                        {"error": {"message": f"Invalid JSON payload: {exc}", "type": "invalid_request_error"}},
                        status_code=400,
                    )
                    return
            else:
                req_json = {}

            # Handle Profile management endpoints
            if is_profiles_config:
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                raw_p = req_json.get("profiles")
                if raw_p is not None:
                    if isinstance(raw_p, str):
                        new_profiles = [p.strip() for p in raw_p.split(",") if p.strip()]
                    elif isinstance(raw_p, list):
                        new_profiles = [str(p).strip() for p in raw_p if p]
                    else:
                        new_profiles = get_available_profiles()
                    pm.set_profiles(new_profiles)
                    if hasattr(self.server, "profiles"):
                        self.server.profiles = new_profiles

                    cfg_file = os.path.expanduser("~/.config/antigravity/bridge_config.json")
                    try:
                        cfg_data: Dict[str, Any] = {}
                        if os.path.exists(cfg_file):
                            try:
                                with open(cfg_file, "r", encoding="utf-8") as f:
                                    cfg_data = json.load(f)
                            except Exception:
                                cfg_data = {}
                        if not isinstance(cfg_data, dict):
                            cfg_data = {}
                        cfg_data["profiles"] = new_profiles
                        os.makedirs(os.path.dirname(cfg_file), exist_ok=True)
                        with open(cfg_file, "w", encoding="utf-8") as f:
                            json.dump(cfg_data, f, indent=2)
                    except Exception as exc:
                        logger.warning("Failed to save bridge_config.json: %s", exc)

                    logger.info("Live dynamic config update: active profiles changed to %s", new_profiles)
                    self._send_json_response({
                        "status": "ok",
                        "message": f"Live profiles configuration updated: {new_profiles}",
                        "active_profiles": new_profiles,
                        "profiles": pm.get_status_summary(),
                    })
                    return
                else:
                    self._send_json_response({
                        "status": "ok",
                        "active_profiles": pm._profiles,
                        "profiles": pm.get_status_summary(),
                    })
                    return

            if is_profiles_disable:
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                target_p = req_json.get("profile")
                if target_p:
                    pm.mark_disabled(target_p)
                    self._send_json_response({
                        "status": "ok",
                        "message": f"Profile '{target_p}' is now DISABLED",
                        "profiles": pm.get_status_summary(),
                    })
                else:
                    self._send_json_response({"error": "Missing 'profile' in request body"}, status_code=400)
                return

            if is_profiles_enable:
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                target_p = req_json.get("profile")
                if target_p:
                    pm.enable(target_p)
                    self._send_json_response({
                        "status": "ok",
                        "message": f"Profile '{target_p}' is now ENABLED",
                        "profiles": pm.get_status_summary(),
                    })
                else:
                    self._send_json_response({"error": "Missing 'profile' in request body"}, status_code=400)
                return

            if is_profiles_reset:
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                target_p = req_json.get("profile")
                pm.reset_all(target_p)
                self._send_json_response({
                    "status": "ok",
                    "message": f"Profile(s) reset: {target_p or 'all'}",
                    "profiles": pm.get_status_summary(),
                })
                return

            if is_profiles_check:
                pm = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                cli_bin, cmd_tpl = detect_cli_command()
                custom_tpl = getattr(self.server, "custom_cmd", None) or cmd_tpl
                check_model = req_json.get("model")
                check_prompt = req_json.get("prompt")

                results: Dict[str, Any] = {}
                for p in pm._profiles:
                    ok, msg, resp_text = probe_profile(p, cmd_template=custom_tpl, model_name=check_model, prompt=check_prompt)
                    if ok:
                        pm.mark_success(p)
                        results[p or "default"] = {"ok": True, "latency": msg, "preview": resp_text[:150]}
                    else:
                        pm.mark_exhausted(p, msg)
                        results[p or "default"] = {"ok": False, "error": msg}

                self._send_json_response({
                    "status": "ok",
                    "results": results,
                    "profiles": pm.get_status_summary(),
                })
                return

            router_url = getattr(self.server, "image_router_url", None) or DEFAULT_IMAGE_ROUTER_URL
            router_key = getattr(self.server, "image_router_key", None) or DEFAULT_IMAGE_ROUTER_KEY

            # Handle direct OpenAI /v1/images/generations endpoint
            if is_image_gen:
                prompt = req_json.get("prompt")
                if not prompt:
                    self._send_json_response(
                        {"error": {"message": "Missing 'prompt' field in request body", "type": "invalid_request_error"}},
                        status_code=400,
                    )
                    return
                model_name = req_json.get("model") or "gemini-3.1-flash-image"
                try:
                    markdown_img, b64_raw = generate_image_via_router(
                        prompt=prompt,
                        model_name=model_name,
                        router_url=router_url,
                        router_key=router_key,
                    )
                    response_data = {
                        "created": int(time.time()),
                        "data": [
                            {
                                "b64_json": b64_raw or "",
                                "revised_prompt": prompt,
                            }
                        ],
                    }
                    self._send_json_response(response_data, status_code=200)
                    return
                except Exception as exc:
                    logger.error("Image generation failed: %s", exc)
                    self._send_json_response(
                        {"error": {"message": f"Image generation failed: {exc}", "type": "api_error"}},
                        status_code=500,
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

            # Handle Image Generation Models via standard /v1/chat/completions or /v1/messages
            if is_image_model(model):
                prompt_text = ""
                for msg in reversed(messages):
                    if msg.get("role") == "user":
                        c = msg.get("content", "")
                        if isinstance(c, str):
                            prompt_text = c
                        elif isinstance(c, list):
                            prompt_text = " ".join(part.get("text", "") for part in c if isinstance(part, dict))
                        if prompt_text:
                            break
                if not prompt_text:
                    prompt_text = format_messages_to_prompt(messages)

                try:
                    markdown_img, b64_raw = generate_image_via_router(
                        prompt=prompt_text,
                        model_name=model,
                        router_url=router_url,
                        router_key=router_key,
                    )
                    logger.info("Successfully generated image via router (model=%s)", model)
                except Exception as exc:
                    logger.error("Image generation via router failed: %s", exc)
                    self._send_json_response(
                        {"error": {"message": f"Image generation failed: {exc}", "type": "api_error"}},
                        status_code=500,
                    )
                    return

                show_status = getattr(self.server, "show_profile_status", True)
                if show_status:
                    pm_banner = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER
                    img_banner = pm_banner.build_profile_quota_banner(None)
                    markdown_img = markdown_img + "\n" + img_banner

                if is_anthropic:
                    msg_id = f"msg_{uuid.uuid4().hex}"
                    if stream:
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.send_header("Cache-Control", "no-cache")
                        self.send_header("Connection", "close")
                        if getattr(self.server, "enable_cors", False):
                            self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()

                        events = [
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
                                    "usage": {"input_tokens": max(1, len(prompt_text) // 4), "output_tokens": 50},
                                },
                            }),
                            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": markdown_img}}),
                            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 50}}),
                            ("message_stop", {"type": "message_stop"}),
                        ]
                        for ev_type, ev_data in events:
                            self.wfile.write(f"event: {ev_type}\ndata: {json.dumps(ev_data)}\n\n".encode("utf-8"))
                            self.wfile.flush()
                        return
                    else:
                        self._send_json_response({
                            "id": msg_id,
                            "type": "message",
                            "role": "assistant",
                            "model": model,
                            "content": [{"type": "text", "text": markdown_img}],
                            "stop_reason": "end_turn",
                            "stop_sequence": None,
                            "usage": {"input_tokens": max(1, len(prompt_text) // 4), "output_tokens": 50},
                        })
                        return
                else:
                    # OpenAI chat completion format
                    chat_id = f"chatcmpl-{uuid.uuid4().hex}"
                    created_ts = int(time.time())
                    if stream:
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.send_header("Cache-Control", "no-cache")
                        self.send_header("Connection", "close")
                        if getattr(self.server, "enable_cors", False):
                            self.send_header("Access-Control-Allow-Origin", "*")
                        self.end_headers()

                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created_ts,
                            "model": model,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"role": "assistant", "content": markdown_img},
                                    "finish_reason": "stop",
                                }
                            ],
                        }
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                        self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                        return
                    else:
                        self._send_json_response({
                            "id": chat_id,
                            "object": "chat.completion",
                            "created": created_ts,
                            "model": model,
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {"role": "assistant", "content": markdown_img},
                                    "finish_reason": "stop",
                                }
                            ],
                            "usage": {
                                "prompt_tokens": max(1, len(prompt_text) // 4),
                                "completion_tokens": 50,
                                "total_tokens": max(1, len(prompt_text) // 4) + 50,
                            },
                        })
                        return

            prompt_text = format_messages_to_prompt(
                messages,
                tools=normalized_tools if normalized_tools else None,
                tool_choice=tool_choice,
            )
            cli_bin, cmd_tpl = detect_cli_command()
            custom_tpl = getattr(self.server, "custom_cmd", None) or cmd_tpl
            configured_profiles = getattr(self.server, "profiles", None)
            profile_manager = getattr(self.server, "profile_manager", None) or GLOBAL_PROFILE_MANAGER

            # If client requested streaming, send SSE headers immediately and start heartbeat to prevent gateway read timeouts
            heartbeat = None
            if stream:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                if getattr(self.server, "enable_cors", False):
                    self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.flush()
                heartbeat = SSEHeartbeat(self.wfile, interval=3.0)

            try:
                prof_timeout = getattr(self.server, "profile_timeout", DEFAULT_PROFILE_TIMEOUT)
                total_timeout = getattr(self.server, "total_timeout", DEFAULT_TOTAL_TIMEOUT)
                output_text, used_profile = execute_cli_with_fallback(
                    custom_tpl,
                    prompt_text,
                    timeout=prof_timeout,
                    total_timeout=total_timeout,
                    profiles=configured_profiles,
                    model_name=model,
                    profile_manager=profile_manager,
                )
                logger.info("Successfully executed CLI using profile: %s (model=%s)", used_profile or "default", model)
            except Exception as exc:
                logger.error("All agy profile attempts failed: %s", exc)
                if stream:
                    if heartbeat:
                        heartbeat.stop()
                    err_payload = {"error": {"message": str(exc), "type": "api_error"}}
                    try:
                        if is_anthropic:
                            self.wfile.write(f"event: error\ndata: {json.dumps(err_payload)}\n\n".encode("utf-8"))
                        else:
                            self.wfile.write(f"data: {json.dumps(err_payload)}\n\n".encode("utf-8"))
                            self.wfile.write(b"data: [DONE]\n\n")
                        self.wfile.flush()
                    except Exception:
                        pass
                    return
                else:
                    self._send_json_response(
                        {"error": {"message": str(exc), "type": "api_error"}},
                        status_code=500,
                    )
                    return
            finally:
                if heartbeat:
                    heartbeat.stop()

            created_ts = int(time.time())

            # Parse tool calls from model output if tools were supplied
            parsed_content_text, parsed_tool_calls = None, None
            if normalized_tools:
                allowed_names = [t.get("name") for t in normalized_tools if t.get("name")]
                parsed_content_text, parsed_tool_calls = parse_tool_calls_from_response(output_text, allowed_tools=allowed_names)

            content_text = parsed_content_text if (parsed_tool_calls and parsed_content_text) else ""

            # Build profile quota status banner and response headers
            show_status = getattr(self.server, "show_profile_status", True)
            status_banner = ""
            if show_status and profile_manager:
                status_banner = profile_manager.build_profile_quota_banner(used_profile)

            final_text_content = (output_text + status_banner) if not parsed_tool_calls else output_text
            final_content_text = (content_text + status_banner) if (parsed_tool_calls and content_text) else content_text

            extra_resp_headers: Dict[str, str] = {}
            if used_profile:
                extra_resp_headers["X-Antigravity-Active-Profile"] = str(used_profile)
            if profile_manager:
                summary = profile_manager.get_status_summary()
                ready_ct = sum(1 for s in summary.values() if s.get("available"))
                extra_resp_headers["X-Antigravity-Profiles-Ready"] = str(ready_ct)
                extra_resp_headers["X-Antigravity-Profiles-Total"] = str(len(summary))
                extra_resp_headers["X-Antigravity-Profile-Quota-Percent"] = str(profile_manager.get_estimated_quota_percent(used_profile))

            # --- Handle Anthropic API format (/v1/messages) ---
            if is_anthropic:
                msg_id = f"msg-{uuid.uuid4().hex[:8]}"

                if parsed_tool_calls:
                    anthropic_content = []
                    if final_content_text:
                        anthropic_content.append({"type": "text", "text": final_content_text})
                    for tc in parsed_tool_calls:
                        anthropic_content.append({
                            "type": "tool_use",
                            "id": tc["id"],
                            "name": tc["name"],
                            "input": tc["arguments"],
                        })
                    stop_reason = "tool_use"
                else:
                    anthropic_content = [{"type": "text", "text": final_text_content}]
                    stop_reason = "end_turn"

                if stream:
                    events = [
                        ("message_start", {"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": len(prompt_text) // 4, "output_tokens": 1}}}),
                    ]
                    if parsed_tool_calls:
                        idx = 0
                        if final_content_text:
                            events.extend([
                                ("content_block_start", {"type": "content_block_start", "index": idx, "content_block": {"type": "text", "text": ""}}),
                                ("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "text_delta", "text": final_content_text}}),
                                ("content_block_stop", {"type": "content_block_stop", "index": idx}),
                            ])
                            idx += 1
                        for tc in parsed_tool_calls:
                            events.extend([
                                ("content_block_start", {"type": "content_block_start", "index": idx, "content_block": {"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": {}}}),
                                ("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": json.dumps(tc["arguments"])}}),
                                ("content_block_stop", {"type": "content_block_stop", "index": idx}),
                            ])
                            idx += 1
                    else:
                        events.extend([
                            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": final_text_content}}),
                            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                        ])

                    events.extend([
                        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": len(final_text_content) // 4}}),
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
                    "usage": {"input_tokens": len(prompt_text) // 4, "output_tokens": len(final_text_content) // 4},
                }
                self._send_json_response(response_payload, extra_headers=extra_resp_headers)
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
                                    "content": final_content_text,
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
                                "delta": {"role": "assistant", "content": final_text_content},
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
                "content": final_content_text if parsed_tool_calls else final_text_content,
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
                    "completion_tokens": len(final_text_content) // 4,
                    "total_tokens": (len(prompt_text) + len(final_text_content)) // 4,
                },
            }

            self._send_json_response(response_payload, extra_headers=extra_resp_headers)
        except Exception as exc:
            logger.error("Unhandled Exception in do_POST: %s", exc)
            self._send_json_response(
                {"error": {"message": f"Internal Server Error: {exc}", "type": "api_error"}},
                status_code=500,
            )


def get_profile_account_email(profile: Optional[str]) -> str:
    """Get active logged in email for a profile from google_accounts.json."""
    if not profile or profile == "default":
        p = os.path.expanduser("~/.gemini/google_accounts.json")
    else:
        p = os.path.expanduser(f"~/.config/antigravity/profiles/{profile}/google_accounts.json")
        if not os.path.exists(p):
            alt_p = os.path.expanduser(f"~/.config/antigravity/{profile}/google_accounts.json")
            if os.path.exists(alt_p):
                p = alt_p
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("active") or "N/A"
        except Exception:
            pass
    return "Not Logged In"


def handle_profile_cli(argv: List[str]) -> int:
    """CLI subcommand handler for managing Antigravity login profiles."""
    if argv and argv[0] in ("-h", "--help", "help"):
        print("""
Antigravity Bridge - Profile Manager CLI 👤

Usage:
  python3 antigravity_bridge.py profile list                  List all profiles, logged-in emails, and quota status
  python3 antigravity_bridge.py profile login <name>          Log in or add a new profile interactively with agy
  python3 antigravity_bridge.py profile remove <name>         Delete a profile directory
  python3 antigravity_bridge.py profile test [name]           Actively test/probe profile quota availability
  python3 antigravity_bridge.py profile disable <name>        Temporarily disable a profile from receiving requests
  python3 antigravity_bridge.py profile enable <name>         Re-enable a previously disabled profile
  python3 antigravity_bridge.py profile set <p1,p2,...>       Live hot-reload active profile list on running server
  python3 antigravity_bridge.py profile order <p1,p2,...>     Set explicit round-robin rotation order of profiles
  python3 antigravity_bridge.py profile reset [name]          Reset cooldown state for a profile or all profiles
  python3 antigravity_bridge.py profile copy <name> <host>    Copy profile credentials to remote server via SCP

Shortcuts:
  python3 antigravity_bridge.py profiles                      Direct shortcut to list all profiles
  python3 antigravity_bridge.py login <name>                  Direct shortcut to login/add a profile

Examples:
  python3 antigravity_bridge.py profile list
  python3 antigravity_bridge.py profile order profile_1,profile_2,profile_3
  python3 antigravity_bridge.py profile set profile_1,profile_2,profile_3
  python3 antigravity_bridge.py profile disable profile_3
  python3 antigravity_bridge.py profile enable profile_3
  python3 antigravity_bridge.py profile login profile_new
  python3 antigravity_bridge.py profile test --model gemini-3.7-flash
  python3 antigravity_bridge.py profile copy profile_1 user@remote-vps
""")
        return 0

    sub = argv[0].lower() if argv else "list"
    profiles_dir = os.path.expanduser("~/.config/antigravity/profiles")
    os.makedirs(profiles_dir, exist_ok=True)

    if sub in ("list", "ls", "status"):
        live_data = None
        port = 8000
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/profiles")
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    live_data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            live_data = None

        if live_data and isinstance(live_data.get("profiles"), dict):
            summary = live_data["profiles"]
            all_profiles = list(summary.keys())
        else:
            pm = GLOBAL_PROFILE_MANAGER
            all_profiles = get_available_profiles()
            summary = pm.get_status_summary()

        print("\n" + "=" * 108)
        print(f"{'Profile Name':<16} {'Google Account Email':<30} {'Status':<11} {'In-Flight':<11} {'Cooldown':<10} {'Est. Quota':<12} {'Success'}")
        print("=" * 108)
        for p in all_profiles:
            name = p or "default"
            email = get_profile_account_email(p)
            info = summary.get(name, {})
            status = info.get("status", "OK")
            in_flight = f"{info.get('in_flight', 0)}/{info.get('max_concurrency', 1)}"
            cooldown = f"{info.get('cooldown_seconds_remaining', 0)}s" if info.get("cooldown_seconds_remaining", 0) > 0 else "Ready"
            succ = info.get("success_count", 0)
            q_pct = f"{info.get('estimated_quota_percent', 100)}%"
            print(f"{name:<16} {email:<30} {status:<11} {in_flight:<11} {cooldown:<10} {q_pct:<12} {succ}")
        print("=" * 108 + "\n")
        return 0

    elif sub in ("set", "use", "config", "order", "rotate"):
        if len(argv) < 2:
            print("[Error] Please specify profiles: python3 antigravity_bridge.py profile order profile_1,profile_2,profile_3")
            return 1
        raw = argv[1].strip()
        new_profiles = [p.strip() for p in raw.split(",") if p.strip()]

        # 1. Try sending to live server if running
        server_updated = False
        port = 8000
        try:
            req_data = json.dumps({"profiles": new_profiles}).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/v1/profiles/config",
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    server_updated = True
        except Exception:
            pass

        # 2. Update local bridge_config.json
        cfg_file = os.path.expanduser("~/.config/antigravity/bridge_config.json")
        try:
            cfg_data: Dict[str, Any] = {}
            if os.path.exists(cfg_file):
                try:
                    with open(cfg_file, "r", encoding="utf-8") as f:
                        cfg_data = json.load(f)
                except Exception:
                    cfg_data = {}
            if not isinstance(cfg_data, dict):
                cfg_data = {}
            cfg_data["profiles"] = new_profiles
            os.makedirs(os.path.dirname(cfg_file), exist_ok=True)
            with open(cfg_file, "w", encoding="utf-8") as f:
                json.dump(cfg_data, f, indent=2)
        except Exception:
            pass

        GLOBAL_PROFILE_MANAGER.set_profiles(new_profiles)

        if server_updated:
            print(f"[SUCCESS] Live Bridge Server updated on the fly! Active Profiles: {new_profiles}")
        else:
            print(f"[SUCCESS] Profile configuration saved! Active Profiles: {new_profiles} (applied for future sessions)")
        return 0

    elif sub in ("login", "add", "new"):
        if len(argv) < 2:
            print("[Error] Please specify profile name: python3 antigravity_bridge.py profile login <profile_name>")
            return 1
        name = argv[1].strip()
        target_dir = os.path.join(profiles_dir, name)
        os.makedirs(target_dir, exist_ok=True)

        # Clear any stale files in target_dir so agy starts clean authentication
        for f in os.listdir(target_dir):
            fp = os.path.join(target_dir, f)
            if os.path.isfile(fp) or os.path.islink(fp):
                try:
                    os.remove(fp)
                except Exception:
                    pass

        print(f"\n[INFO] Starting interactive login for profile '{name}'...")
        print(f"[INFO] Profile directory: {target_dir}")
        print("=" * 80)
        print("💡 ขั้นตอนการบันทึกโปรไฟล์ (Login Instructions):")
        print("   1. เมื่อหน้าต่างเบราว์เซอร์เปิดขึ้นมา (Browser OAuth):")
        print(f"      - เลือกล็อกอินด้วยบัญชี Google ที่ต้องการผูกกับ '{name}'")
        print("   2. เมื่อล็อกอินสำเร็จและกลับมาที่หน้าต่าง Terminal (ที่ขึ้นเครื่องหมาย > ):")
        print("      - พิมพ์คำว่า 'hi' แล้วกด Enter 1 ครั้ง เพื่อให้ระบบยืนยันสิทธิ์ Token")
        print("      - พิมพ์ '/exit' หรือกด Ctrl+D เพื่อบันทึก Credential และกลับสู่หน้าหลัก")
        print("=" * 80 + "\n")

        # Clear any stale keychain entry so agy starts clean authentication on macOS
        if sys.platform == "darwin":
            try:
                subprocess.call(["security", "delete-generic-password", "-s", "gemini", "-a", "antigravity"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass

        gemini_dir = os.path.expanduser("~/.gemini")
        oauth_file = os.path.join(gemini_dir, "oauth_creds.json")
        accounts_file = os.path.join(gemini_dir, "google_accounts.json")
        state_file = os.path.join(gemini_dir, "state.json")

        backup_oauth = os.path.join(gemini_dir, ".oauth_creds.json.bak")
        backup_accounts = os.path.join(gemini_dir, ".google_accounts.json.bak")
        backup_state = os.path.join(gemini_dir, ".state.json.bak")

        # 1. Backup existing ~/.gemini auth files so agy is forced to trigger browser OAuth login
        try:
            if os.path.exists(oauth_file):
                shutil.move(oauth_file, backup_oauth)
            if os.path.exists(accounts_file):
                shutil.move(accounts_file, backup_accounts)
            if os.path.exists(state_file):
                shutil.move(state_file, backup_state)
        except Exception as exc:
            logger.warning("Could not backup existing auth: %s", exc)

        cli_bin, _ = detect_cli_command()
        env = os.environ.copy()
        env["ANTIGRAVITY_PROFILE"] = name
        cmd = [cli_bin] if os.path.isabs(cli_bin) else ["agy"]

        try:
            subprocess.call(cmd, env=env)
        except FileNotFoundError:
            print(f"[Error] '{cli_bin}' binary not found. Make sure agy is installed.")
            return 1
        finally:
            # 2. Extract newly created tokens (from Keychain on macOS or files on Linux/Windows)
            token_saved = False
            verified_email = None

            # Try OS keyring first (macOS Keychain / Linux SecretService)
            keyring_data = extract_os_keyring_token()
            if keyring_data:
                token_info = keyring_data.get("token", {})
                if token_info and token_info.get("access_token"):
                    oauth_data = {
                        "access_token": token_info.get("access_token"),
                        "refresh_token": token_info.get("refresh_token"),
                        "token_type": token_info.get("token_type", "Bearer"),
                        "scope": "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid",
                        "expiry_date": 1789133170339,
                        "token": {
                            "access_token": token_info.get("access_token"),
                            "refresh_token": token_info.get("refresh_token"),
                            "token_type": token_info.get("token_type", "Bearer"),
                            "expiry": token_info.get("expiry", "2026-08-18T23:59:59+07:00"),
                        },
                        "auth_method": keyring_data.get("auth_method", "consumer"),
                    }
                    with open(os.path.join(target_dir, "oauth_creds.json"), "w", encoding="utf-8") as f:
                        json.dump(oauth_data, f, indent=2)
                    with open(os.path.join(target_dir, "antigravity-oauth-token"), "w", encoding="utf-8") as f:
                        json.dump({"token": oauth_data["token"], "auth_method": oauth_data["auth_method"]}, f, indent=2)
                    token_saved = True

                    # Fetch verified email from Google API using access token
                    try:
                        u_req = urllib.request.Request(
                            "https://www.googleapis.com/oauth2/v3/userinfo",
                            headers={"Authorization": f"Bearer {token_info['access_token']}"}
                        )
                        with urllib.request.urlopen(u_req, timeout=5.0) as u_resp:
                            u_data = json.loads(u_resp.read().decode("utf-8"))
                            verified_email = u_data.get("email")
                    except Exception:
                        pass

            # Try OS file fallbacks (antigravity-oauth-token or oauth_creds.json)
            if not token_saved:
                file_data = extract_os_file_token()
                if file_data:
                    raw_tok = file_data.get("token") if isinstance(file_data.get("token"), dict) else file_data
                    auth_meth = file_data.get("auth_method", "consumer")
                    access_tok = raw_tok.get("access_token", "")
                    refresh_tok = raw_tok.get("refresh_token", "")
                    exp_tok = raw_tok.get("expiry", "2026-08-18T23:59:59+07:00")
                    oauth_data = {
                        "access_token": access_tok,
                        "refresh_token": refresh_tok,
                        "token_type": raw_tok.get("token_type", "Bearer"),
                        "scope": "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid",
                        "expiry_date": 1789133170339,
                        "token": {
                            "access_token": access_tok,
                            "refresh_token": refresh_tok,
                            "token_type": raw_tok.get("token_type", "Bearer"),
                            "expiry": exp_tok,
                        },
                        "auth_method": auth_meth,
                    }
                    with open(os.path.join(target_dir, "oauth_creds.json"), "w", encoding="utf-8") as f:
                        json.dump(oauth_data, f, indent=2)
                    with open(os.path.join(target_dir, "antigravity-oauth-token"), "w", encoding="utf-8") as f:
                        json.dump({"token": oauth_data["token"], "auth_method": auth_meth}, f, indent=2)
                    token_saved = True

                    if access_tok:
                        try:
                            u_req = urllib.request.Request(
                                "https://www.googleapis.com/oauth2/v3/userinfo",
                                headers={"Authorization": f"Bearer {access_tok}"}
                            )
                            with urllib.request.urlopen(u_req, timeout=5.0) as u_resp:
                                u_data = json.loads(u_resp.read().decode("utf-8"))
                                verified_email = u_data.get("email")
                        except Exception:
                            pass

            if not token_saved:
                try:
                    if os.path.exists(oauth_file):
                        shutil.copy2(oauth_file, os.path.join(target_dir, "oauth_creds.json"))
                    if os.path.exists(accounts_file):
                        shutil.copy2(accounts_file, os.path.join(target_dir, "google_accounts.json"))
                    if os.path.exists(state_file):
                        shutil.copy2(state_file, os.path.join(target_dir, "state.json"))
                except Exception as exc:
                    logger.warning("Could not save profile auth: %s", exc)

            if verified_email:
                with open(os.path.join(target_dir, "google_accounts.json"), "w", encoding="utf-8") as f:
                    json.dump({"active": verified_email, "old": []}, f, indent=2)
                with open(os.path.join(target_dir, "state.json"), "w", encoding="utf-8") as f:
                    json.dump({"active": verified_email}, f, indent=2)

            # 3. Restore original ~/.gemini auth files
            try:
                if os.path.exists(backup_oauth):
                    shutil.move(backup_oauth, oauth_file)
                if os.path.exists(backup_accounts):
                    shutil.move(backup_accounts, accounts_file)
                if os.path.exists(backup_state):
                    shutil.move(backup_state, state_file)
            except Exception as exc:
                logger.warning("Could not restore original auth: %s", exc)

        email = get_profile_account_email(name)
        if email and email != "Not Logged In":
            print(f"\n[SUCCESS] Profile '{name}' login completed (OS: {get_os_type()})! Active Account: {email}\n")
        else:
            print(f"\n[WARNING] Profile '{name}' does not appear to be logged in. Run command again if needed.\n")
        return 0

    elif sub in ("remove", "delete", "rm"):
        if len(argv) < 2:
            print("[Error] Please specify profile name: python3 antigravity_bridge.py profile remove <profile_name>")
            return 1
        name = argv[1].strip()
        target_dir = os.path.join(profiles_dir, name)
        if not os.path.exists(target_dir):
            print(f"[Warning] Profile directory '{target_dir}' does not exist.")
            return 0
        shutil.rmtree(target_dir, ignore_errors=True)
        pm = GLOBAL_PROFILE_MANAGER
        with pm.lock:
            if name in pm.state:
                del pm.state[name]
                pm.save_cache()
        print(f"[SUCCESS] Profile '{name}' deleted successfully.")
        return 0

    elif sub in ("disable", "pause", "block"):
        if len(argv) < 2:
            print("[Error] Please specify profile name: python3 antigravity_bridge.py profile disable <profile_name>")
            return 1
        name = argv[1].strip()
        server_updated = False
        port = 8000
        try:
            req_data = json.dumps({"profile": name}).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/v1/profiles/disable",
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    server_updated = True
        except Exception:
            pass

        pm = GLOBAL_PROFILE_MANAGER
        pm.mark_disabled(name)
        if server_updated:
            print(f"[SUCCESS] Profile '{name}' is now DISABLED on live server and saved persistently to config.")
        else:
            print(f"[SUCCESS] Profile '{name}' is now DISABLED (persisted to config, will remain disabled even after service restarts).")
        return 0

    elif sub in ("enable", "unpause", "resume"):
        if len(argv) < 2:
            print("[Error] Please specify profile name: python3 antigravity_bridge.py profile enable <profile_name>")
            return 1
        name = argv[1].strip()
        server_updated = False
        port = 8000
        try:
            req_data = json.dumps({"profile": name}).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/v1/profiles/enable",
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                if resp.status == 200:
                    server_updated = True
        except Exception:
            pass

        pm = GLOBAL_PROFILE_MANAGER
        pm.enable(name)
        if server_updated:
            print(f"[SUCCESS] Profile '{name}' is now ENABLED on live server and saved persistently to config.")
        else:
            print(f"[SUCCESS] Profile '{name}' is now ENABLED (status reset to OK).")
        return 0

    elif sub in ("test", "check", "probe"):
        target_model = None
        custom_prompt = None
        cleaned_args = list(argv[1:])
        if "--model" in cleaned_args:
            m_idx = cleaned_args.index("--model")
            if m_idx + 1 < len(cleaned_args):
                target_model = cleaned_args[m_idx + 1]
                del cleaned_args[m_idx:m_idx + 2]
        if "--prompt" in cleaned_args:
            p_idx = cleaned_args.index("--prompt")
            if p_idx + 1 < len(cleaned_args):
                custom_prompt = cleaned_args[p_idx + 1]
                del cleaned_args[p_idx:p_idx + 2]

        target_p = cleaned_args[0].strip() if cleaned_args else None
        profiles_to_test = [target_p] if target_p else get_available_profiles()
        cli_bin, cmd_tpl = detect_cli_command()
        pm = GLOBAL_PROFILE_MANAGER

        test_model = target_model or "gemini-3.7-flash"
        test_prompt = custom_prompt or (
            "Explain in 2 clear bullet points why Fibonacci series with memoization is O(N) time complexity."
        )

        model_label = f" (model: {test_model})"
        print(f"\n[INFO] Testing {len(profiles_to_test)} profile(s){model_label} with prompt: \"{test_prompt[:70]}...\"")
        print("=" * 85)
        for p in profiles_to_test:
            email = get_profile_account_email(p)
            p_dir = os.path.expanduser(f"~/.config/antigravity/profiles/{p}") if p else os.path.expanduser("~/.gemini")
            if p and not os.path.exists(p_dir):
                alt = os.path.expanduser(f"~/.config/antigravity/{p}")
                if os.path.exists(alt):
                    p_dir = alt

            tok_snippet = "N/A"
            oauth_f = os.path.join(p_dir, "oauth_creds.json")
            if os.path.exists(oauth_f):
                try:
                    with open(oauth_f, "r", encoding="utf-8") as tf:
                        td = json.load(tf)
                        tok = td.get("access_token") or (td.get("token", {}).get("access_token") if isinstance(td.get("token"), dict) else "")
                        if tok:
                            tok_snippet = f"{tok[:14]}...{tok[-8:]}" if len(tok) > 25 else tok
                except Exception:
                    pass

            print(f"👉 Testing profile '{p or 'default'}' | Email: {email} | Token: {tok_snippet}", flush=True)
            print(f"   Directory: {p_dir}", flush=True)
            ok, msg, resp_text = probe_profile(p, cmd_template=cmd_tpl, model_name=test_model, prompt=test_prompt)
            if ok:
                pm.mark_success(p)
                print(f"   [OK] Available! Latency: {msg}")
                snippet = resp_text.strip().replace("\n", " ")
                if len(snippet) > 180:
                    snippet = snippet[:180] + "..."
                print(f"   💬 Model Response Preview: \"{snippet}\"\n")
            else:
                pm.mark_exhausted(p, msg)
                print(f"   [FAILED] {msg}\n")
        print("=" * 85)
        return 0

    elif sub in ("reset", "unblock"):
        target_p = argv[1].strip() if len(argv) > 1 else None
        pm = GLOBAL_PROFILE_MANAGER
        pm.reset_all(target_p)
        print(f"[SUCCESS] Cooldown reset for: {target_p or 'all profiles'}.")
        return 0

    elif sub in ("refresh", "reauth"):
        print("\n🔄 Antigravity Profile Token Refresher 🔄\n" + "=" * 60)
        profiles = get_available_profiles()
        target_p = argv[1].strip() if len(argv) > 1 else None
        to_refresh = [target_p] if target_p else profiles

        for p in to_refresh:
            print(f"👉 Refreshing Profile '{p}' (OS: {get_os_type()}) via OAuth Exchange...")
            ok, msg = refresh_profile_token(p)
            if ok:
                print(f"   [SUCCESS] {msg}")
            else:
                print(f"   [FAILED] {msg}")
        print("=" * 60 + "\n")
        return 0

    elif sub in ("diag", "doctor", "debug", "info"):
        print("\n🔍 Antigravity Bridge Diagnostic Doctor 🩺\n" + "=" * 60)
        # 1. Check IP and outbound connection
        try:
            req = urllib.request.Request("https://ifconfig.me/ip", headers={"User-Agent": "curl/7.88.1"})
            with urllib.request.urlopen(req, timeout=5) as r:
                out_ip = r.read().decode().strip()
                print(f"🌐 Direct Outbound IP: {out_ip}")
        except Exception as e:
            print(f"🌐 Direct Outbound IP: Error ({e})")

        # 2. Check WARP SOCKS5 proxy
        proxy_url = detect_local_proxy()
        print(f"🛡️  Active Proxy Setting: {proxy_url or 'None (Direct connection)'}")

        # 3. Clean any stale lock/project cache files in ~/.gemini
        gemini_dir = os.path.expanduser("~/.gemini")
        stale_files = ["default-cli-project.json", "default_project_id.txt", "jetski_state.pbtxt", "update.lock", "knowledge.lock"]
        cleaned = []
        for sf in stale_files:
            fp = os.path.join(gemini_dir, sf)
            if os.path.exists(fp):
                try:
                    os.remove(fp)
                    cleaned.append(sf)
                except Exception:
                    pass
        if cleaned:
            print(f"🧹 Cleaned stale project cache files: {cleaned}")

        # 4. Check each profile's token directly with Google OAuth API
        profiles = get_available_profiles()
        print(f"\n📋 Inspecting {len(profiles)} Profile Tokens directly with Google OAuth UserInfo API:")
        for p in profiles:
            p_dir = os.path.expanduser(f"~/.config/antigravity/profiles/{p}") if p else gemini_dir
            if p and not os.path.exists(p_dir):
                alt = os.path.expanduser(f"~/.config/antigravity/{p}")
                if os.path.exists(alt):
                    p_dir = alt
            oauth_file = os.path.join(p_dir, "oauth_creds.json")
            if not os.path.exists(oauth_file):
                print(f"  ❌ Profile '{p}': oauth_creds.json missing at {p_dir}")
                continue
            try:
                with open(oauth_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    tok = data.get("access_token") or (data.get("token", {}).get("access_token") if isinstance(data.get("token"), dict) else "")
                    refresh_tok = data.get("refresh_token") or (data.get("token", {}).get("refresh_token") if isinstance(data.get("token"), dict) else "")
                    acc_email = get_profile_account_email(p)

                    if not tok and not refresh_tok:
                        print(f"  ❌ Profile '{p}': tokens are empty in {oauth_file}")
                        continue

                    # Call Google OAuth UserInfo directly with Bearer token if available
                    if tok:
                        try:
                            ui_req = urllib.request.Request("https://www.googleapis.com/oauth2/v3/userinfo", headers={"Authorization": f"Bearer {tok}"})
                            with urllib.request.urlopen(ui_req, timeout=8) as resp:
                                user_info = json.loads(resp.read().decode("utf-8"))
                                real_email = user_info.get("email")
                                print(f"  ✅ Profile '{p}': Token ACTIVE & VALID! Verified Google Account: {real_email}")
                                continue
                        except urllib.error.HTTPError as he:
                            if he.code == 401:
                                if refresh_tok:
                                    print(f"  🟡 Profile '{p}': Access token expired (normal after 1h) | Refresh Token: READY ✅ | Account: {acc_email}")
                                else:
                                    print(f"  ❌ Profile '{p}': Access token expired (401) and refresh_token is missing")
                            else:
                                print(f"  ⚠️  Profile '{p}': Google OAuth API returned HTTP {he.code}: {he.reason}")
                        except Exception as exc:
                            print(f"  ⚠️  Profile '{p}': UserInfo check error: {exc}")
                    elif refresh_tok:
                        print(f"  🟡 Profile '{p}': Refresh Token READY ✅ (Auto-generates access token on execution) | Account: {acc_email}")
            except Exception as exc:
                print(f"  ❌ Profile '{p}': Token check error: {exc}")
        print("=" * 60 + "\n")
        return 0

    elif sub in ("copy", "sync", "scp"):
        if len(argv) < 2:
            print("[Error] Usage: python3 antigravity_bridge.py profile sync <remote_user@host>")
            print("        Example: python3 antigravity_bridge.py profile sync user@remote-vps")
            return 1

        if len(argv) == 2:
            # Sync ALL profiles (lightweight tar stream of auth JSONs only)
            remote = argv[1].strip()
            profiles = get_available_profiles()
            print(f"[INFO] Syncing {len(profiles)} profile(s) to {remote}...")
            import tempfile, tarfile
            with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp_tar:
                tar_path = tmp_tar.name

            try:
                with tarfile.open(tar_path, "w:gz") as tar:
                    for p in profiles:
                        p_dir = os.path.join(profiles_dir, p)
                        for f in ("oauth_creds.json", "google_accounts.json", "state.json"):
                            fp = os.path.join(p_dir, f)
                            if os.path.exists(fp):
                                tar.add(fp, arcname=f"{p}/{f}")

                remote_cmd = "mkdir -p ~/.config/antigravity/profiles && tar -xzf - -C ~/.config/antigravity/profiles"
                with open(tar_path, "rb") as tar_in:
                    ssh_proc = subprocess.run(["ssh", remote, remote_cmd], stdin=tar_in)

                if ssh_proc.returncode == 0:
                    print(f"[SUCCESS] All {len(profiles)} profiles synced to {remote} successfully!")
                else:
                    print(f"[Error] Sync failed with exit code {ssh_proc.returncode}")
                return ssh_proc.returncode
            finally:
                if os.path.exists(tar_path):
                    os.remove(tar_path)

        name = argv[1].strip()
        remote = argv[2].strip()
        source_dir = os.path.join(profiles_dir, name)
        if not os.path.exists(source_dir):
            print(f"[Error] Local profile '{name}' not found at {source_dir}")
            return 1

        remote_dest = f"{remote}:~/.config/antigravity/profiles/"
        print(f"[INFO] Copying profile '{name}' to {remote_dest}...")
        res = subprocess.call(["scp", "-r", source_dir, remote_dest])
        if res == 0:
            print(f"[SUCCESS] Profile '{name}' successfully copied to {remote}!")
        else:
            print(f"[Error] scp failed with exit code {res}")
        return res

    else:
        print(f"[Error] Unknown profile command '{sub}'. Run 'python3 antigravity_bridge.py profile --help' for usage.")
        return 1


def main():
    # Handle Profile & Diagnostic CLI subcommands before parser
    known_subs = {
        "profile", "profiles", "login", "auth", "diag", "doctor", "debug", "info",
        "test", "check", "probe", "reset", "unblock", "refresh", "reauth", "sync",
        "list", "ls", "disable", "enable", "remove", "delete", "rm"
    }
    if len(sys.argv) > 1 and sys.argv[1].lower() in known_subs:
        if sys.argv[1].lower() in ("profile", "profiles"):
            sub_args = sys.argv[2:]
        else:
            sub_args = sys.argv[1:]
        sys.exit(handle_profile_cli(sub_args))

    parser = argparse.ArgumentParser(
        description="Antigravity / agy OpenAI & Anthropic compatible API Bridge Server"
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host address to bind to (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--cmd", default=None, help="Custom CLI command template (e.g. 'agy -p \"{prompt}\"')")
    parser.add_argument("--profiles", default=None, help="Comma-separated list of profile names to try for fallback")
    parser.add_argument("--cooldown-sec", type=float, default=300.0, help="Base cooldown seconds for exhausted profiles (default: 300)")
    parser.add_argument("--profile-timeout", type=float, default=DEFAULT_PROFILE_TIMEOUT, help=f"Execution timeout per profile attempt in seconds (default: {int(DEFAULT_PROFILE_TIMEOUT)})")
    parser.add_argument("--total-timeout", type=float, default=DEFAULT_TOTAL_TIMEOUT, help=f"Total execution timeout across all profile fallback attempts in seconds (default: {int(DEFAULT_TOTAL_TIMEOUT)})")
    parser.add_argument("--quota-cache", default=DEFAULT_QUOTA_CACHE_FILE, help=f"Path to quota cache JSON file (default: {DEFAULT_QUOTA_CACHE_FILE})")
    parser.add_argument("--check-profiles-on-start", action="store_true", help="Probe profile availability actively on startup")
    parser.add_argument("--api-key", default=os.environ.get("ANTIGRAVITY_BRIDGE_API_KEY"), help="API Key for authentication")
    parser.add_argument("--enable-cors", "--cors", action="store_true", help="Enable wildcard CORS headers (Access-Control-Allow-Origin: *)")
    parser.add_argument("--image-router-url", default=DEFAULT_IMAGE_ROUTER_URL, help=f"Image generation router URL (default: {DEFAULT_IMAGE_ROUTER_URL})")
    parser.add_argument("--image-router-key", default=DEFAULT_IMAGE_ROUTER_KEY, help="API Key for image generation router")
    parser.add_argument("--no-proxy", "--direct", action="store_true", help="Disable outbound proxy auto-detection and connect directly to Google")
    parser.add_argument("--hide-profile-status", "--no-profile-status", action="store_true", help="Hide profile & quota status footer from assistant responses")
    parser.add_argument("--profile-concurrency", type=int, default=int(os.environ.get("ANTIGRAVITY_PROFILE_CONCURRENCY", "1")), help="Max concurrent requests per profile (default: 1)")
    parser.add_argument("--auto-refresh-min", type=float, default=55.0, help="Interval in minutes for automatic background token refresh (default: 55)")
    parser.add_argument("--no-auto-refresh", action="store_true", help="Disable periodic background OAuth token refresh")

    args = parser.parse_args()

    if args.no_proxy:
        os.environ["ANTIGRAVITY_NO_PROXY"] = "1"

    cli_bin, cmd_tpl = detect_cli_command()
    effective_cmd = args.cmd or cmd_tpl

    configured_profiles = [p.strip() for p in args.profiles.split(",") if p.strip()] if args.profiles else get_available_profiles()

    env_concurrency = os.environ.get("ANTIGRAVITY_PROFILE_CONCURRENCY")
    effective_concurrency = int(env_concurrency) if env_concurrency else args.profile_concurrency

    profile_manager = ProfileManager(
        profiles=configured_profiles,
        cache_file=args.quota_cache,
        default_cooldown=args.cooldown_sec,
        concurrency_per_profile=effective_concurrency,
    )

    if args.check_profiles_on_start:
        logger.info("Probing configured profiles on startup...")
        for p in configured_profiles:
            ok, msg = probe_profile(p, cmd_template=effective_cmd)
            if ok:
                profile_manager.mark_success(p)
                logger.info("Profile '%s' probe: OK (%s)", p or "default", msg)
            else:
                profile_manager.mark_exhausted(p, msg)
                logger.warning("Profile '%s' probe: FAILED (%s)", p or "default", msg)

    show_profile_status = not (
        args.hide_profile_status
        or os.environ.get("ANTIGRAVITY_HIDE_PROFILE_STATUS", "").lower() in ("1", "true", "yes")
        or os.environ.get("ANTIGRAVITY_SHOW_PROFILE_STATUS", "").lower() in ("0", "false", "no")
    )

    auto_refresh_sec = 0.0 if (args.no_auto_refresh or os.environ.get("ANTIGRAVITY_NO_AUTO_REFRESH", "").lower() in ("1", "true", "yes")) else (args.auto_refresh_min * 60.0)

    max_concurrent_capacity = len(configured_profiles) * max(1, effective_concurrency)
    logger.info("Starting Antigravity API Bridge Server...")
    logger.info("Detected CLI Binary: %s", cli_bin)
    logger.info("Command Template:   %s", effective_cmd)
    logger.info("Configured Profiles: %s", configured_profiles)
    logger.info("Concurrency Pool:    %d total parallel capacity (%d request(s) per profile)", max_concurrent_capacity, effective_concurrency)
    logger.info("Quota Cache File:   %s", profile_manager.cache_file)
    logger.info("Profile Timeout:    %.1fs per profile attempt", args.profile_timeout)
    logger.info("Total Timeout:      %.1fs total fallback budget", args.total_timeout)
    logger.info("Profile Status Foot: %s", "ENABLED" if show_profile_status else "DISABLED")
    logger.info("Token Auto-Refresh:  %s", f"ENABLED (every {int(args.auto_refresh_min)} min)" if auto_refresh_sec > 0 else "DISABLED")
    logger.info("Image Generation:   ENABLED (model: gemini-3.1-flash-image / 9router)")
    logger.info("Listening on:       http://%s:%d/v1", args.host, args.port)

    server = ThreadedHTTPServer((args.host, args.port), AntigravityBridgeHandler)
    server.custom_cmd = effective_cmd
    server.profiles = configured_profiles
    server.profile_manager = profile_manager
    server.show_profile_status = show_profile_status
    server.api_key = args.api_key
    server.enable_cors = args.enable_cors
    server.image_router_url = args.image_router_url
    server.image_router_key = args.image_router_key
    server.profile_timeout = args.profile_timeout
    server.total_timeout = args.total_timeout

    if auto_refresh_sec > 0:
        start_token_refresh_daemon(server, interval_seconds=auto_refresh_sec)

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
