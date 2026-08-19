"""Unit tests for Antigravity / agy API Bridge Server."""

import json
import os
import shutil
import sys
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

            # Fast path: only healthy profiles returned when available
            ordered = pm.get_ordered_profiles()
            self.assertEqual(ordered, ["profile_gamma"])

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


if __name__ == "__main__":
    unittest.main()


