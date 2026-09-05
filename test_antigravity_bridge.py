"""Unit tests for Antigravity / agy API Bridge Server."""

import json
import os
import shutil
import signal
import sys
import subprocess
import threading
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
        self.assertEqual(prof_def_small, 90.0)
        self.assertEqual(total_def_small, 240.0)

        # 120KB prompt with default settings -> must be capped at 150.0s (prevents 800s+ timeout blowout)
        prof_def_120k, total_def_120k = antigravity_bridge.AntigravityBridgeHandler._extract_request_timeouts(handler_default, {}, prompt_len=120000)
        self.assertEqual(prof_def_120k, 150.0)
        self.assertEqual(total_def_120k, 300.0)

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


if __name__ == "__main__":
    unittest.main()



