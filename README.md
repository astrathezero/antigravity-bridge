# Antigravity Bridge Server With Multi-Concurrent Pool 🌉

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange.svg)](https://docs.anthropic.com/en/api/messages)
[![Imagen 3](https://img.shields.io/badge/Image-Google%20Imagen%203-purple.svg)](https://ai.google.dev/gemini-api/docs/imagen)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Antigravity Bridge Server** is a high-performance, zero-dependency OpenAI & Anthropic compatible REST API Bridge Server designed for the `antigravity` / `agy` CLI ecosystem. It features smart multi-account profile rotation, automatic quota error recovery, OAuth token auto-refresh daemon, diagnostic doctor, and image generation.

---

## 📖 Table of Contents

- [🌟 Overview & Architecture](#-overview--architecture)
- [✨ Key Features](#-key-features)
- [🤖 Supported Models Matrix](#-supported-models-matrix)
- [👤 Complete Profile Manager CLI Reference](#-complete-profile-manager-cli-reference)
  - [1. List & Quota Status (`profiles`, `profile list`)](#1-list--quota-status-profiles-profile-list)
  - [2. Interactive Login & Add Profile (`login`, `profile login`)](#2-interactive-login--add-profile-login-profile-login)
  - [3. Test & Probe Quota Health (`profile test`)](#3-test--probe-quota-health-profile-test)
  - [4. Dynamic Rotation Order & Set Profiles (`profile set`, `profile order`)](#4-dynamic-rotation-order--set-profiles-profile-set-profile-order)
  - [5. Disable & Enable Profiles (`profile disable`, `profile enable`)](#5-disable--enable-profiles-profile-disable-profile-enable)
  - [6. Reset Cooldown (`profile reset`)](#6-reset-cooldown-profile-reset)
  - [7. Token Refresh (`profile refresh`)](#7-token-refresh-profile-refresh)
  - [8. Sync Profiles Across Servers (`profile sync`, `profile copy`)](#8-sync-profiles-across-servers-profile-sync-profile-copy)
  - [9. Delete Profile (`profile remove`)](#9-delete-profile-profile-remove)
  - [10. Diagnostic Doctor (`diag`, `doctor`)](#10-diagnostic-doctor-diag-doctor)
- [📡 Complete REST API Endpoints Reference](#-complete-rest-api-endpoints-reference)
  - [1. Health Check (`GET /health`)](#1-health-check-get-health)
  - [2. List Models (`GET /v1/models`)](#2-list-models-get-v1models)
  - [3. OpenAI Chat Completions (`POST /v1/chat/completions`)](#3-openai-chat-completions-post-v1chatcompletions)
  - [4. Anthropic Messages (`POST /v1/messages`)](#4-anthropic-messages-post-v1messages)
  - [5. Image Generation (`POST /v1/images/generations`)](#5-image-generation-post-v1imagesgenerations)
  - [6. Profile Status Summary (`GET /v1/profiles`)](#6-profile-status-summary-get-v1profiles)
  - [7. Reset Profile Cooldowns (`POST /v1/profiles/reset`)](#7-reset-profile-cooldowns-post-v1profilesreset)
  - [8. Active Quota Probing (`POST /v1/profiles/check`)](#8-active-quota-probing-post-v1profilescheck)
  - [9. Live Profile Reconfiguration (`POST /v1/profiles/config`)](#9-live-profile-reconfiguration-post-v1profilesconfig)
  - [10. Runtime Disable/Enable (`POST /v1/profiles/disable`, `POST /v1/profiles/enable`)](#10-runtime-disableenable-post-v1profilesdisable-post-v1profilesenable)
- [⚙️ Server CLI Options & Environment Variables](#️-server-cli-options--environment-variables)
  - [Server Command-Line Arguments](#server-command-line-arguments)
  - [Environment Variables](#environment-variables)
- [🤖 Hermes Agent Integration (`config.yaml`)](#-hermes-agent-integration-configyaml)
- [💻 Client SDK Examples](#-client-sdk-examples)
  - [Python (OpenAI SDK)](#python-openai-sdk)
  - [Python (Anthropic SDK)](#python-anthropic-sdk)
  - [JavaScript / TypeScript (OpenAI SDK)](#javascript--typescript-openai-sdk)
  - [cURL](#curl)
- [🚀 Production Deployment](#-production-deployment)
  - [1. Deploy as Systemd Service (Linux)](#1-deploy-as-systemd-service-linux)
  - [2. Deploy with PM2](#2-deploy-with-pm2)
  - [3. Deploy with Nginx (Reverse Proxy + SSL)](#3-deploy-with-nginx-reverse-proxy--ssl)
- [🔧 Troubleshooting & FAQ](#-troubleshooting--faq)
- [🧪 Running Unit Tests](#-running-unit-tests)
- [📄 License](#-license)

---

## 🌟 Overview & Architecture

The **Antigravity Bridge Server** bridges AI clients, external bots, webhooks, and agent frameworks (such as **Hermes Agent**, **OpenAI SDK**, **Anthropic SDK**, **LangChain**, **LlamaIndex**, **n8n**) directly to your local or VPS `antigravity` / `agy` CLI environment.

```
┌─────────────────────────────────────────────────────────┐
│ External AI Clients (Hermes / OpenAI / Anthropic SDK)   │
└────────────────────────────┬────────────────────────────┘
                             │ HTTP REST / SSE Stream
                             ▼
┌─────────────────────────────────────────────────────────┐
│             Antigravity Bridge Server (8000)            │
│  - Dual API Compatibility (OpenAI & Anthropic formats)  │
│  - Smart Profile Rotation & Quota Fallback Manager     │
│  - Token Auto-Refresh Daemon (every 55 minutes)         │
│  - Outbound Proxy Detector (WARP / SOCKS5)              │
│  - Image Generation Router (Google Imagen 3)            │
└────────────────────────────┬────────────────────────────┘
                             │ Headless Subprocess Execution
                             ▼
┌─────────────────────────────────────────────────────────┐
│     Multi-Profile Pool (~/.config/antigravity/profiles) │
│  ├── Profile 1 (astrathezero)  ──► Google Gemini API    │
│  ├── Profile 2 (attasitgits)   ──► Google Gemini API    │
│  └── Profile N (...)           ──► Google Gemini API    │
└─────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

- ⚡ **Multi-Concurrent Profile Pool & Parallel Execution**:
  - **Zero Lock Contention**: Runs each profile in an isolated runtime sandbox (`~/.config/antigravity/sandboxes/<profile>/`).
  - **Independent Profile Leases**: Enables parallel execution across all healthy profiles simultaneously (e.g. 8 profiles = 8 parallel requests).
  - Eliminates SQLite database lock contention (`conversation_summaries.db`) and auth file collisions.
- 🔄 **Dual Format Compatibility**: 100% compatible with both **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`) standards.
- 🛠️ **Tool Calling & Function Calling**: Native extraction and parsing for OpenAI `tools` / `functions` and Anthropic `tools`.
- ⚡ **Real-Time SSE Streaming**: Server-Sent Events (`text/event-stream`) for fast, fluid streaming completions.
- 🔀 **Smart Profile Pool & Zero-Downtime Fallback**:
  - Automatically loads and rotates multiple Google login profiles from `~/.config/antigravity/profiles/`.
  - Instantly detects `429 Too Many Requests`, `RESOURCE_EXHAUSTED`, and quota errors.
  - Automatically parses exact cooldown reset durations (e.g. `Resets in 74h 7m 25s`) and falls back immediately to the next healthy profile without failing the user request.
  - Persists state across restarts in `~/.config/antigravity/quota_cache.json`.
- 🔄 **Automatic OAuth Token Refresh Daemon**: Runs in a background thread every 55 minutes to keep all profile access tokens fresh.
- 🛡️ **Built-in SOCKS5 / Cloudflare WARP Proxy Auto-Detection**: Auto-detects local WARP proxies (ports `40000`, `10808`, `7890`, etc.) for seamless outbound connectivity.
- 🎨 **Image Generation Integration**: Generates images via Google Imagen 3 (`imagen-3.0-generate-002`) and Gemini Image routers (`/v1/images/generations` and chat completions).
- 🧠 **Dynamic Reasoning Effort**: Maps models to CLI flags and reasoning effort parameters (`high`, `medium`, `low`, `thinking`).
- 🩺 **Diagnostic Doctor (`diag` / `doctor`)**: Built-in self-test tool to inspect IP routing, clean stale lock files, and test OAuth token validity with Google's UserInfo API.
- 🚀 **Zero External Dependencies**: Standard Python 3 library only. No `pip install` required!

---

## 🤖 Supported Models Matrix

| Model ID (`model`) | Backend Engine / CLI Mapping | Reasoning Effort | Description | Max Context |
| :--- | :--- | :---: | :--- | :---: |
| **`gemini-3.7-flash-high`** | `--model gemini-3.7-flash` | `high` | Gemini 3.7 Flash (High Reasoning Effort) | 1,000,000 |
| **`gemini-3.7-flash-medium`** | `--model gemini-3.7-flash` | `medium` | Gemini 3.7 Flash (Medium Reasoning Effort) | 1,000,000 |
| **`gemini-3.7-flash-low`** | `--model gemini-3.7-flash` | `low` | Gemini 3.7 Flash (Low Reasoning Effort) | 1,000,000 |
| **`gemini-3.7-flash`** | `--model gemini-3.7-flash` | - | Gemini 3.7 Flash (Default) | 1,000,000 |
| **`gemini-3.6-flash-high`** | `--model gemini-3.6-flash` | `high` | Gemini 3.6 Flash (High Reasoning Effort) | 1,000,000 |
| **`gemini-3.6-flash-medium`** | `--model gemini-3.6-flash` | `medium` | Gemini 3.6 Flash (Medium Reasoning Effort) | 1,000,000 |
| **`gemini-3.6-flash-low`** | `--model gemini-3.6-flash` | `low` | Gemini 3.6 Flash (Low Reasoning Effort) | 1,000,000 |
| **`gemini-3.6-flash`** | `--model gemini-3.6-flash` | - | Gemini 3.6 Flash (Default) | 1,000,000 |
| **`gemini-3.5-flash-medium`** | `--model gemini-3.5-flash` | `medium` | Gemini 3.5 Flash (Medium Reasoning Effort) | 1,000,000 |
| **`gemini-3.5-flash-low`** | `--model gemini-3.5-flash` | `low` | Gemini 3.5 Flash (Low Reasoning Effort) | 1,000,000 |
| **`gemini-3.5-flash`** | `--model gemini-3.5-flash` | - | Gemini 3.5 Flash (Default) | 1,000,000 |
| **`gemini-3.1-pro-high`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (High Reasoning Effort) | 1,000,000 |
| **`gemini-3.1-pro-low`** | `--model gemini-3.1-pro` | `low` | Gemini 3.1 Pro (Low Reasoning Effort) | 1,000,000 |
| **`gemini-3.1-pro`** | `--model gemini-3.1-pro` | - | Gemini 3.1 Pro (Default) | 1,000,000 |
| **`claude-sonnet-4.6-thinking`** | `--model claude-sonnet-4.6` | `thinking` | Anthropic Claude Sonnet 4.6 (Extended Thinking) | 1,000,000 |
| **`claude-sonnet-4.6`** | `--model claude-sonnet-4.6` | - | Anthropic Claude Sonnet 4.6 | 1,000,000 |
| **`claude-opus-4.6-thinking`** | `--model claude-opus-4.6` | `thinking` | Anthropic Claude Opus 4.6 (Extended Thinking) | 1,000,000 |
| **`claude-opus-4.6`** | `--model claude-opus-4.6` | - | Anthropic Claude Opus 4.6 | 1,000,000 |
| **`gpt-oss-120b-medium`** | `--model gpt-oss-120b` | `medium` | GPT-OSS 120B (Medium Reasoning) | 1,000,000 |
| **`gpt-oss-120b`** | `--model gpt-oss-120b` | - | GPT-OSS 120B | 1,000,000 |
| **`imagen-3.0-generate-002`** | Google Imagen 3 API | - | High-Quality Image Generation (`/v1/images/generations`) | - |
| **`imagen-3.0-fast-generate-001`**| Google Imagen 3 Fast API | - | Fast Image Generation (`/v1/images/generations`) | - |
| **`gemini-3.1-flash-image`** | Google Gemini Image Router | - | Fast Gemini Image Generation | - |
| **`antigravity`** / **`agy`** | Default CLI backend | - | Default fallback model routing | 1,000,000 |

---

## 👤 Complete Profile Manager CLI Reference

Manage multiple Google accounts, test quotas, refresh tokens, and sync credentials seamlessly.

### 1. List & Quota Status (`profiles`, `profile list`)

View a formatted table of all discovered profiles, active Google account emails, availability status, in-flight concurrency, cooldown timers, estimated quota, and successful request counts:

```bash
python3 antigravity_bridge.py profiles
# Or
python3 antigravity_bridge.py profile list
```

**Output Preview:**
```text
============================================================================================================
Profile Name     Google Account Email           Status      In-Flight   Cooldown   Est. Quota   Success
============================================================================================================
astramoney       astra.moneylicense@gmail.com   OK          0/1         Ready      100%         9
astrasupergamer  astrasupergamer@gmail.com      OK          0/1         Ready      100%         0
astrathezero     astrathezero@gmail.com         OK          0/1         Ready      86%          28
attasitgits      attasitgits@gmail.com          OK          0/1         Ready      100%         12
mrsermshop       mrsermshop@gmail.com           EXHAUSTED   0/1         246819s    0%           4
panthornchuan    panthornchuan@gmail.com        OK          0/1         Ready      100%         15
somporn          sompornjitdee80@gmail.com      EXHAUSTED   0/1         567484s    0%           0
xiuxiubtc        xiuxiubtc@gmail.com            OK          0/1         Ready      98%          4
============================================================================================================
```

---

### 2. Interactive Login & Add Profile (`login`, `profile login`)

Adds or logs in to a new Google profile interactively:

```bash
python3 antigravity_bridge.py login my_new_profile
# Or
python3 antigravity_bridge.py profile login my_new_profile
```

**What happens:**
1. Backs up current authentication files in `~/.gemini/`.
2. Triggers Google OAuth browser authentication.
3. Automatically extracts OAuth tokens (from macOS Keychain or Linux SecretService/files) and verifies the active Google email address.
4. Stores credentials in `~/.config/antigravity/profiles/my_new_profile/`.
5. Restores original configuration cleanly.

---

### 3. Test & Probe Quota Health (`profile test`)

Actively sends lightweight test requests directly through Google's Gemini models to check API latency, quota availability, and token validity:

```bash
# Test all profiles:
python3 antigravity_bridge.py profile test

# Test a specific profile:
python3 antigravity_bridge.py profile test attasitgits

# Test with a specific model:
python3 antigravity_bridge.py profile test attasitgits --model gemini-3.7-flash

# Test with a custom prompt:
python3 antigravity_bridge.py profile test --prompt "Hello! Confirm you are working."
```

---

### 4. Dynamic Rotation Order & Set Profiles (`profile set`, `profile order`)

Explicitly define the profile rotation order and active pool. This updates both the live running server dynamically via HTTP and saves the preference to `~/.config/antigravity/bridge_config.json`:

```bash
python3 antigravity_bridge.py profile set astrathezero,attasitgits,astramoney,panthornchuan
# Or
python3 antigravity_bridge.py profile order astrathezero,attasitgits,astramoney,panthornchuan
```

---

### 5. Disable & Enable Profiles (`profile disable`, `profile enable`)

Temporarily exclude a profile from receiving requests without deleting its credentials, or re-enable it when ready:

```bash
# Temporarily disable:
python3 antigravity_bridge.py profile disable mrsermshop

# Re-enable:
python3 antigravity_bridge.py profile enable mrsermshop
```

---

### 6. Reset Cooldown (`profile reset`)

Clear cooldown states and reset estimated quotas:

```bash
# Reset a specific profile:
python3 antigravity_bridge.py profile reset attasitgits

# Reset all profiles:
python3 antigravity_bridge.py profile reset
```

---

### 7. Token Refresh (`profile refresh`)

Perform an active OAuth token exchange with Google to regenerate access tokens:

```bash
# Refresh a specific profile:
python3 antigravity_bridge.py profile refresh attasitgits

# Refresh all profiles:
python3 antigravity_bridge.py profile refresh
```

---

### 8. Sync Profiles Across Servers (`profile sync`, `profile copy`)

Quickly copy authentication profiles from your local machine to a remote VPS:

```bash
# Sync ALL profiles at once via compressed SSH stream:
python3 antigravity_bridge.py profile sync attasit@vmi2924193

# Copy a single profile via SCP:
python3 antigravity_bridge.py profile copy attasitgits attasit@vmi2924193
```

---

### 9. Delete Profile (`profile remove`)

Permanently delete a profile directory:

```bash
python3 antigravity_bridge.py profile remove old_profile
```

---

### 10. Diagnostic Doctor (`diag`, `doctor`)

Runs a full system diagnosis including public IP checks, active SOCKS5 proxy detection, stale cache file cleanup, and OAuth token validation directly against the Google UserInfo API:

```bash
python3 antigravity_bridge.py diag
# Or
python3 antigravity_bridge.py doctor
```

---

## 📡 Complete REST API Endpoints Reference

### 1. Health Check (`GET /health`)

Returns server status, active profile, and quota overview.

```bash
curl http://127.0.0.1:8000/health
```

**Response (`200 OK`):**
```json
{
  "status": "ok",
  "service": "antigravity-bridge",
  "active_profile": "astrathezero",
  "profiles": {
    "astrathezero": {
      "status": "OK",
      "cooldown_seconds_remaining": 0,
      "estimated_quota_percent": 100,
      "success_count": 28,
      "google_account": "astrathezero@gmail.com"
    }
  }
}
```

---

### 2. List Models (`GET /v1/models`)

Returns all supported models in standard OpenAI format.

```bash
curl http://127.0.0.1:8000/v1/models \
  -H "Authorization: Bearer sk-antigravity"
```

---

### 3. OpenAI Chat Completions (`POST /v1/chat/completions`)

Standard OpenAI Chat Completions endpoint supporting non-streaming, SSE streaming (`"stream": true`), and tool calling.

#### Non-Streaming Request:
```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "gemini-3.7-flash-high",
    "messages": [
      {"role": "system", "content": "You are a cloud architect."},
      {"role": "user", "content": "Explain Kubernetes ingress vs load balancer in 2 bullet points."}
    ],
    "stream": false
  }'
```

#### Streaming Request (SSE):
```bash
curl -N -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "gemini-3.7-flash-high",
    "messages": [{"role": "user", "content": "Write a Python script to scan ports."}],
    "stream": true
  }'
```

---

### 4. Anthropic Messages (`POST /v1/messages`)

Anthropic Messages API standard supporting top-level `system` prompt, tool calling, and streaming.

```bash
curl -X POST http://127.0.0.1:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-antigravity" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6-thinking",
    "system": "You are an expert algorithms developer.",
    "messages": [
      {"role": "user", "content": "Explain the time complexity of QuickSelect in worst vs average cases."}
    ]
  }'
```

---

### 5. Image Generation (`POST /v1/images/generations`)

Standard OpenAI Image Generation API format powered by **Google Imagen 3**.

> [!TIP]
> **Free Google AI Studio Key Support:**
> Set `GEMINI_API_KEY=AIzaSy...` in your `.env` or pass it in the `Authorization: Bearer <KEY>` header.

```bash
curl -X POST http://127.0.0.1:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "imagen-3.0-generate-002",
    "prompt": "A cinematic shot of a futuristic Tokyo skyscraper with glowing neon lights, photorealistic 8k",
    "size": "1024x1024",
    "n": 1
  }'
```

**Supported Sizes & Aspect Ratios:**
- `"1024x1024"` / `"1:1"` (Square)
- `"1792x1024"` / `"16:9"` (Landscape)
- `"1024x1792"` / `"9:16"` (Portrait Story)
- `"1024x768"` / `"4:3"` (Standard Landscape)
- `"768x1024"` / `"3:4"` (Standard Portrait)

---

### 6. Profile Status Summary (`GET /v1/profiles`)

Lists all profile health statuses, cooldowns, and success metrics:

```bash
curl http://127.0.0.1:8000/v1/profiles \
  -H "Authorization: Bearer sk-antigravity"
```

---

### 7. Reset Profile Cooldowns (`POST /v1/profiles/reset`)

Reset cooldowns for a single profile or all profiles:

```bash
curl -X POST http://127.0.0.1:8000/v1/profiles/reset \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{"profile": "attasitgits"}'
```

---

### 8. Active Quota Probing (`POST /v1/profiles/check`)

Trigger active lightweight health checks across all profiles:

```bash
curl -X POST http://127.0.0.1:8000/v1/profiles/check \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{"model": "gemini-3.7-flash"}'
```

---

### 9. Live Profile Reconfiguration (`POST /v1/profiles/config`)

Hot-reload active profile list on a live running bridge server without restarting:

```bash
curl -X POST http://127.0.0.1:8000/v1/profiles/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{"profiles": ["astrathezero", "attasitgits", "astramoney"]}'
```

---

### 10. Runtime Disable/Enable (`POST /v1/profiles/disable`, `POST /v1/profiles/enable`)

```bash
# Disable profile:
curl -X POST http://127.0.0.1:8000/v1/profiles/disable \
  -H "Content-Type: application/json" \
  -d '{"profile": "mrsermshop"}'

# Enable profile:
curl -X POST http://127.0.0.1:8000/v1/profiles/enable \
  -H "Content-Type: application/json" \
  -d '{"profile": "mrsermshop"}'
```

---

## ⚙️ Server CLI Options & Environment Variables

### Server Command-Line Arguments

Start the server using `python3 antigravity_bridge.py [OPTIONS]`:

| Flag | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`--host`** | `str` | `127.0.0.1` | Network interface to bind (`0.0.0.0` for all interfaces) |
| **`--port`** | `int` | `8000` | Port number to listen on |
| **`--cmd`** | `str` | *Auto-detected* | Custom command template (e.g. `'agy -p "{prompt}"'`) |
| **`--profiles`** | `str` | *Auto-detected* | Comma-separated list of profile names to rotate |
| **`--cooldown-sec`** | `float`| `300.0` | Base cooldown duration in seconds when quota error occurs |
| **`--profile-timeout`** | `float`| `60.0` | Timeout per profile execution attempt in seconds |
| **`--quota-cache`** | `str` | `~/.config/antigravity/quota_cache.json` | Path to persistent quota state JSON file |
| **`--check-profiles-on-start`** | `flag` | `False` | Actively probe all profiles on server startup |
| **`--api-key`** | `str` | `None` | API Key required for client authorization |
| **`--enable-cors`**, **`--cors`** | `flag` | `False` | Enable wildcard CORS headers (`*`) |
| **`--no-proxy`**, **`--direct`** | `flag` | `False` | Disable outbound proxy detection and connect directly |
| **`--hide-profile-status`** | `flag` | `False` | Hide profile and quota status footer from chat completions |
| **`--profile-concurrency`** | `int` | `1` | Max concurrent in-flight requests per profile (e.g. `2` for higher throughput) |
| **`--auto-refresh-min`** | `float`| `55.0` | Interval in minutes for background OAuth token refresh |
| **`--no-auto-refresh`** | `flag` | `False` | Disable background OAuth token refresh daemon |
| **`--image-router-url`** | `str` | *9router* | Custom image router URL |
| **`--image-router-key`** | `str` | `None` | Custom image router API Key |

### Environment Variables

| Variable | Description |
| :--- | :--- |
| **`ANTIGRAVITY_PROFILE_CONCURRENCY`** | Max concurrent in-flight requests per profile (default: `1`). |
| **`ANTIGRAVITY_PROFILES`** | Comma-separated profile names to rotate through. |
| **`ANTIGRAVITY_PROFILE`** | Active default profile name. |
| **`ANTIGRAVITY_BRIDGE_API_KEY`** | Default API key to protect bridge endpoints. |
| **`ANTIGRAVITY_BRIDGE_CMD`** | Custom CLI execution template. |
| **`ANTIGRAVITY_NO_PROXY`** | Set to `1` to disable proxy auto-detection. |
| **`ANTIGRAVITY_NO_AUTO_REFRESH`** | Set to `1` to disable scheduled OAuth token refresh. |
| **`ANTIGRAVITY_HIDE_PROFILE_STATUS`** | Set to `1` to hide the status footer from model responses. |
| **`GEMINI_API_KEY`** / **`GOOGLE_API_KEY`** | Google AI Studio API Key for Imagen 3 generation. |
| **`ANTIGRAVITY_IMAGE_ROUTER_URL`** | URL for external image generation router. |

---

## 🤖 Hermes Agent Integration (`config.yaml`)

To connect **Hermes Agent** or **Hermes Messaging Gateway** (Telegram, Discord, Slack, etc.) to this bridge server:

### 1. Add `agy-cli` to `~/.hermes/config.yaml`
```yaml
model:
  default: gemini-3.7-flash-high
  provider: agy-cli

custom_providers:
  agy-cli:
    api: http://127.0.0.1:8000/v1
    api_key: sk-antigravity
    name: AGY CLI Router
    models:
      gemini-3.7-flash-high:
        context_length: 1000000
      gemini-3.7-flash-medium:
        context_length: 1000000
      gemini-3.7-flash-low:
        context_length: 1000000
      gemini-3.7-flash:
        context_length: 1000000
      gemini-3.6-flash-high:
        context_length: 1000000
      gemini-3.6-flash-medium:
        context_length: 1000000
      gemini-3.6-flash-low:
        context_length: 1000000
      gemini-3.6-flash:
        context_length: 1000000
      gemini-3.5-flash-medium:
        context_length: 1000000
      gemini-3.5-flash-low:
        context_length: 1000000
      gemini-3.5-flash:
        context_length: 1000000
      gemini-3.1-pro-high:
        context_length: 1000000
      gemini-3.1-pro-low:
        context_length: 1000000
      gemini-3.1-pro:
        context_length: 1000000
      claude-sonnet-4.6-thinking:
        context_length: 1000000
      claude-sonnet-4.6:
        context_length: 1000000
      claude-opus-4.6-thinking:
        context_length: 1000000
      claude-opus-4.6:
        context_length: 1000000
      gpt-oss-120b-medium:
        context_length: 1000000
      gpt-oss-120b:
        context_length: 1000000
```

### 2. Platform Gateway Configuration (e.g. Telegram / Discord)
```yaml
platforms:
  telegram:
    enabled: true
    model: gemini-3.7-flash-high
    provider: agy-cli
```

---

## 💻 Client SDK Examples

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="sk-antigravity",
)

# 1. Chat Completion with Reasoning
completion = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[
        {"role": "user", "content": "Explain microservices vs monolith architecture."}
    ]
)
print(completion.choices[0].message.content)

# 2. Image Generation
image_resp = client.images.generate(
    model="imagen-3.0-generate-002",
    prompt="A cute cybernetic robot painter in an art studio, 8k render",
    size="1024x1024",
    response_format="b64_json"
)
import base64
with open("robot.jpg", "wb") as f:
    f.write(base64.b64decode(image_resp.data[0].b64_json))
```

---

### Python (Anthropic SDK)

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8000",
    api_key="sk-antigravity",
)

message = client.messages.create(
    model="claude-sonnet-4.6-thinking",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Analyze the time complexity of QuickSelect algorithm."}
    ]
)
print(message.content[0].text)
```

---

### JavaScript / TypeScript (OpenAI SDK)

```typescript
import OpenAI from 'openai';
import fs from 'fs';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:8000/v1',
  apiKey: 'sk-antigravity',
});

async function main() {
  // Chat Completion
  const chat = await openai.chat.completions.create({
    model: 'gemini-3.7-flash-high',
    messages: [{ role: 'user', content: 'Hello from TypeScript!' }],
  });
  console.log(chat.choices[0].message.content);

  // Image Generation
  const image = await openai.images.generate({
    model: 'imagen-3.0-generate-002',
    prompt: 'Futuristic floating sky city at dusk',
    size: '1024x1024',
    response_format: 'b64_json',
  });
  
  fs.writeFileSync('city.jpg', Buffer.from(image.data[0].b64_json, 'base64'));
}

main();
```

---

### cURL

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "gemini-3.7-flash-high",
    "messages": [{"role": "user", "content": "List 3 benefits of async Python."}]
  }'
```

---

## 🚀 Production Deployment

### 1. Deploy as Systemd Service (Linux)

1. Create `/etc/systemd/system/antigravity-bridge.service`:
   ```ini
   [Unit]
   Description=Antigravity API Bridge Server
   After=network.target

   [Service]
   Type=simple
   User=attasit
   WorkingDirectory=/home/attasit/antigravity-bridge
   ExecStart=/usr/bin/python3 /home/attasit/antigravity-bridge/antigravity_bridge.py --host 127.0.0.1 --port 8000 --profile-concurrency 1
   Restart=always
   RestartSec=5
   Environment=PYTHONUNBUFFERED=1

   [Install]
   WantedBy=multi-user.target
   ```

2. Enable and start service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable antigravity-bridge
   sudo systemctl start antigravity-bridge
   sudo systemctl status antigravity-bridge
   ```

---

### 2. Deploy with PM2

```bash
# Start bridge process
pm2 start antigravity_bridge.py --name "antigravity-bridge" --interpreter python3 -- --host 127.0.0.1 --port 8000 --profile-concurrency 1

# Save process list for system reboot
pm2 save
pm2 startup
```

---

### 3. Deploy with Nginx (Reverse Proxy + SSL)

```nginx
server {
    listen 80;
    server_name bridge.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Disable buffering for real-time SSE streaming
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

---

## 🔧 Troubleshooting & FAQ

### Q1: Copied a new profile to VPS, but `python3 antigravity_bridge.py profiles` doesn't show it?
- **Cause**: If `~/.config/antigravity/bridge_config.json` exists on the VPS, the bridge reads that locked list instead of scanning folders.
- **Fix**:
  ```bash
  # Delete the locked config to enable auto-detection of all profile folders:
  rm -f ~/.config/antigravity/bridge_config.json
  
  # Check profiles again:
  python3 antigravity_bridge.py profiles
  ```

### Q2: How do I test if a profile's Google OAuth token is still valid?
- **Fix**: Run the diagnostic doctor:
  ```bash
  python3 antigravity_bridge.py diag
  ```
  Or probe with a test request:
  ```bash
  python3 antigravity_bridge.py profile test <profile_name>
  ```

### Q3: How do I reset a profile that got stuck in cooldown?
- **Fix**:
  ```bash
  python3 antigravity_bridge.py profile reset <profile_name>
  # Or reset all:
  python3 antigravity_bridge.py profile reset
  ```

---

## 🧪 Running Unit Tests

The test suite thoroughly verifies all HTTP endpoints, streaming handlers, profile ordering algorithms, fallback routing, and CLI subcommand handlers:

```bash
python3 -m unittest test_antigravity_bridge.py -v
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
