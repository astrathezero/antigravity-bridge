#!/usr/bin/env python3
"""
Unit tests for Gemini Headless Image Generation Bridge (gemini_image_bridge.py)
"""

import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from http.server import HTTPServer
import threading
import urllib.request
import urllib.error

from gemini_image_bridge import (
    GeminiImageHTTPHandler,
    GeminiBrowserClient,
    GeminiAuthError,
    GeminiGenerationError,
    PLAYWRIGHT_AVAILABLE,
)


class TestGeminiImageBridgeServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock_client = MagicMock(spec=GeminiBrowserClient)
        cls.mock_client.profile_dir = "/tmp/test_gemini_profile"
        cls.mock_client.headless = True
        
        GeminiImageHTTPHandler.client = cls.mock_client
        # Bind to port 0 for automatic ephemeral port assignment
        cls.server = HTTPServer(("127.0.0.1", 0), GeminiImageHTTPHandler)
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.mock_client.reset_mock()
        self.mock_client.generate_image.side_effect = None
        self.mock_client.check_auth_status.side_effect = None

    def test_health_endpoint(self):
        self.mock_client.check_auth_status.return_value = {"logged_in": True, "url": "https://gemini.google.com/app"}
        req = urllib.request.Request(f"{self.base_url}/health")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertEqual(data.get("service"), "gemini-image-bridge")
            self.assertEqual(data.get("status"), "online")
            self.assertTrue(data.get("auth", {}).get("logged_in"))

    def test_models_endpoint(self):
        req = urllib.request.Request(f"{self.base_url}/v1/models")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertEqual(data.get("object"), "list")
            model_ids = [m["id"] for m in data.get("data", [])]
            self.assertIn("imagen-3", model_ids)

    def test_generate_image_success(self):
        self.mock_client.generate_image.return_value = {
            "created": 1718000000,
            "data": [
                {
                    "b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                    "revised_prompt": "Generate an image of: a golden retriever puppy"
                }
            ]
        }
        payload = json.dumps({"prompt": "a golden retriever puppy", "response_format": "b64_json"}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/v1/images/generations",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("data", data)
            self.assertEqual(len(data["data"]), 1)
            self.assertTrue("b64_json" in data["data"][0])

    def test_generate_image_missing_prompt(self):
        payload = json.dumps({"response_format": "b64_json"}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/v1/images/generations",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 400)

    def test_generate_image_auth_error(self):
        self.mock_client.generate_image.side_effect = GeminiAuthError("Not logged in")
        payload = json.dumps({"prompt": "cyberpunk car"}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/v1/images/generations",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 401)

    def test_generate_image_generation_error(self):
        self.mock_client.generate_image.side_effect = GeminiGenerationError("Safety filter triggered")
        payload = json.dumps({"prompt": "something blocked"}).encode()
        req = urllib.request.Request(
            f"{self.base_url}/v1/images/generations",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 502)

    def test_404_not_found(self):
        req = urllib.request.Request(f"{self.base_url}/v1/unknown")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 404)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class TestAuthExportImport(unittest.TestCase):
    def test_import_cookie_string_parser(self):
        client = GeminiBrowserClient(profile_dir="/tmp/test_gemini_profile_cookies")
        cookie_header = "__Secure-1PSID=test_psid_val; SID=test_sid_val; HSID=test_hsid"
        with patch.object(client, "_create_context") as mock_create:
            mock_ctx = MagicMock()
            mock_create.return_value = mock_ctx
            mock_page = MagicMock()
            mock_ctx.new_page.return_value = mock_page

            res = client.import_cookie_string(cookie_header)
            self.assertTrue(res)
            mock_ctx.add_cookies.assert_called_once()
            added_cookies = mock_ctx.add_cookies.call_args[0][0]
            self.assertEqual(len(added_cookies), 3)
            self.assertEqual(added_cookies[0]["name"], "__Secure-1PSID")
            self.assertEqual(added_cookies[0]["value"], "test_psid_val")


if __name__ == "__main__":
    unittest.main()
