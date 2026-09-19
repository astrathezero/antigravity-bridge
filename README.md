# Antigravity Bridge Server 🌉

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![Node.js 18+](https://img.shields.io/badge/node-18+-brightgreen.svg)](https://nodejs.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange.svg)](https://docs.anthropic.com/en/api/messages)
[![Imagen 3](https://img.shields.io/badge/Image-Google%20Imagen%203-purple.svg)](https://ai.google.dev/gemini-api/docs/imagen)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Languages:** **English** | [🇹🇭 ภาษาไทย](README.th.md)

**Antigravity Bridge Server** is a zero-dependency, OpenAI & Anthropic compatible REST API bridge for the `antigravity` / `agy` CLI ecosystem. It turns the Google accounts logged into your local CLI into a resilient multi-profile API cluster with smart rotation, instant quota fallback, background OAuth refresh, native tool calling, SSE streaming and image generation.

The repository ships **two editions of the same server** that live side by side in this one folder and share one `.env`, one profile store and one feature set:

| | 🐍 Python Edition | ⚡ Node.js Edition |
| :--- | :--- | :--- |
| Entry point | `antigravity_bridge.py` | `src/index.mjs` |
| Default port | `8000` | `8008` |
| Runtime | Python 3.8+ (standard library only) | Node.js 18+ (native ESM, no `npm install`) |
| Layout | Single file | Modular (`src/core`, `src/translators`, `src/cli`, `src/image`) |
| Concurrency | Threads | Non-blocking event loop |
| Typical RSS | ~80–150 MB | ~35–55 MB |
| Tests | `test_antigravity_bridge.py` (73 tests) | `tests/*.test.mjs` (37 tests) |

Pick one, or run both at once on their default ports. See [Choosing an Edition](#-choosing-an-edition).

---

> [!IMPORTANT]
> ### 📢 Notice: Cross-Machine Usage
> **Antigravity Bridge runs on the machine where the `antigravity`/`agy` CLI and its Google profiles are installed**, but clients on other machines can use it.
> - Clients (Hermes Agent, OpenAI SDK, Anthropic SDK, bots, webhooks) reach the bridge over HTTP from any machine or network.
> - To expose it beyond localhost, keep the bridge bound to `127.0.0.1`, put **Nginx** in front of it with TLS (see [Nginx reverse proxy](#nginx-reverse-proxy-with-streaming-support)), add the public hostname to `ANTIGRAVITY_ALLOWED_HOSTS`, and **enable API key authentication** so only your clients can call it.
> - **Be careful with security:** the bridge runs `agy` with permissions disabled, so an exposed, unauthenticated port is equivalent to giving remote shell access to the host. Read the [Security Model](#-security-model) before opening it up.
> - The bridge itself always executes the CLI locally. Distributed / remote worker clustering is not supported.

> [!WARNING]
> ### ⚠️ Disclaimer & Terms of Service Notice
> - **Educational & research use only.** This is an independent community utility for developer testing, personal interoperability and local automation.
> - **Terms of Service:** automated wrappers and multi-account rotation may violate the Terms of Service, Acceptable Use Policies or usage limits of Google, Gemini and Antigravity.
> - **Risk of rate limits / suspension:** aggressive querying or account switching may lead to cooldowns or suspension by upstream providers.
> - **Use at your own risk.** The authors accept no liability for account restrictions, data loss or damages.

---

## 📖 Table of Contents

- [🧭 Choosing an Edition](#-choosing-an-edition)
- [🌟 Architecture & Overview](#-architecture--overview)
- [✨ Key Features](#-key-features)
- [📦 Quick Start Installation](#-quick-start-installation)
- [🤖 Supported Models Matrix](#-supported-models-matrix)
- [👤 Profile Manager CLI Reference](#-profile-manager-cli-reference)
- [🔑 API Key Manager CLI Reference](#-api-key-manager-cli-reference)
- [📡 REST API Reference](#-rest-api-reference)
- [🔒 Security Model](#-security-model)
- [⚙️ Configuration & Environment Variables](#️-configuration--environment-variables)
- [🤖 Hermes Agent Integration](#-hermes-agent-integration-configyaml)
- [🦞 OpenClaw Integration](#-openclaw-integration-openclawjson)
- [💻 Client SDK Examples](#-client-sdk-examples)
- [⏱️ Custom Timeout Options & Large Prompt Handling](#️-custom-timeout-options--large-prompt-handling)
- [🚀 Production Deployment](#-production-deployment)
- [🔧 Troubleshooting & FAQ](#-troubleshooting--faq)
- [🧪 Running Unit Tests](#-running-unit-tests)
- [🗄️ Archived design: Web Extension Edition](#️-archived-design-web-extension-edition)
- [📄 License](#-license)

---

## 🧭 Choosing an Edition

Both editions expose the same HTTP API, read the same `.env`, rotate the same profiles under `~/.config/antigravity/profiles/`, and are developed together (every feature commit touches both). The differences that matter day to day:

| Topic | Python (`8000`) | Node.js (`8008`) |
| :--- | :--- | :--- |
| Start | `python3 antigravity_bridge.py` | `node src/index.mjs` or `npm start` |
| API key variables | `ANTIGRAVITY_BRIDGE_API_KEYS` / `ANTIGRAVITY_BRIDGE_API_KEY` | `ANTIGRAVITY_API_KEYS` / `ANTIGRAVITY_API_KEY` |
| Per-profile concurrency | `ANTIGRAVITY_PROFILE_CONCURRENCY` or `--profile-concurrency` | `ANTIGRAVITY_CONCURRENCY_PER_PROFILE` |
| Profile login / doctor CLI | `profile login`, `doctor` | not built in, use the Python CLI (or `agy` directly) once |
| Service installers | `setup_systemd.sh` | `setup_systemd_node.sh`, `setup_launchd_mac.sh`, `setup_service_windows.ps1`, `run_windows.bat` |
| Staging-first deploy helper | `safe_deploy.sh` (see `AGENTS.md`) | edit, run `npm test`, restart |

Because the key variables differ, one shared `.env` can hold keys for the Python port while the Node port stays open, or the other way round. Keys in the other edition's variable are ignored, not merged.

**Running both at once:** the defaults already avoid port collisions. To keep runtime state apart as well, give the Node edition its own quota cache and sandbox root (both editions honour these):

```ini
ANTIGRAVITY_QUOTA_CACHE_FILE=~/.config/antigravity/quota_cache_node.json
ANTIGRAVITY_SANDBOX_BASE=~/.config/antigravity/sandboxes-node
```

Put those in the Node service's environment (the systemd installer does this for you), not in the shared `.env`.

---

## 🌟 Architecture & Overview

Antigravity Bridge is an HTTP gateway between your applications and local `antigravity`/`agy` CLI subprocesses:

```
┌────────────────────────────────────────────────────────────────────────┐
│      External AI Clients (Hermes / OpenClaw / OpenAI & Anthropic SDK)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST / SSE Stream
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│     Antigravity Bridge Server  (Python :8000  and/or  Node.js :8008)    │
│  ├── Multi-API Key Auth & Client Isolator (Cursor, Hermes, Cline)      │
│  ├── Dual API Translators (OpenAI v1 & Anthropic Messages)             │
│  ├── Multi-Concurrent Profile Pool & Dynamic Lease Allocator           │
│  ├── Smart Quota Detector (Auto-Calculates Reset Timers & Rotates)     │
│  ├── Dynamic Timeout Scaling (Up to 2h) & Large Prompt Support         │
│  ├── Context Compactor & SSE Keep-Alive Heartbeat Generator            │
│  ├── Background OAuth Auto-Refresh Daemon (Every 55m)                  │
│  └── Google Imagen 3 & Gemini Image Router                             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Isolated Subprocess Execution
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│         Isolated Runtime Sandboxes (~/.config/antigravity/sandboxes/)   │
│  ├── Sandbox [Profile 1] (Zero DB Lock) ──► Google Gemini API (Stream) │
│  ├── Sandbox [Profile 2] (Zero DB Lock) ──► Google Gemini API (Stream) │
│  └── Sandbox [Profile N] (Zero DB Lock) ──► Google Gemini API (Stream) │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

- 🔑 **Multi-API Key Management & Agent Isolation**
  - Separate keys per agent (Cursor, Hermes, Cline, Claude Dev) in `.env`, managed from the built-in `key` CLI of either edition.
  - Accepts `Authorization: Bearer <key>`, `x-api-key: <key>` or `api-key: <key>`.
- ⚡ **Multi-Concurrent Profile Pool**
  - **Isolated sandboxes:** each profile runs in its own runtime directory (`~/.config/antigravity/sandboxes/<profile>/`), eliminating SQLite locks and auth-file collisions.
  - **Parallel capacity:** configurable concurrency per profile (e.g. 14 profiles × 2 = 28 parallel requests).
- 🔄 **Dual Format Compatibility:** drop-in for both **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`).
- 🛠️ **Native Tool & Function Calling:** OpenAI `tools`/`functions` and Anthropic `tools` are translated both ways.
- 🌊 **SSE Streaming & Heartbeats:** `text/event-stream` with periodic heartbeat comments so proxies do not time out during long reasoning.
- 🔀 **Smart Fallback & Fast-Fail**
  - Rotates across every profile in `~/.config/antigravity/profiles/`.
  - Detects `429`, `RESOURCE_EXHAUSTED` and quota errors, parses reset durations (`Resets in 74h 7m 25s`) and moves to the next healthy profile without failing the request.
  - Skips profiles in cooldown without extra calls; fails fast when the whole pool is exhausted.
- 🚀 **Large Prompt Support & Adaptive Compaction**
  - Prompts up to `ANTIGRAVITY_MAX_CLI_ARG_BYTES` (120 KB) go to agy as a CLI argument; larger ones are streamed over stdin as NDJSON up to `ANTIGRAVITY_MAX_STDIN_PROMPT_BYTES` (2 MB), so Linux `ARG_MAX` is never hit.
  - Above the context budget (`ANTIGRAVITY_MAX_PROMPT_CHARS`, 200 KB) older tool results are compacted instead of truncating the conversation.
- ⏱️ **Dynamic Execution Timeouts:** request up to **2 hours** via headers, body, query, model suffix or in-prompt directive; auto-scales for prompts over 10 KB. See [Custom Timeout Options](#️-custom-timeout-options--large-prompt-handling).
- 🔒 **Persistent Profile State:** `profile disable <name>` is saved to `~/.config/antigravity/bridge_config.json` and survives restarts.
- 🔄 **OAuth Auto-Refresh Daemon:** refreshes Google access tokens every 55 minutes.
- 🌐 **SOCKS5 / Cloudflare WARP Auto-Detection:** finds local proxies on ports `40000`, `10808`, `7890`, etc.
- 🎨 **Image Generation:** Google Imagen 3 (`imagen-3.0-generate-002`) and Gemini image routers via `/v1/images/generations`.
- 🩺 **Diagnostic Doctor** (Python CLI): checks OAuth validity, public IP routing and cleans stale locks.
- 📦 **Zero External Dependencies** in both editions: Python standard library only; Node.js native ESM with no `npm install`.

---

## 📦 Quick Start Installation

### 1. Prerequisites
- **Antigravity CLI** (`antigravity` or `agy`) installed and in `PATH`.
- **Git**.
- **Python 3.8+** for the Python edition, **Node.js 18+** for the Node.js edition. Python is also handy for Node users because profile login and `doctor` live in the Python CLI.

### 2. Clone
```bash
git clone https://github.com/astrathezero/antigravity-bridge.git
cd antigravity-bridge
```

### 3. Configure `.env`
```bash
cp .env.example .env
nano .env
```
Both editions look for, in order: `./.env` (Python also checks the script directory), `~/.config/antigravity/bridge.env`, `~/.config/antigravity/.env`, `~/.env`. Values already present in the process environment win over the file.

```ini
ANTIGRAVITY_HOST=127.0.0.1
ANTIGRAVITY_PORT=8000                 # Python; Node ignores this unless you drop --port (default 8008)
ANTIGRAVITY_PROFILE_CONCURRENCY=1     # Python
# ANTIGRAVITY_CONCURRENCY_PER_PROFILE=1   # Node.js
# ANTIGRAVITY_DISABLED_PROFILES=reserve_profile
```

### 4. Create API keys (strongly recommended)
Without a key either server starts in anonymous mode and logs a warning (see [Security Model](#-security-model)).

```bash
# Python edition → writes ANTIGRAVITY_BRIDGE_API_KEYS
python3 antigravity_bridge.py key create agent-hermes
python3 manage_keys.py list

# Node.js edition → writes ANTIGRAVITY_API_KEYS
node src/index.mjs key generate agent-hermes
node src/index.mjs key list
```

### 5. Add Google profiles
```bash
python3 antigravity_bridge.py login profile_1
python3 antigravity_bridge.py login profile_2
```
> **Login steps:**
> 1. A browser opens Google OAuth. Select the account and authorize.
> 2. When the terminal shows `>`, type `hi` and press `Enter` to activate.
> 3. Type `/exit` (or `Ctrl+D`). Credentials are saved to `~/.config/antigravity/profiles/<name>/`.
>
> Profiles are shared: once logged in, both editions see them.

### 6. Launch

**Python edition (port 8000)**
```bash
python3 antigravity_bridge.py                      # keys from .env
python3 antigravity_bridge.py --api-key sk-agv-... # or pass one explicitly
./setup_systemd.sh                                 # or install as a systemd service
```

**Node.js edition (port 8008)**
```bash
node src/index.mjs                                 # keys from .env
node src/index.mjs --port 8008 --host 127.0.0.1 --api-key sk-agv-...
npm start                                          # same as node src/index.mjs --port 8008
./setup_systemd_node.sh                            # Linux service
./setup_launchd_mac.sh                             # macOS launchd
.\setup_service_windows.ps1                        # Windows service (or run_windows.bat)
```

### 7. Verify
```bash
python3 antigravity_bridge.py profiles             # profile pool status (either CLI)
node src/index.mjs profile list

curl http://127.0.0.1:8000/health                  # liveness only, no key needed
curl http://127.0.0.1:8008/health
curl -H "Authorization: Bearer sk-agv-..." http://127.0.0.1:8000/health   # full status
```

---

## 🤖 Supported Models Matrix

| Model ID (`model`) | Backend CLI Mapping | Reasoning Effort | Description | Max Context |
| :--- | :--- | :---: | :--- | :---: |
| **`gemini-3.8-flash-high`** | `--model gemini-3.8-flash` | `high` | Gemini 3.8 Flash (High Reasoning Effort) | 1,000,000 |
| **`gemini-3.8-flash-medium`** | `--model gemini-3.8-flash` | `medium` | Gemini 3.8 Flash (Medium Reasoning Effort) | 1,000,000 |
| **`gemini-3.8-flash-low`** | `--model gemini-3.8-flash` | `low` | Gemini 3.8 Flash (Low Reasoning Effort) | 1,000,000 |
| **`gemini-3.8-flash`** | `--model gemini-3.8-flash` | `high` | Gemini 3.8 Flash (Standard) | 1,000,000 |
| **`gemini-3.7-flash-high`** | `--model gemini-3.7-flash` | `high` | Gemini 3.7 Flash (High Reasoning Effort) | 1,000,000 |
| **`gemini-3.7-flash-medium`** | `--model gemini-3.7-flash` | `medium` | Gemini 3.7 Flash (Medium Reasoning Effort) | 1,000,000 |
| **`gemini-3.7-flash-low`** | `--model gemini-3.7-flash` | `low` | Gemini 3.7 Flash (Low Reasoning Effort) | 1,000,000 |
| **`gemini-3.7-flash`** | `--model gemini-3.7-flash` | - | Gemini 3.7 Flash (Standard) | 1,000,000 |
| **`gemini-3.6-flash-high`** | `--model gemini-3.6-flash` | `high` | Gemini 3.6 Flash (High Reasoning Effort) | 1,000,000 |
| **`gemini-3.6-flash`** | `--model gemini-3.6-flash` | - | Gemini 3.6 Flash (Standard) | 1,000,000 |
| **`gemini-3.5-flash-medium`** | `--model gemini-3.5-flash` | `medium` | Gemini 3.5 Flash (Medium Reasoning Effort) | 1,000,000 |
| **`gemini-3.5-flash`** | `--model gemini-3.5-flash` | - | Gemini 3.5 Flash (Standard) | 1,000,000 |
| **`gemini-3.1-pro-high`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (High Reasoning Effort) | 2,000,000 |
| **`gemini-3.1-pro-low`** | `--model gemini-3.1-pro` | `low` | Gemini 3.1 Pro (Low Reasoning Effort) | 2,000,000 |
| **`gemini-3.1-pro`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (Standard) | 2,000,000 |
| **`claude-sonnet-4.6-thinking`** | `--model claude-sonnet-4.6` | `thinking` | Claude Sonnet 4.6 (Extended Thinking) | 200,000 |
| **`claude-sonnet-4.6`** | `--model claude-sonnet-4.6` | - | Claude Sonnet 4.6 | 200,000 |
| **`claude-opus-4.6-thinking`** | `--model claude-opus-4.6` | `thinking` | Claude Opus 4.6 (Extended Thinking) | 200,000 |
| **`claude-opus-4.6`** | `--model claude-opus-4.6` | - | Claude Opus 4.6 | 200,000 |
| **`gpt-oss-120b-medium`** / **`gpt-oss-128b`** | `--model gpt-oss-120b` | `medium` | GPT-OSS 120B / 128B (Medium Reasoning) | 128,000 |
| **`gpt-oss-120b`** | `--model gpt-oss-120b` | - | GPT-OSS 120B | 128,000 |
| **`imagen-3.0-generate-002`** | Google Imagen 3 API | - | High-quality image generation (`/v1/images/generations`) | - |
| **`imagen-3.0-fast-generate-001`**| Google Imagen 3 Fast API | - | Fast image generation (`/v1/images/generations`) | - |
| **`gemini-3.1-flash-image`** | Gemini Image Router | - | Fast Gemini image generation | - |
| **`antigravity`** / **`agy`** | Default CLI backend | - | Default fallback model routing | 1,000,000 |

---

## 👤 Profile Manager CLI Reference

Both CLIs operate on the same profile store, so you can mix them.

| Task | Python | Node.js |
| :--- | :--- | :--- |
| List profiles, emails, leases, cooldowns, quota | `python3 antigravity_bridge.py profile list` (alias `profiles`) | `node src/index.mjs profile list` |
| Log in / register a new Google profile | `python3 antigravity_bridge.py login <name>` | — (use the Python command) |
| Probe quota & model responsiveness | `python3 antigravity_bridge.py profile test [name]` | `node src/index.mjs profile probe [name]` |
| Set rotation pool & priority | `python3 antigravity_bridge.py profile set p1,p2` (alias `order`) | `node src/index.mjs profile set p1,p2` (alias `order`) |
| Disable / enable persistently | `profile disable <name>` / `profile enable <name>` | `profile disable <name>` / `profile enable <name>` |
| Reset cooldowns & exhausted flags | `profile reset [name]` | `profile reset [name]` |
| Force OAuth token refresh | `profile refresh [name]` | `profile refresh [name]` |
| Sync profiles to a remote host over SSH | `profile sync <user@vps>` | — |
| Copy one profile via SCP / remove a profile | `profile copy <name> <vps>` / `profile remove <name>` | — |
| Sync a profile's token into the system credential store | — | `profile sync <name>` |
| Diagnostics (IP, proxy, token validity, lock cleanup) | `python3 antigravity_bridge.py doctor` (alias `diag`) | — |

---

## 🔑 API Key Manager CLI Reference

Keys are stored in `.env`. The Python edition reads and writes `ANTIGRAVITY_BRIDGE_API_KEYS`, the Node.js edition `ANTIGRAVITY_API_KEYS`. Both accept the same `label:key,label2:key2` format.

| Task | Python | Node.js |
| :--- | :--- | :--- |
| List keys and labels | `python3 antigravity_bridge.py key list` or `python3 manage_keys.py list` | `node src/index.mjs key list` |
| Generate a new random key | `key create <label>` (alias `generate`) | `key generate <label>` (alias `create`) |
| Register an existing key | `key add <label> <key>` / `manage_keys.py add` | — |
| Revoke | `key revoke <label\|key>` | `key revoke <label>` |
| Live-test a key against a running server | `key test <key>` / `manage_keys.py test <key>` | `curl -H "Authorization: Bearer <key>" http://127.0.0.1:8008/health` |

```ini
# Python edition
ANTIGRAVITY_BRIDGE_API_KEYS=agent-cursor:sk-agv-a1b2c3d4,agent-hermes:sk-agv-e5f6g7h8
# Node.js edition
ANTIGRAVITY_API_KEYS=agent-cursor:sk-agv-a1b2c3d4,agent-hermes:sk-agv-e5f6g7h8
```

Both editions also expose `GET /v1/keys`, `POST /v1/keys/create` and `POST /v1/keys/revoke` for the same operations over HTTP (authenticated).

---

## 📡 REST API Reference

The routes below are identical on both editions; only the port differs. Examples use `8000`; replace with `8008` for Node.js.

### 1. Health Check (`GET /health`)
```bash
curl http://127.0.0.1:8000/health                                        # → {"status":"ok","service":"antigravity-bridge","auth_required":true}
curl -H "Authorization: Bearer sk-agv-..." http://127.0.0.1:8000/health  # full status below
```
```json
{
  "status": "ok",
  "service": "antigravity-bridge",
  "active_profile": "profile_1",
  "concurrency": { "active_in_flight": 0, "max_pool_capacity": 28, "concurrency_per_profile": 2 },
  "profiles": {
    "profile_1": {
      "status": "OK",
      "in_flight": 0,
      "max_concurrency": 2,
      "cooldown_seconds_remaining": 0,
      "estimated_quota_percent": 100,
      "success_count": 42,
      "google_account": "user@gmail.com"
    }
  }
}
```

### 2. List Models (`GET /v1/models`)
```bash
curl http://127.0.0.1:8000/v1/models -H "Authorization: Bearer sk-antigravity"
```

### 3. OpenAI Chat Completions (`POST /v1/chat/completions`)
```bash
curl -N -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "gemini-3.7-flash-high",
    "messages": [{"role": "user", "content": "Explain async concurrency in Python."}],
    "stream": true
  }'
```

### 4. Anthropic Messages (`POST /v1/messages`)
```bash
curl -X POST http://127.0.0.1:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-antigravity" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6-thinking",
    "system": "You are a senior systems engineer.",
    "messages": [{"role": "user", "content": "Compare Redis vs Memcached."}]
  }'
```

### 5. Image Generation (`POST /v1/images/generations`)
```bash
curl -X POST http://127.0.0.1:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "imagen-3.0-generate-002",
    "prompt": "A cybernetic dragon flying over neon Tokyo, photorealistic 8k",
    "size": "1024x1024",
    "n": 1
  }'
```

### 6. Profile Control APIs (`/v1/profiles/*`)
- `GET /v1/profiles` — list all profile metrics.
- `POST /v1/profiles/reset` — reset cooldowns (`{"profile": "profile_1"}`).
- `POST /v1/profiles/check` — trigger an active quota probe (`{"model": "gemini-3.7-flash"}`).
- `POST /v1/profiles/config` — hot-reload the rotation list (`{"profiles": ["p1", "p2"]}`).
- `POST /v1/profiles/disable` / `POST /v1/profiles/enable` — toggle a profile (`{"profile": "p1"}`).
- `GET /v1/config` — current effective configuration.

---

## 🔒 Security Model

The bridge runs the `agy` CLI with `--dangerously-skip-permissions`, so **anyone who can reach the port can make the agent run commands and write files on this machine**. Treat the port like SSH access. The controls below apply to both editions.

| Control | Default | Notes |
| :--- | :---: | :--- |
| API key auth | Recommended | Without a key the server starts in anonymous mode and logs a warning; every endpoint is then open to whoever can reach the port. |
| Key transport | Header only | `Authorization: Bearer`, `x-api-key` or `api-key`. Keys in the URL query string are **not** accepted. |
| Key comparison | Constant-time | Exact match on configured keys only. |
| Bind address | `127.0.0.1` | Binding `0.0.0.0` exposes the agent to the network; put it behind a reverse proxy with TLS if you must. |
| Host header | Allow-list | Loopback + bind host, plus `ANTIGRAVITY_ALLOWED_HOSTS`. Blocks DNS-rebinding from web pages. |
| CORS | **Off** | `--enable-cors` sends `Access-Control-Allow-Origin: *`; only enable for a browser client you control. |
| `/health` | Liveness only | Unauthenticated callers get `{"status":"ok"}`; profile details require a key. |
| Token files | `0600` | OAuth tokens, `.env` and quota caches are written owner-only; Keychain writes go over stdin, never argv. |
| Profile names | `[A-Za-z0-9._-]` | Validated on every endpoint and CLI path (no `..`, `/`, control characters). |
| agy tool use | **Blocked** | API mode: the model is told not to use agy's own tools; if agy still starts a tool step the run is killed within a second. When the request defines a client-side tool that does the same job (a terminal-style tool for `run_command` / `list_dir` / `grep_search` / `find_by_name`, a file-reading tool for `view_file`), the bridge answers with that client tool call instead, logged as `[TOOL TRANSLATED]` (`ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS=0` disables). Otherwise the run is retried once on the same profile with a reinforced no-tools notice that names the request's client-side tools (`ANTIGRAVITY_TOOL_BLOCK_RETRIES`, default `1`), and only then fails with a clear error. A run that agy ends with its own `improperly formatted function call` error is not a failure when the model had already replied with a well-formed call to one of the client's tools: the bridge logs `[SALVAGED]` and returns that reply instead of failing over to another profile. `ANTIGRAVITY_ALLOW_CLI_TOOLS=1` re-enables agentic runs. One narrower opt-in exists: `ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1` lets agy read only the conversation log it writes itself during the run (agy points the model at it when a prompt is too large for one turn). |
| Client disconnect | Cancels CLI | When the client closes the connection (e.g. Hermes `/stop`), the agy process is killed instead of running on. |

---

## ⚙️ Configuration & Environment Variables

Shared by both editions unless a column says otherwise.

| Variable | Default | Description |
| :--- | :---: | :--- |
| **`ANTIGRAVITY_HOST`** | `127.0.0.1` | Interface to bind (`0.0.0.0` for all). |
| **`ANTIGRAVITY_PORT`** | `8000` / `8008` | Listening port. Node also accepts `PORT` / `BRIDGE_PORT`. |
| **`ANTIGRAVITY_PROFILE_CONCURRENCY`** | `1` | **Python only.** Max concurrent requests per profile. |
| **`ANTIGRAVITY_CONCURRENCY_PER_PROFILE`** | `1` | **Node.js only.** Same meaning. |
| **`ANTIGRAVITY_PROFILES`** | *auto* | Comma-separated profile names to rotate through. |
| **`ANTIGRAVITY_PROFILE`** | — | Pin a single profile. |
| **`ANTIGRAVITY_DISABLED_PROFILES`** | — | Profiles excluded from rotation and fallback. |
| **`ANTIGRAVITY_BRIDGE_API_KEYS`** / **`ANTIGRAVITY_BRIDGE_API_KEY`** | — | **Python only.** Labeled key list / single key. |
| **`ANTIGRAVITY_API_KEYS`** / **`ANTIGRAVITY_API_KEY`** | — | **Node.js only.** Labeled key list / single key (`BRIDGE_API_KEYS`, `API_KEYS` also read). |
| **`ANTIGRAVITY_ALLOWED_HOSTS`** | — | Extra `Host` header values to accept besides loopback and the bind host. |
| **`ANTIGRAVITY_HIDE_PROFILE_STATUS`** | `0` | `1` hides the status footer tag from AI responses. |
| **`ANTIGRAVITY_NO_PROXY`** | `0` | `1` disables proxy auto-detection. |
| **`ANTIGRAVITY_NO_AUTO_REFRESH`** | `0` | `1` disables the 55-minute OAuth refresh daemon. |
| **`ANTIGRAVITY_ALLOW_CLI_TOOLS`** | `0` | `1` lets agy execute its own tools (terminal/files/browser) during API requests. |
| **`ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS`** | `1` | Answer a blocked agy tool step with the equivalent client-side tool call when the request defines one (terminal-style tool for `run_command`, `list_dir`, `grep_search`, `find_by_name`; file-reading tool for `view_file`). `0` disables. |
| **`ANTIGRAVITY_TOOL_BLOCK_RETRIES`** | `1` | Retries of a tool-blocked run on the same profile with a reinforced no-tools notice (it lists the client-side tools of the request, when any). `0` disables. Skipped once text has been streamed. |
| **`ANTIGRAVITY_ALLOW_TRANSCRIPT_READS`** | `0` | `1` lets agy read only its own conversation log for the current run (`<sandbox>/.gemini/antigravity-cli/brain/<conversation>/…`). Commands, writes and other conversations stay blocked. |
| **`ANTIGRAVITY_MAX_CLI_ARG_BYTES`** | `120000` | Largest prompt passed as a CLI argument. Bigger prompts go over stdin as NDJSON up to `ANTIGRAVITY_MAX_STDIN_PROMPT_BYTES` (2 MB). |
| **`ANTIGRAVITY_MAX_PROMPT_CHARS`** | `200000` | Context budget (UTF-8 bytes). Above it, older tool results are compacted to `ANTIGRAVITY_OLD_TOOL_OUTPUT_CHARS` (2000) and recent ones to `ANTIGRAVITY_RECENT_TOOL_OUTPUT_CHARS` (20000). |
| **`ANTIGRAVITY_PROFILE_TIMEOUT`** / **`ANTIGRAVITY_TOTAL_TIMEOUT`** | `600` / `1800` | Seconds per profile attempt / total fallback budget. |
| **`ANTIGRAVITY_MAX_AUTOSCALE_TIMEOUT`** / **`ANTIGRAVITY_MAX_TOTAL_TIMEOUT`** | `900` / `3600` | Ceiling for auto-scaled and client-requested timeouts. |
| **`ANTIGRAVITY_STALL_TIMEOUT`** | `600` | Seconds of CLI silence before a run is abandoned. Reasoning models print nothing while thinking, so keep it high. |
| **`ANTIGRAVITY_FALLBACK_CHAIN`** / **`ANTIGRAVITY_MODEL_FALLBACK_ENABLED`** | — / `true` | Model-level fallback order when a family is in cooldown. |
| **`ANTIGRAVITY_QUOTA_CACHE_FILE`** | `~/.config/antigravity/quota_cache.json` | Where quota state is persisted. Give each edition its own file when running both. |
| **`ANTIGRAVITY_SANDBOX_BASE`** | `~/.config/antigravity/sandboxes` | Root of per-profile sandboxes. Give each edition its own root when running both. |
| **`ANTIGRAVITY_BRIDGE_CMD`** | *auto* | Custom CLI command template (also `--cmd`). |
| **`GEMINI_API_KEY`** | — | Google AI Studio key for direct Imagen 3 generation. |
| **`ANTIGRAVITY_IMAGE_ROUTER_URL`** / **`ANTIGRAVITY_IMAGE_ROUTER_KEY`** | — | External OpenAI-compatible image gateway. |

---

## 🤖 Hermes Agent Integration (`config.yaml`)

**Hermes Agent** can use the bridge as a custom OpenAI-compatible provider with streaming and tool calling. Add a provider under `custom_providers` in `~/.hermes/config.yaml` or `~/.hermes/profiles/<profile>/config.yaml`. Point `api` at whichever edition you run (`8000` Python, `8008` Node.js); you can define one provider per port.

```yaml
model:
  default: gemini-3.7-flash-high
  provider: agy-cli

custom_providers:
  agy-cli:
    api: http://127.0.0.1:8000/v1
    api_key: sk-antigravity  # a key from the edition's key list, or any string if auth is off
    name: Antigravity Multi-Profile Bridge
    models:
      gemini-3.7-flash-high:
        context_length: 1000000
      gemini-3.7-flash-medium:
        context_length: 1000000
      gemini-3.7-flash:
        context_length: 1000000
      gemini-3.6-flash-high:
        context_length: 1000000
      gemini-3.1-pro-high:
        context_length: 2000000
      claude-sonnet-4.6-thinking:
        context_length: 200000
      claude-opus-4.6-thinking:
        context_length: 200000
      gpt-oss-120b-medium:
        context_length: 128000
```

```bash
hermes models                                  # view loaded custom models
hermes model set agy-cli/gemini-3.7-flash-high # set the default
hermes chat -m agy-cli/gemini-3.7-flash-high   # chat through the bridge
```

---

## 🦞 OpenClaw Integration (`openclaw.json`)

**OpenClaw** connects to the bridge as a custom OpenAI-compatible provider. Edit `~/.openclaw/openclaw.json` (or the path in `OPENCLAW_CONFIG_PATH`):

```json5
{
  "models": {
    "mode": "merge",
    "providers": {
      "antigravity": {
        "baseUrl": "http://127.0.0.1:8000/v1",   // or :8008 for the Node.js edition
        "apiKey": "sk-antigravity",
        "api": "openai-completions",
        "models": [
          { "id": "gemini-3.7-flash-high",      "name": "Gemini 3.7 Flash (High Reasoning)",      "contextWindow": 1000000, "maxTokens": 64000 },
          { "id": "gemini-3.7-flash-medium",    "name": "Gemini 3.7 Flash (Medium Reasoning)",    "contextWindow": 1000000, "maxTokens": 64000 },
          { "id": "gemini-3.7-flash",           "name": "Gemini 3.7 Flash",                       "contextWindow": 1000000, "maxTokens": 64000 },
          { "id": "gemini-3.1-pro-high",        "name": "Gemini 3.1 Pro (High Reasoning)",        "contextWindow": 2000000, "maxTokens": 64000 },
          { "id": "claude-sonnet-4.6-thinking", "name": "Claude Sonnet 4.6 (Extended Thinking)",  "contextWindow": 200000,  "maxTokens": 64000 },
          { "id": "claude-opus-4.6-thinking",   "name": "Claude Opus 4.6 (Extended Thinking)",    "contextWindow": 200000,  "maxTokens": 64000 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "antigravity/gemini-3.7-flash-high" },
      "models": {
        "antigravity/gemini-3.7-flash-high":      { "alias": "gemini-flash" },
        "antigravity/claude-sonnet-4.6-thinking": { "alias": "claude-sonnet" }
      }
    }
  }
}
```

Or via the CLI:
```bash
openclaw config set models.providers.antigravity.baseUrl "http://127.0.0.1:8000/v1"
openclaw config set models.providers.antigravity.apiKey "sk-antigravity"
openclaw config set models.providers.antigravity.api "openai-completions"
openclaw models set antigravity/gemini-3.7-flash-high
openclaw config validate && openclaw models list
```

**OpenClaw in Docker:** reach the host with `http://172.17.0.1:8000/v1` or `http://host.docker.internal:8000/v1` (add `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux), e.g. `OPENAI_BASE_URL=http://172.17.0.1:8000/v1` and `OPENAI_API_KEY=sk-antigravity` in the container's `.env`.

---

## 💻 Client SDK Examples

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-antigravity")

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "Explain event loops in Node.js vs Python."}],
)
print(response.choices[0].message.content)
```

### Python (Anthropic SDK)
```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8000", api_key="sk-antigravity")

message = client.messages.create(
    model="claude-sonnet-4.6-thinking",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a binary search algorithm in Rust."}],
)
print(message.content[0].text)
```

### Node.js (OpenAI SDK)
```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8008/v1", apiKey: "sk-antigravity" });

const stream = await client.chat.completions.create({
  model: "gemini-3.7-flash-high",
  messages: [{ role: "user", content: "Summarise the CAP theorem." }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

### Python (Custom Long Timeout: 20–30 Minutes for Massive Prompts)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="sk-antigravity",
    timeout=1800.0,  # 30 minutes client timeout
    default_headers={"X-Profile-Timeout": "30m"},
)

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "Analyze and refactor this massive 100k-token repository codebase..."}],
    extra_body={"profile_timeout": "30m"},
)
print(response.choices[0].message.content)
```

---

## ⏱️ Custom Timeout Options & Large Prompt Handling

For very large prompts or deep reasoning you can request execution timeouts up to **2 hours** with any of these methods. The bridge reports the budget it applied in the `X-Antigravity-Profile-Timeout` and `X-Antigravity-Total-Timeout` response headers, and auto-scales (up to 60 minutes) for prompts over 10 KB when nothing is specified.

| Method | Example |
| :--- | :--- |
| **HTTP header** | `X-Profile-Timeout: 30m`, `X-Execution-Timeout: 20m`, `OpenAI-Timeout: 1800`, `X-Timeout: 1800`, `Prefer: wait=1800` |
| **JSON body** | `{"model": "gemini-3.7-flash-high", "profile_timeout": "30m", ...}` or `"timeout": 1800` |
| **`extra_body`** | `client.chat.completions.create(..., extra_body={"profile_timeout": "30m"})` |
| **URL query** | `POST /v1/chat/completions?timeout=30m` or `?profile_timeout=20m` |
| **Model suffix** | `model: "gemini-3.7-flash-high:timeout=30m"`, `"gemini-3.7-flash-high:30m"`, `"gemini-3.7-flash?timeout=1800"` |
| **In-prompt directive** | `[antigravity:timeout=30m]` or `<!-- timeout: 30m -->` at the top of the prompt or system instruction |

---

## 🚀 Production Deployment

### Systemd (Linux)
Each edition has its own installer; run one or both from the repo directory. They generate a unit that points at this checkout, so a single clone can serve both ports.

```bash
./setup_systemd.sh          # antigravity-bridge.service      → Python, port 8000
./setup_systemd_node.sh     # antigravity-bridge-node.service → Node.js, port 8008 (own quota cache + sandbox root)

sudo systemctl status antigravity-bridge antigravity-bridge-node
sudo systemctl restart antigravity-bridge-node
sudo journalctl -u antigravity-bridge-node -f
```

Deploying an update is then `git pull --ff-only` in the checkout followed by a restart of the affected unit(s). Run the tests first ([Running Unit Tests](#-running-unit-tests)); for the Python edition `safe_deploy.sh` wraps stage → test → atomic swap → health check → rollback (see `AGENTS.md`).

### macOS (launchd) and Windows — Node.js edition
```bash
./setup_launchd_mac.sh                # LaunchAgent for node src/index.mjs
```
```powershell
.\setup_service_windows.ps1           # Windows service
.\run_windows.bat                     # or a plain foreground run on port 8008
```

### PM2 (any OS) — Node.js edition
```bash
npm install -g pm2
pm2 start src/index.mjs --name antigravity-bridge -- --port 8008
pm2 save && pm2 startup
```

### Nginx reverse proxy with streaming support
```nginx
server {
    listen 80;
    server_name bridge.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;      # or 8008
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Required for SSE streaming and long reasoning tasks
        proxy_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
```
Add `bridge.yourdomain.com` to `ANTIGRAVITY_ALLOWED_HOSTS` so the Host allow-list accepts proxied requests.

---

## 🔧 Troubleshooting & FAQ

### Q1: Newly added profiles do not show up in `profile list`
- **Cause:** if `~/.config/antigravity/bridge_config.json` exists, the bridge locks to that profile list instead of scanning folders.
- **Fix:**
  ```bash
  rm -f ~/.config/antigravity/bridge_config.json
  python3 antigravity_bridge.py profiles      # or: node src/index.mjs profile list
  ```

### Q2: How do I verify OAuth token validity for all accounts?
```bash
python3 antigravity_bridge.py doctor
```

### Q3: How do I reset profiles stuck in cooldown?
```bash
python3 antigravity_bridge.py profile reset   # or: node src/index.mjs profile reset
```

### Q4: I set API keys but the other edition still says `auth_required: false`
Each edition reads its own variable: Python `ANTIGRAVITY_BRIDGE_API_KEYS`, Node.js `ANTIGRAVITY_API_KEYS`. Generate keys with the matching CLI (`key create` / `key generate`) or add the second variable to `.env`.

### Q5: A request fails with `CLI tool execution blocked … view_file … transcript_full.jsonl`
The prompt was too large for one agy turn and the model tried to read agy's own transcript. Either lower the prompt size, or set `ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1` to allow that single read-only access (see [Security Model](#-security-model)).

---

## 🧪 Running Unit Tests

```bash
# Python edition (73 tests)
python3 -m unittest test_antigravity_bridge.py -v

# Node.js edition (37 tests, node:test — no dev dependencies)
npm test
```

Both suites cover API translation, streaming, profile ordering, fallback routing, cooldown fast-fail, large prompt delivery, security controls and CLI handlers. The Node suite writes to `tests/.tmp-sandbox/` only.

---

## 🗄️ Archived design: Web Extension Edition

The earlier "Web Extension Edition" (Chrome extension + Docker/noVNC browser sessions as a second channel next to the CLI) was removed from the active branches on 2026-09-15. Its design, protocol and deployment notes are preserved in [docs/WEB_EXTENSION_BRIDGE_APPROACH.md](docs/WEB_EXTENSION_BRIDGE_APPROACH.md); the code is kept as git bundles outside the repository (see that document, section 8).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
