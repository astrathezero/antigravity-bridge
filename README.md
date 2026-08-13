# Antigravity Bridge Server

Standalone OpenAI-compatible REST API Bridge Server for `antigravity` / `agy` CLI.

## Overview
This standalone service acts as a local OpenAI REST API server (`http://127.0.0.1:8000/v1`) that translates standard OpenAI `/v1/chat/completions` API calls into local CLI execution (`antigravity` / `agy`).

### Features
- **OpenAI Compatible**: Implements `/v1/chat/completions`, `/v1/models`, and `/health`.
- **Multi-Profile Fallback**: Automatically discovers and rotates through `agy` login profiles (`~/.config/antigravity/profiles/`) when quota or rate limits occur.
- **Model & Reasoning Effort Support**: Exposes Gemini models and maps reasoning effort flags (`--model`, `--effort`) automatically.
- **Headless Non-Interactive Mode**: Uses `--dangerously-skip-permissions` to allow tool execution without TUI prompts.
- **Zero External Dependencies**: Built entirely on Python standard library (`http.server`, `subprocess`).

---

## Supported Models

| Model ID (`model`) | agy CLI Flags | Description |
| :--- | :--- | :--- |
| `gemini-3.6-flash-high` | `--model gemini-3.6-flash --effort high` | Gemini 3.6 Flash (High Reasoning) |
| `gemini-3.6-flash-medium` | `--model gemini-3.6-flash --effort medium` | Gemini 3.6 Flash (Medium Reasoning) |
| `gemini-3.6-flash-low` | `--model gemini-3.6-flash --effort low` | Gemini 3.6 Flash (Low Reasoning) |
| `gemini-3.6-flash` | `--model gemini-3.6-flash` | Gemini 3.6 Flash (Default) |
| `gemini-3.5-flash` | `--model gemini-3.5-flash` | Gemini 3.5 Flash |
| `gemini-3.1-pro` | `--model gemini-3.1-pro` | Gemini 3.1 Pro |
| `antigravity` / `agy` | *(default)* | Default CLI Model |

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
      gemini-3.6-flash:
        context_length: 1000000
      gemini-3.5-flash:
        context_length: 1000000
      gemini-3.1-pro:
        context_length: 1000000
      antigravity:
        context_length: 1000000
      agy:
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
