# Antigravity Bridge Server 🌉

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange.svg)](https://docs.anthropic.com/en/api/messages)
[![Imagen 3](https://img.shields.io/badge/Image-Google%20Imagen%203-purple.svg)](https://ai.google.dev/gemini-api/docs/imagen)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Standalone OpenAI & Anthropic compatible REST API Bridge Server for `antigravity` / `agy` CLI with Smart Profile Switching and Image Generation support.

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Supported Models Matrix](#-supported-models-matrix)
- [Profile Management Endpoints](#-profile-management-endpoints)
- [API Endpoints Reference](#-api-endpoints-reference)
  - [1. Health Check (`GET /health`)](#1-health-check-get-health)
  - [2. List Models (`GET /v1/models`)](#2-list-models-get-v1models)
  - [3. OpenAI Chat Completions (`POST /v1/chat/completions`)](#3-openai-chat-completions-post-v1chatcompletions)
  - [4. Anthropic Messages (`POST /v1/messages`)](#4-anthropic-messages-post-v1messages)
  - [5. Image Generation (`POST /v1/images/generations`)](#5-image-generation-post-v1imagesgenerations)
  - [6. Profile Management (`GET /v1/profiles`, `POST /v1/profiles/reset`, `POST /v1/profiles/check`)](#-profile-management-endpoints)
- [Hermes Agent Integration (`config.yaml`)](#-hermes-agent-integration-configyaml)
- [Client SDK Examples](#-client-sdk-examples)
  - [Python (OpenAI SDK)](#python-openai-sdk)
  - [Python (Anthropic SDK)](#python-anthropic-sdk)
  - [JavaScript / TypeScript (OpenAI SDK)](#javascript--typescript-openai-sdk)
- [CLI Options & Environment Variables](#-cli-options--environment-variables)
- [Production Deployment](#-production-deployment)
  - [Deploy as Systemd Service (Recommended)](#1-deploy-as-systemd-service-recommended)
  - [Deploy with PM2](#2-deploy-with-pm2)
  - [Deploy with Nginx (Reverse Proxy + SSL)](#3-deploy-with-nginx-reverse-proxy--ssl)
- [Running Unit Tests](#-running-unit-tests)
- [License](#-license)

---

## 🌟 Overview

The **Antigravity Bridge Server** bridges external AI clients (e.g. **Hermes Agent**, **OpenAI SDK**, **Anthropic SDK**, **LangChain**, **LlamaIndex**, webhooks, bots) to your local `antigravity` / `agy` CLI environment.

It exposes standard REST endpoints locally (`http://127.0.0.1:8000/v1`), seamlessly converting HTTP requests into headless `agy` CLI executions while providing automatic multi-profile rotation and circuit breaking to bypass quota and rate limits.

---

## ✨ Key Features

- 🔄 **Dual Format Compatibility**: Full support for both **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`) API specifications.
- 🛠️ **Tool Calling & Function Calling**: Full support for OpenAI `tools` / `functions` and Anthropic `tools` parameter, parsing tool calls automatically.
- ⚡ **Real-Time SSE Streaming**: Supports Server-Sent Events (`text/event-stream`) for both OpenAI and Anthropic streaming consumers.
- 🔀 **Smart Profile Manager & Automatic Quota Fallback**:
  - Automatically discovers and dynamically rotates through `agy` profiles (`~/.config/antigravity/profiles/`).
  - Detects `429 Too Many Requests`, `RESOURCE_EXHAUSTED`, and quota errors instantly.
  - Automatically enters cooldown for exhausted profiles and immediately routes incoming requests to available/healthy profiles (e.g. `attasitgits`).
  - Preserves quota health states across restarts via `~/.config/antigravity/quota_cache.json`.
- 🎨 **Image Generation Support**: Built-in `/v1/images/generations` and image model routing.
- 🧠 **Dynamic Reasoning Effort**: Maps model IDs to `--model` and `--effort` CLI parameters (`high`, `medium`, `low`) automatically.
- 🛡️ **Zero External Dependencies**: Built entirely with Python 3 standard library (`http.server`, `urllib.request`, `subprocess`). No `pip install` required!
- 🔒 **Security Hardening**: Built-in API Key authorization support, payload size limits (32MB), CLI argument sanitization, and environment isolation.

---

## 👥 Profile Management Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | `GET` | Server health, active healthy profile, and profile quota status summary |
| `/v1/profiles` | `GET` | List all profiles with availability, cooldown remaining, and success counts |
| `/v1/profiles/reset` | `POST` | Reset cooldowns (`{"profile": "optional_name"}`) |
| `/v1/profiles/check` | `POST` | Run active lightweight health probes across all profiles |

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

---

## 📡 API Endpoints Reference

### 1. Health Check (`GET /health`)

Check bridge server health and status.

```bash
curl http://127.0.0.1:8000/health
```

**Response (`200 OK`):**
```json
{
  "status": "ok",
  "service": "antigravity-bridge"
}
```

---

### 2. List Models (`GET /v1/models`)

Lists all supported models compatible with OpenAI client model discovery.

```bash
curl http://127.0.0.1:8000/v1/models
```

---

### 3. OpenAI Chat Completions (`POST /v1/chat/completions`)

Standard OpenAI Chat Completions API with optional SSE streaming (`"stream": true`).

#### Non-Streaming Example:
```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "gemini-3.6-flash-high",
    "messages": [
      {"role": "system", "content": "You are a senior systems architect."},
      {"role": "user", "content": "Explain raft consensus in 3 bullet points."}
    ],
    "stream": false
  }'
```

**Response (`200 OK`):**
```json
{
  "id": "chatcmpl-ag-7f9a2b1c",
  "object": "chat.completion",
  "created": 1755263810,
  "model": "gemini-3.6-flash-high",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "1. Leader Election...\n2. Log Replication...\n3. Safety Invariants..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 28,
    "completion_tokens": 85,
    "total_tokens": 113
  }
}
```

---

### 4. Anthropic Messages (`POST /v1/messages`)

Standard Anthropic Messages API format with top-level `system` prompt and SSE streaming support.

```bash
curl -X POST http://127.0.0.1:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-antigravity" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6-thinking",
    "system": "You are an expert Python engineer.",
    "messages": [
      {"role": "user", "content": "Write an asynchronous rate-limiter using token bucket algorithm."}
    ]
  }'
```

**Response (`200 OK`):**
```json
{
  "id": "msg-9e4a8b12",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4.6-thinking",
  "content": [
    {
      "type": "text",
      "text": "```python\nimport asyncio\nimport time\n\nclass TokenBucket:..."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 25,
    "output_tokens": 180
  }
}
```

---

### 5. Image Generation (`POST /v1/images/generations`)

Standard OpenAI Image Generation API format powered by **Google Imagen 3** (`imagen-3.0-generate-002`).

> [!TIP]
> **Why Google AI Studio Free API Key?**
> The local `agy` CLI is specialized for text, reasoning, and coding agent workflows and does not have a local image diffusion engine.
> Therefore, image generation is seamlessly powered by **Google AI Studio's Free API Key** via Google Imagen 3.
> 
> Simply get your free API key at [Google AI Studio](https://aistudio.google.com/) and save it to `.env`:
> ```bash
> echo "GEMINI_API_KEY=AIzaSyYourKeyHere" >> .env
> ```
> The bridge automatically discovers your key from `.env`, environment variables, or the client's `Authorization: Bearer <API_KEY>` header.

```bash
# Generate image via Bridge Server (uses GEMINI_API_KEY from .env or Bearer token)
curl -X POST http://127.0.0.1:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "imagen-3.0-generate-002",
    "prompt": "A cinematic shot of a futuristic neon cyberpunk metropolis at dusk, photorealistic, 8k",
    "size": "1024x1024",
    "n": 1
  }'
```

#### Supported Image Sizes & Aspect Ratios:
- `"1024x1024"` or `"1:1"` → Square (1:1)
- `"1792x1024"` or `"16:9"` → Landscape Wide (16:9)
- `"1024x1792"` or `"9:16"` → Portrait Mobile / Story (9:16)
- `"1024x768"` or `"4:3"` → Landscape Standard (4:3)
- `"768x1024"` or `"3:4"` → Portrait Standard (3:4)

**Response (`200 OK`):**
```json
{
  "created": 1755263810,
  "data": [
    {
      "b64_json": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...",
      "revised_prompt": "A cinematic shot of a futuristic neon cyberpunk metropolis at dusk, photorealistic, 8k"
    }
  ]
}
```


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
    model: gemini-3.6-flash-high
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

# 1. Chat Completion
completion = client.chat.completions.create(
    model="gemini-3.6-flash-high",
    messages=[
        {"role": "user", "content": "Explain microservices vs monoliths"}
    ]
)
print(completion.choices[0].message.content)

# 2. Image Generation
image_resp = client.images.generate(
    model="imagen-3.0-generate-002",
    prompt="A cute robot painter working on a canvas in an art gallery",
    size="1024x1024",
    response_format="b64_json"
)
import base64
with open("robot_painter.jpg", "wb") as f:
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
        {"role": "user", "content": "Analyze the time complexity of QuickSelect"}
    ]
)
print(message.content[0].text)
```

---

### JavaScript / TypeScript (OpenAI SDK)

```javascript
import OpenAI from 'openai';
import fs from 'fs';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:8000/v1',
  apiKey: 'sk-antigravity',
});

async function main() {
  // Chat Completion
  const chat = await openai.chat.completions.create({
    model: 'gemini-3.6-flash-high',
    messages: [{ role: 'user', content: 'Say hello from Antigravity Bridge!' }],
  });
  console.log(chat.choices[0].message.content);

  // Image Generation
  const image = await openai.images.generate({
    model: 'imagen-3.0-generate-002',
    prompt: 'A futuristic floating city in the clouds at sunrise',
    size: '1024x1024',
    response_format: 'b64_json',
  });
  
  const buffer = Buffer.from(image.data[0].b64_json, 'base64');
  fs.writeFileSync('floating_city.jpg', buffer);
}

main();
```

---

## ⚙️ CLI Options & Environment Variables

### Command Line Flags

| Flag | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`--host`** | `str` | `127.0.0.1` | Network interface to bind (`0.0.0.0` to allow external connections) |
| **`--port`** | `int` | `8000` | Port number to listen on |
| **`--cmd`** | `str` | *Auto-detected* | Custom command template (e.g. `'agy -p "{prompt}"'`) |
| **`--profiles`** | `str` | *Auto-detected* | Comma-separated list of profile names to rotate on rate limits |
| **`--api-key`** | `str` | `None` | Optional API Key to require for client authentication |
| **`--enable-cors`**| `bool`| `False` | Enable wildcard CORS headers (`Access-Control-Allow-Origin: *`) |

### Environment Variables

| Variable | Description |
| :--- | :--- |
| **`GEMINI_API_KEY`** / **`gemini_api_key`** / **`GOOGLE_API_KEY`** | Google AI Studio Free API Key for Imagen 3 image generation. [Get Key Here](https://aistudio.google.com/) |
| **`ANTIGRAVITY_PROFILES`** | Comma-separated list of `agy` profile directory names to rotate through. |
| **`ANTIGRAVITY_PROFILE`** | Active default profile name. |
| **`ANTIGRAVITY_BRIDGE_API_KEY`** | Default API key to protect bridge endpoints. |
| **`ANTIGRAVITY_BRIDGE_CMD`** | Custom CLI execution template. |

---

## 🚀 Production Deployment

### 1. Deploy as Systemd Service (Recommended)

1. **Edit and copy the service file:**
   ```bash
   sudo cp antigravity-bridge.service /etc/systemd/system/
   ```

2. **Reload daemon, enable, and start service:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable antigravity-bridge
   sudo systemctl start antigravity-bridge
   ```

3. **Check status & live logs:**
   ```bash
   sudo systemctl status antigravity-bridge
   journalctl -u antigravity-bridge -f
   ```

---

### 2. Deploy with PM2

```bash
# Start bridge with PM2
pm2 start antigravity_bridge.py --name "antigravity-bridge" --interpreter python3 -- --host 0.0.0.0 --port 8000

# Save PM2 process list to auto-start on boot
pm2 save
pm2 startup
```

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
        proxy_cache_bypass $http_upgrade;

        # Disable buffering for SSE streaming
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

---

## 🧪 Running Unit Tests

The test suite exercises all API endpoints (`/health`, `/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/images/generations`), profile rotations, CLI template parsers, and error cases:

```bash
python3 -m unittest test_antigravity_bridge.py -v
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
