# Antigravity Bridge Server 🌉

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange.svg)](https://docs.anthropic.com/en/api/messages)
[![Imagen 3](https://img.shields.io/badge/Image-Google%20Imagen%203-purple.svg)](https://ai.google.dev/gemini-api/docs/imagen)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Languages:** **English** | [🇹🇭 ภาษาไทย](README.th.md)

**Antigravity Bridge Server** is a high-performance, zero-dependency OpenAI & Anthropic compatible REST API Bridge Server designed for the `antigravity` / `agy` CLI ecosystem. It transforms your local Google accounts into a resilient, multi-concurrent API cluster with smart profile rotation, instant quota fallback, background OAuth auto-refresh, native tool calling, and image generation.

---

> [!IMPORTANT]
> ### 📢 Notice: Cross-Machine & Remote Access via Nginx
> **Antigravity Bridge executes CLI subprocesses and browser web extensions on the host machine where it is installed.**
> - **Cross-Machine / Remote Client Access Supported**: You can expose the Bridge to remote laptops, external servers, cloud VMs, and AI agents across your local network or the public internet by setting up an **[Nginx Reverse Proxy](#2-public-exposure--cross-machine-access-via-nginx-reverse-proxy)** with HTTPS/SSL.
> - **Security Best Practice**: When exposing the server publicly, always enable Bearer API Key authentication by configuring `ANTIGRAVITY_BRIDGE_API_KEYS` in your `.env` file.
> - **Roadmap**: Distributed multi-node worker clustering (dispatching CLI tasks across a swarm of separate host machines) is slated for a future release. Centralized hosting with remote client access across machines is fully supported today.

> [!WARNING]
> ### ⚠️ Disclaimer & Terms of Service Notice
> **Please read carefully before using this software:**
> - **Educational & Research Purpose Only:** This project is an independent community utility created for developer testing, personal interoperability, and local automation workflows.
> - **Terms of Service Compliance:** Using automated tools, REST API wrappers, or multi-account rotation mechanisms may violate the Terms of Service, Acceptable Use Policies, or API Usage Limits of Google, Gemini, and Antigravity.
> - **Risk of Rate Limits / Account Suspension:** Excessive automated querying or aggressive multi-account switching may result in temporary cooldowns or account suspension by upstream providers.
> - **Use at Your Own Risk:** The authors and contributors assume no responsibility or liability for account restrictions, data loss, or damages resulting from the use of this software.

---

## 📖 Table of Contents

- [🌟 Architecture & Overview](#-architecture--overview)
- [✨ Key Features](#-key-features)
- [📦 Quick Start Installation](#-quick-start-installation)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Clone & Setup](#2-clone--setup)
  - [3. Configure Environment (.env)](#3-configure-environment-env)
  - [4. Manage API Keys (Optional)](#4-manage-api-keys-optional)
  - [5. Add Google Profiles](#5-add-google-profiles)
  - [6. Launch Bridge Server](#6-launch-bridge-server)
  - [7. Verify & Health Check](#7-verify--health-check)
- [🤖 Supported Models Matrix](#-supported-models-matrix)
- [👤 Profile Manager CLI Reference](#-profile-manager-cli-reference)
- [🔑 API Key Manager CLI Reference](#-api-key-manager-cli-reference-multiple-keys--agents)
- [📡 REST API Reference](#-rest-api-reference)
  - [1. Health Check (`GET /health`)](#1-health-check-get-health)
  - [2. List Models (`GET /v1/models`)](#2-list-models-get-v1models)
  - [3. OpenAI Chat Completions (`POST /v1/chat/completions`)](#3-openai-chat-completions-post-v1chatcompletions)
  - [4. Anthropic Messages (`POST /v1/messages`)](#4-anthropic-messages-post-v1messages)
  - [5. Image Generation (`POST /v1/images/generations`)](#5-image-generation-post-v1imagesgenerations)
  - [6. Profile & Channel Control APIs (`/v1/profiles/*` & `/extension/*`)](#6-profile--channel-control-apis-v1profiles--extension)
- [🌐 Chrome Extension & Browser Web Fallback (noVNC Setup)](#-chrome-extension--browser-web-fallback-novnc-setup)
- [🧪 Interactive Live Testing (`test_bridge.py`)](#-interactive-live-testing-test_bridgepy)
- [⚙️ Configuration & Environment Variables](#️-configuration--environment-variables)
- [🤖 Hermes Agent Integration (`config.yaml`)](#-hermes-agent-integration-configyaml)
- [🦞 OpenClaw Integration (`openclaw.json`)](#-openclaw-integration-openclawjson)
- [🚀 Production Deployment & Public Exposure (Systemd / Nginx)](#-production-deployment--public-exposure-systemd--nginx)
  - [1. Systemd Service Setup (Linux)](#1-systemd-service-setup-linux)
  - [2. Public Exposure & Cross-Machine Access via Nginx Reverse Proxy](#2-public-exposure--cross-machine-access-via-nginx-reverse-proxy)
  - [3. Connecting Remote Clients Across Machines](#3-connecting-remote-clients-across-machines)
- [🔧 Troubleshooting & FAQ](#-troubleshooting--faq)
- [🧪 Running Unit Tests](#-running-unit-tests)
- [📄 License](#-license)

---

## 🌟 Architecture & Overview

Antigravity Bridge acts as a unified HTTP gateway between your applications (Hermes Agent, OpenCode, Claude Code, Python/Node.js SDKs, Webhooks) and local `antigravity`/`agy` CLI subprocesses with seamless Web browser extension fallback:

```
┌────────────────────────────────────────────────────────────────────────┐
│            External AI Clients (Hermes / OpenAI / Anthropic SDK)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST / SSE Stream
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Antigravity Bridge Server (Port 8000)                 │
│  ├── Multi-API Key Auth & Client Isolator (Cursor, Hermes, Cline)      │
│  ├── Dual API Translators (OpenAI v1 & Anthropic Messages)             │
│  ├── Multi-Concurrent Profile Pool & Dynamic Lease Allocator           │
│  ├── Smart Quota Detector (Auto-Calculates Reset Timers & Rotates)     │
│  ├── 3-Tier Multi-Engine Dynamic Fallback:                            │
│  │   ├── Tier 1: CLI Gemini 3.8 Flash (Thinking / Reasoning)          │
│  │   ├── Tier 2: CLI Anthropic Sonnet 4.6 (Thinking Fallback)         │
│  │   └── Tier 3: Web Extension Bridge (gemini.google.com Browser)      │
│  ├── Dynamic Timeout Scaling (Up to 2h) & Large Prompt Support         │
│  ├── Context Compactor & SSE Keep-Alive Heartbeat Generator            │
│  ├── Background OAuth Auto-Refresh Daemon (Every 55m)                  │
│  └── Google Imagen 3 & Gemini Image Router                             │
└─────────────────┬──────────────────────────────────┬───────────────────┘
                  │ Subprocess CLI                   │ WebSocket Bridge
                  ▼                                  ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│  Isolated Runtime Sandboxes (CLI)    │  │  Browser Sessions (noVNC/Web)│
│  (~/.config/antigravity/sandboxes/)  │  │  (gemini.google.com Tabs)    │
│  ├── Sandbox [Profile 1]             │  │  ├── Tab [Profile 1]         │
│  └── Sandbox [Profile N]             │  │  └── Tab [Profile N]         │
└──────────────────────────────────────┘  └──────────────────────────────┘
```

---

## ✨ Key Features

- 🔑 **Multi-API Key Management & Agent Isolation**:
  - Assign separate, secure API keys to different agents (Cursor, Hermes, Cline, Claude Dev) directly in `.env`.
  - Built-in standalone CLI tool (`manage_keys.py` / `python3 antigravity_bridge.py key`) to create, list, revoke, and test keys.
  - Automatically verifies `Authorization: Bearer <key>`, `x-api-key: <key>`, `api-key: <key>`, or `?api_key=<key>`.
- ⚡ **Multi-Concurrent Profile Pool**:
  - **Isolated Sandboxes**: Each profile runs in its own isolated runtime directory (`~/.config/antigravity/sandboxes/<profile>/`), completely eliminating SQLite database locks (`conversation_summaries.db`) and auth file collisions.
  - **Parallel Capacity**: Configurable concurrent requests per profile (e.g. 14 profiles × 2 concurrency = **28 parallel requests**).
- 🔄 **Dual Format Compatibility**: 100% drop-in compatible with both **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`) standards.
- 🛠️ **Native Tool & Function Calling**: Seamless extraction and translation for OpenAI `tools`/`functions` and Anthropic `tools`.
- 🌊 **Real-Time SSE Streaming & Heartbeats**: Fast Server-Sent Events (`text/event-stream`) streaming with periodic heartbeat comments to prevent upstream proxy timeouts during deep reasoning queries.
- 🔀 **Zero-Downtime Smart Fallback & Fast-Fail**:
  - Automatically rotates across multiple accounts in `~/.config/antigravity/profiles/`.
  - Instantly detects `429 Too Many Requests`, `RESOURCE_EXHAUSTED`, and quota errors.
  - Automatically parses cooldown reset durations (e.g. `Resets in 74h 7m 25s`) and falls back immediately to the next healthy profile without failing the user request.
  - **Cooldown Skip & Fast-Fail**: Automatically skips profiles in cooldown without making redundant API calls or hanging; fast-fails immediately if the entire pool is exhausted.
- 🚀 **Large Prompt Support & Adaptive Compaction**:
  - Direct CLI argument delivery supporting massive prompts up to **350KB (~85,000 words)** natively without hitting OS `ARG_MAX` buffer limits.
  - Clean boundary-aware middle truncation for ultra-long context sessions (>350KB) to keep model reasoning responsive.
- ⏱️ **Dynamic Execution Timeout & Large Prompt Auto-Scaling**:
  - Request custom execution timeouts up to **2 hours** (e.g. 20–30 minutes for massive reasoning prompts) via:
    - **HTTP Headers**: `X-Profile-Timeout: 30m`, `X-Execution-Timeout: 20m`, `OpenAI-Timeout: 1800`, `X-Timeout: 1800`, `Prefer: wait=1800`
    - **JSON Request Body**: `"profile_timeout": "30m"`, `"timeout": 1800`, `"extra_body": {"profile_timeout": "30m"}`
    - **URL Query Parameters**: `?timeout=30m`, `?profile_timeout=20m`
    - **Model Name Suffix**: `model: "gemini-3.7-flash-high:timeout=30m"` or `model: "gemini-3.7-flash:30m"` or `model: "gemini-3.7-flash?timeout=1800"`
    - **In-Prompt Directives**: `[antigravity:timeout=30m]` or `<!-- timeout: 30m -->`
  - Auto-scales profile timeout for prompts larger than 10KB (up to 60 minutes) if no explicit timeout is provided.
  - Informs clients of active budgets via response headers `X-Antigravity-Profile-Timeout` and `X-Antigravity-Total-Timeout`.
- 🔒 **Persistent Profile State**: Disabled profiles via `profile disable <name>` are saved to configuration (`~/.config/antigravity/bridge_config.json`) and persist across service restarts.
- 🔄 **Automatic OAuth Refresh Daemon**: Background thread refreshes Google access tokens every 55 minutes to prevent session expiration.
- 🌐 **SOCKS5 / Cloudflare WARP Proxy Auto-Detection**: Auto-detects local WARP proxies (ports `40000`, `10808`, `7890`, etc.) for uninterrupted outbound connectivity.
- 🎨 **Image Generation Integration**: Generates images via Google Imagen 3 (`imagen-3.0-generate-002`) and Gemini Image routers (`/v1/images/generations`).
- 🩺 **Diagnostic Doctor (`doctor` / `diag`)**: Built-in diagnostic tool to test OAuth token validity, public IP routing, and clean stale lock files.
- 🚀 **Zero External Dependencies**: Standard Python 3 standard library only (`http.server`, `urllib`, `sqlite3`, `subprocess`). No `pip install` required!

---

## 📦 Quick Start Installation

### 1. Prerequisites
- **Python 3.8+** installed (`python3 --version`).
- **Antigravity CLI** (`antigravity` or `agy`) installed in your PATH.
- **Git** installed.

### 2. Clone & Setup
```bash
git clone https://github.com/astrathezero/antigravity-bridge.git
cd antigravity-bridge
```

### 3. Configure Environment (`.env`)
```bash
cp .env.example .env
nano .env
```
Key settings in `.env`:
```ini
ANTIGRAVITY_HOST=127.0.0.1
ANTIGRAVITY_PORT=8000
ANTIGRAVITY_PROFILE_CONCURRENCY=2
# ANTIGRAVITY_DISABLED_PROFILES=reserve_profile
# ANTIGRAVITY_BRIDGE_API_KEYS=agent-cursor:sk-agv-111,agent-hermes:sk-agv-222
```

### 4. Manage API Keys (Optional)
Generate secure API keys for your AI agents:
```bash
python3 manage_keys.py create agent-cursor
python3 manage_keys.py create agent-hermes
python3 manage_keys.py list
```

### 5. Add Google Profiles
Add your Google account profiles interactively:
```bash
python3 antigravity_bridge.py login profile_1
python3 antigravity_bridge.py login profile_2
```
> **Login Steps:**
> 1. Browser will open Google OAuth login. Select account and authorize.
> 2. When the terminal prompt displays `>`, type `hi` and press `Enter` to activate.
> 3. Type `/exit` (or `Ctrl+D`) to save the profile credentials to `~/.config/antigravity/profiles/<name>/`.

### 6. Launch Bridge Server

#### Option A: 1-Click Systemd Service (Recommended for Linux)
```bash
chmod +x setup_systemd.sh
./setup_systemd.sh
```

#### Option B: Direct Terminal Run
```bash
python3 antigravity_bridge.py
```

### 7. Verify & Health Check
```bash
# Check profile pool status:
python3 antigravity_bridge.py profiles

# Test HTTP Health endpoint:
curl http://127.0.0.1:8000/health
```

---

## 🤖 Supported Models Matrix

| Model ID (`model`) | Backend CLI Mapping | Reasoning Effort | Description | Max Context |
| :--- | :--- | :---: | :--- | :---: |
| **`gemini-3.8-flash-thinking`** | `--model gemini-3.8-flash` | `high` | Gemini 3.8 Flash (High Reasoning Effort / Flash Thinking) | 1,000,000 |
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
| **`claude-sonnet-4.6-thinking`** | `--model claude-sonnet-4.6` | `thinking` | Claude Sonnet 4.6 (Extended Thinking / Tier 2 Fallback) | 200,000 |
| **`claude-sonnet-4.6`** | `--model claude-sonnet-4.6` | - | Claude Sonnet 4.6 | 200,000 |
| **`claude-opus-4.6-thinking`** | `--model claude-opus-4.6` | `thinking` | Claude Opus 4.6 (Extended Thinking) | 200,000 |
| **`claude-opus-4.6`** | `--model claude-opus-4.6` | - | Claude Opus 4.6 | 200,000 |
| **`gpt-oss-120b-medium`** | `--model gpt-oss-120b` | `medium` | GPT-OSS 120B (Medium Reasoning) | 128,000 |
| **`gpt-oss-120b`** | `--model gpt-oss-120b` | - | GPT-OSS 120B | 128,000 |
| **`imagen-3.0-generate-002`** | Google Imagen 3 API | - | High-Quality Image Generation (`/v1/images/generations`) | - |
| **`imagen-3.0-fast-generate-001`**| Google Imagen 3 Fast API | - | Fast Image Generation (`/v1/images/generations`) | - |
| **`gemini-3.1-flash-image`** | Gemini Image Router | - | Fast Gemini Image Generation | - |
| **`gemini-2.0-flash-thinking`** | Gemini Web Extension | `high` | Gemini Web Extension Flash Thinking (Fallback Tier 3) | 1,000,000 |
| **`gemini-web`** | Gemini Web Extension | `high` | Dedicated Web Browser Extension Channel | 1,000,000 |
| **`antigravity`** / **`agy`** | Default CLI backend | - | Default fallback model routing | 1,000,000 |

---

## 👤 Profile Manager CLI Reference

The CLI provides built-in subcommands to manage multiple Google profiles:

| Command | Shortcut | Description |
| :--- | :--- | :--- |
| `python3 antigravity_bridge.py profile list` | `profiles` | Display table of profiles, Google emails, in-flight leases, cooldowns, and CLI/Web channel states |
| `python3 antigravity_bridge.py profile login <name>` | `login <name>` | Interactively authenticate and register a new Google profile |
| `python3 antigravity_bridge.py profile test [name]` | - | Actively probe quota availability and model responsiveness |
| `python3 antigravity_bridge.py profile set <p1,p2>` | `profile order` | Dynamically set profile rotation pool and priority order |
| `python3 antigravity_bridge.py profile disable <name> [--channel cli\|web\|all]` | - | Persistently disable a profile on CLI, Web, or all channels (persists across restarts) |
| `python3 antigravity_bridge.py profile enable <name> [--channel cli\|web\|all]` | - | Re-enable a profile on CLI, Web, or all channels |
| `python3 antigravity_bridge.py profile toggle <name> <cli\|web> [on\|off]` | - | Quickly toggle CLI or Web channel on or off for a profile |
| `python3 antigravity_bridge.py profile reset [name]` | - | Reset cooldown timers and clear exhausted flags |
| `python3 antigravity_bridge.py profile refresh [name]` | - | Force OAuth token refresh directly with Google |
| `python3 antigravity_bridge.py profile sync <user@vps>` | - | Sync all profiles to a remote VPS over compressed SSH |
| `python3 antigravity_bridge.py profile copy <name> <vps>` | - | Copy a single profile to remote host via SCP |
| `python3 antigravity_bridge.py profile remove <name>` | - | Delete profile credentials directory |
| `python3 antigravity_bridge.py doctor` | `diag` | Run diagnostic check (IP, proxy, token validity, lock cleanup) |

---

## 🔑 API Key Manager CLI Reference (Multiple Keys & Agents)

Antigravity Bridge includes built-in Multi-API Key management for isolating and authenticating requests from different AI agents (e.g. Cursor, Hermes, Cline, Claude Dev):

| Command | Standalone Shortcut | Description |
| :--- | :--- | :--- |
| `python3 antigravity_bridge.py key list` | `python3 manage_keys.py list` | Display active API keys, agent labels, and status |
| `python3 antigravity_bridge.py key create <label>` | `python3 manage_keys.py create <label>` | Generate and save a cryptographically secure random token to `.env` |
| `python3 antigravity_bridge.py key add <label> <key>` | `python3 manage_keys.py add <label> <key>` | Register an existing custom API key with a label in `.env` |
| `python3 antigravity_bridge.py key revoke <label\|key>` | `python3 manage_keys.py revoke <label\|key>` | Revoke and remove an API key from `.env` |
| `python3 antigravity_bridge.py key test <key>` | `python3 manage_keys.py test <key>` | Live test API key authentication against running bridge server |

### Key Configuration in `.env`:
```bash
# Multiple API Keys format with agent labels
ANTIGRAVITY_BRIDGE_API_KEYS=agent-cursor:sk-agv-a1b2c3d4,agent-hermes:sk-agv-e5f6g7h8,team-dev:sk-agv-99887766
```

---

## 📡 REST API Reference

### 1. Health Check (`GET /health`)
```bash
curl http://127.0.0.1:8000/health
```
```json
{
  status: ok,
  service: antigravity-bridge,
  active_profile: profile_1,
  concurrency: {
    active_in_flight: 0,
    max_pool_capacity: 28,
    concurrency_per_profile: 2
  },
  profiles: {
    profile_1: {
      status: OK,
      in_flight: 0,
      max_concurrency: 2,
      cooldown_seconds_remaining: 0,
      estimated_quota_percent: 100,
      success_count: 42,
      google_account: user@gmail.com
    }
  }
}
```

### 2. List Models (`GET /v1/models`)
```bash
curl http://127.0.0.1:8000/v1/models   -H "Authorization: Bearer sk-antigravity"
```

### 3. OpenAI Chat Completions (`POST /v1/chat/completions`)

#### Streaming Request (SSE):
```bash
curl -N -X POST http://127.0.0.1:8000/v1/chat/completions   -H "Content-Type: application/json"   -H "Authorization: Bearer sk-antigravity"   -d '{
    "model": "gemini-3.7-flash-high",
    "messages": [
      {"role": "user", "content": "Explain async concurrency in Python."}
    ],
    "stream": true
  }'
```

### 4. Anthropic Messages (`POST /v1/messages`)
```bash
curl -X POST http://127.0.0.1:8000/v1/messages   -H "Content-Type: application/json"   -H "x-api-key: sk-antigravity"   -H "anthropic-version: 2023-06-01"   -d '{
    "model": "claude-sonnet-4.6-thinking",
    "system": "You are a senior systems engineer.",
    "messages": [
      {"role": "user", "content": "Compare Redis vs Memcached."}
    ]
  }'
```

### 5. Image Generation (`POST /v1/images/generations`)
```bash
curl -X POST http://127.0.0.1:8000/v1/images/generations   -H "Content-Type: application/json"   -H "Authorization: Bearer sk-antigravity"   -d '{
    "model": "imagen-3.0-generate-002",
    "prompt": "A cybernetic dragon flying over neon Tokyo, photorealistic 8k",
    "size": "1024x1024",
    "n": 1
  }'
```

### 6. Profile & Channel Control APIs (`/v1/profiles/*` & `/extension/*`)
- `GET /v1/profiles` — List all profile metrics, channel states, and quota cooldowns.
- `POST /v1/profiles/toggle` — Toggle a profile channel (`{"profile": "p1", "channel": "web", "enabled": false}`).
- `POST /v1/profiles/disable` — Disable a profile (`{"profile": "p1", "channel": "cli|web|all"}`).
- `POST /v1/profiles/enable` — Enable a profile (`{"profile": "p1", "channel": "cli|web|all"}`).
- `POST /v1/profiles/reset` — Reset cooldowns (`{"profile": "profile_1"}`).
- `POST /v1/profiles/check` — Trigger active quota probe (`{"model": "gemini-3.7-flash"}`).
- `POST /v1/profiles/config` — Live hot-reload profile rotation (`{"profiles": ["p1", "p2"]}`).
- `GET /extension/status` — Inspect connected Chrome Extension clients and active sessions.

---

## 🌐 Chrome Extension & Browser Web Fallback (noVNC Setup)

Antigravity Bridge includes a powerful **Web Browser Extension Bridge** that routes prompts directly to active `gemini.google.com` sessions inside Google Chrome or Chromium.

### 🌟 3-Tier Multi-Engine Dynamic Fallback
When a request is received with `channel="auto"` (the default):
1. **Tier 1 (CLI Gemini):** Attempt execution via Antigravity CLI using `gemini-3.8-flash-thinking`.
2. **Tier 2 (CLI Sonnet):** If all Gemini accounts are in quota cooldown, automatically fall back to `claude-sonnet-4.6-thinking` via CLI.
3. **Tier 3 (Web Extension):** If both Gemini and Claude are in cooldown on the CLI, seamlessly route the prompt to connected Chrome Extension tabs on `gemini.google.com`!

### ✨ Extension Capabilities
- **Smart Model Picker:** The extension automatically scans the dropdown on `gemini.google.com` and selects **3.8 Flash Thinking**, **2.0 Flash Thinking**, or the best available reasoning model.
- **Thinking Process Extraction:** Automatically parses `<think>...</think>` blocks from the browser DOM so reasoning tokens are returned cleanly.
- **Continuous Keep-Alive Engine:** Uses Chrome Alarms API (`chrome.alarms`), persistent WebSocket heartbeats, and simulated interactions to prevent background tabs from being suspended or throttled.
- **Profile-to-Tab Matching:** Automatically extracts the logged-in Google email from the page and maps it to the corresponding Antigravity profile.
- **Per-Channel Toggling:** Granularly enable or disable CLI or Web channels per profile (`profile disable <p> --channel web` or `profile toggle <p> web off`).

### 📦 Loading the Extension in Desktop Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **"Developer mode"** in the top-right corner.
3. Click **"Load unpacked"** and select the [`extension/`](extension/) directory from this repository.
4. Open a browser tab to [https://gemini.google.com](https://gemini.google.com) and log in with your Google Account.
5. Click the Antigravity Extension icon in the toolbar. It will connect to `ws://127.0.0.1:8000/ws` and show a green `CONNECTED` status.

### 🐳 Headless VPS Deployment with noVNC (Docker)
For headless Linux servers or VPS environments without a display monitor, the [`deploy/`](deploy/) directory provides a complete Docker & noVNC environment:

```bash
cd deploy/
docker compose up -d --build
```
- **Access noVNC Desktop:** Connect via SSH tunnel:
  ```bash
  ssh -L 6080:127.0.0.1:6080 -L 8000:127.0.0.1:8000 user@your-server-ip
  ```
  Then open `http://127.0.0.1:6080` in your browser.
- Log in to your Google accounts inside the noVNC Chromium browser once; sessions stay alive indefinitely!

---

## 🧪 Interactive Live Testing (`test_bridge.py`)

Antigravity Bridge includes a zero-dependency CLI test suite [`test_bridge.py`](test_bridge.py) to test health, models, web extension connection, chat completions, and real-time streaming tokens.

### 🎮 Interactive Mode (Menu 0-9)
```bash
python3 test_bridge.py
```
Displays an interactive menu to test any component on demand:
- `1. 🩺 Full System Health & Quota Overview`
- `2. 🤖 List Registered Models`
- `3. 🔌 Check Browser Web Extension Status`
- `4. ⚡ Test Chat Completion (gemini-3.8-flash-thinking)`
- `5. 🌊 Test Chat Streaming (SSE Real-time Tokens)`
- `6. 🌐 Test Web Extension Channel (channel='web')`
- `7. 🖥️  Test CLI Channel (channel='cli')`
- `8. 🅰️  Test Anthropic Messages Endpoint (/v1/messages)`
- `9. 🚀 Run ALL Tests Sequentially`

### ⚡ One-Liner Commands
```bash
# Check server health and all profile cooldowns:
python3 test_bridge.py --health

# Inspect available models:
python3 test_bridge.py --models

# Verify Chrome Extension status:
python3 test_bridge.py --extension

# Test chat completion with Flash Thinking:
python3 test_bridge.py --chat "Explain quantum entanglement in 1 sentence."

# Test real-time SSE token streaming:
python3 test_bridge.py --chat "Count 1 to 5" --stream

# Force test through Web Extension Channel:
python3 test_bridge.py --chat "Hello" --channel web

# Test Anthropic /v1/messages compatibility:
python3 test_bridge.py --anthropic

# Run all automated tests:
python3 test_bridge.py --all
```

---

## ⚙️ Configuration & Environment Variables

### Environment Variables (`.env`)

| Variable | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| **`ANTIGRAVITY_HOST`** | `str` | `127.0.0.1` | Network interface to bind (`0.0.0.0` for all interfaces) |
| **`ANTIGRAVITY_PORT`** | `int` | `8000` | Port number to listen on |
| **`ANTIGRAVITY_PROFILE_CONCURRENCY`** | `int` | `1` | Max concurrent requests per profile (e.g. `2` for higher capacity) |
| **`ANTIGRAVITY_PROFILES`** | `str` | *Auto* | Comma-separated list of profile names to rotate through |
| **`ANTIGRAVITY_BRIDGE_API_KEYS`** | `str` | `None` | Comma-separated or labeled API Keys (`agent-1:sk-xxx,agent-2:sk-yyy`) |
| **`ANTIGRAVITY_BRIDGE_API_KEY`** | `str` | `None` | Single secret API key to require from clients (`Bearer <key>`) |
| **`ANTIGRAVITY_HIDE_PROFILE_STATUS`** | `int/bool`| `0` | Set `1` to hide the status footer tag from AI responses |
| **`ANTIGRAVITY_NO_PROXY`** | `int/bool`| `0` | Set `1` to disable proxy auto-detection |
| **`ANTIGRAVITY_NO_AUTO_REFRESH`** | `int/bool`| `0` | Set `1` to disable background 55-minute OAuth token refresh |
| **`GEMINI_API_KEY`** | `str` | `None` | Google AI Studio Key for direct Imagen 3 generation |
| **`ANTIGRAVITY_IMAGE_ROUTER_URL`** | `str` | *9router* | Custom image generation gateway URL |

---

## 🤖 Hermes Agent Integration (`config.yaml`)

**Hermes Agent** can use Antigravity Bridge as a high-performance custom OpenAI-compatible provider with full streaming and tool-calling capabilities.

### 1. Configure `config.yaml`
Add `agy-cli` under `custom_providers` in your Hermes configuration file (`~/.hermes/config.yaml` or `~/.hermes/profiles/<profile>/config.yaml`):

```yaml
model:
  default: gemini-3.7-flash-high
  provider: agy-cli

custom_providers:
  agy-cli:
    api: http://127.0.0.1:8000/v1
    api_key: sk-antigravity  # Match ANTIGRAVITY_BRIDGE_API_KEY (or any string if unset)
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

### 2. Verify & Switch Models via Hermes CLI
```bash
# 1. View loaded custom models:
hermes models

# 2. Set default active model:
hermes model set agy-cli/gemini-3.7-flash-high

# 3. Start a chat session using Antigravity Bridge:
hermes chat -m agy-cli/gemini-3.7-flash-high
```

---

## 🦞 OpenClaw Integration (`openclaw.json`)

**OpenClaw** (an autonomous agent gateway and multi-channel runtime) can connect directly to Antigravity Bridge as a custom OpenAI-compatible provider.

### 1. Configure `openclaw.json` (JSON5)
Edit your OpenClaw configuration file (`~/.openclaw/openclaw.json` or path in `OPENCLAW_CONFIG_PATH`):

```json5
{
  "models": {
    "mode": "merge",
    "providers": {
      "antigravity": {
        "baseUrl": "http://127.0.0.1:8000/v1",
        "apiKey": "sk-antigravity", // Match ANTIGRAVITY_BRIDGE_API_KEY
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini-3.7-flash-high",
            "name": "Gemini 3.7 Flash (High Reasoning)",
            "contextWindow": 1000000,
            "maxTokens": 64000
          },
          {
            "id": "gemini-3.7-flash-medium",
            "name": "Gemini 3.7 Flash (Medium Reasoning)",
            "contextWindow": 1000000,
            "maxTokens": 64000
          },
          {
            "id": "gemini-3.7-flash",
            "name": "Gemini 3.7 Flash",
            "contextWindow": 1000000,
            "maxTokens": 64000
          },
          {
            "id": "gemini-3.1-pro-high",
            "name": "Gemini 3.1 Pro (High Reasoning)",
            "contextWindow": 2000000,
            "maxTokens": 64000
          },
          {
            "id": "claude-sonnet-4.6-thinking",
            "name": "Claude Sonnet 4.6 (Extended Thinking)",
            "contextWindow": 200000,
            "maxTokens": 64000
          },
          {
            "id": "claude-opus-4.6-thinking",
            "name": "Claude Opus 4.6 (Extended Thinking)",
            "contextWindow": 200000,
            "maxTokens": 64000
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity/gemini-3.7-flash-high"
      },
      "models": {
        "antigravity/gemini-3.7-flash-high": {
          "alias": "gemini-flash"
        },
        "antigravity/claude-sonnet-4.6-thinking": {
          "alias": "claude-sonnet"
        }
      }
    }
  }
}
```

### 2. Configure via OpenClaw CLI
You can also configure the provider and models using the OpenClaw CLI:

```bash
# 1. Register custom provider base URL and API key
openclaw config set models.providers.antigravity.baseUrl "http://127.0.0.1:8000/v1"
openclaw config set models.providers.antigravity.apiKey "sk-antigravity"
openclaw config set models.providers.antigravity.api "openai-completions"

# 2. Set default primary model
openclaw models set antigravity/gemini-3.7-flash-high

# 3. Validate configuration & list recognized models
openclaw config validate
openclaw models list
```

### 3. OpenClaw in Docker Setup (`openclaw-in-docker`)
If running OpenClaw in Docker, configure the bridge endpoint to route to the host machine:

* **Linux Docker Host**: Use `http://172.17.0.1:8000/v1` or `http://host.docker.internal:8000/v1` (with `extra_hosts: ["host.docker.internal:host-gateway"]` in `docker-compose.yml`).
* In `.env` for Docker:
  ```ini
  OPENAI_BASE_URL=http://172.17.0.1:8000/v1
  OPENAI_API_KEY=sk-antigravity
  ```

---

## 💻 Client SDK Examples

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="sk-antigravity"
)

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "Explain event loops in Node.js vs Python."}]
)
print(response.choices[0].message.content)
```

### Python (Anthropic SDK)
```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8000",
    api_key="sk-antigravity"
)

message = client.messages.create(
    model="claude-sonnet-4.6-thinking",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a binary search algorithm in Rust."}]
)
print(message.content[0].text)
```

### Python (Custom Long Timeout: 20–30 Minutes for Massive Prompts)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="sk-antigravity",
    timeout=1800.0,  # 30 minutes client timeout
    default_headers={"X-Profile-Timeout": "30m"}
)

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "Analyze and refactor this massive 100k-token repository codebase..."}],
    extra_body={"profile_timeout": "30m"}
)
print(response.choices[0].message.content)
```

---

## ⏱️ Custom Timeout Options & Large Prompt Handling

When processing very large prompts (e.g. multi-file codebase analysis or deep reasoning queries), you can request custom execution timeouts up to **2 hours** using any of the following methods:

| Method | Example |
| :--- | :--- |
| **HTTP Header** | `X-Profile-Timeout: 30m` or `OpenAI-Timeout: 1800` or `X-Execution-Timeout: 20m` |
| **JSON Request Body** | `{"model": "gemini-3.7-flash-high", "profile_timeout": "30m", ...}` |
| **Inside `extra_body`** | `client.chat.completions.create(..., extra_body={"profile_timeout": "30m"})` |
| **URL Query Parameter** | `POST http://127.0.0.1:8000/v1/chat/completions?timeout=30m` |
| **Model Name Suffix** | `model: "gemini-3.7-flash-high:timeout=30m"` or `model: "gemini-3.7-flash-high:30m"` |
| **In-Prompt Directive** | `[antigravity:timeout=30m]` embedded at the top of your prompt or system instruction |

---

## 🌐 Web Extension Bridge (`gemini.google.com`)

Antigravity Bridge includes a Chrome Extension (Manifest V3) that allows routing requests directly through real, logged-in browser tabs on `https://gemini.google.com/`.

### Why use the Web Extension?
- **Web Session Routing**: Utilize features and quotas available through your Google web interface.
- **Multi-Profile Auto-Pairing**: When you open Gemini in Chromium, the extension detects your active Google Account email from the avatar/DOM and automatically maps it to the matching Antigravity profile (`google_accounts.json`).
- **Granular Channel Controls**: Selectively choose whether each profile handles requests via CLI (`agy`), Web Extension, or both.
- **Offscreen Keepalive**: Prevents Chrome from terminating background service workers even when tabs are idle.

### Installing the Extension Locally
1. In Chrome / Chromium, navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in top right).
3. Click **Load unpacked** and select the `extension/` folder in this repository.
4. Open `https://gemini.google.com/app` and verify you are logged in.
5. Click the Antigravity Extension icon in the toolbar. It should show **🟢 Connected** to `http://127.0.0.1:8000`.

---

## 🐳 Headless Deployment with Docker & noVNC (`deploy/`)

To run Antigravity Bridge 24/7 on a remote Linux server or VPS without keeping your laptop open:

```bash
cd deploy/
docker compose up -d --build
```

- **Web Desktop (noVNC)**: Accessible on `http://127.0.0.1:6080` (via SSH tunnel: `ssh -L 6080:127.0.0.1:6080 -L 8000:127.0.0.1:8000 user@server`).
- **API Endpoint**: `http://127.0.0.1:8000`.
- **Persistent Cookies**: Chrome login sessions persist inside `deploy/chrome-data/`.
- Full details in [deploy/README.md](deploy/README.md).

---

## 🔀 Multi-Channel Profile Control (CLI vs Web)

You can selectively configure which channel each profile is allowed to execute:

```bash
# Disable Web channel for profile 'p1' (CLI remains active)
python3 antigravity_bridge.py profile disable p1 --channel web

# Disable CLI for profile 'p2' (Web extension remains active)
python3 antigravity_bridge.py profile disable p2 --channel cli

# Disable both channels
python3 antigravity_bridge.py profile disable p1 --channel all

# Re-enable Web channel for profile 'p1'
python3 antigravity_bridge.py profile enable p1 --channel web

# View profile status with CLI & Web channel indicators
python3 antigravity_bridge.py profile list
```

When sending API completion requests, you can optionally configure or force a specific channel:
```json
{
  "model": "antigravity",
  "channel": "auto",
  "messages": [{"role": "user", "content": "Hello!"}]
}
```
Supported values for `channel`:
- **`"auto"` (Default 3-Tier Fallback)**:
  1. **Primary**: CLI execution via standard `agy` CLI (Gemini model family).
  2. **Tier 1 Fallback**: CLI execution switches dynamically to Claude Sonnet (`claude-sonnet-4.6-thinking`) when Gemini hits quota limits / cooldown.
  3. **Tier 2 Fallback**: Web Extension (`gemini.google.com`) when **BOTH** Gemini and Sonnet reach quota limits on CLI.
  4. **Tier 3 Safety Net**: If all candidate profiles fail on CLI, falls back to any connected Web Extension before erroring out.
- **`"cli"`**: Forces CLI execution only (`agy`). Never routes to Web Extension even if CLI hits quota limits.
- **`"web"`** (or any model ending in `-web`): Forces Web Extension execution directly via `gemini.google.com`.

---

## 🚀 Production Deployment & Public Exposure (Systemd / Nginx)

### 1. Systemd Service Setup (Linux)
Run the automated installer:
```bash
chmod +x setup_systemd.sh
./setup_systemd.sh
```

Or manually manage via systemctl:
```bash
sudo systemctl status antigravity-bridge
sudo systemctl restart antigravity-bridge
sudo journalctl -u antigravity-bridge -f
```

### 2. Public Exposure & Cross-Machine Access via Nginx Reverse Proxy

To allow remote machines, external laptops, cloud VMs, and decentralized AI agents to connect to your Antigravity Bridge over the public internet, deploy **Nginx** as a secure Reverse Proxy with SSL termination, Server-Sent Events (SSE) streaming support, and WebSocket proxying.

#### Recommended Network Architecture
```
┌────────────────────────────────────────────────────────┐
│  Remote Clients / Machines (Laptops, Cloud VMs, Bots)  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS (Port 443) / WSS
                            ▼
┌────────────────────────────────────────────────────────┐
│             Nginx Reverse Proxy (Public Host)          │
│  - SSL / TLS Termination (Let's Encrypt Certbot)       │
│  - Unbuffered SSE Streaming (proxy_buffering off)       │
│  - WebSocket Upgrade for /ws Extension Bridge          │
│  - Extended 1800s Timeouts for Deep Reasoning Models   │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP (127.0.0.1:8000)
                            ▼
┌────────────────────────────────────────────────────────┐
│         Antigravity Bridge Server (Local Host)         │
│  - Multi-profile rotation & 3-tier fallback            │
│  - Bearer API Key Authentication                       │
└────────────────────────────────────────────────────────┘
```

#### Production Nginx Virtual Host Configuration
Create or edit `/etc/nginx/sites-available/antigravity-bridge`:

```nginx
# 1. HTTP to HTTPS automatic redirection
server {
    listen 80;
    listen [::]:80;
    server_name bridge.yourdomain.com;
    return 301 https://$host$request_uri;
}

# 2. Public HTTPS API & WebSocket Reverse Proxy
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name bridge.yourdomain.com;

    # SSL certificates (managed automatically by Certbot)
    ssl_certificate /etc/letsencrypt/live/bridge.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bridge.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Max body size for multimodal base64 image/file uploads
    client_max_body_size 50M;

    # Root API Proxy (Chat Completions, Anthropic Messages, Health)
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # Standard Proxy Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # CRITICAL: Disable Buffering for Real-Time SSE Streaming
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        # CRITICAL: Extended timeouts for Deep Reasoning / Thinking models
        proxy_connect_timeout 300s;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }

    # WebSocket Proxy for Chrome Extension Bridge (/ws)
    location /ws {
        proxy_pass http://127.0.0.1:8000/ws;
        proxy_http_version 1.1;

        # WebSocket Upgrade Headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Keep-alive timeout for persistent WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

#### Step-by-Step Installation & SSL Setup
```bash
# 1. Install Nginx and Certbot (Ubuntu/Debian)
sudo apt update && sudo apt install nginx certbot python3-certbot-nginx -y

# 2. Enable virtual host configuration
sudo ln -s /etc/nginx/sites-available/antigravity-bridge /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 3. Obtain free SSL certificate via Let's Encrypt
sudo certbot --nginx -d bridge.yourdomain.com

# 4. Require API Key in .env for public exposure
# Edit .env on the Bridge host:
# ANTIGRAVITY_BRIDGE_API_KEYS="sk-prod-your-secure-key-here"
```

### 3. Connecting Remote Clients Across Machines

Once your Nginx Reverse Proxy is active, any client application or AI agent on any external machine can connect securely using standard SDKs:

#### Python OpenAI SDK (from any remote machine)
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://bridge.yourdomain.com/v1",
    api_key="sk-prod-your-secure-key-here",
)

response = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": "Hello from an external machine!"}],
    stream=True,
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

#### Hermes Agent (`config.yaml` on remote machine)
```yaml
model: gemini-3.8-flash
api_base: https://bridge.yourdomain.com/v1
api_key: sk-prod-your-secure-key-here
```

#### Claude Code / Anthropic SDK (from any remote machine)
```bash
export ANTHROPIC_BASE_URL="https://bridge.yourdomain.com"
export ANTHROPIC_API_KEY="sk-prod-your-secure-key-here"
claude
```

#### Direct cURL (from any remote machine)
```bash
curl https://bridge.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-prod-your-secure-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "Ping from remote machine"}]
  }'
```

---

## 🔧 Troubleshooting & FAQ

### Q1: Why are my newly added profiles not showing up in `profiles`?
- **Cause**: If `~/.config/antigravity/bridge_config.json` exists, the bridge locks to that specific profile list instead of scanning folders.
- **Fix**: Remove the locked configuration file:
  ```bash
  rm -f ~/.config/antigravity/bridge_config.json
  python3 antigravity_bridge.py profiles
  ```

### Q2: How do I verify OAuth token validity for all accounts?
- **Fix**: Run the built-in diagnostic doctor:
  ```bash
  python3 antigravity_bridge.py doctor
  ```

### Q3: How do I reset profiles stuck in cooldown?
- **Fix**:
  ```bash
  python3 antigravity_bridge.py profile reset
  ```

---

## 🧪 Running Unit Tests

Run the complete test suite covering API formats, streaming handlers, profile ordering algorithms, fallback routing, cooldown fast-fail, large prompt passing, and CLI subcommand handlers (**25/25 tests**):

```bash
python3 -m unittest test_antigravity_bridge.py -v
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
