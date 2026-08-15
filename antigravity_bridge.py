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
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any, Dict, List, Optional, Tuple


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

logger = logging.getLogger("antigravity_bridge")

MAX_BODY_SIZE = 32 * 1024 * 1024  # 32 MB limit

SUPPORTED_MODELS = {
    "gemini-3.7-flash-high": ("gemini-3.7-flash", "high"),
    "gemini-3.7-flash-medium": ("gemini-3.7-flash", "medium"),
    "gemini-3.7-flash-low": ("gemini-3.7-flash", "low"),
    "gemini-3.7-flash": ("gemini-3.7-flash", None),
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
    "imagen-3.0-generate-002": ("imagen-3.0-generate-002", None),
    "imagen-3.0-fast-generate-001": ("imagen-3.0-fast-generate-001", None),
    "imagen-3": ("imagen-3.0-generate-002", None),
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


def format_messages_to_prompt(messages: List[Dict[str, Any]]) -> str:
    """Format OpenAI/Anthropic messages list into a prompt string for CLI tools."""
    if not messages:
        return ""

    if len(messages) == 1 and isinstance(messages[0], dict) and messages[0].get("role") == "user":
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
        if not isinstance(msg, dict):
            continue
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

    if "gemini-3.7-flash" in model_lower:
        flags.extend(["--model", "gemini-3.7-flash"])
    elif "gemini-3.6-flash" in model_lower:
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
            timeout=180.0,
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
            is_image_gen = path in ("/v1/images/generations", "/images/generations")

            if not (is_openai or is_anthropic or is_image_gen):
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

            # --- Handle Image Generation format (/v1/images/generations) ---
            if is_image_gen:
                prompt = req_json.get("prompt")
                if not prompt or not isinstance(prompt, str) or not prompt.strip():
                    self._send_json_response(
                        {"error": {"message": "'prompt' field is required and must be a non-empty string", "type": "invalid_request_error"}},
                        status_code=400,
                    )
                    return

                raw_model = (req_json.get("model") or "imagen-3.0-generate-002").strip()
                if raw_model in ("imagen-3", "imagen"):
                    img_model = "imagen-3.0-generate-002"
                elif raw_model in SUPPORTED_MODELS and raw_model.startswith("imagen-"):
                    img_model = raw_model
                else:
                    img_model = raw_model

                try:
                    n = max(1, min(int(req_json.get("n", 1)), 4))
                except (ValueError, TypeError):
                    n = 1

                size = req_json.get("size")
                aspect_ratio = req_json.get("aspect_ratio")
                if not aspect_ratio and size:
                    aspect_ratio = IMAGE_SIZE_TO_ASPECT_RATIO.get(str(size), "1:1")
                if not aspect_ratio:
                    aspect_ratio = "1:1"

                output_mime = req_json.get("output_mime_type") or "image/jpeg"
                if output_mime not in ("image/jpeg", "image/png"):
                    output_mime = "image/jpeg"

                auth_header = self.headers.get("Authorization", "")
                auth_token = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""

                image_results = None
                # Tier 1: Try direct Google Imagen 3 API if API key is available
                try:
                    resolved_key = resolve_gemini_api_key(client_key=auth_token)
                    if resolved_key:
                        image_results = generate_image_with_imagen(
                            prompt=prompt.strip(),
                            model=img_model,
                            sample_count=n,
                            aspect_ratio=aspect_ratio,
                            output_mime_type=output_mime,
                            api_key=resolved_key,
                        )
                except Exception as e:
                    logger.warning("Imagen API direct generation failed: %s — falling back to agy CLI", e)

                # Tier 2: Fallback to local agy CLI (gemini-3.1-flash-image)
                if not image_results:
                    try:
                        _, cmd_tpl = detect_cli_command()
                        custom_tpl = getattr(self.server, "custom_cmd", None) or cmd_tpl
                        configured_profiles = getattr(self.server, "profiles", None)
                        image_results = generate_image_with_agy(
                            prompt=prompt.strip(),
                            aspect_ratio=aspect_ratio,
                            cmd_template=custom_tpl,
                            profiles=configured_profiles,
                        )
                    except Exception as exc:
                        logger.error("All image generation methods failed: %s", exc)
                        self._send_json_response(
                            {"error": {"message": str(exc), "type": "api_error"}},
                            status_code=500,
                        )
                        return


                self._send_json_response({
                    "created": int(time.time()),
                    "data": image_results,
                })
                return


            messages = req_json.get("messages", [])
            if not isinstance(messages, list):
                self._send_json_response(
                    {"error": {"message": "'messages' field must be a list of message objects", "type": "invalid_request_error"}},
                    status_code=400,
                )
                return


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

            prompt_text = format_messages_to_prompt(messages)
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

            # --- Handle Anthropic API format (/v1/messages) ---
            if is_anthropic:
                msg_id = f"msg-{uuid.uuid4().hex[:8]}"
                if stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    if getattr(self.server, "enable_cors", False):
                        self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()

                    events = [
                        ("message_start", {"type": "message_start", "message": {"id": msg_id, "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": len(prompt_text) // 4, "output_tokens": 1}}}),
                        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": output_text}}),
                        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": len(output_text) // 4}}),
                        ("message_stop", {"type": "message_stop"}),
                    ]
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
                    "content": [{"type": "text", "text": output_text}],
                    "stop_reason": "end_turn",
                    "stop_sequence": None,
                    "usage": {"input_tokens": len(prompt_text) // 4, "output_tokens": len(output_text) // 4},
                }
                self._send_json_response(response_payload)
                return

            # --- Handle OpenAI API format (/v1/chat/completions) ---
            completion_id = f"chatcmpl-ag-{uuid.uuid4().hex[:8]}"

            if stream:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                if getattr(self.server, "enable_cors", False):
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
                try:
                    self.wfile.write(f"data: {json.dumps(chunk_start)}\n\n".encode("utf-8"))
                    self.wfile.write(f"data: {json.dumps(chunk_stop)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    logger.warning("Client disconnected during OpenAI SSE stream")
                return

            # Standard OpenAI non-streaming response
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
