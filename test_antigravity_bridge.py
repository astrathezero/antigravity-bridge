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
ProfileManager = antigravity_bridge.ProfileManager
is_quota_or_rate_limit_error = antigravity_bridge.is_quota_or_rate_limit_error
probe_profile = antigravity_bridge.probe_profile
resolve_model_flags = antigravity_bridge.resolve_model_flags


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
            self.assertIn("agy", tpl)

    @patch("subprocess.Popen")
    def test_execute_cli_command_with_profile(self, mock_popen):
        """Test CLI command execution with ANTIGRAVITY_PROFILE env setting."""
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.communicate.return_value = ("CLI execution output", "")
        mock_popen.return_value = mock_proc

        with patch.object(antigravity_bridge, "sync_profile_to_system", return_value=("test@gmail.com", "ya29.test")):
            output = execute_cli_command('echo "{prompt}"', "Hello world", profile="astrathezero")
            self.assertEqual(output, "CLI execution output")
            mock_popen.assert_called_once()
            _, kwargs = mock_popen.call_args
            self.assertEqual(kwargs.get("env", {}).get("ANTIGRAVITY_PROFILE"), "astrathezero")

    def test_is_quota_or_rate_limit_error(self):
        """Test detecting quota exhaustion and rate limit error patterns."""
        self.assertTrue(is_quota_or_rate_limit_error("Error 429: Too Many Requests"))
        self.assertTrue(is_quota_or_rate_limit_error("RESOURCE_EXHAUSTED: Quota exceeded for model"))
        self.assertTrue(is_quota_or_rate_limit_error("insufficient_quota on user account"))
        self.assertTrue(is_quota_or_rate_limit_error("Rate limit reached for profile astrathezero"))
        self.assertTrue(is_quota_or_rate_limit_error("You have exceeded your current quota"))
        self.assertTrue(is_quota_or_rate_limit_error("out of credits"))
        self.assertTrue(is_quota_or_rate_limit_error("model overloaded"))
        self.assertTrue(is_quota_or_rate_limit_error("503 Service Unavailable"))
        self.assertFalse(is_quota_or_rate_limit_error("SyntaxError: invalid syntax"))
        self.assertFalse(is_quota_or_rate_limit_error("FileNotFoundError: file not found"))

    def test_profile_manager_lifecycle_and_cache(self):
        """Test ProfileManager cooldown tracking and cache persistence."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name

        try:
            pm = ProfileManager(profiles=["p1", "p2", "p3"], cache_file=cache_file, default_cooldown=100.0)
            self.assertFalse(pm.is_in_cooldown("p1"))

            # Mark p1 exhausted
            pm.mark_exhausted("p1", "Rate limit 429")
            self.assertTrue(pm.is_in_cooldown("p1"))
            self.assertFalse(pm.is_in_cooldown("p2"))

            # Mark p2 success
            pm.mark_success("p2")
            self.assertEqual(pm.state["p2"]["status"], "OK")
            self.assertEqual(pm.state["p2"]["success_count"], 1)

            # Check cache saved and can be reloaded
            pm2 = ProfileManager(profiles=["p1", "p2", "p3"], cache_file=cache_file)
            self.assertTrue(pm2.is_in_cooldown("p1"))
            self.assertEqual(pm2.state["p2"]["success_count"], 1)

            # Reset p1
            pm2.reset_all("p1")
            self.assertFalse(pm2.is_in_cooldown("p1"))
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_profile_quota_banner_and_duration_format(self):
        """Test human-readable cooldown duration and quota banner formatting."""
        format_cooldown = antigravity_bridge.format_cooldown_duration
        self.assertEqual(format_cooldown(45), "45s")
        self.assertEqual(format_cooldown(125), "2m 5s")
        self.assertEqual(format_cooldown(3665), "1h 1m 5s")

        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        try:
            pm = ProfileManager(profiles=["p1", "p2"], cache_file=cache_file)
            pm.mark_success("p1")
            pm.mark_exhausted("p2", "Rate limit exceeded", cooldown_seconds=300)
            banner = pm.build_profile_quota_banner("p1")
            self.assertIn("Antigravity Profile:** `p1`", banner)
            self.assertIn("1/2** Profiles Ready", banner)
            self.assertIn("in Cooldown", banner)
            self.assertIn("p2", banner)
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_smart_profile_ordering_and_rotation(self):
        """Test that healthy profiles come first and exhausted profiles are placed last."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        try:
            pm = ProfileManager(profiles=["astrathezero", "mrsermshop", "attasitgits"], cache_file=cache_file)
            pm.mark_exhausted("astrathezero", "429 Quota Exceeded")
            pm.mark_exhausted("mrsermshop", "ResourceExhausted")

            # Fast path: only healthy profiles returned when available
            ordered = pm.get_ordered_profiles()
            self.assertEqual(ordered, ["attasitgits"])

            # When all are exhausted, fallback returns all sorted by earliest cooldown
            pm.mark_exhausted("attasitgits", "ResourceExhausted")
            fallback_ordered = pm.get_ordered_profiles()
            self.assertEqual(len(fallback_ordered), 3)
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_execute_cli_with_smart_fallback(self):
        """Test that execute_cli_with_fallback immediately routes to healthy profile."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        try:
            pm = ProfileManager(profiles=["astrathezero", "mrsermshop", "attasitgits"], cache_file=cache_file)
            attempts = []

            def side_effect(cmd, prompt, timeout=60.0, profile=None, **kwargs):
                attempts.append(profile)
                if profile in ("astrathezero", "mrsermshop"):
                    raise RuntimeError(f"RESOURCE_EXHAUSTED on {profile}")
                if profile == "attasitgits":
                    return "Output from attasitgits"
                raise RuntimeError(f"Unknown profile {profile}")

            with patch.object(antigravity_bridge, "execute_cli_command", side_effect=side_effect):
                # 1. First call: astrathezero and mrsermshop fail with quota error, attasitgits succeeds
                output1, used_profile1 = execute_cli_with_fallback('echo "{prompt}"', "test", profile_manager=pm)
                self.assertEqual(output1, "Output from attasitgits")
                self.assertEqual(used_profile1, "attasitgits")
                self.assertEqual(attempts, ["astrathezero", "mrsermshop", "attasitgits"])

                # 2. Second call: astrathezero and mrsermshop are now IN COOLDOWN!
                # It must execute attasitgits directly without trying astrathezero or mrsermshop first!
                attempts.clear()
                output2, used_profile2 = execute_cli_with_fallback('echo "{prompt}"', "test", profile_manager=pm)
                self.assertEqual(output2, "Output from attasitgits")
                self.assertEqual(used_profile2, "attasitgits")
                self.assertEqual(attempts, ["attasitgits"])
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_resolve_model_flags(self):
        """Test model flag mapping with reasoning effort defaults."""
        flags_37 = resolve_model_flags("gemini-3.7-flash")
        self.assertEqual(flags_37, ["--model", "gemini-3.7-flash", "--effort", "high"])

        flags_37_low = resolve_model_flags("gemini-3.7-flash-low")
        self.assertEqual(flags_37_low, ["--model", "gemini-3.7-flash", "--effort", "low"])

        flags_31_pro = resolve_model_flags("gemini-3.1-pro")
        self.assertEqual(flags_31_pro, ["--model", "gemini-3.1-pro", "--effort", "high"])

        flags_claude = resolve_model_flags("claude-sonnet-4.6-thinking")
        self.assertEqual(flags_claude, ["--model", "claude-sonnet-4.6"])

    def test_handle_profile_cli(self):
        """Test Profile Manager CLI helper and subcommands."""
        handle_profile_cli = antigravity_bridge.handle_profile_cli
        get_profile_account_email = antigravity_bridge.get_profile_account_email

        # Test help
        self.assertEqual(handle_profile_cli(["--help"]), 0)
        # Test disable / enable
        self.assertEqual(handle_profile_cli(["disable", "astrathezero"]), 0)
        self.assertEqual(handle_profile_cli(["enable", "astrathezero"]), 0)
        # Test reset
        self.assertEqual(handle_profile_cli(["reset"]), 0)

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

            # 3. Test /v1/chat/completions POST (OpenAI format)
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
                    self.assertIn("Bridge response", resp_json["choices"][0]["message"]["content"])
                    self.assertIn("Antigravity Profile", resp_json["choices"][0]["message"]["content"])

            # 4. Test /v1/messages POST (Anthropic format)
            messages_url = f"http://127.0.0.1:{port}/v1/messages"
            anthropic_req_data = json.dumps({
                "model": "claude-sonnet-4.6-thinking",
                "system": "You are a helpful assistant.",
                "messages": [{"role": "user", "content": "Hello Anthropic"}],
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "execute_cli_command", return_value="Anthropic Bridge response"):
                req = urllib.request.Request(messages_url, data=anthropic_req_data, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["type"], "message")
                    self.assertIn("Anthropic Bridge response", resp_json["content"][0]["text"])
                    self.assertIn("Antigravity Profile", resp_json["content"][0]["text"])

            # 5. Test /v1/chat/completions with Image Model (gemini-3.1-flash-image)
            image_chat_req = json.dumps({
                "model": "gemini-3.1-flash-image",
                "messages": [{"role": "user", "content": "Draw a cute puppy"}],
            }).encode("utf-8")

            dummy_img_md = "\n![image](data:image/jpeg;base64,dummy_puppy_b64)"
            with patch.object(antigravity_bridge, "generate_image_via_router", return_value=(dummy_img_md, "dummy_puppy_b64")):
                req = urllib.request.Request(chat_url, data=image_chat_req, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["object"], "chat.completion")
                    self.assertEqual(resp_json["model"], "gemini-3.1-flash-image")
                    content = resp_json["choices"][0]["message"]["content"]
                    self.assertIn("![image](data:image/jpeg;base64,dummy_puppy_b64)", content)

            # 6. Test /v1/messages with Image Model (Anthropic format)
            image_msg_req = json.dumps({
                "model": "gemini-3.1-flash-image",
                "messages": [{"role": "user", "content": "Draw a cute puppy"}],
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "generate_image_via_router", return_value=(dummy_img_md, "dummy_puppy_b64")):
                req = urllib.request.Request(messages_url, data=image_msg_req, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(resp_json["type"], "message")
                    self.assertEqual(resp_json["model"], "gemini-3.1-flash-image")
                    content = resp_json["content"][0]["text"]
                    self.assertIn("![image](data:image/jpeg;base64,dummy_puppy_b64)", content)

            # 7. Test /v1/images/generations endpoint
            image_gen_url = f"http://127.0.0.1:{port}/v1/images/generations"
            image_gen_req = json.dumps({
                "model": "gemini-3.1-flash-image",
                "prompt": "A cute cat",
            }).encode("utf-8")

            with patch.object(antigravity_bridge, "generate_image_via_router", return_value=(dummy_img_md, "dummy_cat_b64")):
                req = urllib.request.Request(image_gen_url, data=image_gen_req, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    resp_json = json.loads(resp.read().decode("utf-8"))
                    self.assertIn("data", resp_json)
                    self.assertEqual(resp_json["data"][0]["b64_json"], "dummy_cat_b64")

            # 8. Test /v1/profiles GET endpoint
            profiles_url = f"http://127.0.0.1:{port}/v1/profiles"
            with urllib.request.urlopen(profiles_url) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["object"], "list")
                self.assertIn("profiles", resp_json)
                self.assertIn("default_test", resp_json["profiles"])

            # 9. Test /v1/profiles/reset POST endpoint
            reset_url = f"http://127.0.0.1:{port}/v1/profiles/reset"
            reset_req = json.dumps({"profile": "default_test"}).encode("utf-8")
            req = urllib.request.Request(reset_url, data=reset_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertIn("default_test", resp_json["profiles"])

            # 10. Test /v1/profiles/config POST endpoint (Live dynamic reload)
            config_url = f"http://127.0.0.1:{port}/v1/profiles/config"
            config_req = json.dumps({"profiles": "p_alpha,p_beta"}).encode("utf-8")
            req = urllib.request.Request(config_url, data=config_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertEqual(resp_json["active_profiles"], ["p_alpha", "p_beta"])

            # 11. Test /v1/profiles/disable and /v1/profiles/enable
            disable_url = f"http://127.0.0.1:{port}/v1/profiles/disable"
            disable_req = json.dumps({"profile": "p_alpha"}).encode("utf-8")
            req = urllib.request.Request(disable_url, data=disable_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertEqual(resp_json["profiles"]["p_alpha"]["status"], "DISABLED")

            enable_url = f"http://127.0.0.1:{port}/v1/profiles/enable"
            enable_req = json.dumps({"profile": "p_alpha"}).encode("utf-8")
            req = urllib.request.Request(enable_url, data=enable_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertEqual(resp_json["profiles"]["p_alpha"]["status"], "OK")
        finally:
            server.shutdown()
            server.server_close()
            test_cfg = os.path.expanduser("~/.config/antigravity/bridge_config.json")
            if os.path.exists(test_cfg):
                try:
                    os.remove(test_cfg)
                except Exception:
                    pass


if __name__ == "__main__":
    unittest.main()

