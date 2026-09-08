# Headless Deployment with Docker & noVNC 🐳

Run **Antigravity Bridge** along with the **Web Extension** headlessly on a Linux server or VPS 24/7 without needing an open laptop.

## Architecture

```
Internet / Client
       │
       ▼ (SSH Tunnel or VPN)
┌─────────────────────────────────────────────────────────────┐
│ Docker Container: antigravity-bridge                        │
│                                                             │
│   noVNC (Port 6080) ──▶ websockify ──▶ x11vnc (:5900)       │
│                                            │                │
│                                            ▼                │
│                                        Xvfb (:99)           │
│                                            ▲                │
│   Chromium (with extension) ───────────────┤ (GUI Display)  │
│        ▲ (DOM / Web Stream)                │                │
│        │                                   │                │
│   gemini.google.com                        │                │
│        │                                   │                │
│   Antigravity Extension                    │                │
│        │ (SSE / Delta Events)              │                │
│        ▼                                   │                │
│   Bridge Server (Port 8000) ───────────────┘ (Supervisor)  │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Configure Environment (Optional)
If you want password protection on the noVNC web viewer:
```bash
cp .env.example .env
# Edit .env and set noVNC_PASSWORD
```

### 2. Build & Start the Container
From the `deploy/` directory:
```bash
docker compose up -d --build
```

### 3. Connect to noVNC Web Desktop
By default, ports are bound to `127.0.0.1` for security. Open an SSH tunnel from your local machine to the server:
```bash
ssh -L 6080:127.0.0.1:6080 -L 8000:127.0.0.1:8000 user@your-server-ip
```

Then open your browser to:
[http://127.0.0.1:6080](http://127.0.0.1:6080)

### 4. Log in to Gemini
Inside the noVNC desktop:
1. You will see Chromium running with Gemini (`https://gemini.google.com/app`).
2. Log in with your Google account.
3. The Antigravity Web Extension icon will detect your logged-in Google account email and automatically link to the corresponding bridge profile.
4. Keep the tab open. Chromium has background throttling disabled so it will stream continuously even when you close the VNC window.

### 5. Verify the Bridge
On your local machine or server:
```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/extension/status
```

Test prompt through web channel:
```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "antigravity",
    "channel": "web",
    "messages": [{"role": "user", "content": "Hello from headless Gemini Web!"}]
  }'
```

## Maintenance & Utilities

- **Restart browser without losing session**:
  ```bash
  ./reset.sh restart
  ```

- **View container logs**:
  ```bash
  ./reset.sh logs
  ```

- **Clean and reset Chrome profile (warning: clears cookies)**:
  ```bash
  ./reset.sh clean
  ```
