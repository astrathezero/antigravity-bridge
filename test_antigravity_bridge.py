"""Unit tests for Antigravity / agy API Bridge Server."""

import json
import os
import shutil
import signal
import sys
import subprocess
import threading
import tempfile
import time
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
compact_tool_output = antigravity_bridge.compact_tool_output
compact_messages = antigravity_bridge.compact_messages
sanitize_prompt_for_cli = antigravity_bridge.sanitize_prompt_for_cli
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

        with patch.object(antigravity_bridge, "sync_profile_to_system", return_value=("test@example.com", "ya29.test")):
            output = execute_cli_command('echo "{prompt}"', "Hello world", profile="profile_alpha")
            self.assertEqual(output, "CLI execution output")
            mock_popen.assert_called_once()
            _, kwargs = mock_popen.call_args
            self.assertEqual(kwargs.get("env", {}).get("ANTIGRAVITY_PROFILE"), "profile_alpha")

    def test_is_quota_or_rate_limit_error(self):
        """Test detecting quota exhaustion and rate limit error patterns."""
        self.assertTrue(is_quota_or_rate_limit_error("Error 429: Too Many Requests"))
        self.assertTrue(is_quota_or_rate_limit_error("RESOURCE_EXHAUSTED: Quota exceeded for model"))
        self.assertTrue(is_quota_or_rate_limit_error("insufficient_quota on user account"))
        self.assertTrue(is_quota_or_rate_limit_error("Rate limit reached for profile profile_alpha"))
        self.assertTrue(is_quota_or_rate_limit_error("You have exceeded your current quota"))
        self.assertTrue(is_quota_or_rate_limit_error("out of credits"))
        self.assertTrue(is_quota_or_rate_limit_error("model overloaded"))
        self.assertTrue(is_quota_or_rate_limit_error("503 Service Unavailable"))
        self.assertTrue(is_quota_or_rate_limit_error("Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 88h27m35s."))
        self.assertTrue(is_quota_or_rate_limit_error("Please upgrade your subscription to increase your limits."))
        self.assertTrue(is_quota_or_rate_limit_error("Daily quota reached for model"))
        self.assertFalse(is_quota_or_rate_limit_error("SyntaxError: invalid syntax"))
        self.assertFalse(is_quota_or_rate_limit_error("FileNotFoundError: file not found"))

    def test_parse_quota_reset_seconds(self):
        """Test extracting reset and cooldown durations accurately from CLI errors."""
        from antigravity_bridge import parse_quota_reset_seconds
        self.assertEqual(parse_quota_reset_seconds("Resets in 88h27m35s."), 88 * 3600 + 27 * 60 + 35)
        self.assertEqual(parse_quota_reset_seconds("Resets in 19h37m31s."), 19 * 3600 + 37 * 60 + 31)
        self.assertEqual(parse_quota_reset_seconds("Resets in 2d 3h 4m 5s"), 2 * 86400 + 3 * 3600 + 4 * 60 + 5)
        self.assertEqual(parse_quota_reset_seconds("Resets in 45s"), 45.0)
        self.assertEqual(parse_quota_reset_seconds("Retry after 120s"), 120.0)
        self.assertIsNone(parse_quota_reset_seconds("General error without reset time"))

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
            self.assertEqual(pm.get_estimated_quota_percent("p1"), 100)

            pm.mark_success("p1")
            self.assertEqual(pm.get_estimated_quota_percent("p1"), 98)

            pm.mark_exhausted("p2", "Rate limit exceeded", cooldown_seconds=300)
            self.assertEqual(pm.get_estimated_quota_percent("p2"), 0)

            banner = pm.build_profile_quota_banner("p1")
            self.assertIn("Antigravity Profile:** `p1`", banner)
            self.assertIn("Quota:** ~**98%**", banner)
            self.assertIn("1/2** Ready", banner)
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
            pm = ProfileManager(profiles=["profile_alpha", "profile_beta", "profile_gamma"], cache_file=cache_file)
            pm.mark_exhausted("profile_alpha", "429 Quota Exceeded")
            pm.mark_exhausted("profile_beta", "ResourceExhausted")

            # Healthy profiles prioritized first, exhausted profiles placed last for complete fallback
            ordered = pm.get_ordered_profiles()
            self.assertEqual(ordered[0], "profile_gamma")
            self.assertEqual(len(ordered), 3)

            # When all are exhausted, fallback returns all sorted by earliest cooldown
            pm.mark_exhausted("profile_gamma", "ResourceExhausted")
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
            pm = ProfileManager(profiles=["profile_alpha", "profile_beta", "profile_gamma"], cache_file=cache_file)
            attempts = []

            def side_effect(cmd, prompt, timeout=60.0, profile=None, **kwargs):
                attempts.append(profile)
                if profile in ("profile_alpha", "profile_beta"):
                    raise RuntimeError(f"RESOURCE_EXHAUSTED on {profile}")
                if profile == "profile_gamma":
                    return "Output from profile_gamma"
                raise RuntimeError(f"Unknown profile {profile}")

            with patch.object(antigravity_bridge, "execute_cli_command", side_effect=side_effect):
                # 1. First call: profile_alpha and profile_beta fail with quota error, profile_gamma succeeds
                output1, used_profile1 = execute_cli_with_fallback('echo "{prompt}"', "test", profile_manager=pm)
                self.assertEqual(output1, "Output from profile_gamma")
                self.assertEqual(used_profile1, "profile_gamma")
                self.assertEqual(attempts, ["profile_alpha", "profile_beta", "profile_gamma"])

                # 2. Second call: profile_alpha and profile_beta are now IN COOLDOWN!
                # It must execute profile_gamma directly without trying profile_alpha or profile_beta first!
                attempts.clear()
                output2, used_profile2 = execute_cli_with_fallback('echo "{prompt}"', "test", profile_manager=pm)
                self.assertEqual(output2, "Output from profile_gamma")
                self.assertEqual(used_profile2, "profile_gamma")
                self.assertEqual(attempts, ["profile_gamma"])
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_deep_fallback_across_all_profiles(self):
        """Test that execute_cli_with_fallback cascades through all profiles until finding a working one."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        try:
            profile_list = [f"p_{i}" for i in range(1, 11)]  # 10 profiles
            pm = ProfileManager(profiles=profile_list, cache_file=cache_file)
            attempts = []

            def mock_execute(cmd, prompt, timeout=60.0, profile=None, **kwargs):
                attempts.append(profile)
                if profile == "p_10":
                    return "Success from p_10"
                raise RuntimeError(f"Error: Individual quota reached on {profile}. Resets in 88h.")

            with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_execute):
                output, used_p = execute_cli_with_fallback('echo "{prompt}"', "prompt", profile_manager=pm)
                self.assertEqual(output, "Success from p_10")
                self.assertEqual(used_p, "p_10")
                self.assertEqual(len(attempts), 10)
                self.assertEqual(attempts, profile_list)

                # Next call should go straight to p_10 because p_1 to p_9 are in cooldown
                attempts.clear()
                output2, used_p2 = execute_cli_with_fallback('echo "{prompt}"', "prompt", profile_manager=pm)
                self.assertEqual(output2, "Success from p_10")
                self.assertEqual(used_p2, "p_10")
                self.assertEqual(attempts, ["p_10"])
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_resolve_model_flags(self):
        """Test model flag mapping with reasoning effort defaults."""
        flags_38 = resolve_model_flags("gemini-3.8-flash")
        self.assertEqual(flags_38, ["--model", "gemini-3.8-flash", "--effort", "high"])

        flags_38_high = resolve_model_flags("gemini-3.8-flash-high")
        self.assertEqual(flags_38_high, ["--model", "gemini-3.8-flash", "--effort", "high"])

        flags_38_med = resolve_model_flags("gemini-3.8-flash-medium")
        self.assertEqual(flags_38_med, ["--model", "gemini-3.8-flash", "--effort", "medium"])

        flags_38_low = resolve_model_flags("gemini-3.8-flash-low")
        self.assertEqual(flags_38_low, ["--model", "gemini-3.8-flash", "--effort", "low"])

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
        self.assertEqual(handle_profile_cli(["disable", "profile_alpha"]), 0)
        self.assertEqual(handle_profile_cli(["enable", "profile_alpha"]), 0)
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

            # 12. Test /extension/status GET endpoint
            ext_status_url = f"http://127.0.0.1:{port}/extension/status"
            with urllib.request.urlopen(ext_status_url) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertIn("connected_profiles", resp_json)
                self.assertIn("clients", resp_json)

            # 13. Test /v1/profiles/toggle POST endpoint
            toggle_url = f"http://127.0.0.1:{port}/v1/profiles/toggle"
            toggle_req = json.dumps({"profile": "p_alpha", "channel": "web", "enabled": False}).encode("utf-8")
            req = urllib.request.Request(toggle_url, data=toggle_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertFalse(resp_json["web_enabled"])

            # 14. Test channel-specific /v1/profiles/disable and enable
            disable_cli_req = json.dumps({"profile": "p_alpha", "channel": "cli"}).encode("utf-8")
            req = urllib.request.Request(disable_url, data=disable_cli_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertFalse(resp_json["profiles"]["p_alpha"]["cli_enabled"])

            enable_url = f"http://127.0.0.1:{port}/v1/profiles/enable"
            enable_cli_req = json.dumps({"profile": "p_alpha", "channel": "cli"}).encode("utf-8")
            req = urllib.request.Request(enable_url, data=enable_cli_req, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as resp:
                resp_json = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(resp_json["status"], "ok")
                self.assertTrue(resp_json["profiles"]["p_alpha"]["cli_enabled"])
        finally:
            server.shutdown()
            server.server_close()
            test_cfg = os.path.expanduser("~/.config/antigravity/bridge_config.json")
            if os.path.exists(test_cfg):
                try:
                    os.remove(test_cfg)
                except Exception:
                    pass

    def test_refresh_profile_token_and_daemon(self):
        """Test active token refresh and background daemon thread execution."""
        refresh_fn = antigravity_bridge.refresh_profile_token
        start_daemon = antigravity_bridge.start_token_refresh_daemon

        # Non-existent profile should return False gracefully
        ok, msg = refresh_fn("non_existent_profile_xyz")
        self.assertFalse(ok)
        self.assertIn("missing", msg.lower())

        # Test daemon start and graceful shutdown
        dummy_server = MagicMock()
        dummy_server.profiles = ["default_test"]
        shutdown_evt = threading.Event()
        dummy_server._shutdown_event = shutdown_evt

        with patch.object(antigravity_bridge, "refresh_profile_token", return_value=(True, "Refreshed OK")) as mock_ref:
            # Start daemon with small initial delay
            t = start_daemon(dummy_server, interval_seconds=100.0, initial_delay=0.05)
            self.assertIsNotNone(t)
            self.assertTrue(t.is_alive())

            # Signal shutdown
            shutdown_evt.set()
            t.join(timeout=1.0)
            self.assertFalse(t.is_alive())

    def test_profile_lease_pool(self):
        """Test acquiring and releasing profile leases for multi-concurrency."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        try:
            pm = ProfileManager(profiles=["p1", "p2"], cache_file=cache_file, concurrency_per_profile=1)
            self.assertEqual(pm.get_total_in_flight(), 0)

            # Acquire p1
            chosen1 = pm.acquire_profile(["p1", "p2"])
            self.assertIsNotNone(chosen1)
            self.assertEqual(pm.get_in_flight(chosen1), 1)
            self.assertEqual(pm.get_total_in_flight(), 1)

            # Acquire p2 (should pick the other available profile)
            chosen2 = pm.acquire_profile(["p1", "p2"])
            self.assertIsNotNone(chosen2)
            self.assertNotEqual(chosen1, chosen2)
            self.assertEqual(pm.get_total_in_flight(), 2)

            # All profiles at max capacity (1 each), so acquire_profile should return None
            chosen3 = pm.acquire_profile(["p1", "p2"])
            self.assertIsNone(chosen3)

            # Release p1
            pm.release_profile(chosen1)
            self.assertEqual(pm.get_in_flight(chosen1), 0)
            self.assertEqual(pm.get_total_in_flight(), 1)

            # Now p1 is available again
            chosen4 = pm.acquire_profile(["p1", "p2"])
            self.assertEqual(chosen4, chosen1)
            self.assertEqual(pm.get_total_in_flight(), 2)

            # Release both
            pm.release_profile(chosen1)
            pm.release_profile(chosen2)
            self.assertEqual(pm.get_total_in_flight(), 0)
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_worker_sandbox_creation(self):
        """Test creating isolated sandbox directory for a profile."""
        get_sandbox = antigravity_bridge.get_profile_sandbox_dir
        sb = get_sandbox("test_worker_profile")
        self.assertTrue(os.path.exists(sb))
        self.assertTrue(os.path.exists(os.path.join(sb, ".gemini")))
        self.assertTrue(os.path.exists(os.path.join(sb, ".config", "antigravity")))

    def test_concurrent_multi_profile_execution(self):
        """Test parallel multi-profile execution across worker threads."""
        import concurrent.futures
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name

        try:
            pm = ProfileManager(profiles=["p_alpha", "p_beta", "p_gamma"], cache_file=cache_file, concurrency_per_profile=1)

            def mock_exec(cmd_template, prompt_text, timeout=60.0, profile=None, **kwargs):
                time.sleep(0.05)  # Simulate CLI work
                return f"Result from {profile}: {prompt_text}"

            with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
                def run_req(idx):
                    out, prof = execute_cli_with_fallback('echo "{prompt}"', f"req_{idx}", profile_manager=pm)
                    return idx, prof, out

                # Run 3 concurrent requests simultaneously
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                    futures = [executor.submit(run_req, i) for i in range(3)]
                    results = [f.result() for f in futures]

                used_profiles = {r[1] for r in results}
                # Verify that all 3 distinct profiles were utilized concurrently
                self.assertEqual(used_profiles, {"p_alpha", "p_beta", "p_gamma"})
                self.assertEqual(pm.get_total_in_flight(), 0)
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)

    def test_server_api_key_auth(self):
        """Test that API Key authentication blocks unauthorized requests with 401."""
        server = ThreadedHTTPServer(("127.0.0.1", 0), AntigravityBridgeHandler)
        server.profiles = ["default_test"]
        server.api_key = "secret-test-key-123"
        port = server.server_port

        import threading
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            models_url = f"http://127.0.0.1:{port}/v1/models"
            # 1. Unauthorized request should get 401
            req_unauth = urllib.request.Request(models_url)
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req_unauth)
            self.assertEqual(ctx.exception.code, 401)

            # 2. Authorized with Bearer token should get 200
            req_auth = urllib.request.Request(models_url, headers={"Authorization": "Bearer secret-test-key-123"})
            with urllib.request.urlopen(req_auth) as resp:
                self.assertEqual(resp.status, 200)

            # 3. Authorized with x-api-key header should get 200
            req_xauth = urllib.request.Request(models_url, headers={"x-api-key": "secret-test-key-123"})
            with urllib.request.urlopen(req_xauth) as resp:
                self.assertEqual(resp.status, 200)
        finally:
            server.shutdown()
            server.server_close()

    def test_context_compaction_and_tool_truncation(self):
        """Test that compact_messages preserves system instructions and compacts middle tool outputs."""
        huge_tool_output = "X" * 20000
        messages = [
            {"role": "system", "content": "You are a specialized AI."},
            {"role": "user", "content": "Initial user goal: research topic"},
            {"role": "assistant", "content": "Running tool..."},
            {"role": "tool", "content": huge_tool_output},
            {"role": "assistant", "content": "Intermediate answer"},
            {"role": "user", "content": "Continue research"},
            {"role": "assistant", "content": "Running another tool..."},
            {"role": "tool", "content": huge_tool_output},
            {"role": "assistant", "content": "Final analysis step"},
            {"role": "user", "content": "Latest user message"},
        ]

        compacted = compact_messages(messages, max_total_chars=10000, recent_keep_count=3)
        self.assertEqual(compacted[0]["role"], "system")
        self.assertEqual(compacted[0]["content"], "You are a specialized AI.")
        self.assertEqual(compacted[1]["role"], "user")
        self.assertIn("Initial user goal", compacted[1]["content"])

        # Check that middle tool output was compacted
        middle_tool_msg = next(m for m in compacted if m.get("role") == "tool")
        self.assertLess(len(middle_tool_msg["content"]), 2500)
        self.assertIn("Tool output truncated", middle_tool_msg["content"])

        # Check format_messages_to_prompt produces compacted string
        prompt = format_messages_to_prompt(messages, max_prompt_chars=10000)
        self.assertIn("[System Instructions]\nYou are a specialized AI.", prompt)
        self.assertIn("[User]\nLatest user message", prompt)
        self.assertLess(len(prompt), 15000)

    def test_boundary_aware_cli_sanitization(self):
        """Test that sanitize_prompt_for_cli cleanly truncates large prompts at section boundaries."""
        large_prompt = "[System Instructions]\nKeep safe.\n\n" + ("\n\n[User]\nTurn data...\n\n[Assistant]\nResponse..." * 2000)
        sanitized = sanitize_prompt_for_cli(large_prompt, max_bytes=10000)
        self.assertLessEqual(len(sanitized.encode("utf-8")), 10000)
        self.assertIn("[System Instructions]", sanitized)
        self.assertIn("Middle context truncated", sanitized)

    def test_total_timeout_budget_fallback(self):
        """Test that execute_cli_with_fallback terminates when total timeout budget is exceeded."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        try:
            pm = ProfileManager(profiles=["p1", "p2", "p3", "p4", "p5"], cache_file=cache_file)
            attempts = []

            def mock_hanging_cli(cmd, prompt, timeout=45.0, profile=None, **kwargs):
                attempts.append(profile)
                time.sleep(0.05)
                raise RuntimeError(f"CLI Execution Timeout after {timeout:.1f}s (profile={profile})")

            with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_hanging_cli):
                # Set total_timeout to a very small budget (0.08s) so only 1-2 profiles can be attempted before budget expires
                with self.assertRaises(RuntimeError) as ctx:
                    execute_cli_with_fallback('echo "{prompt}"', "test", timeout=0.05, total_timeout=0.08, profile_manager=pm)
                self.assertIn("Total fallback timeout budget", str(ctx.exception))
                self.assertLess(len(attempts), 5)
        finally:
            if os.path.exists(cache_file):
                os.remove(cache_file)


    def test_persistent_disabled_profile(self):
        """Test persistent profile disabling across cache reloads and bulk resets."""
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            cache_file = tf.name
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as cfg_tf:
            cfg_file = cfg_tf.name

        real_expanduser = os.path.expanduser
        try:
            with patch("os.path.expanduser", side_effect=lambda p: cfg_file if "bridge_config.json" in p else real_expanduser(p)):
                # 1. Initially enable p1, p2, p3
                antigravity_bridge.persist_disabled_profile("p2", disabled=True)
                dis = antigravity_bridge.get_disabled_profiles()
                self.assertIn("p2", dis)

                # 2. ProfileManager should initialize p2 as DISABLED
                pm = ProfileManager(profiles=["p1", "p2", "p3"], cache_file=cache_file)
                self.assertEqual(pm.state["p2"]["status"], "DISABLED")
                self.assertGreater(pm.state["p2"]["exhausted_until"], time.time() + 100000)

                # 3. Ordered profiles should exclude p2
                ordered = pm.get_ordered_profiles()
                self.assertNotIn("p2", ordered)
                self.assertIn("p1", ordered)
                self.assertIn("p3", ordered)

                # 4. Bulk reset should not clear DISABLED status of p2
                pm.reset_all()
                self.assertEqual(pm.state["p2"]["status"], "DISABLED")

                # 5. Explicitly enable p2
                pm.enable("p2")
                self.assertEqual(pm.state["p2"]["status"], "OK")
                dis_after = antigravity_bridge.get_disabled_profiles()
                self.assertNotIn("p2", dis_after)
        finally:
            for f in (cache_file, cfg_file):
                if os.path.exists(f):
                    os.remove(f)

    def test_parse_cmd_template_large_prompt_agy(self):
        """Test that parse_cmd_template safely passes large prompts up to 350KB in argv directly."""
        large_prompt = "A" * 70000
        argv, stdin_input = antigravity_bridge.parse_cmd_template('agy -p "{prompt}"', large_prompt)
        self.assertEqual(argv, ["agy", "-p", large_prompt])
        self.assertEqual(stdin_input, "")

    def test_parse_cmd_template_small_prompt_agy(self):
        """Test that parse_cmd_template keeps small prompts in argv directly."""
        small_prompt = "Hello AI"
        argv, stdin_input = antigravity_bridge.parse_cmd_template('agy -p "{prompt}"', small_prompt)
        self.assertEqual(argv, ["agy", "-p", "Hello AI"])
        self.assertEqual(stdin_input, "")

    def test_parse_cmd_template_oversized_prompt_truncation(self):
        """Test that parse_cmd_template truncates prompts exceeding MAX_CLI_ARG_BYTES (350KB)."""
        oversized_prompt = "[System]\nKeep safe.\n\n" + ("\n\n[User]\nTurn data...\n\n[Assistant]\nResponse..." * 25000) # > 500KB
        argv, stdin_input = antigravity_bridge.parse_cmd_template('agy -p "{prompt}"', oversized_prompt)
        self.assertEqual(stdin_input, "")
        self.assertEqual(argv[0], "agy")
        self.assertEqual(argv[1], "-p")
        self.assertLessEqual(len(argv[2].encode("utf-8")), 350000)
        self.assertIn("[System]", argv[2])


    def test_parse_timeout_value(self):
        """Test parse_timeout_value across numeric, string units, clock, and ms formats."""
        self.assertEqual(antigravity_bridge.parse_timeout_value(1800), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value(1800.5), 1800.5)
        self.assertEqual(antigravity_bridge.parse_timeout_value("1800"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("1800s"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("20m"), 1200.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("30m"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("30 min"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("30 mins"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("30 minutes"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("0.5h"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("1h"), 3600.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("20:00"), 1200.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("30:00"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("1800000ms"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value(1800000), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("wait=1800"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("timeout=30m"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("profile_timeout: 20m"), 1200.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("<!-- timeout: 30m -->"), 1800.0)
        self.assertEqual(antigravity_bridge.parse_timeout_value("[timeout: 20m]"), 1200.0)
        self.assertIsNone(antigravity_bridge.parse_timeout_value(None))
        self.assertIsNone(antigravity_bridge.parse_timeout_value(""))
        self.assertIsNone(antigravity_bridge.parse_timeout_value(-10))

    def test_extract_model_and_timeout(self):
        """Test extraction of clean model name and embedded timeout modifier from model strings."""
        m, t = antigravity_bridge.extract_model_and_timeout("gemini-3.7-flash:timeout=30m")
        self.assertEqual(m, "gemini-3.7-flash")
        self.assertEqual(t, 1800.0)

        m, t = antigravity_bridge.extract_model_and_timeout("gemini-3.7-flash:30m")
        self.assertEqual(m, "gemini-3.7-flash")
        self.assertEqual(t, 1800.0)

        m, t = antigravity_bridge.extract_model_and_timeout("gemini-3.7-flash-high:20m")
        self.assertEqual(m, "gemini-3.7-flash-high")
        self.assertEqual(t, 1200.0)

        m, t = antigravity_bridge.extract_model_and_timeout("gemini-3.7-flash?timeout=1800")
        self.assertEqual(m, "gemini-3.7-flash")
        self.assertEqual(t, 1800.0)

        m, t = antigravity_bridge.extract_model_and_timeout("gemini-3.7-flash#timeout=25m")
        self.assertEqual(m, "gemini-3.7-flash")
        self.assertEqual(t, 1500.0)

        m, t = antigravity_bridge.extract_model_and_timeout("openrouter/google/gemini-3.7-flash:timeout=30m")
        self.assertEqual(m, "openrouter/google/gemini-3.7-flash")
        self.assertEqual(t, 1800.0)

        m, t = antigravity_bridge.extract_model_and_timeout("gemini-3.7-flash")
        self.assertEqual(m, "gemini-3.7-flash")
        self.assertIsNone(t)

    def test_extract_timeout_from_prompt_text(self):
        """Test extraction of timeout directive tags embedded inside prompts or system instructions."""
        p1 = "Please write a comprehensive analysis.\n[antigravity:timeout=30m]\nFocus on high-detail output."
        self.assertEqual(antigravity_bridge.extract_timeout_from_prompt_text(p1), 1800.0)

        p2 = "<!-- timeout: 20m -->\nExecute full refactoring."
        self.assertEqual(antigravity_bridge.extract_timeout_from_prompt_text(p2), 1200.0)

        p3 = "Normal prompt with no directives."
        self.assertIsNone(antigravity_bridge.extract_timeout_from_prompt_text(p3))

    def test_extract_request_timeouts_headers(self):
        """Test extraction of custom profile and total timeouts from HTTP request headers."""
        handler = MagicMock()
        handler.server = MagicMock()
        handler.server.profile_timeout = 180.0
        handler.server.total_timeout = 480.0
        handler.path = "/v1/chat/completions"

        # 1. Profile header (30m)
        handler.headers = {"X-Profile-Timeout": "30m"}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {})
        self.assertEqual(prof, 1800.0)
        self.assertEqual(total, 4500.0)

        # 2. Execution header (20m) & Total timeout header (60m)
        handler.headers = {"X-Execution-Timeout": "20m", "X-Total-Timeout": "60m"}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {})
        self.assertEqual(prof, 1200.0)
        self.assertEqual(total, 3600.0)

        # 3. Prefer wait header (15m)
        handler.headers = {"Prefer": "wait=900"}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {})
        self.assertEqual(prof, 900.0)

        # 4. OpenAI / Client timeout header (25m)
        handler.headers = {"OpenAI-Timeout": "25m"}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {})
        self.assertEqual(prof, 1500.0)

    def test_extract_request_timeouts_query_and_body(self):
        """Test extraction of custom timeouts from URL query parameters and JSON body."""
        handler = MagicMock()
        handler.server = MagicMock()
        handler.server.profile_timeout = 180.0
        handler.server.total_timeout = 480.0
        handler.headers = {}

        # 1. URL Query Parameter (?timeout=25m)
        handler.path = "/v1/chat/completions?timeout=25m"
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {})
        self.assertEqual(prof, 1500.0)

        # 2. JSON Body top-level
        handler.path = "/v1/chat/completions"
        req_json = {"profile_timeout": "30m"}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, req_json)
        self.assertEqual(prof, 1800.0)

        # 3. JSON Body inside extra_body
        req_json = {"extra_body": {"profile_timeout": 1200}}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, req_json)
        self.assertEqual(prof, 1200.0)

        # 4. JSON Body inside model_kwargs
        req_json = {"model_kwargs": {"timeout": "20m"}}
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, req_json)
        self.assertEqual(prof, 1200.0)

    def test_extract_request_timeouts_model_and_prompt_directives(self):
        """Test timeout extraction from model embedded modifier and prompt directive tags."""
        handler = MagicMock()
        handler.server = MagicMock()
        handler.server.profile_timeout = 180.0
        handler.server.total_timeout = 480.0
        handler.headers = {}
        handler.path = "/v1/chat/completions"

        # 1. Model embedded timeout (30m)
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(
            handler, {}, model_timeout=1800.0
        )
        self.assertEqual(prof, 1800.0)

        # 2. Prompt directive tag ([antigravity:timeout=20m])
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(
            handler, {}, raw_prompt_text="[antigravity:timeout=20m]\nExecute big task"
        )
        self.assertEqual(prof, 1200.0)

    def test_extract_request_timeouts_auto_scaling_large_prompt(self):
        """Test that large prompts automatically scale up profile timeout if none explicitly requested."""
        handler = MagicMock()
        handler.server = MagicMock()
        handler.server.profile_timeout = 180.0
        handler.server.total_timeout = 480.0
        handler.server.max_autoscale_timeout = 3600.0
        handler.server.max_total_timeout = 9000.0
        handler.headers = {}
        handler.path = "/v1/chat/completions"

        # Small prompt (<= 10k chars) -> baseline 180.0s
        prof_small, _ = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {}, prompt_len=5000)
        self.assertEqual(prof_small, 180.0)

        # Large prompt (55k chars) -> 180 + (45000 / 10000) * 15 = 180 + 67.5 = 247.5s
        prof_large, total_large = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {}, prompt_len=55000)
        self.assertEqual(prof_large, 180.0 + (45000 / 10000.0) * 15.0)
        self.assertGreaterEqual(total_large, prof_large * 2.0)

        # Massive prompt (100k chars) -> 180 + 9 * 15 = 315.0s
        prof_100k, _ = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {}, prompt_len=100000)
        self.assertEqual(prof_100k, 315.0)

        # Huge prompt (600k chars) -> 180 + 59 * 15 = 1065.0s
        prof_600k, _ = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {}, prompt_len=600000)
        self.assertEqual(prof_600k, 1065.0)

        # Extreme prompt (2.5M chars) -> capped at 3600s (60 min)
        prof_huge, _ = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {}, prompt_len=2500000)
        self.assertEqual(prof_huge, 3600.0)

        # Default server settings (fail-fast interactive bounds: 90s base, 150s max autoscale, 300s max total)
        handler_default = MagicMock()
        handler_default.server = None
        handler_default.headers = {}
        handler_default.path = "/v1/chat/completions"
        prof_def_small, total_def_small = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler_default, {}, prompt_len=5000)
        self.assertEqual(prof_def_small, 600.0)
        self.assertEqual(total_def_small, 1800.0)

        # 120KB prompt with default settings -> scaled base
        prof_def_120k, total_def_120k = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler_default, {}, prompt_len=120000)
        self.assertEqual(prof_def_120k, 765.0)
        self.assertEqual(total_def_120k, 1800.0)

    def test_parse_api_keys(self):
        """Test parsing single, multiple, labeled, and structured API key strings."""
        # 1. Labeled comma-separated
        res = antigravity_bridge.parse_api_keys("agent-cursor:sk-agv-111,agent-hermes:sk-agv-222")
        self.assertEqual(res, {"sk-agv-111": "agent-cursor", "sk-agv-222": "agent-hermes"})

        # 2. Simple comma-separated without labels
        res = antigravity_bridge.parse_api_keys("sk-1, sk-2, sk-3")
        self.assertEqual(res, {"sk-1": "default", "sk-2": "default", "sk-3": "default"})

        # 3. Equals format
        res = antigravity_bridge.parse_api_keys("bot1=sk-aaa, bot2=sk-bbb")
        self.assertEqual(res, {"sk-aaa": "bot1", "sk-bbb": "bot2"})

        # 4. JSON format
        res = antigravity_bridge.parse_api_keys('{"sk-json-1": "agent-json"}')
        self.assertEqual(res, {"sk-json-1": "agent-json"})

        # 5. Empty/None
        self.assertEqual(antigravity_bridge.parse_api_keys(None), {})
        self.assertEqual(antigravity_bridge.parse_api_keys(""), {})
        self.assertEqual(antigravity_bridge.parse_api_keys("   "), {})

    def test_generate_and_mask_api_key(self):
        """Test API key token generation and masking."""
        key = antigravity_bridge.generate_api_key("sk-agv-")
        self.assertTrue(key.startswith("sk-agv-"))
        self.assertEqual(len(key), 7 + 32)  # 'sk-agv-' (7) + 32 hex chars

        masked = antigravity_bridge.mask_api_key(key)
        self.assertTrue(masked.startswith("sk-agv-"))
        self.assertIn("...", masked)
        self.assertTrue(masked.endswith(key[-6:]))

        self.assertEqual(antigravity_bridge.mask_api_key(""), "")
        self.assertEqual(antigravity_bridge.mask_api_key("short1234"), "sho...34")

    def test_save_and_revoke_api_key_to_env(self):
        """Test saving and revoking API keys in a temporary .env file."""
        import tempfile
        with tempfile.NamedTemporaryFile("w+", delete=False) as tf:
            tf.write("# Initial config\nPORT=8000\n")
            temp_env = tf.name

        try:
            # 1. Save first key
            ok, p = antigravity_bridge.save_api_key_to_env("agent-cursor", "sk-agv-123456", env_path=temp_env)
            self.assertTrue(ok)
            with open(temp_env, "r", encoding="utf-8") as f:
                content = f.read()
            keys = antigravity_bridge.parse_api_keys(content.split("ANTIGRAVITY_BRIDGE_API_KEYS=")[1].split("\n")[0])
            self.assertEqual(keys.get("sk-agv-123456"), "agent-cursor")

            # 2. Save second key
            ok, p = antigravity_bridge.save_api_key_to_env("agent-hermes", "sk-agv-789012", env_path=temp_env)
            self.assertTrue(ok)
            with open(temp_env, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("agent-cursor:sk-agv-123456", content)
            self.assertIn("agent-hermes:sk-agv-789012", content)

            # 3. Revoke by label
            ok, p, removed = antigravity_bridge.revoke_api_key_from_env("agent-cursor", env_path=temp_env)
            self.assertTrue(ok)
            self.assertEqual(len(removed), 1)
            self.assertEqual(removed[0], ("agent-cursor", "sk-agv-123456"))

            # 4. Verify only agent-hermes remains
            with open(temp_env, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertNotIn("sk-agv-123456", content)
            self.assertIn("agent-hermes:sk-agv-789012", content)

            # 5. Revoke by key
            ok, p, removed = antigravity_bridge.revoke_api_key_from_env("sk-agv-789012", env_path=temp_env)
            self.assertTrue(ok)
            self.assertEqual(len(removed), 1)

            # 6. Revoking non-existent should return False
            ok, p, removed = antigravity_bridge.revoke_api_key_from_env("non-existent", env_path=temp_env)
            self.assertFalse(ok)
        finally:
            if os.path.exists(temp_env):
                os.remove(temp_env)

    def test_multi_api_key_server_auth(self):
        """Test server authentication across multiple active API keys, header types, and endpoints."""
        server = ThreadedHTTPServer(("127.0.0.1", 0), AntigravityBridgeHandler)
        server.profiles = ["default_test"]
        server.api_keys = {
            "sk-test-cursor": "agent-cursor",
            "sk-test-hermes": "agent-hermes",
        }
        port = server.server_port

        import threading
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            models_url = f"http://127.0.0.1:{port}/v1/models"
            health_url = f"http://127.0.0.1:{port}/health"
            keys_url = f"http://127.0.0.1:{port}/v1/keys"

            # 1. Health check is public and reports auth state
            with urllib.request.urlopen(urllib.request.Request(health_url)) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(data.get("auth_required"))
                self.assertEqual(data.get("active_keys_count"), 2)

            # 2. Unauthenticated request to /v1/models should get 401
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(urllib.request.Request(models_url))
            self.assertEqual(ctx.exception.code, 401)

            # 3. Invalid key should get 401
            req_wrong = urllib.request.Request(models_url, headers={"Authorization": "Bearer sk-invalid-key"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req_wrong)
            self.assertEqual(ctx.exception.code, 401)

            # 4. Valid key 1 via Authorization Bearer
            req_auth1 = urllib.request.Request(models_url, headers={"Authorization": "Bearer sk-test-cursor"})
            with urllib.request.urlopen(req_auth1) as resp:
                self.assertEqual(resp.status, 200)

            # 5. Valid key 2 via x-api-key header
            req_auth2 = urllib.request.Request(models_url, headers={"x-api-key": "sk-test-hermes"})
            with urllib.request.urlopen(req_auth2) as resp:
                self.assertEqual(resp.status, 200)

            # 6. Valid key via query parameter ?api_key=...
            req_query = urllib.request.Request(f"{models_url}?api_key=sk-test-cursor")
            with urllib.request.urlopen(req_query) as resp:
                self.assertEqual(resp.status, 200)

            # 7. List active keys endpoint (/v1/keys)
            req_keys = urllib.request.Request(keys_url, headers={"Authorization": "Bearer sk-test-cursor"})
            with urllib.request.urlopen(req_keys) as resp:
                self.assertEqual(resp.status, 200)
                data = json.loads(resp.read().decode("utf-8"))
                self.assertEqual(data.get("total"), 2)
                labels = [item["label"] for item in data.get("data", [])]
                self.assertIn("agent-cursor", labels)
                self.assertIn("agent-hermes", labels)
        finally:
            server.shutdown()
            server.server_close()

    def test_handle_key_cli(self):
        """Test API Key CLI commands (list, help, unknown)."""
        import io
        from contextlib import redirect_stdout

        f = io.StringIO()
        with redirect_stdout(f):
            code = antigravity_bridge.handle_key_cli(["--help"])
            self.assertEqual(code, 0)
        self.assertIn("API Key Manager CLI", f.getvalue())

        f = io.StringIO()
        with redirect_stdout(f):
            code = antigravity_bridge.handle_key_cli(["list"])
            self.assertEqual(code, 0)
        self.assertIn("Agent / Label", f.getvalue())

    def test_kill_process_tree(self):
        """Test kill_process_tree cleanly terminates process tree and handles errors."""
        # 1. None proc should not raise
        antigravity_bridge.kill_process_tree(None)

        # 2. Already terminated proc (poll() returns 0) should not call killpg
        mock_done = MagicMock()
        mock_done.poll.return_value = 0
        with patch("os.killpg") as mock_killpg:
            antigravity_bridge.kill_process_tree(mock_done)
            mock_killpg.assert_not_called()

        # 3. Active proc with pid should call killpg on POSIX
        mock_active = MagicMock()
        mock_active.poll.return_value = None
        mock_active.pid = 98765
        with patch("os.killpg") as mock_killpg:
            antigravity_bridge.kill_process_tree(mock_active)
            if os.name != "nt" and hasattr(os, "killpg"):
                mock_killpg.assert_called_once_with(98765, signal.SIGKILL)

        # 4. ProcessLookupError should be swallowed silently
        mock_lookup_err = MagicMock()
        mock_lookup_err.poll.return_value = None
        mock_lookup_err.pid = 98766
        with patch("os.killpg", side_effect=ProcessLookupError):
            antigravity_bridge.kill_process_tree(mock_lookup_err)

        # 5. force=True should call killpg even if poll() returns 0 (killing grandchild processes)
        mock_orphan = MagicMock()
        mock_orphan.poll.return_value = 0
        mock_orphan.pid = 98767
        with patch("os.killpg") as mock_killpg:
            antigravity_bridge.kill_process_tree(mock_orphan, force=True)
            if os.name != "nt" and hasattr(os, "killpg"):
                mock_killpg.assert_called_once_with(98767, signal.SIGKILL)

    @patch("subprocess.Popen")
    def test_execute_cli_command_stdin_devnull(self, mock_popen):
        """Test execute_cli_command uses DEVNULL and start_new_session when stdin is empty."""
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.communicate.return_value = ("Output text", "")
        mock_popen.return_value = mock_proc

        out = antigravity_bridge.execute_cli_command('echo "{prompt}"', "hello")
        self.assertEqual(out, "Output text")
        mock_popen.assert_called_once()
        _, kwargs = mock_popen.call_args
        self.assertEqual(kwargs.get("stdin"), subprocess.DEVNULL)
        if os.name != "nt":
            self.assertTrue(kwargs.get("start_new_session"))

    @patch("subprocess.Popen")
    def test_execute_cli_command_timeout_calls_kill_process_tree(self, mock_popen):
        """Test execute_cli_command invokes kill_process_tree on subprocess.TimeoutExpired."""
        mock_proc = MagicMock()
        mock_proc.communicate.side_effect = subprocess.TimeoutExpired(cmd=["agy"], timeout=1.0)
        mock_popen.return_value = mock_proc

        with patch.object(antigravity_bridge, "kill_process_tree") as mock_kill_tree:
            with self.assertRaises(RuntimeError) as ctx:
                antigravity_bridge.execute_cli_command('agy -p "{prompt}"', "prompt text", timeout=1.0)
            self.assertIn("CLI Execution Timeout", str(ctx.exception))
            mock_kill_tree.assert_called()

    def test_extract_request_timeouts_custom_autoscale_caps(self):
        """Test custom max autoscale and total timeout caps when configured on server."""
        handler = MagicMock()
        handler.server = MagicMock()
        handler.server.profile_timeout = 60.0
        handler.server.total_timeout = 120.0
        handler.server.max_autoscale_timeout = 150.0
        handler.server.max_total_timeout = 300.0
        handler.headers = {}
        handler.path = "/v1/chat/completions"

        # 100k chars prompt: without cap would be 60 + 9 * 75 = 735s.
        # With max_autoscale_timeout = 150.0s, it must be clamped to 150.0s.
        prof, total = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler, {}, prompt_len=100000)
        self.assertEqual(prof, 150.0)
        # Total timeout with max_total_timeout = 300.0s
        self.assertEqual(total, 300.0)

    def test_send_json_response_broken_pipe_suppression(self):
        """Test that BrokenPipeError during send_json_response is raised cleanly for caller suppression."""
        handler = MagicMock()
        handler.server = MagicMock()
        handler.server.enable_cors = False
        handler.wfile = MagicMock()
        handler.wfile.write.side_effect = BrokenPipeError(32, "Broken pipe")

        with self.assertRaises(BrokenPipeError):
            antigravity_bridge.AntigravityBridgeHandler._send_json_response(handler, {"key": "val"})

    def test_sse_heartbeat_openai(self):
        """Test that SSEHeartbeat emits comment keep-alive and OpenAI delta chunk, and stops cleanly."""
        wfile = MagicMock()
        hb = antigravity_bridge.SSEHeartbeat(wfile, interval=0.01, is_anthropic=False)
        time.sleep(0.05)
        hb.stop()

        self.assertFalse(hb.running)
        written_bytes = b"".join([call[0][0] for call in wfile.write.call_args_list if call[0]])
        self.assertIn(b": keep-alive\n\n", written_bytes)
        self.assertIn(b"chat.completion.chunk", written_bytes)
        self.assertIn(b'"delta": {}', written_bytes)

    def test_sse_heartbeat_anthropic(self):
        """Test that SSEHeartbeat emits comment keep-alive and Anthropic ping event."""
        wfile = MagicMock()
        hb = antigravity_bridge.SSEHeartbeat(wfile, interval=0.01, is_anthropic=True)
        time.sleep(0.05)
        hb.stop()

        self.assertFalse(hb.running)
        written_bytes = b"".join([call[0][0] for call in wfile.write.call_args_list if call[0]])
        self.assertIn(b": keep-alive\n\n", written_bytes)
        self.assertIn(b'event: ping\ndata: {"type": "ping"}\n\n', written_bytes)


    def test_profile_concurrency_tracking_and_status(self):
        """Test ProfileManager in_flight tracking, busy status, and summary formatting."""
        pm = ProfileManager(profiles=["alpha", "beta"], concurrency_per_profile=1)
        self.assertEqual(len(pm.get_idle_profiles()), 2)
        self.assertEqual(len(pm.get_busy_profiles()), 0)
        self.assertFalse(pm.is_profile_busy("alpha"))

        # Acquire alpha
        chosen = pm.acquire_profile(["alpha", "beta"])
        self.assertEqual(chosen, "alpha")
        self.assertTrue(pm.is_profile_busy("alpha"))
        self.assertFalse(pm.is_profile_busy("beta"))
        self.assertEqual(pm.get_in_flight("alpha"), 1)
        self.assertEqual(len(pm.get_idle_profiles()), 1)
        self.assertEqual(len(pm.get_busy_profiles()), 1)

        summary = pm.get_status_summary()
        self.assertEqual(summary["alpha"]["concurrency_status"], "BUSY")
        self.assertTrue(summary["alpha"]["is_busy"])
        self.assertEqual(summary["beta"]["concurrency_status"], "IDLE")
        self.assertFalse(summary["beta"]["is_busy"])

        # Release alpha
        pm.release_profile("alpha")
        self.assertFalse(pm.is_profile_busy("alpha"))
        self.assertEqual(pm.get_in_flight("alpha"), 0)
        self.assertEqual(pm.get_status_summary()["alpha"]["concurrency_status"], "IDLE")

    def test_execute_cli_with_fallback_routes_around_busy_profile(self):
        """Test that execute_cli_with_fallback dynamically routes away from busy profile to idle profile."""
        pm = ProfileManager(profiles=["p_busy", "p_idle"], concurrency_per_profile=1)
        pm.acquire_specific_profile("p_busy")
        self.assertTrue(pm.is_profile_busy("p_busy"))

        executed_profiles = []

        def mock_exec(cmd_tpl, prompt, timeout=180.0, profile=None, model_name=None):
            executed_profiles.append(profile)
            return f"Success from {profile}"

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
            output, used_profile = execute_cli_with_fallback('echo "{prompt}"', "hello", profile_manager=pm)
            self.assertEqual(used_profile, "p_idle")
            self.assertIn("Success from p_idle", output)
            self.assertEqual(executed_profiles, ["p_idle"])

    def test_execute_cli_with_fallback_preferred_profile_busy_reroutes(self):
        """Test that if preferred_profile is busy, fallback immediately chooses an idle profile."""
        pm = ProfileManager(profiles=["prof_1", "prof_2"], concurrency_per_profile=1)
        pm.acquire_specific_profile("prof_1")
        self.assertTrue(pm.is_profile_busy("prof_1"))

        def mock_exec(cmd_tpl, prompt, timeout=180.0, profile=None, model_name=None):
            return f"Result from {profile}"

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
            output, used_profile = execute_cli_with_fallback(
                'echo "{prompt}"',
                "test",
                profile_manager=pm,
                preferred_profile="prof_1",
            )
            self.assertEqual(used_profile, "prof_2")
            self.assertIn("Result from prof_2", output)

    def test_sandbox_directory_lock_blocks_concurrent_access(self):
        """Test that SandboxDirectoryLock raises RuntimeError on concurrent acquisition."""
        temp_dir = tempfile.mkdtemp(prefix="test_sandbox_lock_")
        try:
            lock1 = antigravity_bridge.SandboxDirectoryLock(temp_dir, profile_name="test_p")
            lock2 = antigravity_bridge.SandboxDirectoryLock(temp_dir, profile_name="test_p")

            with lock1:
                # Same thread / process attempt while locked
                with self.assertRaises(RuntimeError) as ctx:
                    with lock2:
                        pass
                self.assertIn("currently locked", str(ctx.exception).lower())
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def test_execute_cli_with_fallback_recovers_from_sandbox_lock(self):
        """Test that a sandbox lock collision automatically falls back to next profile without error cooldown."""
        pm = ProfileManager(profiles=["locked_p", "free_p"], concurrency_per_profile=1)

        def mock_exec(cmd_tpl, prompt, timeout=180.0, profile=None, model_name=None):
            if profile == "locked_p":
                raise RuntimeError("Profile 'locked_p' sandbox is currently locked by another running process")
            return f"Success from {profile}"

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
            out, used = execute_cli_with_fallback('echo "{prompt}"', "query", profile_manager=pm)
            self.assertEqual(used, "free_p")
            self.assertIn("Success from free_p", out)
            # locked_p should NOT be in cooldown or marked with status ERROR_COOLDOWN / EXHAUSTED
            self.assertFalse(pm.is_in_cooldown("locked_p"))
            self.assertEqual(pm.state["locked_p"]["status"], "OK")

    def test_calculate_dynamic_stall_timeout(self):
        """Test dynamic stall timeout calculations for short prompts, long prompts, and reasoning models."""
        # Short prompt (< 2k chars): 40 + (50/2000)*35 = ~40.9s
        short_stall = antigravity_bridge.calculate_dynamic_stall_timeout(50)
        self.assertGreaterEqual(short_stall, 35.0)
        self.assertLessEqual(short_stall, 50.0)

        # Medium prompt (5k chars): base default 75.0s
        med_stall = antigravity_bridge.calculate_dynamic_stall_timeout(5000)
        self.assertEqual(med_stall, 75.0)

        # Long prompt (80k chars): 75 + ((80000-20000)/40000)*30 = 75 + 45 = 120.0s
        long_stall = antigravity_bridge.calculate_dynamic_stall_timeout(80000)
        self.assertEqual(long_stall, 120.0)

        # Reasoning model (even on short prompt): floor at 90.0s
        reasoning_stall = antigravity_bridge.calculate_dynamic_stall_timeout(100, model_name="gemini-3.8-flash-high")
        self.assertGreaterEqual(reasoning_stall, 90.0)

        claude_thinking_stall = antigravity_bridge.calculate_dynamic_stall_timeout(100, model_name="claude-3-7-sonnet-thinking")
        self.assertGreaterEqual(claude_thinking_stall, 90.0)

    def test_process_activity_tracker_hung_process_stalls(self):
        """Test that a silent, deadlocked/sleeping process triggers stall watchdog and is killed."""
        proc = subprocess.Popen(["sleep", "10"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        tracker = antigravity_bridge.ProcessActivityTracker(
            proc=proc,
            timeout=5.0,
            stall_timeout=0.6,
            profile="test_hung",
        )
        t0 = time.time()
        with self.assertRaises(RuntimeError) as ctx:
            tracker.run()
        elapsed = time.time() - t0
        self.assertIn("CLI Execution Stalled", str(ctx.exception))
        self.assertLess(elapsed, 2.5)  # Should terminate well before timeout (5.0s)
        self.assertIsNotNone(proc.poll())  # Process must be killed

    def test_process_activity_tracker_active_process_runs_long(self):
        """Test that an active process streaming output runs long without triggering stall ('ยาวจริง ไม่ได้ค้าง')."""
        cmd = ["bash", "-c", "echo tick1; sleep 0.4; echo tick2; sleep 0.4; echo tick3"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        tracker = antigravity_bridge.ProcessActivityTracker(
            proc=proc,
            timeout=5.0,
            stall_timeout=0.7,
            profile="test_active",
        )
        stdout_out, stderr_out = tracker.run()
        self.assertIn("tick1", stdout_out)
        self.assertIn("tick2", stdout_out)
        self.assertIn("tick3", stdout_out)
        self.assertFalse(tracker.stalled)

    def test_extract_stall_timeout_headers_and_body(self):
        """Test extraction of stall_timeout from headers and body."""
        handler = MagicMock()
        handler.headers = {"X-Stall-Timeout": "45s"}
        handler.path = "/v1/chat/completions"
        s = antigravity_bridge.AntigravityBridgeHandler._extract_stall_timeout(handler, {})
        self.assertEqual(s, 45.0)

        handler.headers = {}
        s_body = antigravity_bridge.AntigravityBridgeHandler._extract_stall_timeout(handler, {"stall_timeout": 80.0})
        self.assertEqual(s_body, 80.0)

    def test_execute_cli_with_fallback_routes_on_stall(self):
        """Test that when a profile stalls, fallback immediately routes to alternative profile."""
        pm = ProfileManager(profiles=["hung_profile", "good_profile"], concurrency_per_profile=1)

        def mock_exec(cmd_tpl, prompt, timeout=180.0, profile=None, model_name=None, stall_timeout=None, output_callback=None):
            if profile == "hung_profile":
                raise RuntimeError(f"CLI Execution Stalled: no activity for {stall_timeout}s (profile=hung_profile)")
            return f"Healthy response from {profile}"

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
            out, used = execute_cli_with_fallback('echo "{prompt}"', "query", profile_manager=pm)
            self.assertEqual(used, "good_profile")
            self.assertIn("Healthy response from good_profile", out)
            self.assertEqual(pm.state["hung_profile"]["status"], "ERROR_COOLDOWN")
            self.assertTrue(pm.is_in_cooldown("hung_profile"))

    def test_dynamic_fallback_routes_to_sonnet_when_gemini_in_cooldown(self):
        """Test that a request for gemini-3.8-flash dynamically falls back to Claude Sonnet when profile has Gemini cooldown."""
        pm = ProfileManager(profiles=["p_gemini_down"], concurrency_per_profile=1)
        pm.mark_exhausted("p_gemini_down", "RESOURCE_EXHAUSTED: Individual quota reached. Resets in 88h.", model="gemini-3.8-flash")

        self.assertTrue(pm.is_family_in_cooldown("p_gemini_down", "gemini"))
        self.assertFalse(pm.is_family_in_cooldown("p_gemini_down", "claude"))
        self.assertTrue(pm.is_sonnet_fallback_candidate("p_gemini_down"))
        self.assertTrue(pm.is_executable("p_gemini_down", model="gemini-3.8-flash"))

        executed_models = []
        def mock_exec(cmd_tpl, prompt, timeout=180.0, profile=None, model_name=None, **kwargs):
            executed_models.append(model_name)
            return f"Response from {model_name}"

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
            res = execute_cli_with_fallback('echo "{prompt}"', "Hello", profile_manager=pm, model_name="gemini-3.8-flash")
            self.assertEqual(res.effective_model, antigravity_bridge.DEFAULT_SONNET_FALLBACK_MODEL)
            self.assertEqual(executed_models, [antigravity_bridge.DEFAULT_SONNET_FALLBACK_MODEL])
            self.assertEqual(res[1], "p_gemini_down")

    def test_dynamic_fallback_restores_gemini_when_cooldown_expires(self):
        """Test that once Gemini cooldown expires, requests return directly to Gemini."""
        pm = ProfileManager(profiles=["p_restored"], concurrency_per_profile=1)
        pm.mark_exhausted("p_restored", "Rate limit", cooldown_seconds=0.01, model="gemini-3.8-flash")
        time.sleep(0.02)

        self.assertFalse(pm.is_family_in_cooldown("p_restored", "gemini"))
        self.assertFalse(pm.is_sonnet_fallback_candidate("p_restored"))

        executed_models = []
        def mock_exec(cmd_tpl, prompt, timeout=180.0, profile=None, model_name=None, **kwargs):
            executed_models.append(model_name)
            return f"Response from {model_name}"

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_exec):
            res = execute_cli_with_fallback('echo "{prompt}"', "Hello", profile_manager=pm, model_name="gemini-3.8-flash")
            self.assertEqual(res.effective_model, "gemini-3.8-flash")
            self.assertEqual(executed_models, ["gemini-3.8-flash"])

    def test_dynamic_fallback_prioritizes_gemini_over_fallback(self):
        """Test that profiles with healthy Gemini are prioritized before falling back to Sonnet profiles."""
        with patch.object(antigravity_bridge, "get_profile_account_email", return_value="user@example.com"):
            pm = ProfileManager(profiles=["p_cooldown", "p_healthy"], concurrency_per_profile=1)
            pm.mark_exhausted("p_cooldown", "Gemini quota exceeded", model="gemini-3.8-flash")

            ordered = pm.get_ordered_profiles(model="gemini-3.8-flash")
            self.assertEqual(ordered[0], "p_healthy")
            self.assertEqual(ordered[1], "p_cooldown")

    def test_dynamic_fallback_cli_gemini_to_sonnet_to_web(self):
        """Test 3-tier fallback: CLI Gemini -> CLI Sonnet -> Web Extension when both CLI models hit quota limits."""
        pm = ProfileManager(profiles=["p1"], concurrency_per_profile=1)

        # 1. Gemini only in cooldown -> Fallback Tier 1: Sonnet on CLI
        pm.mark_exhausted("p1", "Gemini quota exceeded", model="gemini-3.8-flash")
        with patch.object(antigravity_bridge, "execute_cli_command", return_value="CLI Sonnet Output") as mock_cli:
            res = execute_cli_with_fallback('echo "{prompt}"', "hello", profile_manager=pm, model_name="gemini-3.8-flash")
            self.assertEqual(res.output, "CLI Sonnet Output")
            self.assertEqual(res.effective_model, antigravity_bridge.DEFAULT_SONNET_FALLBACK_MODEL)
            mock_cli.assert_called_once()

        # 2. Both Gemini AND Claude in cooldown -> Fallback Tier 2: Web Extension
        pm.mark_exhausted("p1", "Claude quota exceeded", model="claude-sonnet-4.6-thinking")
        self.assertTrue(pm.is_family_in_cooldown("p1", "gemini"))
        self.assertTrue(pm.is_family_in_cooldown("p1", "claude"))

        # When Web Extension is connected
        with patch.object(antigravity_bridge.GLOBAL_WEB_CLIENT_MANAGER, "is_profile_connected", return_value=True), \
             patch.object(antigravity_bridge, "execute_web_command", return_value=antigravity_bridge.CLIExecutionResult("Web Output", "p1", antigravity_bridge.DEFAULT_WEB_FALLBACK_MODEL)) as mock_web:
            res = execute_cli_with_fallback('echo "{prompt}"', "hello", profile_manager=pm, model_name="gemini-3.8-flash")
            self.assertEqual(res.output, "Web Output")
            self.assertEqual(res.effective_model, antigravity_bridge.DEFAULT_WEB_FALLBACK_MODEL)
            mock_web.assert_called_once()

        # When Web Extension is NOT connected -> Fails cleanly with all profiles exhausted
        with patch.object(antigravity_bridge.GLOBAL_WEB_CLIENT_MANAGER, "is_profile_connected", return_value=False), \
             patch.object(antigravity_bridge.GLOBAL_WEB_CLIENT_MANAGER, "get_connected_profiles", return_value=[]):
            with self.assertRaises(RuntimeError) as ctx:
                execute_cli_with_fallback('echo "{prompt}"', "hello", profile_manager=pm, model_name="gemini-3.8-flash")
            self.assertIn("All agy profile execution attempts failed", str(ctx.exception))

    def test_in_flight_cli_quota_exhausted_falls_back_to_web(self):
        """Test that in-flight CLI quota error triggers immediate Web Extension fallback when Sonnet also in cooldown."""
        pm = ProfileManager(profiles=["p1"], concurrency_per_profile=1)
        # Pre-exhaust claude family so only Gemini was tried first
        pm.mark_exhausted("p1", "Claude exhausted", model="claude-sonnet-4.6-thinking")

        def mock_cli_quota(*args, **kwargs):
            raise RuntimeError("RESOURCE_EXHAUSTED: 429 quota reached for gemini-3.8-flash")

        with patch.object(antigravity_bridge, "execute_cli_command", side_effect=mock_cli_quota), \
             patch.object(antigravity_bridge.GLOBAL_WEB_CLIENT_MANAGER, "is_profile_connected", return_value=True), \
             patch.object(antigravity_bridge, "execute_web_command", return_value=antigravity_bridge.CLIExecutionResult("Recovered via Web", "p1", antigravity_bridge.DEFAULT_WEB_FALLBACK_MODEL)) as mock_web:
            res = execute_cli_with_fallback('echo "{prompt}"', "hello", profile_manager=pm, model_name="gemini-3.8-flash")
            self.assertEqual(res.output, "Recovered via Web")
            self.assertEqual(res.effective_model, antigravity_bridge.DEFAULT_WEB_FALLBACK_MODEL)
            mock_web.assert_called_once()

    def test_get_ordered_profiles_prioritizes_cli_gemini_then_sonnet_then_web(self):
        """Test profile ordering puts CLI Gemini > CLI Sonnet > Web Extension > Exhausted."""
        with patch.object(antigravity_bridge, "get_profile_account_email", return_value="user@example.com"), \
             patch.object(antigravity_bridge.GLOBAL_WEB_CLIENT_MANAGER, "is_profile_connected", return_value=True):
            pm = ProfileManager(profiles=["p_web_only", "p_cli_gemini", "p_cli_sonnet"], concurrency_per_profile=1)
            # p_cli_sonnet: Gemini in cooldown, Sonnet available
            pm.mark_exhausted("p_cli_sonnet", "Gemini exhausted", model="gemini-3.8-flash")
            # p_web_only: Both in cooldown, but Web connected
            pm.mark_exhausted("p_web_only", "Gemini exhausted", model="gemini-3.8-flash")
            pm.mark_exhausted("p_web_only", "Claude exhausted", model="claude-sonnet-4.6-thinking")

            ordered = pm.get_ordered_profiles(model="gemini-3.8-flash")
            self.assertEqual(ordered[0], "p_cli_gemini")
            self.assertEqual(ordered[1], "p_cli_sonnet")
            self.assertEqual(ordered[2], "p_web_only")

    def test_channel_disabling_and_persistence(self):
        """Test channel-specific disabling (cli, web) and backward compatibility."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = os.path.join(tmpdir, "bridge_config.json")
            with patch.object(antigravity_bridge, "get_canonical_antigravity_dir", return_value=tmpdir):
                # Initially all enabled
                self.assertTrue(antigravity_bridge.is_profile_cli_enabled("p_test"))
                self.assertTrue(antigravity_bridge.is_profile_web_enabled("p_test"))

                # Disable CLI only
                antigravity_bridge.persist_channel_profile_state("p_test", channel="cli", disabled=True)
                self.assertFalse(antigravity_bridge.is_profile_cli_enabled("p_test"))
                self.assertTrue(antigravity_bridge.is_profile_web_enabled("p_test"))

                # Re-enable CLI, disable Web
                antigravity_bridge.persist_channel_profile_state("p_test", channel="cli", disabled=False)
                antigravity_bridge.persist_channel_profile_state("p_test", channel="web", disabled=True)
                self.assertTrue(antigravity_bridge.is_profile_cli_enabled("p_test"))
                self.assertFalse(antigravity_bridge.is_profile_web_enabled("p_test"))

                # Disable all
                antigravity_bridge.persist_channel_profile_state("p_test", channel="all", disabled=True)
                self.assertFalse(antigravity_bridge.is_profile_cli_enabled("p_test"))
                self.assertFalse(antigravity_bridge.is_profile_web_enabled("p_test"))

                # Verify file contains proper keys
                with open(cfg_path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                self.assertIn("p_test", saved.get("cli_disabled_profiles", []))
                self.assertIn("p_test", saved.get("web_disabled_profiles", []))
                self.assertIn("p_test", saved.get("disabled_profiles", []))

    def test_channel_filtering_in_profile_manager(self):
        """Test that get_ordered_profiles respects channel filter (cli, web)."""
        pm = ProfileManager(profiles=["p_cli_only", "p_web_only", "p_both", "p_none"])

        def mock_cli_enabled(p):
            return p in ("p_cli_only", "p_both")

        def mock_web_enabled(p):
            return p in ("p_web_only", "p_both")

        with patch.object(antigravity_bridge, "is_profile_cli_enabled", side_effect=mock_cli_enabled), \
             patch.object(antigravity_bridge, "is_profile_web_enabled", side_effect=mock_web_enabled), \
             patch.object(antigravity_bridge.GLOBAL_WEB_CLIENT_MANAGER, "is_profile_connected", return_value=True), \
             patch.object(antigravity_bridge, "get_profile_account_email", return_value="test@example.com"):

            cli_ordered = pm.get_ordered_profiles(channel="cli")
            self.assertIn("p_cli_only", cli_ordered)
            self.assertIn("p_both", cli_ordered)
            self.assertNotIn("p_web_only", cli_ordered)
            self.assertNotIn("p_none", cli_ordered)

            web_ordered = pm.get_ordered_profiles(channel="web")
            self.assertIn("p_web_only", web_ordered)
            self.assertIn("p_both", web_ordered)
            self.assertNotIn("p_cli_only", web_ordered)
            self.assertNotIn("p_none", web_ordered)

    def test_web_client_manager_lifecycle(self):
        """Test registration, job dispatch, delta handling, and unregistration in WebClientManager."""
        mgr = antigravity_bridge.WebClientManager()
        client = mgr.register_client(profile="test_prof", email="tester@gmail.com", client_id="c123")

        self.assertTrue(mgr.is_profile_connected("test_prof"))
        self.assertIn("test_prof", mgr.get_connected_profiles())

        job = antigravity_bridge.WebJob(
            job_id="job_abc",
            profile="test_prof",
            prompt="Hello Gemini",
            model="antigravity",
            stream=True
        )

        dispatched = mgr.dispatch_job(job)
        self.assertTrue(dispatched)
        msg = client.queue.get_nowait()
        self.assertEqual(msg["event"], "job")
        self.assertEqual(msg["data"]["jobId"], "job_abc")

        # Delta streaming
        mgr.handle_delta("job_abc", "Hello ")
        mgr.handle_delta("job_abc", "World!")
        self.assertEqual(job.delta_queue.get_nowait(), "Hello ")
        self.assertEqual(job.delta_queue.get_nowait(), "World!")

        # Done
        mgr.handle_done("job_abc", "Hello World!")
        self.assertTrue(job.done_event.is_set())
        self.assertEqual(job.final_output, "Hello World!")

        # Unregister
        mgr.unregister_client("c123")
        self.assertFalse(mgr.is_profile_connected("test_prof"))

    def _make_dispatched_job(self, mgr, job_id):
        mgr.register_client(profile="p", email="p@gmail.com", client_id="c_" + job_id)
        job = antigravity_bridge.WebJob(job_id=job_id, profile="p", prompt="hi", model="gemini-web")
        mgr.dispatch_job(job)
        return job

    def test_handle_done_keeps_streamed_output_when_browser_text_is_shorter(self):
        """A short final page reading must not overwrite a longer streamed answer.

        Gemini re-renders mid-answer (the thoughts panel collapses, markdown re-renders), so
        the browser's final reading of the page can hold less than the deltas already sent.
        Letting it overwrite unconditionally is how a complete answer became a stub.
        """
        mgr = antigravity_bridge.WebClientManager()
        job = self._make_dispatched_job(mgr, "job_short_final")

        mgr.handle_delta("job_short_final", "A complete answer that streamed in full. ")
        mgr.handle_delta("job_short_final", "With a second sentence.")
        streamed = job.final_output

        mgr.handle_done("job_short_final", "I've created the document.")

        self.assertEqual(job.final_output, streamed)
        self.assertIn("second sentence", job.final_output)

    def test_handle_done_prefers_browser_text_when_it_is_more_complete(self):
        """The browser's final reading wins when it actually carries more than the stream."""
        mgr = antigravity_bridge.WebClientManager()
        job = self._make_dispatched_job(mgr, "job_full_final")

        mgr.handle_delta("job_full_final", "Partial ")
        mgr.handle_done("job_full_final", "Partial answer plus everything added after the re-render.")

        self.assertEqual(job.final_output, "Partial answer plus everything added after the re-render.")

    def test_handle_done_without_browser_text_keeps_deltas(self):
        """An empty/omitted final text must leave the streamed answer intact."""
        mgr = antigravity_bridge.WebClientManager()
        job = self._make_dispatched_job(mgr, "job_no_final")

        mgr.handle_delta("job_no_final", "Streamed only.")
        mgr.handle_done("job_no_final", "")

        self.assertEqual(job.final_output, "Streamed only.")

    def test_find_profile_by_email(self):
        """Test auto-matching profile from Google account email."""
        with patch.object(antigravity_bridge, "get_canonical_antigravity_dir") as mock_dir, \
             patch("os.path.isdir", return_value=True), \
             patch("os.listdir", return_value=["p1", "p2"]), \
             patch.object(antigravity_bridge, "get_profile_account_email") as mock_email:

            mock_dir.return_value = "/fake/antigravity"
            mock_email.side_effect = lambda p: "alice@gmail.com" if p == "p1" else "bob@gmail.com"

            matched = antigravity_bridge.find_profile_by_email("alice@gmail.com")
            self.assertEqual(matched, "p1")

            matched_bob = antigravity_bridge.find_profile_by_email("BOB@gmail.com")
            self.assertEqual(matched_bob, "p2")

            self.assertIsNone(antigravity_bridge.find_profile_by_email("charlie@gmail.com"))


if __name__ == "__main__":
    unittest.main()



