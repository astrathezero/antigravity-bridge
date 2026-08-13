"""Unit tests for Antigravity / agy OpenAI API Bridge Server."""

import json
import os
import shutil
import unittest
import urllib.request
from unittest.mock import MagicMock, patch

from antigravity_bridge import (
    AntigravityBridgeHandler,
    ThreadedHTTPServer,
    detect_cli_command,
    execute_cli_command,
    execute_cli_with_fallback,
    format_messages_to_prompt,
    get_available_profiles,
)


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

    def test_detect_cli_command(self):
        """Test auto-detection of local CLI binary."""
        with patch("os.path.exists", return_value=False), patch("shutil.which") as mock_which:
            mock_which.side_effect = lambda bin_name: "/usr/local/bin/agy" if bin_name == "agy" else None
            binary, tpl = detect_cli_command()
            self.assertEqual(binary, "agy")
            self.assertIn("agy --dangerously-skip-permissions -p", tpl)

    @patch("subprocess.Popen")
    def test_execute_cli_command_with_profile(self, mock_popen):
        """Test CLI command execution with ANTIGRAVITY_PROFILE env setting."""
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.communicate.return_value = ("CLI execution output", "")
        mock_popen.return_value = mock_proc

        output = execute_cli_command('echo "{prompt}"', "Hello world", profile="test_profile")
        self.assertEqual(output, "CLI execution output")
        mock_popen.assert_called_once()
        _, kwargs = mock_popen.call_args
        self.assertEqual(kwargs.get("env", {}).get("ANTIGRAVITY_PROFILE"), "test_profile")

    def test_execute_cli_with_fallback_profile(self):
        """Test profile fallback when first profile fails and second succeeds."""
        def side_effect(cmd, prompt, timeout=180.0, profile=None):
            if profile == "p1":
                raise RuntimeError("Rate limit on p1")
            if profile == "p2":
                return "Output from p2"
            raise RuntimeError("Unknown profile")

        with patch("antigravity_bridge.execute_cli_command", side_effect=side_effect):
            output, used_profile = execute_cli_with_fallback('echo "{prompt}"', "test", profiles=["p1", "p2"])
            self.assertEqual(output, "Output from p2")
            self.assertEqual(used_profile, "p2")

    def test_server_http_endpoints(self):
        """Test HTTP server endpoints /health, /v1/models, and /v1/chat/completions."""
        server = ThreadedHTTPServer(("127.0.0.1", 0), AntigravityBridgeHandler)
        server.profiles = ["default_test"]
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

            # 3. Test /v1/chat/completions POST (mocking subprocess execution)
            chat_url = f"http://127.0.0.1:{port}/v1/chat/completions"
            req_data = json.dumps({
                "model": "antigravity",
                "messages": [{"role": "user", "content": "Hello"}],
            }).encode("utf-8")

            with patch("antigravity_bridge.execute_cli_command", return_value="Bridge response"):
                req = urllib.request.Request(chat_url, data=req_data, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["object"], "chat.completion")
                    self.assertEqual(resp_json["choices"][0]["message"]["content"], "Bridge response")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
