#!/usr/bin/env python3
"""
Gemini Headless Image Generation Bridge Server
Translates OpenAI-compatible /v1/images/generations requests into
automated headless browser interactions with gemini.google.com (Imagen / Gemini Web).
"""

import argparse
import base64
import json
import os
import re
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Dict, Any, Optional, List, Tuple
from urllib.parse import urlparse, parse_qs

# Try importing Playwright
try:
    from playwright.sync_api import sync_playwright, Playwright, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    Playwright = Any  # type: ignore
    BrowserContext = Any  # type: ignore
    Page = Any  # type: ignore
    PlaywrightTimeoutError = Exception  # type: ignore


DEFAULT_PROFILE_DIR = os.path.expanduser("~/.config/gemini-image-bridge/browser_profile")
DEFAULT_PORT = 8001
DEFAULT_HOST = "127.0.0.1"
GEMINI_URL = "https://gemini.google.com/app"

# Chromium stealth arguments to avoid anti-bot detection
CHROME_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
]

STEALTH_JS = """
// Overwrite the `webdriver` property to avoid bot detection
Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
});

// Mock plugins and languages
Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'th']
});

Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5]
});
"""


class GeminiAuthError(Exception):
    """Raised when the session is not authenticated with Google/Gemini."""
    pass


class GeminiGenerationError(Exception):
    """Raised when image generation fails on Gemini web."""
    pass


class GeminiBrowserClient:
    """Manages Playwright browser instance and Gemini web automation."""

    def __init__(self, profile_dir: str = DEFAULT_PROFILE_DIR, headless: bool = True):
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError(
                "Playwright is not installed. Please install it with:\n"
                "  pip3 install playwright\n"
                "  python3 -m playwright install chromium"
            )
        self.profile_dir = os.path.abspath(os.path.expanduser(profile_dir))
        self.headless = headless
        self.lock = threading.Lock()
        os.makedirs(self.profile_dir, exist_ok=True)

    def _create_context(self, p: Playwright, headless: Optional[bool] = None) -> BrowserContext:
        """Launch a persistent context with stealth settings."""
        is_headless = self.headless if headless is None else headless
        context = p.chromium.launch_persistent_context(
            user_data_dir=self.profile_dir,
            headless=is_headless,
            args=CHROME_ARGS,
            viewport={"width": 1280, "height": 900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            ignore_https_errors=True,
        )
        context.add_init_script(STEALTH_JS)
        return context

    def setup_login_interactive(self, timeout_seconds: int = 300) -> bool:
        """
        Open a visible (headed) browser to let the user log into Google Account manually.
        Waits until the Gemini chat box appears or timeout expires.
        """
        print("\n" + "=" * 60)
        print(" [SETUP LOGIN MODE]")
        print(" A browser window will now open.")
        print(" 1. Please log in to your Google Account.")
        print(" 2. Complete any 2-Step Verification (2FA).")
        print(" 3. Wait until you reach the Gemini main chat interface.")
        print(f" Profile Directory: {self.profile_dir}")
        print("=" * 60 + "\n")

        with sync_playwright() as p:
            context = self._create_context(p, headless=False)
            page = context.new_page()
            
            try:
                page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                print(f"Notice: Initial page load returned: {e}")

            print("\n" + "-" * 60)
            print(" [INSTRUCTIONS]")
            print(" 1. The browser window is now open on your screen.")
            print(" 2. Click 'Sign in' (or 'ลงชื่อเข้าสู่ระบบ') and complete your Google login.")
            print(" 3. Wait until you see your account name / avatar on the Gemini home screen.")
            print(" 4. When ready, COME BACK TO THIS TERMINAL and press [ENTER].")
            print(" (The browser will NOT auto-close and will wait for you)")
            print("-" * 60 + "\n")

            try:
                input(">>> Press [ENTER] here once you have finished logging in: ")
            except (EOFError, KeyboardInterrupt):
                print("\nReceived exit signal. Saving session...")

            # Verify login status before closing
            time.sleep(1)
            sign_in_elem = page.locator("a[href*='accounts.google.com/ServiceLogin'], button:has-text('Sign in'), button:has-text('ลงชื่อเข้าสู่ระบบ')").first
            avatar_elem = page.locator("a[href*='accounts.google.com/SignOutOptions'], [aria-label*='Google Account'], [aria-label*='บัญชี Google'], button.gb_d").first
            
            is_signed_in = False
            try:
                is_signed_in = avatar_elem.is_visible(timeout=2000) and not sign_in_elem.is_visible(timeout=1000)
            except Exception:
                pass

            # Give a brief moment for storage/cookies to persist
            time.sleep(3)
            context.close()

            if is_signed_in:
                print("\n[SUCCESS] Confirmed Google Account login session on Gemini!")
                print("[SUCCESS] Login session saved successfully.")
                print(f"You can now run image generation in headless mode.")
                return True
            else:
                print("\n[NOTICE] Browser closed and session saved.")
                print("You can verify auth status with: python3 gemini_image_bridge.py --check-auth")
                return True

    def export_auth(self, export_path: str) -> bool:
        """
        Export authenticated cookies and localStorage to a portable JSON file.
        This JSON file can be transferred to a headless Linux server.
        """
        export_file = Path(export_path).resolve()
        with self.lock:
            with sync_playwright() as p:
                context = self._create_context(p, headless=True)
                page = context.new_page()
                try:
                    page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=30000)
                    time.sleep(2)
                except Exception:
                    pass
                
                export_file.parent.mkdir(parents=True, exist_ok=True)
                context.storage_state(path=str(export_file))
                context.close()
                print(f"\n[SUCCESS] Authentication state exported to: {export_file}")
                print(f"Transfer this file to your Linux server and run:")
                print(f"  python3 gemini_image_bridge.py --import-auth {export_file.name}")
                return True

    def import_auth(self, import_path: str) -> bool:
        """
        Import cookies and storage state from a JSON file into the local profile.
        Ideal for headless Linux servers without GUI.
        """
        import_file = Path(import_path).resolve()
        if not import_file.is_file():
            print(f"[ERROR] Auth file not found: {import_file}", file=sys.stderr)
            return False

        with open(import_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        with self.lock:
            with sync_playwright() as p:
                context = self._create_context(p, headless=True)
                
                # 1. Add cookies
                cookies = data.get("cookies", [])
                if isinstance(data, list):  # If exported directly as a cookie array from Chrome extension
                    cookies = data
                
                if cookies:
                    formatted_cookies = []
                    for c in cookies:
                        cookie_dict = {
                            "name": c["name"],
                            "value": c["value"],
                            "domain": c.get("domain", ".google.com"),
                            "path": c.get("path", "/"),
                            "secure": c.get("secure", True),
                        }
                        if "sameSite" in c and c["sameSite"] in ["Strict", "Lax", "None"]:
                            cookie_dict["sameSite"] = c["sameSite"]
                        formatted_cookies.append(cookie_dict)
                    try:
                        context.add_cookies(formatted_cookies)
                    except Exception as e:
                        print(f"Warning: partial cookie import: {e}")

                # 2. Inject localStorage if present
                page = context.new_page()
                try:
                    page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    pass

                origins = data.get("origins", [])
                for origin_entry in origins:
                    origin = origin_entry.get("origin", "")
                    if "google.com" in origin:
                        for item in origin_entry.get("localStorage", []):
                            page.evaluate(
                                "([k, v]) => { try { localStorage.setItem(k, v); } catch(e){} }",
                                [item["name"], item["value"]]
                            )

                time.sleep(2)
                context.close()
                print(f"\n[SUCCESS] Authentication state successfully imported into: {self.profile_dir}")
                return True

    def import_cookie_string(self, raw_cookie_str: str) -> bool:
        """
        Import cookies from a raw HTTP 'Cookie:' header string (e.g. '__Secure-1PSID=...; SID=...').
        """
        cookies = []
        pairs = raw_cookie_str.split(";")
        for pair in pairs:
            if "=" in pair:
                name, val = pair.strip().split("=", 1)
                cookies.append({
                    "name": name.strip(),
                    "value": val.strip(),
                    "domain": ".google.com",
                    "path": "/",
                    "secure": True
                })
        
        with self.lock:
            with sync_playwright() as p:
                context = self._create_context(p, headless=True)
                context.add_cookies(cookies)
                page = context.new_page()
                try:
                    page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    pass
                time.sleep(2)
                context.close()
                print(f"[SUCCESS] Injected {len(cookies)} cookies into {self.profile_dir}")
                return True

    def check_auth_status(self) -> Dict[str, Any]:
        """Check if current profile is logged in to Gemini."""
        with self.lock:
            with sync_playwright() as p:
                try:
                    context = self._create_context(p, headless=True)
                    page = context.new_page()
                    page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=30000)
                    time.sleep(3)

                    # Check current URL
                    current_url = page.url
                    if "accounts.google.com" in current_url:
                        context.close()
                        return {"logged_in": False, "reason": "Redirected to Google Accounts login page"}

                    sign_in_elem = page.locator("a[href*='accounts.google.com/ServiceLogin'], button:has-text('Sign in'), button:has-text('ลงชื่อเข้าสู่ระบบ')").first
                    avatar_elem = page.locator("a[href*='accounts.google.com/SignOutOptions'], [aria-label*='Google Account'], [aria-label*='บัญชี Google'], button.gb_d").first

                    is_logged_in = avatar_elem.is_visible(timeout=3000) and not sign_in_elem.is_visible(timeout=1000)
                    context.close()
                    return {"logged_in": bool(is_logged_in), "url": current_url}
                except Exception as e:
                    return {"logged_in": False, "error": str(e)}

    def generate_image(
        self,
        prompt: str,
        timeout: int = 120,
        response_format: str = "b64_json"
    ) -> Dict[str, Any]:
        """
        Automates Gemini Web UI to generate an image from prompt.
        Returns a dict matching OpenAI /v1/images/generations data response.
        """
        with self.lock:
            with sync_playwright() as p:
                context = self._create_context(p, headless=self.headless)
                page = context.new_page()

                try:
                    # 1. Navigate to Gemini Web App
                    page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass

                # Check if redirected to login
                if "accounts.google.com" in page.url:
                    context.close()
                    raise GeminiAuthError(
                        "Not logged in to Google/Gemini. Please run `python3 gemini_image_bridge.py --setup-login` first."
                    )

                # 2. Locate Chat Input
                try:
                    input_locator = page.locator("rich-textarea div[contenteditable='true'], div[contenteditable='true'], textarea").first
                    input_locator.wait_for(state="visible", timeout=20000)
                except PlaywrightTimeoutError:
                    context.close()
                    raise GeminiAuthError(
                        "Gemini chat input box not found. Make sure you are logged in using `--setup-login`."
                    )

                # 3. Activate "สร้างรูปภาพ" (Create Image / Nano Banana) Tool Tag if needed
                try:
                    # Check if already active
                    is_active = page.evaluate("""
                    () => {
                        const chips = Array.from(document.querySelectorAll('mat-chip, .tool-chip, .pill, [data-test-id*="tool"], .attachment-chip'));
                        return chips.some(c => (c.innerText || '').includes('สร้างรูปภาพ') || (c.innerText || '').includes('Create image'));
                    }
                    """)
                    if not is_active:
                        # Click the leading tool/attachment '+' or 'X' button
                        opened_menu = page.evaluate("""
                        () => {
                            const buttons = Array.from(document.querySelectorAll('button')).filter(b => {
                                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                                const icon = b.querySelector('mat-icon') ? b.querySelector('mat-icon').innerText.toLowerCase() : '';
                                return aria.includes('เครื่องมือ') || aria.includes('แนบ') || aria.includes('add') || 
                                       aria.includes('attach') || aria.includes('upload') || aria.includes('menu') || 
                                       aria.includes('เปิดเมนู') || aria.includes('ตัวเลือก') ||
                                       icon.includes('add') || icon.includes('attach_file') || icon.includes('close');
                            });
                            if (buttons.length > 0) {
                                buttons[0].click();
                                return true;
                            }
                            // Fallback: look near rich-textarea
                            const leadingBtn = document.querySelector('rich-textarea')?.parentElement?.querySelector('button') ||
                                               document.querySelector('.leading-actions button') ||
                                               document.querySelector('.input-area button');
                            if (leadingBtn) {
                                leadingBtn.click();
                                return true;
                            }
                            return false;
                        }
                        """)
                        
                        time.sleep(0.8)

                        # Click "สร้างรูปภาพ" or "Create image" in the menu
                        page.evaluate("""
                        () => {
                            const items = Array.from(document.querySelectorAll('[role="menuitem"], mat-menu-item, .mat-menu-panel button, .cdk-overlay-pane button, .cdk-overlay-pane div, [role="menu"] *'));
                            for (const item of items) {
                                const text = (item.innerText || '').trim();
                                const aria = (item.getAttribute('aria-label') || '').trim();
                                if (text.includes('สร้างรูปภาพ') || aria.includes('สร้างรูปภาพ') || 
                                    text.includes('Create image') || aria.includes('Create image')) {
                                    item.click();
                                    return true;
                                }
                            }
                            return false;
                        }
                        """)
                        time.sleep(0.5)
                        print("[GeminiImageBridge] Activated 'สร้างรูปภาพ' (Create Image / Nano Banana) tool tag.")
                except Exception as tool_err:
                    print(f"[GeminiImageBridge] Tool activation note: {tool_err}")

                # Format prompt to trigger image generation if not already explicit
                formatted_prompt = prompt
                lower_p = prompt.lower()
                if not any(k in lower_p for k in ["generate an image", "create an image", "draw", "generate image", "create image", "สร้างรูปภาพ", "วาดรูป"]):
                    formatted_prompt = f"Generate an image of: {prompt}"

                # 4. Enter Prompt
                input_locator.click()
                input_locator.fill("")
                input_locator.type(formatted_prompt, delay=20)
                time.sleep(0.5)

                # 5. Click Send Button or Press Enter
                try:
                    send_button = page.locator("button[aria-label*='Send'], button[aria-label*='ส่ง'], button.send-button, mat-icon[data-mat-icon-name='send']").first
                    if send_button.is_visible(timeout=2000):
                        send_button.click()
                    else:
                        input_locator.press("Enter")
                except Exception:
                    input_locator.press("Enter")

                print(f"[GeminiImageBridge] Prompt sent: '{formatted_prompt[:60]}...'. Waiting for generation...")

                # 5. Wait for generated image output
                # Uses robust in-page inspection to find generated image inside model response, strictly filtering out Google avatars
                start_wait = time.time()
                found_image_url = None
                found_img_info = None

                js_find_image = """
                () => {
                    const excludeSelectors = [
                        'header', 'nav', 'aside',
                        '[aria-label*="Google Account"]', '[aria-label*="Account"]',
                        '.gb_a', '.gb_d', '.gb_c', '.avatar', 'user-query'
                    ];
                    
                    const candidates = Array.from(document.querySelectorAll(
                        'model-response img, .model-response img, .response-container img, message-content img, generated-image img, figure img, picture img, img[src*="googleusercontent.com"], img[src*="blob:"]'
                    ));

                    for (let i = candidates.length - 1; i >= 0; i--) {
                        const img = candidates[i];
                        
                        // Check if contained within excluded elements
                        let isExcluded = false;
                        for (const sel of excludeSelectors) {
                            if (img.closest(sel)) {
                                isExcluded = true;
                                break;
                            }
                        }
                        if (isExcluded) continue;

                        const src = img.src || img.getAttribute('src') || '';
                        if (!src) continue;

                        // Filter out Google profile avatars and icons
                        if (src.includes('/a/') || src.includes('/ogw/') || src.includes('photo.jpg') || src.includes('default_user')) continue;
                        if (src.includes('=s32') || src.includes('=s64') || src.includes('=s96')) continue;

                        // Check size: real generated images from Imagen are large (>= 150px)
                        const rect = img.getBoundingClientRect();
                        const naturalW = img.naturalWidth || 0;
                        const naturalH = img.naturalHeight || 0;

                        if (naturalW >= 150 || naturalH >= 150 || rect.width >= 150 || rect.height >= 150) {
                            return {
                                src: src,
                                width: naturalW || rect.width,
                                height: naturalH || rect.height
                            };
                        }
                    }
                    return null;
                }
                """

                # Wait loop
                while time.time() - start_wait < timeout:
                    try:
                        info = page.evaluate(js_find_image)
                        if info and info.get("src"):
                            found_image_url = info["src"]
                            found_img_info = info
                            # Wait a brief moment for complete render
                            time.sleep(2)
                            break
                    except Exception:
                        pass
                    time.sleep(2)

                if not found_image_url:
                    # Check if Gemini returned text explanation or error
                    page_text = ""
                    try:
                        page_text = page.locator(".model-response-text, .response-container, model-response").last.inner_text(timeout=3000)
                    except Exception:
                        pass
                    context.close()
                    raise GeminiGenerationError(
                        f"Image generation timed out or failed. Model response: {page_text[:200] if page_text else 'No response text found'}"
                    )

                print(f"[GeminiImageBridge] Found generated image: {found_image_url[:80]}... ({found_img_info.get('width',0)}x{found_img_info.get('height',0)})")

                # 6. Extract / Download the image
                base64_data = ""
                try:
                    js_fetch_script = """
                    async (url) => {
                        const response = await fetch(url);
                        const blob = await response.blob();
                        return new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    }
                    """
                    data_url = page.evaluate(js_fetch_script, found_image_url)
                    if data_url and "," in data_url:
                        base64_data = data_url.split(",", 1)[1]
                except Exception as fetch_err:
                    print(f"[GeminiImageBridge] Warning: Browser fetch failed ({fetch_err})")

                context.close()

                # Build response item
                item: Dict[str, Any] = {
                    "revised_prompt": formatted_prompt
                }
                if response_format == "b64_json" or not found_image_url:
                    item["b64_json"] = base64_data
                else:
                    item["url"] = found_image_url
                    if base64_data:
                        item["b64_json"] = base64_data

                return {
                    "created": int(time.time()),
                    "data": [item]
                }


class GeminiImageHTTPHandler(BaseHTTPRequestHandler):
    """Handles OpenAI-compatible HTTP requests."""

    client: Optional[GeminiBrowserClient] = None

    def _set_headers(self, status: int = 200, content_type: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(200)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path in ("", "/", "/health"):
            auth_info = {"status": "uninitialized"}
            if self.client:
                auth_info = self.client.check_auth_status()
            response = {
                "service": "gemini-image-bridge",
                "status": "online",
                "auth": auth_info
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response, indent=2).encode("utf-8"))

        elif path in ("/v1/models", "/models"):
            models = {
                "object": "list",
                "data": [
                    {
                        "id": "imagen-3",
                        "object": "model",
                        "created": 1718000000,
                        "owned_by": "google",
                        "permission": [],
                        "root": "imagen-3",
                        "parent": None
                    },
                    {
                        "id": "gemini-web-image",
                        "object": "model",
                        "created": 1718000000,
                        "owned_by": "google",
                        "permission": [],
                        "root": "gemini-web-image",
                        "parent": None
                    }
                ]
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(models, indent=2).encode("utf-8"))

        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": f"Endpoint {path} not found"}).encode("utf-8"))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path in ("/v1/images/generations", "/images/generations"):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            
            try:
                payload = json.loads(body.decode("utf-8")) if body else {}
            except Exception as e:
                self._set_headers(400)
                self.wfile.write(json.dumps({"error": f"Invalid JSON payload: {e}"}).encode("utf-8"))
                return

            prompt = payload.get("prompt")
            if not prompt:
                self._set_headers(400)
                self.wfile.write(json.dumps({"error": "Missing required field: 'prompt'"}).encode("utf-8"))
                return

            response_format = payload.get("response_format", "b64_json")
            timeout = int(payload.get("timeout", 120))

            if not self.client:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": "Browser client not initialized"}).encode("utf-8"))
                return

            try:
                result = self.client.generate_image(
                    prompt=prompt,
                    timeout=timeout,
                    response_format=response_format
                )
                self._set_headers(200)
                self.wfile.write(json.dumps(result).encode("utf-8"))
            except GeminiAuthError as auth_err:
                self._set_headers(401)
                self.wfile.write(json.dumps({"error": str(auth_err), "code": "auth_required"}).encode("utf-8"))
            except GeminiGenerationError as gen_err:
                self._set_headers(502)
                self.wfile.write(json.dumps({"error": str(gen_err), "code": "generation_failed"}).encode("utf-8"))
            except Exception as err:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": f"Internal server error: {err}"}).encode("utf-8"))
        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": f"Endpoint {path} not found"}).encode("utf-8"))


def start_server(host: str, port: int, client: GeminiBrowserClient):
    """Starts the HTTP server on specified host/port."""
    GeminiImageHTTPHandler.client = client
    server = HTTPServer((host, port), GeminiImageHTTPHandler)
    print("\n" + "=" * 60)
    print(f" Gemini Image Bridge Server running at http://{host}:{port}")
    print(f" - OpenAI Endpoint : POST http://{host}:{port}/v1/images/generations")
    print(f" - Health & Models : GET  http://{host}:{port}/health , GET /v1/models")
    print(f" - Browser Profile : {client.profile_dir}")
    print(f" - Mode            : {'Headless' if client.headless else 'Visible (Headed)'}")
    print("=" * 60 + "\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()


def main():
    parser = argparse.ArgumentParser(
        description="Gemini Headless Image Generation Bridge (OpenAI /v1/images/generations compatible)"
    )
    parser.add_argument(
        "--setup-login",
        action="store_true",
        help="Open visible browser to log in to Google/Gemini account and save session."
    )
    parser.add_argument(
        "--check-auth",
        action="store_true",
        help="Check if the saved session is currently authenticated."
    )
    parser.add_argument(
        "--export-auth",
        type=str,
        default=None,
        metavar="FILE.json",
        help="Export authenticated session (cookies & storage state) to a JSON file for Linux server transfer."
    )
    parser.add_argument(
        "--import-auth",
        type=str,
        default=None,
        metavar="FILE.json",
        help="Import authenticated session JSON file into current profile (for headless Linux servers)."
    )
    parser.add_argument(
        "--import-cookies",
        type=str,
        default=None,
        metavar="COOKIE_STR",
        help="Import raw cookie header string (e.g. '__Secure-1PSID=...; SID=...')."
    )
    parser.add_argument(
        "--prompt",
        type=str,
        default=None,
        help="One-shot prompt to generate an image directly from terminal without running server."
    )
    parser.add_argument(
        "--output",
        type=str,
        default="generated_image.png",
        help="File path to save the generated image (when using --prompt)."
    )
    parser.add_argument(
        "--host",
        type=str,
        default=DEFAULT_HOST,
        help=f"Server host address (default: {DEFAULT_HOST})"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Server port (default: {DEFAULT_PORT})"
    )
    parser.add_argument(
        "--profile-dir",
        type=str,
        default=DEFAULT_PROFILE_DIR,
        help=f"Browser profile directory (default: {DEFAULT_PROFILE_DIR})"
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in visible (headed) mode for debugging."
    )

    args = parser.parse_args()

    client = GeminiBrowserClient(
        profile_dir=args.profile_dir,
        headless=not args.headed
    )

    # 1. Setup Login Mode
    if args.setup_login:
        client.setup_login_interactive()
        return

    # 2. Export Auth Mode
    if args.export_auth:
        client.export_auth(args.export_auth)
        return

    # 3. Import Auth Mode
    if args.import_auth:
        client.import_auth(args.import_auth)
        return

    # 4. Import Raw Cookies Mode
    if args.import_cookies:
        client.import_cookie_string(args.import_cookies)
        return

    # 5. Check Auth Status
    if args.check_auth:
        status = client.check_auth_status()
        print(json.dumps(status, indent=2))
        return

    # 6. Direct One-Shot Prompt Generation
    if args.prompt:
        print(f"Generating image for prompt: '{args.prompt}'...")
        try:
            res = client.generate_image(args.prompt, response_format="b64_json")
            data_items = res.get("data", [])
            if data_items:
                first = data_items[0]
                b64 = first.get("b64_json")
                if b64:
                    out_path = Path(args.output).resolve()
                    with open(out_path, "wb") as f:
                        f.write(base64.b64decode(b64))
                    print(f"\n[SUCCESS] Image generated and saved to: {out_path}")
                elif first.get("url"):
                    print(f"\n[SUCCESS] Image URL: {first.get('url')}")
            else:
                print("\n[ERROR] No image data returned.")
        except Exception as e:
            print(f"\n[ERROR] Generation failed: {e}", file=sys.stderr)
            sys.exit(1)
        return

    # 4. Default: Run API Server
    start_server(args.host, args.port, client)


if __name__ == "__main__":
    main()
