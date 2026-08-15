"""Unit tests for Antigravity / agy API Bridge Server."""

import json
import os
import shutil
import sys
import unittest
import urllib.request
from unittest.mock import MagicMock, patch

# Allow import from current dir or scripts dir
try:
    import antigravity_bridge
except ImportError:
    from scripts import antigravity_bridge

AntigravityBridgeHandler = antigravity_bridge.AntigravityBridgeHandler
ThreadedHTTPServer = antigravity_bridge.ThreadedHTTPServer
detect_cli_command = antigravity_bridge.detect_cli_command
execute_cli_command = antigravity_bridge.execute_cli_command
execute_cli_with_fallback = antigravity_bridge.execute_cli_with_fallback
format_messages_to_prompt = antigravity_bridge.format_messages_to_prompt
get_available_profiles = antigravity_bridge.get_available_profiles
normalize_tools = antigravity_bridge.normalize_tools
format_tools_to_system_prompt = antigravity_bridge.format_tools_to_system_prompt
parse_tool_calls_from_response = antigravity_bridge.parse_tool_calls_from_response


class TestAntigravityBridge(unittest.TestCase):
    """Test suite for Antigravity API Bridge Server."""

    def test_format_messages_to_prompt(self):
        """Test formatting OpenAI messages into prompt text."""
        messages = [
            {"role": "system", "content": "System directive"},
            {"role": "user", "content": "User query"},
        ]
        prompt = format_messages_to_prompt(messages)
        self.assertIn("[System Instructions]\nSystem directive", prompt)
        self.assertIn("[User]\nUser query", prompt)

    def test_normalize_tools(self):
        """Test normalizing OpenAI tools, legacy functions, and Anthropic tools."""
        openai_tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather info",
                    "parameters": {
                        "type": "object",
                        "properties": {"location": {"type": "string"}},
                        "required": ["location"],
                    },
                },
            }
        ]
        anthropic_tools = [
            {
                "name": "search_db",
                "description": "Search database",
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                },
            }
        ]
        functions = [
            {
                "name": "calc",
                "description": "Calculate math expression",
                "parameters": {"type": "object", "properties": {"expr": {"type": "string"}}},
            }
        ]

        norm_openai = normalize_tools(tools=openai_tools)
        self.assertEqual(len(norm_openai), 1)
        self.assertEqual(norm_openai[0]["name"], "get_weather")
        self.assertIn("location", norm_openai[0]["parameters"]["properties"])

        norm_anthropic = normalize_tools(tools=anthropic_tools)
        self.assertEqual(len(norm_anthropic), 1)
        self.assertEqual(norm_anthropic[0]["name"], "search_db")

        norm_mixed = normalize_tools(tools=openai_tools, functions=functions)
        self.assertEqual(len(norm_mixed), 2)
        names = [item["name"] for item in norm_mixed]
        self.assertIn("get_weather", names)
        self.assertIn("calc", names)

    def test_format_tools_to_system_prompt(self):
        """Test generating tool prompt instructions."""
        tools = [
            {
                "name": "get_weather",
                "description": "Get weather",
                "parameters": {"type": "object", "properties": {"location": {"type": "string"}}},
            }
        ]
        prompt_auto = format_tools_to_system_prompt(tools, tool_choice="auto")
        self.assertIn("[Available Tools & Functions]", prompt_auto)
        self.assertIn("get_weather", prompt_auto)
        self.assertIn("tool_calls", prompt_auto)

        prompt_none = format_tools_to_system_prompt(tools, tool_choice="none")
        self.assertEqual(prompt_none, "")

        prompt_required = format_tools_to_system_prompt(tools, tool_choice="required")
        self.assertIn("CRITICAL: You MUST call at least one tool", prompt_required)

        prompt_forced = format_tools_to_system_prompt(
            tools, tool_choice={"type": "function", "function": {"name": "get_weather"}}
        )
        self.assertIn("CRITICAL: You MUST call the tool 'get_weather'", prompt_forced)

    def test_parse_tool_calls_from_response(self):
        """Test parsing tool calls from various model output formats."""
        # 1. JSON code block with tool_calls list
        output_1 = (
            'I will check the weather.\n```json\n'
            '{\n  "tool_calls": [\n    {"name": "get_weather", "arguments": {"location": "Bangkok"}}\n  ]\n}\n```'
        )
        text_1, calls_1 = parse_tool_calls_from_response(output_1)
        self.assertEqual(text_1, "I will check the weather.")
        self.assertIsNotNone(calls_1)
        self.assertEqual(len(calls_1), 1)
        self.assertEqual(calls_1[0]["name"], "get_weather")
        self.assertEqual(calls_1[0]["arguments"], {"location": "Bangkok"})

        # 2. Raw JSON string
        output_2 = '{"tool_calls": [{"name": "search", "arguments": {"query": "python"}}]}'
        text_2, calls_2 = parse_tool_calls_from_response(output_2)
        self.assertIsNone(text_2)
        self.assertEqual(len(calls_2), 1)
        self.assertEqual(calls_2[0]["name"], "search")
        self.assertEqual(calls_2[0]["arguments"], {"query": "python"})

        # 3. XML style tool call
        output_3 = 'Let me run that.<tool_call>{"name": "exec_cmd", "arguments": {"cmd": "ls"}}</tool_call>'
        text_3, calls_3 = parse_tool_calls_from_response(output_3)
        self.assertEqual(text_3, "Let me run that.")
        self.assertEqual(len(calls_3), 1)
        self.assertEqual(calls_3[0]["name"], "exec_cmd")
        self.assertEqual(calls_3[0]["arguments"], {"cmd": "ls"})

        # 4. Normal text (no tool call)
        output_4 = "Hello, how are you today?"
        text_4, calls_4 = parse_tool_calls_from_response(output_4)
        self.assertEqual(text_4, "Hello, how are you today?")
        self.assertIsNone(calls_4)

    def test_format_messages_with_tool_history(self):
        """Test multi-turn tool call history in messages."""
        messages = [
            {"role": "user", "content": "What is the weather in Tokyo?"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_123",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"location": "Tokyo"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_123",
                "name": "get_weather",
                "content": '{"temperature": "22C", "condition": "Sunny"}',
            },
        ]
        prompt = format_messages_to_prompt(messages)
        self.assertIn("[User]\nWhat is the weather in Tokyo?", prompt)
        self.assertIn("[Tool Call: get_weather({\"location\": \"Tokyo\"})]", prompt)
        self.assertIn("[Tool Result (call_123)]\n{\"temperature\": \"22C\", \"condition\": \"Sunny\"}", prompt)

    def test_detect_cli_command(self):
        """Test auto-detection of local CLI binary."""
        with patch("os.path.exists", return_value=False), patch("shutil.which") as mock_which:
            mock_which.side_effect = lambda bin_name: "/usr/local/bin/agy" if bin_name == "agy" else None
            binary, tpl = detect_cli_command()
            self.assertEqual(binary, "agy")
            self.assertIn("agy", tpl)

    @patch("subprocess.Popen")
    def test_execute_cli_command_with_profile(self, mock_popen):
        """Test CLI command execution with ANTIGRAVITY_PROFILE env setting."""
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.communicate.return_value = ("CLI execution output", "")
        mock_popen.return_value = mock_proc

        output = execute_cli_command('echo "{prompt}"', "Hello world", profile="astrathezero")
        self.assertEqual(output, "CLI execution output")
        mock_popen.assert_called_once()
        _, kwargs = mock_popen.call_args
        self.assertEqual(kwargs.get("env", {}).get("ANTIGRAVITY_PROFILE"), "astrathezero")

    def test_execute_cli_with_fallback_profile(self):
        """Test profile fallback when first profile fails and second succeeds."""
        def side_effect(cmd, prompt, timeout=180.0, profile=None, **kwargs):
            if profile == "p1":
                raise RuntimeError("Rate limit on p1")
            if profile == "p2":
                return "Output from p2"
            raise RuntimeError("Unknown profile")

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=side_effect):
            output, used_profile = execute_cli_with_fallback('echo "{prompt}"', "test", profiles=["p1", "p2"])
            self.assertEqual(output, "Output from p2")
            self.assertEqual(used_profile, "p2")

    def test_server_http_endpoints(self):
        """Test HTTP server endpoints /health, /v1/models, /v1/chat/completions, /v1/messages."""
        server = ThreadedHTTPServer(("127.0.0.1", 0), AntigravityBridgeHandler)
        server.profiles = ["default_test"]
        server.api_key = None
        server.enable_cors = False
        port = server.server_port

        import threading
        thread = threading.Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()

        try:
            # 1. Test /health
            health_url = f"http://127.0.0.1:{port}/health"
            with urllib.request.urlopen(health_url) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(data["status"], "ok")
                self.assertEqual(data["service"], "antigravity-bridge")

            # 2. Test /v1/models
            models_url = f"http://127.0.0.1:{port}/v1/models"
            with urllib.request.urlopen(models_url) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(data["object"], "list")
                model_ids = [m["id"] for m in data["data"]]
                self.assertIn("antigravity", model_ids)
                self.assertIn("agy", model_ids)

            # 3. Test /v1/chat/completions POST (OpenAI format without tools)
            chat_url = f"http://127.0.0.1:{port}/v1/chat/completions"
            req_data = json.dumps({
                "model": "antigravity",
                "messages": [{"role": "user", "content": "Hello"}],
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "execute_cli_command", return_value="Bridge response"):
                req = urllib.request.Request(chat_url, data=req_data, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["object"], "chat.completion")
                    self.assertEqual(resp_json["choices"][0]["message"]["content"], "Bridge response")
                    self.assertEqual(resp_json["choices"][0]["finish_reason"], "stop")

            # 4. Test /v1/chat/completions POST (OpenAI format WITH tool calling)
            tool_call_cli_output = '```json\n{\n  "tool_calls": [\n    {"name": "get_weather", "arguments": {"location": "London"}}\n  ]\n}\n```'
            req_data_tools = json.dumps({
                "model": "gemini-3.6-flash-high",
                "messages": [{"role": "user", "content": "What is the weather in London?"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "description": "Get weather",
                            "parameters": {"type": "object", "properties": {"location": {"type": "string"}}},
                        },
                    }
                ],
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "execute_cli_command", return_value=tool_call_cli_output):
                req = urllib.request.Request(chat_url, data=req_data_tools, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["choices"][0]["finish_reason"], "tool_calls")
                    self.assertIn("tool_calls", resp_json["choices"][0]["message"])
                    tc = resp_json["choices"][0]["message"]["tool_calls"][0]
                    self.assertEqual(tc["function"]["name"], "get_weather")
                    self.assertEqual(json.loads(tc["function"]["arguments"]), {"location": "London"})

            # 5. Test /v1/messages POST (Anthropic format WITH tool calling)
            messages_url = f"http://127.0.0.1:{port}/v1/messages"
            anthropic_tool_req = json.dumps({
                "model": "claude-sonnet-4.6-thinking",
                "messages": [{"role": "user", "content": "Check London weather"}],
                "tools": [
                    {
                        "name": "get_weather",
                        "description": "Get weather",
                        "input_schema": {"type": "object", "properties": {"location": {"type": "string"}}},
                    }
                ],
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "execute_cli_command", return_value=tool_call_cli_output):
                req = urllib.request.Request(messages_url, data=anthropic_tool_req, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["type"], "message")
                    self.assertEqual(resp_json["stop_reason"], "tool_use")
                    tool_blocks = [b for b in resp_json["content"] if b["type"] == "tool_use"]
                    self.assertEqual(len(tool_blocks), 1)
                    self.assertEqual(tool_blocks[0]["name"], "get_weather")
                    self.assertEqual(tool_blocks[0]["input"], {"location": "London"})

            # 6. Test /v1/chat/completions Streaming WITH tool calling
            req_data_stream = json.dumps({
                "model": "gemini-3.6-flash-high",
                "messages": [{"role": "user", "content": "What is the weather in London?"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "parameters": {"type": "object", "properties": {"location": {"type": "string"}}},
                        },
                    }
                ],
                "stream": True,
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "execute_cli_command", return_value=tool_call_cli_output):
                req = urllib.request.Request(chat_url, data=req_data_stream, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    lines = []
                    while True:
                        line = resp.readline().decode("utf-8")
                        if not line:
                            break
                        lines.append(line)
                        if "[DONE]" in line:
                            break
                    stream_data = "".join(lines)
                    self.assertIn("data: ", stream_data)
                    self.assertIn("[DONE]", stream_data)
                    self.assertIn("tool_calls", stream_data)
                    self.assertIn("get_weather", stream_data)

            # 7. Test /v1/messages Streaming WITH tool calling
            anthropic_stream_req = json.dumps({
                "model": "claude-sonnet-4.6-thinking",
                "messages": [{"role": "user", "content": "Check London weather"}],
                "tools": [
                    {
                        "name": "get_weather",
                        "input_schema": {"type": "object", "properties": {"location": {"type": "string"}}},
                    }
                ],
                "stream": True,
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "execute_cli_command", return_value=tool_call_cli_output):
                req = urllib.request.Request(messages_url, data=anthropic_stream_req, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    lines = []
                    while True:
                        line = resp.readline().decode("utf-8")
                        if not line:
                            break
                        lines.append(line)
                        if "message_stop" in line:
                            break
                    stream_data = "".join(lines)
                    self.assertIn("event: content_block_start", stream_data)
                    self.assertIn("tool_use", stream_data)
                    self.assertIn("get_weather", stream_data)

        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
