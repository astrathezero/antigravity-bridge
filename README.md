# Antigravity Bridge Server

Standalone OpenAI-compatible REST API Bridge Server for `antigravity` / `agy` CLI.

## Overview
This standalone service acts as a local OpenAI REST API server (`http://127.0.0.1:8000/v1`) that translates standard OpenAI `/v1/chat/completions` API calls into local CLI execution (`antigravity` / `agy`).

### Features
- **Dual API Format**: OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`).
- **Tool Calling & Function Calling**: Full support for OpenAI `tools` / `functions` and Anthropic `tools` parameter, parsing tool calls automatically.
- **Multi-Profile Fallback**: Automatically discovers and rotates through `agy` login profiles (`~/.config/antigravity/profiles/`) when quota or rate limits occur.
- **Model & Reasoning Effort Support**: Exposes Gemini models and maps reasoning effort flags (`--model`, `--effort`) automatically.
- **Streaming Support**: Real-time SSE streams (`text/event-stream`) for both OpenAI chunks and Anthropic events including tool calling deltas.
- **Headless Non-Interactive Mode**: Uses `--dangerously-skip-permissions` to allow tool execution without TUI prompts.
- **Zero External Dependencies**: Built entirely on Python standard library (`http.server`, `subprocess`).

---

## Supported Models

| Model ID (`model`) | agy CLI Flags | Description |
| :--- | :--- | :--- |
| `gemini-3.6-flash-high` | `--model gemini-3.6-flash --effort high` | Gemini 3.6 Flash (High Reasoning) |
| `gemini-3.6-flash-medium` | `--model gemini-3.6-flash --effort medium` | Gemini 3.6 Flash (Medium Reasoning) |
| `gemini-3.6-flash-low` | `--model gemini-3.6-flash --effort low` | Gemini 3.6 Flash (Low Reasoning) |
| `gemini-3.5-flash-medium` | `--model gemini-3.5-flash --effort medium` | Gemini 3.5 Flash (Medium Reasoning) |
| `gemini-3.5-flash-low` | `--model gemini-3.5-flash --effort low` | Gemini 3.5 Flash (Low Reasoning) |
| `gemini-3.5-flash` | `--model gemini-3.5-flash` | Gemini 3.5 Flash (Default) |
| `gemini-3.1-pro-high` | `--model gemini-3.1-pro --effort high` | Gemini 3.1 Pro (High Reasoning) |
| `gemini-3.1-pro-low` | `--model gemini-3.1-pro --effort low` | Gemini 3.1 Pro (Low Reasoning) |
| `gemini-3.1-pro` | `--model gemini-3.1-pro` | Gemini 3.1 Pro (Default) |
| `claude-sonnet-4.6-thinking` | `--model claude-sonnet-4.6` | Claude Sonnet 4.6 (Thinking) |
| `claude-opus-4.6-thinking` | `--model claude-opus-4.6` | Claude Opus 4.6 (Thinking) |
| `gpt-oss-120b-medium` | `--model gpt-oss-120b --effort medium` | GPT-OSS 120B (Medium Reasoning) |

---

## Hermes Configuration (`~/.hermes/config.yaml`)

To connect **Hermes Agent** or **Hermes Messaging Gateway** to this bridge service, add `agy-cli` under `custom_providers` (or `providers`) in `config.yaml`:

### 1. Provider & Models Configuration
```yaml
model:
  default: gemini-3.6-flash-high
  provider: agy-cli

custom_providers:
  agy-cli:
    api: http://127.0.0.1:8000/v1
    api_key: sk-antigravity
    name: AGY CLI Router
    models:
      gemini-3.6-flash-high:
        context_length: 1000000
      gemini-3.6-flash-medium:
        context_length: 1000000
      gemini-3.6-flash-low:
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
      claude-opus-4.6-thinking:
        context_length: 1000000
      gpt-oss-120b-medium:
        context_length: 1000000
```

### 2. Telegram / Messaging Platform Configuration
```yaml
platforms:
  telegram:
    enabled: true
    model: gemini-3.6-flash-high
    provider: agy-cli
```

---

## Quick Start

### 1. Run directly:
```bash
python3 antigravity_bridge.py --port 8000
```

### 2. Run with specified profile order:
```bash
python3 antigravity_bridge.py --port 8000 --profiles profile1,profile2,profile3
```

---

## Deploy as Systemd Service (Linux / Ubuntu)

To run the bridge continuously in the background and auto-start on boot:

1. Copy `antigravity-bridge.service` to `/etc/systemd/system/`:
   ```bash
   sudo cp antigravity-bridge.service /etc/systemd/system/
   ```

2. Reload systemd & enable service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable antigravity-bridge
   sudo systemctl start antigravity-bridge
   ```

3. Check service status & logs:
   ```bash
   sudo systemctl status antigravity-bridge
   journalctl -u antigravity-bridge -f
   ```

---

## Alternative: Run with PM2 or nohup

### Using PM2:
```bash
pm2 start antigravity_bridge.py --name "antigravity-bridge" -- interpreter python3 -- --port 8000
pm2 save
```

### Using nohup:
```bash
nohup python3 antigravity_bridge.py --port 8000 > bridge.log 2>&1 &
```

---

## Tool Calling / Function Calling Examples

### 1. OpenAI Python SDK Example
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-antigravity")

response = client.chat.completions.create(
    model="gemini-3.6-flash-high",
    messages=[{"role": "user", "content": "What's the weather in Tokyo?"}],
    tools=[
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get current weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "City name"}
                    },
                    "required": ["location"],
                },
            },
        }
    ],
    tool_choice="auto",
)

if response.choices[0].finish_reason == "tool_calls":
    for tool_call in response.choices[0].message.tool_calls:
        print(f"Function called: {tool_call.function.name}")
        print(f"Arguments: {tool_call.function.arguments}")
```

### 2. cURL Example
```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.6-flash-high",
    "messages": [{"role": "user", "content": "Check weather in Tokyo"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {
          "type": "object",
          "properties": {"location": {"type": "string"}}
        }
      }
    }]
  }'
```

