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
> ### 📢 Notice: Cross-Machine Usage & Roadmap
> **Antigravity Bridge currently operates on the local host machine** where the `antigravity`/`agy` CLI and Google authentication profiles are installed.
> - Client applications (Hermes Agent, OpenAI SDK, Anthropic SDK, bots, webhooks) can connect to the Bridge over HTTP from any network or machine.
> - However, the Bridge itself executes the underlying CLI profiles locally on the host machine.
> - **Distributed cross-machine / remote node worker clustering is NOT yet supported in this version** and is planned for an upcoming release.

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
  - [4. Add Google Profiles](#4-add-google-profiles)
  - [5. Launch Bridge Server](#5-launch-bridge-server)
  - [6. Verify & Health Check](#6-verify--health-check)
- [🤖 Supported Models Matrix](#-supported-models-matrix)
- [👤 Profile Manager CLI Reference](#-profile-manager-cli-reference)
- [📡 REST API Reference](#-rest-api-reference)
  - [1. Health Check (`GET /health`)](#1-health-check-get-health)
  - [2. List Models (`GET /v1/models`)](#2-list-models-get-v1models)
  - [3. OpenAI Chat Completions (`POST /v1/chat/completions`)](#3-openai-chat-completions-post-v1chatcompletions)
  - [4. Anthropic Messages (`POST /v1/messages`)](#4-anthropic-messages-post-v1messages)
  - [5. Image Generation (`POST /v1/images/generations`)](#5-image-generation-post-v1imagesgenerations)
  - [6. Profile Control APIs (`/v1/profiles/*`)](#6-profile-control-apis-v1profiles)
- [⚙️ Configuration & Environment Variables](#️-configuration--environment-variables)
- [🤖 Hermes Agent Integration (`config.yaml`)](#-hermes-agent-integration-configyaml)
- [🦞 OpenClaw Integration (`openclaw.json`)](#-openclaw-integration-openclawjson)
- [💻 Client SDK Examples](#-client-sdk-examples)
- [🚀 Production Deployment (Systemd / PM2 / Nginx)](#-production-deployment-systemd--pm2--nginx)
- [🔧 Troubleshooting & FAQ](#-troubleshooting--faq)
- [🧪 Running Unit Tests](#-running-unit-tests)
- [📄 License](#-license)

---

## 🌟 Architecture & Overview

Antigravity Bridge acts as a unified HTTP gateway between your applications (Hermes Agent, OpenCode, Claude Code, Python/Node.js SDKs, Webhooks) and local `antigravity`/`agy` CLI subprocesses:

```
┌────────────────────────────────────────────────────────────────────────┐
│            External AI Clients (Hermes / OpenAI / Anthropic SDK)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST / SSE Stream
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Antigravity Bridge Server (Port 8000)                 │
│  ├── Dual API Translators (OpenAI v1 & Anthropic Messages)             │
│  ├── Multi-Concurrent Profile Pool & Dynamic Lease Allocator           │
│  ├── Smart Quota Detector (Auto-Calculates Reset Timers & Rotates)     │
│  ├── Context Compactor & Heartbeat Generator (For Long Reasoning)      │
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

- ⚡ **Multi-Concurrent Profile Pool**:
  - **Isolated Sandboxes**: Each profile runs in its own isolated runtime directory (`~/.config/antigravity/sandboxes/<profile>/`), completely eliminating SQLite database locks (`conversation_summaries.db`) and auth file collisions.
  - **Parallel Capacity**: Configurable concurrent requests per profile (e.g. 14 profiles × 2 concurrency = **28 parallel requests**).
- 🔄 **Dual Format Compatibility**: 100% drop-in compatible with both **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`) standards.
- 🛠️ **Native Tool & Function Calling**: Seamless extraction and translation for OpenAI `tools`/`functions` and Anthropic `tools`.
- 🌊 **Real-Time SSE Streaming & Heartbeats**: Fast Server-Sent Events (`text/event-stream`) streaming with periodic heartbeat comments to prevent upstream proxy timeouts during deep reasoning queries.
- 🔀 **Zero-Downtime Smart Fallback**:
  - Automatically rotates across multiple accounts in `~/.config/antigravity/profiles/`.
  - Instantly detects `429 Too Many Requests`, `RESOURCE_EXHAUSTED`, and quota errors.
  - Automatically parses cooldown reset durations (e.g. `Resets in 74h 7m 25s`) and falls back immediately to the next healthy profile without failing the user request.
- 🛡️ **Adaptive Context Compaction**: Automatically sanitizes prompts and compacts oversized conversation histories from heavy analytical agents to prevent buffer overflows and CLI crashes.
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
# ANTIGRAVITY_BRIDGE_API_KEY=sk-antigravity
```

### 4. Add Google Profiles
Add your Google account profiles interactively:
```bash
python3 antigravity_bridge.py login profile_1
python3 antigravity_bridge.py login profile_2
```
> **Login Steps:**
> 1. Browser will open Google OAuth login. Select account and authorize.
> 2. When the terminal prompt displays `>`, type `hi` and press `Enter` to activate.
> 3. Type `/exit` (or `Ctrl+D`) to save the profile credentials to `~/.config/antigravity/profiles/<name>/`.

### 5. Launch Bridge Server

#### Option A: 1-Click Systemd Service (Recommended for Linux)
```bash
chmod +x setup_systemd.sh
./setup_systemd.sh
```

#### Option B: Direct Terminal Run
```bash
python3 antigravity_bridge.py
```

### 6. Verify & Health Check
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
| **`gpt-oss-120b-medium`** | `--model gpt-oss-120b` | `medium` | GPT-OSS 120B (Medium Reasoning) | 128,000 |
| **`gpt-oss-120b`** | `--model gpt-oss-120b` | - | GPT-OSS 120B | 128,000 |
| **`imagen-3.0-generate-002`** | Google Imagen 3 API | - | High-Quality Image Generation (`/v1/images/generations`) | - |
| **`imagen-3.0-fast-generate-001`**| Google Imagen 3 Fast API | - | Fast Image Generation (`/v1/images/generations`) | - |
| **`gemini-3.1-flash-image`** | Gemini Image Router | - | Fast Gemini Image Generation | - |
| **`antigravity`** / **`agy`** | Default CLI backend | - | Default fallback model routing | 1,000,000 |

---

## 👤 Profile Manager CLI Reference

The CLI provides built-in subcommands to manage multiple Google profiles:

| Command | Shortcut | Description |
| :--- | :--- | :--- |
| `python3 antigravity_bridge.py profile list` | `profiles` | Display table of profiles, Google emails, in-flight leases, cooldowns, and quota |
| `python3 antigravity_bridge.py profile login <name>` | `login <name>` | Interactively authenticate and register a new Google profile |
| `python3 antigravity_bridge.py profile test [name]` | - | Actively probe quota availability and model responsiveness |
| `python3 antigravity_bridge.py profile set <p1,p2>` | `profile order` | Dynamically set profile rotation pool and priority order |
| `python3 antigravity_bridge.py profile disable <name>` | - | Persistently disable a profile from receiving requests (persists across restarts) |
| `python3 antigravity_bridge.py profile enable <name>` | - | Re-enable a previously disabled profile |
| `python3 antigravity_bridge.py profile reset [name]` | - | Reset cooldown timers and clear exhausted flags |
| `python3 antigravity_bridge.py profile refresh [name]` | - | Force OAuth token refresh directly with Google |
| `python3 antigravity_bridge.py profile sync <user@vps>` | - | Sync all profiles to a remote VPS over compressed SSH |
| `python3 antigravity_bridge.py profile copy <name> <vps>` | - | Copy a single profile to remote host via SCP |
| `python3 antigravity_bridge.py profile remove <name>` | - | Delete profile credentials directory |
| `python3 antigravity_bridge.py doctor` | `diag` | Run diagnostic check (IP, proxy, token validity, lock cleanup) |

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

### 6. Profile Control APIs (`/v1/profiles/*`)
- `GET /v1/profiles` — List all profile metrics.
- `POST /v1/profiles/reset` — Reset cooldowns (`{"profile": "profile_1"}`).
- `POST /v1/profiles/check` — Trigger active quota probe (`{"model": "gemini-3.7-flash"}`).
- `POST /v1/profiles/config` — Live hot-reload profile rotation (`{"profiles": ["p1", "p2"]}`).
- `POST /v1/profiles/disable` — Temporarily disable profile (`{"profile": "p1"}`).
- `POST /v1/profiles/enable` — Re-enable profile (`{"profile": "p1"}`).

---

## ⚙️ Configuration & Environment Variables

### Environment Variables (`.env`)

| Variable | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| **`ANTIGRAVITY_HOST`** | `str` | `127.0.0.1` | Network interface to bind (`0.0.0.0` for all interfaces) |
| **`ANTIGRAVITY_PORT`** | `int` | `8000` | Port number to listen on |
| **`ANTIGRAVITY_PROFILE_CONCURRENCY`** | `int` | `1` | Max concurrent requests per profile (e.g. `2` for higher capacity) |
| **`ANTIGRAVITY_PROFILES`** | `str` | *Auto* | Comma-separated list of profile names to rotate through |
| **`ANTIGRAVITY_BRIDGE_API_KEY`** | `str` | `None` | Secret API key to require from clients (`Bearer <key>`) |
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

---

## 🚀 Production Deployment (Systemd / PM2 / Nginx)

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

### 2. Nginx Reverse Proxy with Streaming Support
```nginx
server {
    listen 80;
    server_name bridge.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Crucial for SSE Streaming
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
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

Run the complete test suite covering API formats, streaming handlers, profile ordering algorithms, fallback routing, and CLI subcommand handlers:

```bash
python3 -m unittest test_antigravity_bridge.py -v
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
