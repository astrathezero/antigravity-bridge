# Antigravity Bridge — Web Extension Channel ("Web Extension Edition")
## เอกสารสำรองการออกแบบสำหรับนำกลับมาทำใหม่ (Design Backup / Re-implementation Guide)

| รายการ | ค่า |
| --- | --- |
| สถานะ | **ยกเลิก (abandoned)** — branch ถูกลบจาก GitHub เมื่อ 2026-09-15, มี backup ครบ (ดูหัวข้อ 8) |
| Branch ล่าสุด (แหล่งอ้างอิงหลักของเอกสารนี้) | `fix/web-channel-no-response` @ `fb3898e` — "fix(web): return real answers on reasoning prompts and sanitize configuration" (2026-09-15 11:40 +07) |
| Branch ก่อนหน้า | `feat/web-extension-bridge` @ `2fdbf3c` — "feat: Antigravity Bridge - Web Extension Edition" (2026-09-15 11:35 +07) |
| ความสัมพันธ์ของ commit | ทั้งสอง commit เป็น **root commit ที่ไม่มี parent** (squashed) และ **ไม่มี merge-base กับ `main`** (`git merge-base main backup/fix-web-channel-no-response` คืน exit 1) — ต้องเปรียบเทียบด้วย `git diff <A> <B>` เท่านั้น |
| ไฟล์ที่มีเฉพาะใน branch นี้ | `bridge_config.json`, `deploy/{.env.example,Dockerfile,README.md,docker-compose.yml,machine-id,policies.json,reset.sh,start-browser.sh,start-vnc.sh,supervisord.conf,test-docker.sh}`, `extension/{manifest.json,background.js,content.js,page.js,offscreen.html,offscreen.js,popup.html,popup.js,icons/icon{16,48,128}.png}`, `test_bridge.py` |
| ไฟล์ที่ถูกแก้มาก | `antigravity_bridge.py` (~7,129 บรรทัดใน FIX; `git diff --stat main backup/fix-web-channel-no-response -- antigravity_bridge.py` = 1,343 (+) / 847 (−)), `README.md`, `README.th.md`, `test_antigravity_bridge.py` |
| `main` ปัจจุบัน | ไม่มีโค้ด web channel เลย (`grep -c "WebClientManager\|extension/events\|execute_web_command"` บน `main:antigravity_bridge.py` = 0) |

> **ข้อควรระวังในการอ่าน:** ทุกข้อความในเอกสารนี้ตรวจกับโค้ดจริงใน worktree ของ `fb3898e` แล้ว เว้นแต่จะระบุว่า "ยังไม่ได้ตรวจสอบ/อนุมาน" อย่างชัดเจน (รวบรวมไว้ในหัวข้อ 9) อีเมล/คีย์ทั้งหมดในเอกสารนี้เป็น placeholder

---

## 0. Abstract (English)

The "Web Extension Edition" of Antigravity Bridge added a **second execution channel** ("web channel") next to the existing `agy` CLI channel. Instead of spawning the `agy` CLI with a Google OAuth profile, the bridge could hand a prompt to a **Chrome Manifest‑V3 extension** running inside a Chromium that is logged into the Gemini web app (`https://gemini.google.com`), one browser tab per Google account (`/app`, `/u/1/app`, `/u/2/app`, …). The extension's background service worker keeps one **Server‑Sent Events (SSE)** stream per bridge *profile* open against `GET /extension/events?profile=<name>&email=<account>`; the bridge pushes `event: job` messages down that stream, the extension injects a page‑world script (`page.js`) that types the prompt into the Gemini composer, clicks Send, observes the response DOM with a `MutationObserver`, streams text deltas back with `POST /extension/delta`, and finishes with `POST /extension/done` (or `POST /extension/error`). The bridge then wraps the text as a normal OpenAI `/v1/chat/completions` or Anthropic `/v1/messages` response. Routing between CLI and web is governed by `ANTIGRAVITY_WEB_PRIORITY` / `bridge_config.json:web_priority`, per‑profile channel flags, the requested `channel` (`auto|cli|web`) and the model name. A `deploy/` directory ships a Docker image (Xvfb + fluxbox + x11vnc + noVNC/websockify + supervisord + Chromium with `--load-extension`) so the whole thing can run 24/7 on a headless server, with a human logging into each Google account once through noVNC. The motivation was **quota isolation**: the web UI has its own, independent quota per Google account, so it served as Tier‑3 fallback when both Gemini and Claude quotas on the CLI were exhausted, or as the primary channel when `web_priority` was on. The approach was abandoned because of fragility (Gemini DOM drift, reasoning prompts returning only a "thinking" placeholder, tab/profile mis‑mapping, MV3 worker eviction); the last commit `fb3898e` fixed the most severe of these. This document records the design in enough detail to re‑implement it from scratch. **Note:** despite the README's wording, the transport is SSE + HTTP POST, *not* WebSocket.

---

## 1. บทคัดย่อ (ภาษาไทย)

### 1.1 Web channel คืออะไร
Antigravity Bridge ตัวปกติ (branch `main`) เป็น HTTP server ที่รับ request รูปแบบ OpenAI (`POST /v1/chat/completions`) และ Anthropic (`POST /v1/messages`) แล้วไปเรียก CLI `agy` (Google Antigravity) ด้วย Google OAuth profile ของผู้ใช้ ("CLI channel") ใน branch นี้ได้เพิ่ม **ช่องทางที่สอง** คือ **Web channel**: ส่ง prompt ไปยัง **Chrome extension** ที่โหลดอยู่ใน Chromium ซึ่ง login เว็บ Gemini (`gemini.google.com`) ไว้แล้ว โดยเปิด **หนึ่ง tab ต่อหนึ่งบัญชี Google** (ใช้ Google multi‑login: `/app` = บัญชี index 0, `/u/1/app` = index 1, …) extension จะพิมพ์ prompt ลงในกล่องข้อความของหน้าเว็บ, กด Send, อ่านคำตอบจาก DOM แล้วส่งกลับมาให้ bridge ผ่าน HTTP

### 1.2 ทำไมถึงมี
1. **แยกโควตา/rate‑limit ต่อบัญชี** — โควตาของเว็บ Gemini เป็นคนละก้อนกับโควตาของ CLI `agy` ดังนั้นเมื่อ profile หนึ่งโดน cooldown ทั้ง Gemini และ Claude บน CLI แล้ว ยังสามารถใช้บัญชีเดียวกันผ่านเว็บได้ (Tier‑3 fallback) หรือใช้เว็บเป็นช่องทางหลักไปเลย (`web_priority`)
2. **ใช้ความสามารถ/โมเดลของเว็บ** — เช่น "3.8 Flash Thinking" ผ่าน model picker ของหน้าเว็บ และ Canvas mode
3. **รันบนเซิร์ฟเวอร์ headless ได้** — ผ่าน Docker + noVNC โดยมนุษย์ login บัญชี Google ครั้งเดียว cookie ถูกเก็บใน volume

### 1.3 สถานะ
- ถูกยกเลิก; branch `feat/web-extension-bridge` และ `fix/web-channel-no-response` ถูกลบจาก remote แล้ว
- มี backup 3 รูปแบบ (git bundle, tar.gz ของทั้งสอง tree, และ local branch `backup/*`) — ดูหัวข้อ 8
- `main` ปัจจุบันเป็น CLI‑only (มี Python edition และ Node.js edition) และไม่มีโค้ดส่วนนี้เลย

### 1.4 สรุปกลไกใน 6 บรรทัด
1. extension (background service worker) เปิด SSE ค้างไว้: `GET http://127.0.0.1:8000/extension/events?profile=<profile>&email=<email>` หนึ่งสายต่อหนึ่ง profile
2. bridge ลงทะเบียน `WebClient` ให้ profile นั้น; เมื่อมี request เข้ามาและ router เลือก web จะ push `event: job` ลงสายนั้น
3. background.js เลือก tab ของบัญชีที่ตรงกับ profile → ส่ง `EXECUTE_JOB` ให้ `content.js` → `content.js` โยนต่อให้ `page.js` (main world) ด้วย `window.postMessage`
4. `page.js` เปิดแชทใหม่, เลือกโมเดล, พิมพ์ prompt, กด Send, เฝ้า DOM ของคำตอบ, ส่ง `AG_JOB_DELTA`/`AG_JOB_DONE`/`AG_JOB_ERROR` กลับ
5. background.js แปลงเป็น `POST /extension/delta|done|error` ไปที่ bridge; bridge เติมลง `WebJob.delta_queue` แล้ว `execute_web_command()` รวมข้อความคืนให้ handler
6. handler ห่อเป็น response OpenAI/Anthropic ตามปกติ (พร้อม header `X-Antigravity-Active-Profile`, `X-Antigravity-Effective-Model`)

---

## 2. สถาปัตยกรรม

### 2.1 แผนภาพการไหลของข้อมูล

```
 AI client (Hermes / Cursor / Claude Code / curl)
   │  POST /v1/chat/completions  {model, messages, channel:"auto|cli|web", profile?, stream?}
   │  POST /v1/messages          (Anthropic format)
   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ antigravity_bridge.py  (ThreadedHTTPServer, 1 thread / connection)  :8000                │
│                                                                                          │
│  AntigravityBridgeHandler.do_POST                                                        │
│    └─ execute_cli_with_fallback(channel=req_channel, model_name=model, ...)              │
│         ├─ ProfileManager.get_ordered_profiles(model, channel)  ← web_priority, flags    │
│         ├─ [use_web?] ──► execute_web_command(prompt, profile, model, timeout)            │
│         │                    └─ GLOBAL_WEB_CLIENT_MANAGER.dispatch_job(WebJob)           │
│         │                          └─ WebClient.queue.put({"event":"job","data":{...}})  │
│         └─ [else]     ──► execute_cli_command(...)  (agy CLI, เหมือน main)               │
│                                                                                          │
│  do_GET /extension/events?profile=&email=  ──► SSE stream (event: connected / job)       │
│  do_POST /extension/delta | /extension/done | /extension/error | /extension/debug        │
│  do_GET /extension/status , /v1/profiles , /health                                       │
└───────────────▲──────────────────────────────────────────────┬───────────────────────────┘
                │ HTTP POST (JSON)                              │ SSE (text/event-stream)
                │ delta/done/error/debug                        ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Chromium (--load-extension=/app/extension, --user-data-dir=/app/chrome-data)             │
│                                                                                          │
│  background.js (MV3 service worker)                                                      │
│    • profileConnections: Map<profile, {controller, clientId, isConnected, ...}>           │
│    • openGeminiTabs:     Map<tabId,  {url, email, profile}>                              │
│    • emailByAccountIndex: Map<N, email>   (เรียนรู้จาก /u/N/ ของแต่ละ tab)               │
│    • fetch() SSE ต่อ profile, cycle ทุก 4 นาที, reconnect ทุก 3 วิ, scan tabs ทุก 10/15 วิ │
│    • handleJobEvent(job) → เลือก tab → chrome.tabs.sendMessage(tabId, {type:'EXECUTE_JOB'}) │
│         │                                                                                │
│         ▼ chrome.runtime messaging                                                       │
│  content.js (isolated world บน https://gemini.google.com/*)                              │
│    • inject <script src=chrome-extension://.../page.js> เข้า main world                  │
│    • relay: EXECUTE_JOB ⇄ AG_EXECUTE_JOB ; AG_JOB_* ⇄ JOB_* ; AG_DETECTED_EMAIL ⇄ DETECTED_EMAIL │
│         │                                                                                │
│         ▼ window.postMessage                                                             │
│  page.js (main world ของหน้า Gemini)                                                     │
│    • detectAccountEmail()  → AG_DETECTED_EMAIL ทุก 3 วิ                                   │
│    • executeJob(job): ensureFreshChatIfNeeded → ensureCanvasMode → selectBestModel        │
│        → findInputElement + execCommand('insertText') → findSendButton().click()          │
│        → รอ response container ≤45 วิ → MutationObserver + poll 400ms                     │
│        → extractCleanText() (แยก <think>…</think>, ตัดปุ่ม/toolbar, ต่อ Canvas content)   │
│        → AG_JOB_DELTA (high‑water‑mark diff) … → AG_JOB_DONE {text, finishReason}         │
│                                                                                          │
│  offscreen.html/offscreen.js  (keepalive ป้องกัน MV3 worker ถูก evict)                    │
│  popup.html/popup.js          (ตั้งค่า bridge URL, profile override, model, canvas)       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                     ▲ noVNC :6080 → websockify → x11vnc :5900 → Xvfb :99 (มนุษย์ login Google)
```

### 2.2 ตาราง endpoint / port ที่ใช้จริง

| ฝั่ง | Method + Path (alias) | ใคร → ใคร | หน้าที่ |
| --- | --- | --- | --- |
| bridge | `GET /extension/events` (alias `/api/web/events`, `/events`) | extension → bridge | เปิด SSE stream 1 สาย/profile; query `profile`, `email` |
| bridge | `POST /extension/delta` (`/api/web/delta`) | extension → bridge | ส่ง text delta ของ job |
| bridge | `POST /extension/done` (`/api/web/done`) | extension → bridge | job เสร็จ พร้อมข้อความสุดท้ายที่อ่านจากหน้า |
| bridge | `POST /extension/error` (`/api/web/error`) | extension → bridge | job ล้มเหลว |
| bridge | `POST /extension/debug` (`/api/web/debug`) | extension → bridge | log JSON อะไรก็ได้ (`[EXTENSION DEBUG] ...`) |
| bridge | `GET /extension/status` (`/api/web/status`) | ใครก็ได้ | สรุป client ที่ต่ออยู่ |
| bridge | `GET /v1/profiles` (`/profiles`) | extension/popup/CLI | รายชื่อ profile + `account_email`, `cli_enabled`, `web_enabled`, `web_connected` |
| bridge | `POST /v1/profiles/toggle` (`/profiles/toggle`) | popup/ผู้ดูแล | `{"profile","channel":"cli\|web\|all","enabled":bool}` |
| bridge | `POST /v1/profiles/disable`, `/v1/profiles/enable` | CLI `profile disable/enable --channel` | body `{"profile","channel"}` |
| bridge | `GET /health` | ทุกคน / `start-browser.sh` รอจนตอบ | สถานะ + `profiles{...web_connected...}` |
| bridge | `POST /v1/chat/completions`, `POST /v1/messages` | AI client | request ปกติ + field `channel` |
| Chromium | `http://127.0.0.1:9222/json/{version,list,new,close/<id>}` | `start-browser.sh`, `test-docker.sh` | CDP remote debugging สำหรับนับ/ปิด/เปิด tab |
| container | `:8000` bridge (host map `127.0.0.1:${BRIDGE_PORT}`), `:6080` noVNC (host map `127.0.0.1:${NOVNC_PORT}`), `:5900` x11vnc (loopback ใน container), `:9222` CDP (loopback ใน container) | — | — |

**การยืนยันตัวตน:** ถ้าตั้ง `ANTIGRAVITY_BRIDGE_API_KEY(S)` ไว้ endpoint ทั่วไปต้องมี Bearer/x‑api‑key แต่ **endpoint ของ extension ได้รับการยกเว้นเมื่อ client มาจาก loopback** (`127.0.0.1`, `::1`, `localhost`): ใน `do_POST` ยกเว้น `/extension/delta|done|error|debug` (มีตั้งแต่ FEAT); ใน `do_GET` ยกเว้น `/extension/events`, `/extension/status`, `/v1/profiles` (เพิ่มใน FIX เพราะ FEAT จะ 401 SSE stream ทันทีที่เปิด API key ทำให้ไม่มี web client ลงทะเบียนเลย)

### 2.3 โปรโตคอลระหว่าง bridge ↔ extension (รูปแบบ JSON จริงจากโค้ด)

**Downlink (SSE, bridge → extension)** — `do_GET` เขียน header:
```
HTTP/1.0 200
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
Access-Control-Allow-Origin: *
```
แล้วส่ง event แรกทันที (`register_client` เรียกก่อนหน้านี้แล้ว):
```
event: connected
data: {"status": "connected", "clientId": "web_1a2b3c4d", "profile": "profile_beta", "email": "user2@example.com"}

```
จากนั้นวนลูป `client.queue.get(timeout=10.0)`:
- ได้ `{"event":"job","data":{...}}` → เขียน
  ```
  event: job
  data: {"jobId": "webjob_0123456789", "profile": "profile_beta", "prompt": "<prompt ทั้งก้อน>", "model": "gemini-3.8-flash-thinking", "stream": false, "timeout": 600.0}

  ```
  (`jobId` = `f"webjob_{uuid4().hex[:10]}"`; `stream` = `output_callback is not None` ซึ่งใน handler จริง **เป็น False เสมอ** ดู 3.8; `timeout` = attempt timeout เป็นวินาที)
- ได้ `{"event":"close"}` → break ออกจากลูป (ใช้ตอน retire client เก่า)
- `queue.Empty` (ไม่มีอะไร 10 วิ) → เขียน comment `: keepalive\n\n` (extension ใช้เป็น heartbeat: เงียบเกิน `HEARTBEAT_STALE_MS`=60 วิ ถือว่าตาย)
- เมื่อ write ล้มเหลว (BrokenPipe ฯลฯ) ขณะกำลังส่ง `job` → พยายาม re‑dispatch ไป client อื่นของ profile เดียวกัน ไม่งั้น set `job.error = "Client socket error sending job: ..."`
- `finally: GLOBAL_WEB_CLIENT_MANAGER.unregister_client(client.client_id)`

**Uplink (HTTP POST JSON, extension → bridge)** — bridge รับได้ทั้ง `jobId` และ `job_id`:

| Path | Body ที่ extension ส่งจริง (background.js) | ฝั่ง bridge อ่าน | ตอบ |
| --- | --- | --- | --- |
| `/extension/delta` | `{"job_id": "...", "delta": "..."}` | `handle_delta(job_id, delta)` | `{"status":"ok"}` หรือ `{"status":"unknown_job"}` |
| `/extension/done` | `{"job_id": "...", "text": "...", "finish_reason": "stop"}` | `handle_done(job_id, text)` (`text` หรือ `output`; `finish_reason` ไม่ถูกใช้) | เหมือนกัน |
| `/extension/error` | `{"job_id": "...", "error": "..."}` | `handle_error(job_id, error)` (default `"Unknown browser error"`) | เหมือนกัน |
| `/extension/debug` | object อะไรก็ได้ (`message.debug`) | `logger.info("[EXTENSION DEBUG] %s", ...)` | `{"status":"ok"}` |

**สิ่งที่ extension ดึงจาก bridge เพิ่มเติม:** `GET /v1/profiles` (ทุก 60 วิ หรือเมื่อ resolve profile ไม่ได้) และ popup ยิง `POST /v1/profiles/toggle`

### 2.4 ชื่อ message ภายใน extension

| ช่อง | ชื่อ message | payload |
| --- | --- | --- |
| page.js → content.js (`window.postMessage`) | `AG_PAGE_READY` | `{email}` |
| | `AG_DETECTED_EMAIL` | `{email}` |
| | `AG_JOB_DELTA` | `{jobId, delta}` |
| | `AG_JOB_DONE` | `{jobId, text, finishReason:'stop'}` |
| | `AG_JOB_ERROR` | `{jobId, error}` |
| | `AG_DEBUG` | `{debug}` (ไม่มีจุดส่งจริงใน page.js เวอร์ชันนี้ แต่ content.js รองรับ) |
| content.js → page.js | `AG_EXECUTE_JOB` | `{job}` (job = data ของ SSE event หลัง background เติม `model`/`canvas`) |
| | `AG_CHECK_EMAIL` | — |
| content.js → background.js (`chrome.runtime.sendMessage`) | `DETECTED_EMAIL` | `{email}` |
| | `JOB_DELTA` / `JOB_DONE` / `JOB_ERROR` / `DEBUG` | `{jobId, delta}` / `{jobId, text, finishReason}` / `{jobId, error}` / `{debug}` |
| | `content-ping` | — (keepalive; ตอบ `{ok:true, awake:true, timestamp}`) |
| content.js → background.js (port `gemini-tab`) | `content-heartbeat` | `{time}` ทุก 10 วิ |
| offscreen.js → background.js | port `offscreen-keepalive` + `offscreen-heartbeat`, `sendMessage {type:'offscreen-ping'}` | ทุก 10 วิ |
| background.js → content.js (`chrome.tabs.sendMessage`) | `EXECUTE_JOB` | `{job}` → ตอบ `{status:'dispatched'}` |
| | `CHECK_EMAIL` | — → ตอบ `{status:'checking'}` |
| popup.js → background.js | `GET_STATUS` | → `{connected, connectedProfiles:[{name,email}], activeSessions:[{tabId,url,email,profile,connected}], bridgeUrl, assignedProfile, webEnabled, canvasMode, preferredWebModel}` |
| | `SET_CONFIG` | `{bridgeUrl, assignedProfile, webEnabled, canvasMode, preferredWebModel}` → `{success:true}` |
| | `RECONNECT` | → `{status:'reconnecting'}` |

### 2.5 Sequence diagram (หนึ่ง request ผ่าน web channel)

```mermaid
sequenceDiagram
    participant C as AI client
    participant B as bridge (do_POST)
    participant M as WebClientManager
    participant BG as background.js
    participant CS as content.js
    participant PG as page.js (Gemini DOM)

    Note over BG,B: ก่อนหน้า: BG เปิด GET /extension/events?profile=P&email=E ค้างไว้ (event: connected → clientId)
    C->>B: POST /v1/chat/completions {channel:"auto"|"web", model}
    B->>B: execute_cli_with_fallback → use_web=True
    B->>M: execute_web_command → dispatch_job(WebJob)
    M-->>BG: SSE  event: job {jobId, profile, prompt, model, stream, timeout}
    BG->>BG: handleJobEvent: เลือก tab ของ profile/email (หรือเปิด tab ใหม่)
    BG->>CS: chrome.scripting.executeScript(content.js) + sendMessage EXECUTE_JOB (retry 3x)
    CS->>PG: window.postMessage AG_EXECUTE_JOB {job}
    PG->>PG: ensureFreshChatIfNeeded → ensureCanvasMode → selectBestModel → พิมพ์ prompt → click Send
    loop MutationObserver + poll 400ms
        PG->>CS: AG_JOB_DELTA {jobId, delta}
        CS->>BG: JOB_DELTA
        BG->>B: POST /extension/delta {job_id, delta}
        B->>M: handle_delta → job.delta_queue.put(delta)
    end
    PG->>CS: AG_JOB_DONE {jobId, text}
    CS->>BG: JOB_DONE
    BG->>B: POST /extension/done {job_id, text, finish_reason}
    B->>M: handle_done → final_output = longer(streamed, text); delta_queue.put(None)
    M-->>B: execute_web_command คืน CLIExecutionResult(text, profile, model, channel="web")
    B-->>C: 200 JSON / SSE chunk เดียว + quota banner + X-Antigravity-* headers
```

---

## 3. ฝั่ง Bridge (`antigravity_bridge.py` ใน branch)

### 3.1 การตั้งค่า: `bridge_config.json`, env vars

**ตำแหน่งไฟล์ — `get_bridge_config_path()`** (ลำดับ):
1. env `ANTIGRAVITY_BRIDGE_CONFIG` (ถ้าไฟล์มีอยู่)
2. `/app/bridge_config.json` (Docker bind mount)
3. `./bridge_config.json` (cwd)
4. `<canonical>/bridge_config.json` โดย `get_canonical_antigravity_dir()` = `~/.config/antigravity` (ตัด path `.../sandboxes/...` ออก)

**ตัวอย่างจริงในไฟล์ `bridge_config.json` ของ branch** (อีเมลเป็น placeholder ตั้งแต่ต้น):
```json
{
  "profiles": {
    "default":       { "account_email": "user1@example.com", "cli_enabled": true, "web_enabled": true },
    "profile_beta":  { "account_email": "user2@example.com", "cli_enabled": true, "web_enabled": true },
    "profile_gamma": { "account_email": "user3@example.com", "cli_enabled": true, "web_enabled": true }
  },
  "profile_emails": {
    "user1@example.com": "default",
    "user2@example.com": "profile_beta",
    "user3@example.com": "profile_gamma"
  },
  "web_priority": true
}
```

**Schema ที่โค้ดอ่านจริง** (สำคัญ: ไม่ตรงกับ key ในตัวอย่างทั้งหมด):

| key | ใช้โดย | ความหมาย |
| --- | --- | --- |
| `profiles` (dict หรือ list) | `get_available_profiles()` | รายชื่อ profile (dict → ใช้ keys) — ถ้ามี key นี้ bridge จะ **ไม่สแกน** `~/.config/antigravity/profiles/` |
| `profiles.<name>.account_email` หรือ `.email` | `get_profile_account_email()`, `find_profile_by_email()` | อีเมล Google ของ profile — ใช้จับคู่ tab ↔ profile |
| `profiles.<name>.cli` / `.web` / `.disabled` (boolean) | `get_cli_disabled_profiles()`, `get_web_disabled_profiles()`, `get_disabled_profiles()` | **key ที่ใช้ปิดช่องทางจริงคือ `cli:false` / `web:false` / `disabled:true`** — ส่วน `cli_enabled` / `web_enabled` ในตัวอย่างข้างบน **ไม่ถูกอ่าน** (เป็นแค่ชื่อ field ที่ `/v1/profiles` ตอบกลับ) การเขียน `"web_enabled": false` จึง *ไม่* ปิด web channel |
| `profile_emails` (dict email→profile) | `find_profile_by_email()` (ตรวจก่อน `profiles.*.account_email`), `get_profile_account_email()` (reverse lookup) | ตารางจับคู่อีเมล → profile |
| `web_priority` (bool) | `is_web_priority_enabled()` | ให้ web มาก่อน CLI ใน `channel:"auto"` (env `ANTIGRAVITY_WEB_PRIORITY` ชนะถ้าตั้ง) |
| `disabled_profiles` / `disabled`, `cli_disabled_profiles`, `web_disabled_profiles` (list หรือ comma string) | ฟังก์ชัน `get_*_disabled_profiles()` | รายชื่อที่ถูกปิด; `persist_channel_profile_state()` เขียน 3 list นี้ + `profiles.<name>.{cli,web,disabled}` |

**Env vars ที่เกี่ยวกับ web channel** (ทั้งหมดที่พบใน FIX):

| ตัวแปร | ค่า default | ผล |
| --- | --- | --- |
| `ANTIGRAVITY_WEB_PRIORITY` | ไม่ตั้ง → ใช้ `web_priority` ในไฟล์ → `False` | `1/true/yes` = web ก่อน CLI ใน auto; `0/false/no` = บังคับปิด priority |
| `ANTIGRAVITY_WEB_FALLBACK_MODEL` | `gemini-3.8-flash-thinking` | `DEFAULT_WEB_FALLBACK_MODEL` — โมเดลที่ส่งให้ extension เวลา fallback/safety‑net |
| `ANTIGRAVITY_WEB_DISABLED_PROFILES` | ว่าง | comma list ปิด web ต่อ profile |
| `ANTIGRAVITY_CLI_DISABLED_PROFILES`, `ANTIGRAVITY_DISABLED_PROFILES` | ว่าง | คู่กันฝั่ง CLI/ทั้งหมด |
| `ANTIGRAVITY_BRIDGE_CONFIG` | ว่าง | path ของ `bridge_config.json` |
| `ANTIGRAVITY_PROFILE_TIMEOUT` | `600.0` | `DEFAULT_PROFILE_TIMEOUT` = timeout ต่อ attempt (ส่งต่อไปเป็น `job.timeout`) |
| `ANTIGRAVITY_TOTAL_TIMEOUT` | `1800.0` | งบรวมทุก fallback |
| `ANTIGRAVITY_STALL_TIMEOUT` | `75.0` | ใช้กับ CLI เท่านั้น |
| `ANTIGRAVITY_MODEL_FALLBACK_ENABLED` | `true` | เปิด tier fallback (gemini→claude→web) |
| `ANTIGRAVITY_BRIDGE_API_KEY(S)` | — | ถ้าตั้ง: endpoint ทั่วไปต้อง auth; extension ใช้ได้เฉพาะจาก loopback |

**โมเดลที่เพิ่มใน `SUPPORTED_MODELS`:** `"gemini-web": ("gemini-3.8-flash-thinking", "high")`, `"gemini-2.0-flash-thinking"`, `"gemini-2.0-flash-thinking-exp"` (context 1,000,000 ใน `MODEL_CONTEXT_LIMITS`) และ `get_model_family()` คืน `"web"` เมื่อชื่อมี `-web` / ลงท้าย `web` / เท่ากับ `web` / มี `gemini-web`

### 3.2 ฟังก์ชัน helper ด้าน profile/channel (module‑level)

| ฟังก์ชัน | หน้าที่ |
| --- | --- |
| `is_web_priority_enabled()` | อธิบายข้างบน |
| `get_available_profiles()` | env `ANTIGRAVITY_PROFILES` → config `profiles` → สแกนโฟลเดอร์ `<canonical>/profiles/*` (ข้าม `.disabled`, `.bak`, ขึ้นต้นด้วยจุด; ย้าย `ANTIGRAVITY_PROFILE` ขึ้นหน้า) → `[ANTIGRAVITY_PROFILE]` หรือ `[None]` |
| `get_disabled_profiles()` / `get_cli_disabled_profiles()` / `get_web_disabled_profiles()` | รวม env + config list + per‑profile flag |
| `is_profile_cli_enabled(p)` / `is_profile_web_enabled(p)` | `p or "default"`; False ถ้าอยู่ใน disabled ทั้งหมดหรือ disabled ของช่องนั้น |
| `get_profile_channel_status(p)` | `{"cli":bool,"web":bool,"disabled":bool}` |
| `persist_channel_profile_state(profile, channel="all", disabled=True)` | เขียน `bridge_config.json` (สร้าง `profiles.<p>` ถ้าไม่มี); `channel` = `all`/`*`/`cli`/`web`; เปิดช่องใดช่องหนึ่งจะเอาชื่อออกจาก `disabled_profiles` และตั้ง `disabled:false` ด้วย |
| `persist_disabled_profile(p, disabled)` | wrapper channel="all" |
| `get_profile_account_email(profile)` | config `profiles.<p>.account_email/email` → reverse `profile_emails` → `google_accounts.json` (`~/.gemini/google_accounts.json` สำหรับ default, `<canonical>/profiles/<p>/google_accounts.json` หรือ `<canonical>/<p>/google_accounts.json`) field `active` → `"N/A"` → `"Not Logged In"` |
| `find_profile_by_email(email)` | `profile_emails[email]` → `profiles.*.account_email` → สแกนโฟลเดอร์ profile เทียบ `get_profile_account_email` → `"default"` ถ้าอีเมล default ตรง → `None` |
| `is_thinking_only_text(text)` (**FIX**) | regex `^\s*<think>[\s\S]*?</think>\s*$` (IGNORECASE) — True ถ้าทั้งข้อความมีแต่ think block |

### 3.3 `WebJob`, `WebClient`, `WebClientManager`

```python
class WebJob:  # หนึ่ง request ที่ส่งไป extension
    job_id, profile, prompt, model, stream=True, timeout=180.0   # ctor args (จริงส่ง timeout=attempt_timeout)
    created_at, last_activity, delta_queue: queue.Queue[Optional[str]], done_event: threading.Event
    final_output = "", error: Optional[str] = None, effective_model = model or "gemini-web"
    client_id: Optional[str] = None   # FIX: client ที่กำลังถือ job (ตั้งใน dispatch_job / re‑dispatch)

class WebClient:  # หนึ่ง SSE stream
    client_id, profile, email, connected_at, last_heartbeat, queue: queue.Queue[dict], is_alive=True
    # หมายเหตุ: last_heartbeat ถูกตั้งครั้งเดียวตอนสร้าง ไม่มีที่ไหนอัปเดต → idle_seconds ใน /extension/status = เวลาตั้งแต่ต่อ

class WebClientManager:  # singleton GLOBAL_WEB_CLIENT_MANAGER, ป้องกันด้วย RLock
    clients: Dict[client_id, WebClient]
    profile_to_client_ids: Dict[profile, Set[client_id]]
    jobs: Dict[job_id, WebJob]
```

| method | พฤติกรรม (FIX) |
| --- | --- |
| `register_client(profile, email="", client_id=None) -> WebClient` | `cid = client_id or f"web_{uuid4().hex[:8]}"`, `prof = profile or "default"`; **retire client เก่าทั้งหมดของ profile นั้น** (`is_alive=False` + put `{"event":"close"}` ให้ลูป SSE เก่าจบ) **ยกเว้น client ที่มี job in‑flight** (`busy_cids` — เพิ่มใน FIX เพราะ extension cycle SSE ทุก 4 นาที แล้ว client เก่าที่กำลังตอบถูก retire จน job ไม่มีใครรายงานผล); สร้าง client ใหม่, log `[WEB EXTENSION] Registered client ...` |
| `unregister_client(client_id)` | ลบออก; ถ้า profile ไม่เหลือ client ลบ key; สำหรับ job ที่ `job.client_id == client_id` (หรือ `client_id is None` และ profile เดียวกัน) → re‑dispatch ไป `get_client_for_profile(job.profile)` (put `event: job` ใหม่, ตั้ง `job.client_id`) ถ้าไม่มี → `job.error = "Web extension client '<cid>' disconnected while job was running"`, sentinel `None`, `done_event.set()`, pop job (FEAT เดิม match ด้วย profile อย่างเดียว ทำให้ tab หนึ่งหลุดแล้วล้ม job ของ client อื่นใน profile เดียวกัน) |
| `is_profile_connected(profile)` | True ถ้ามี client `is_alive` ใน profile; สำหรับ `"default"`: True เฉพาะเมื่อมี client ชื่อ `default` หรือ client ที่ `email` ตรงกับ `get_profile_account_email("default")` (FEAT: `default` ถือว่าต่ออยู่ถ้ามี client ใดก็ได้ → job ถูกส่งลง queue ที่ไม่มีใครอ่าน) |
| `get_connected_profiles()` | `sorted(profile_to_client_ids.keys())` (รวม profile ที่ set ว่างชั่วคราวได้) |
| `get_client_for_profile(profile)` | client ที่ alive และ `max(connected_at,last_heartbeat)` ล่าสุด; ถ้า `default` และไม่มี → client alive ใดก็ได้ |
| `dispatch_job(job) -> bool` | หา client; ถ้า `job.profile=="default"` แต่ client เป็น profile จริง → เปลี่ยน `job.profile`; ตั้ง `job.client_id`; เก็บใน `jobs`; put `{"event":"job","data":{jobId, profile, prompt, model, stream, timeout}}`; log `Dispatched job ...`; False + warning ถ้าไม่มี client |
| `handle_delta(job_id, delta)` | `final_output += delta`, `delta_queue.put(delta)`, `last_activity=now` |
| `handle_done(job_id, full_output)` | pop job; ถ้า `len(full_output) >= len(streamed)` ใช้ `full_output` ไม่งั้นคง streamed (log "keeping streamed output"); put `None`; `done_event.set()` |
| `handle_error(job_id, msg)` | pop job; `job.error=msg`; put `None`; set event; warning |
| `get_status_summary()` | `{"connected_clients_count","connected_profiles","active_jobs_count","clients":[{client_id,profile,email,connected_at,idle_seconds}]}` |

### 3.4 `ProfileManager` — ส่วนที่เกี่ยวกับ web

| method | พฤติกรรม |
| --- | --- |
| `is_web_in_cooldown(profile)` | อ่าน `state[p]["family_cooldowns"]["web"]` — **ในโค้ดไม่มีที่ไหนตั้งค่า cooldown family "web" เลย** (ไม่มี `mark_exhausted(..., model="gemini-web")`) จึงคืน False ตลอด |
| `is_web_executable(profile, model=None)` | `is_profile_web_enabled(p) and GLOBAL_WEB_CLIENT_MANAGER.is_profile_connected(p) and not is_web_in_cooldown(p)` — **ไม่สน** quota/cooldown ของ CLI เลย |
| `is_executable(profile, model)` | คืน True ทันทีถ้า `is_web_executable` (ใช้ตัดสิน preferred profile) |
| `mark_success(profile, model="gemini-web")` | family "web" ไม่อยู่ใน `family_cooldowns` (มีแค่ gemini/claude) จึงไม่ reset อะไร แต่ยังนับ `success_count`, `window_requests` และ `last_used` ของ profile (ทำให้ quota banner/`estimated_quota_percent` ลดลงจากงานเว็บด้วย) |
| `get_status_summary()` | เพิ่ม field ต่อ profile: `cli_enabled`, `web_enabled`, `web_connected`, `account_email`, `capabilities:{cli,web}` (ใช้โดย `/health`, `/v1/profiles`, popup, `profile list`) |
| `get_ordered_profiles(model=None, channel="auto")` | ดูด้านล่าง |

**การจัดลำดับใน `get_ordered_profiles`:**
- ถ้า `channel in ("web","auto")` → เติม profile ที่ต่ออยู่ผ่าน web (`get_connected_profiles()`) แต่ไม่อยู่ใน `_profiles` เข้าไปด้วย (ถ้า web enabled)
- profile ที่ `status=="DISABLED"` ถูกข้าม เว้นแต่ web enabled+connected และ channel web/auto
- `channel=="cli"` ตัด profile ที่ CLI ปิด; `channel=="web"` ตัดที่ web ปิดหรือไม่ได้ต่อ; `auto` ตัดที่ปิดทั้งคู่
- **`channel=="web"`**: ถ้า `is_web_executable` → ใส่ `web_idle` (in_flight 0 และ sandbox ไม่ล็อก) / `web_avail` / `web_busy` ไม่งั้นใส่ `exhausted`
- **`auto` + `web_prio` + web executable** → web buckets (continue)
- **`auto` + CLI ปิด** → web buckets ถ้า executable ไม่งั้น exhausted
- ปกติ (fallback routing เปิดสำหรับ gemini family): ทั้ง gemini และ claude cooldown → web buckets ถ้า executable ไม่งั้น exhausted; ไม่ใช่ gemini family และ `exhausted_until` ยังไม่ถึง → web buckets ถ้า executable ไม่งั้น exhausted
- ที่เหลือแบ่ง `ready_*` / `sonnet_*` / `recovering_*` / `unauthenticated` (อีเมล `Not Logged In` และไม่เคยสำเร็จ)
- round‑robin ภายใน `ready_idle`, `sonnet_idle`, `web_idle` ด้วย `current_idx`
- **ลำดับสุดท้ายเมื่อ `web_prio` และมี web_idle/web_avail:** `web_idle + web_avail + ready_idle + ready_avail + sonnet_idle + sonnet_avail + recovering_idle + web_busy + ready_busy + sonnet_busy + recovering_busy + unauthenticated + exhausted`
- **ไม่งั้น:** `ready_idle + ready_avail + sonnet_idle + sonnet_avail + web_idle + web_avail + recovering_idle + ready_busy + sonnet_busy + web_busy + recovering_busy + unauthenticated + exhausted`
- ว่างทั้งหมด → `[None]`

### 3.5 `execute_web_command()`

```python
def execute_web_command(prompt_text, profile=None, model_name=None,
                        timeout=DEFAULT_PROFILE_TIMEOUT, output_callback=None) -> CLIExecutionResult
```
ลำดับ:
1. `prof = profile or "default"`; ถ้า `default` และ `get_client_for_profile("default")` คืน client ของ profile จริง → ใช้ profile นั้น
2. `not is_profile_web_enabled(prof)` → `RuntimeError("Profile '<p>' has Web channel disabled in configuration")`
3. `not is_profile_connected(prof)` → `RuntimeError("No active Chrome extension connected for profile '<p>'")`
4. สร้าง `WebJob(job_id="webjob_<10hex>", profile, prompt, model=model_name or "gemini-web", stream=output_callback is not None, timeout=timeout)`
5. `dispatch_job` ล้มเหลว → `RuntimeError("Failed to dispatch job to Chrome extension for profile '<p>'")`
6. วนรอ: `delta_queue.get(timeout=1.0)`; `None` = จบ; delta → สะสม + `output_callback(delta)`; `queue.Empty` และ `done_event` set → จบ; **เกิน `timeout` วินาที** → `handle_error(job_id, "Web execution timeout after Xs")` แล้ว `raise TimeoutError("Web execution timed out after Xs (profile=...)")`
7. `job.error` → `RuntimeError(f"Web Extension Execution Error: {job.error}")` ← รูปแบบข้อความ error ที่ client จะเห็นหลัง prefix `All agy profile execution attempts failed. Details: Web Profile '<p>': ...`
8. `result_text = longer(streamed, job.final_output)`
9. **FIX:** `is_thinking_only_text(result_text)` → `RuntimeError("Web Extension returned only a thinking placeholder with no answer text (profile=..., chars=N)")`
10. คืน `CLIExecutionResult(result_text, prof, effective_model=model_name or "gemini-web", channel="web")` (tuple‑subclass `(output, profile)` + attributes `.output .profile .effective_model .channel`)

### 3.6 กติกาเลือกช่องทางใน `execute_cli_with_fallback(..., channel="auto")`

`req_channel` มาจาก header `X-Bridge-Channel` → `X-Channel` → body `channel` → `"auto"`; `preferred_profile` จาก `X-Antigravity-Profile` → `X-Profile` → body `profile`

ต่อ profile ผู้สมัคร (ตามลำดับจาก `get_ordered_profiles`) ตัดสิน `use_web`:

| ลำดับ | เงื่อนไข | ผล |
| --- | --- | --- |
| 1 | `req_ch == "web"` | `use_web=True` เสมอ (ถ้าไม่ได้ต่อจะ raise ใน `execute_web_command` แล้วข้ามไป profile ถัดไป ไม่ตกไป CLI) |
| 2 | `auto` และ (`is_web_priority_enabled()` **หรือ** ชื่อโมเดลมี `-web` / `thinking` / `high`) และ `mgr.is_web_executable(profile, model)` | web — **สังเกต: แค่ขอ `gemini-3.8-flash-thinking` หรือ `*-high` ก็ไปเว็บทันทีถ้า extension ของ profile นั้นต่ออยู่ แม้ไม่ได้เปิด priority** |
| 3 | `auto` และโมเดลมี `-web` หรือ `== "gemini-web"` | web (ถ้าไม่ได้ต่อ → error แล้ว fallback CLI ถ้า CLI เปิด) |
| 4 | `auto` และ CLI ของ profile ปิด | web ถ้า executable ไม่งั้น `errors.append("... CLI channel disabled and Web not executable")` แล้วข้าม |
| 5 | CLI path, gemini family, fallback เปิด: gemini cooldown & claude ไม่ → Tier 1 `effective_model = DEFAULT_SONNET_FALLBACK_MODEL` (`claude-sonnet-4-6`); ทั้งคู่ cooldown → **Tier 2** web ถ้า `auto` และ executable (`effective_model = DEFAULT_WEB_FALLBACK_MODEL`) ไม่งั้นข้าม | |
| 6 | CLI path, โมเดล family อื่นอยู่ใน cooldown → web ถ้า `auto` และ executable ไม่งั้นข้าม | |
| 7 | web ล้มเหลว (exception) และ `auto` และ CLI เปิด → ลอง CLI ด้วย profile เดิมต่อ; ไม่งั้น release แล้วไป profile ถัดไป | |
| 8 | CLI โดน quota/rate‑limit error ระหว่างทำงาน (`is_quota_or_rate_limit_error`) และ `auto` และ web executable และ (effective model เป็น claude หรือ claude cooldown) → **In‑flight Tier 2**: เรียก `execute_web_command` ทันทีด้วย `DEFAULT_WEB_FALLBACK_MODEL` | |
| 9 | หลังลองครบทุก profile และ `auto` → **Global Web Safety Net**: วน `get_connected_profiles()` ที่ web enabled+executable ลอง web ด้วย `timeout=min(timeout,total_timeout)` | |
| 10 | ทั้งหมดล้มเหลว → `RuntimeError("All agy profile execution attempts failed. Details: ...")` | |

หลัง web สำเร็จ: `mgr.mark_success(actual_prof, model="gemini-web")`, `set_last_execution_model(..)`, `release_profile`, return

**Timeout ต่อ attempt:** `attempt_timeout = max(1.0, min(timeout, remaining_budget))` โดย `timeout` = `prof_timeout` ที่ handler คำนวณจาก request (`timeout` ใน query/body/model suffix/ในprompt directive, auto‑scale ตามความยาว) default 600 วิ; ค่านี้ถูกส่งเป็น `job.timeout` ให้ extension ด้วย (page.js ใช้ `(job.timeout || 600) * 1000` ms) — **ทั้งสองฝั่งหมดเวลาพร้อมกัน** ฝั่ง bridge จะ `handle_error` แล้ว raise TimeoutError

### 3.7 HTTP handler (`AntigravityBridgeHandler`)

**`do_GET`**
- `/`, `/health` → `{status:"ok", service:"antigravity-bridge", active_profile, auth_required, active_keys_count, concurrency{active_in_flight,max_pool_capacity,concurrency_per_profile,idle_profiles_count,busy_profiles_count}, profiles: <get_status_summary()>}` (ไม่มี field `available_profiles_count`/`total_profiles_count` ที่ `test_bridge.py` พยายามอ่าน — จะแสดง 0/0)
- auth check (ยกเว้น extension GET จาก loopback — FIX)
- `/v1/keys` …
- `/v1/profiles` → `{object:"list", concurrency{...}, profiles{<name>:{..., account_email, cli_enabled, web_enabled, web_connected, capabilities}}}` — extension รองรับทั้งกรณี `profiles` เป็น array หรือ object (แปลง object เป็น `[{name, ...}]`)
- `/v1/models` → รวม `gemini-web` ฯลฯ
- `/extension/events` → SSE ตาม 2.3; ก่อน register: ถ้ามี `email` → `find_profile_by_email(email)`; **FIX: ถ้าเจอและต่างจาก `profile` ที่ extension ส่งมา ให้ใช้ชื่อจาก config แทน** (log `Remapped profile 'x' -> 'y' for Google account ...`) — FEAT remap เฉพาะเมื่อ `profile` ว่าง/`default` ทำให้เกิด "phantom profile" เช่น `user1` เมื่อ extension เดาชื่อจาก username ของอีเมล
- `/extension/status` → `get_status_summary()` ของ `WebClientManager`
- อื่น → 404

**`do_POST`** — เส้นทางที่รับ: `/v1/chat/completions`, `/v1/messages`, `/v1/images/generations`, `/v1/profiles/{reset,check,config,disable,enable,toggle}`, `/v1/keys/{create,revoke}`, `/extension/{delta,done,error,debug}` (และ alias ไม่มี `/v1`, `/api/web/*`); auth ยกเว้น extension POST จาก loopback; `MAX_BODY_SIZE` = 32 MB
- `/v1/profiles/toggle`: `{"profile","channel"="all","enabled"=true}` → `persist_channel_profile_state(profile, channel, disabled=not enabled)`; ถ้า `all` ก็ `pm.mark_disabled/enable`; ตอบ `{status, profile, channel, enabled, cli_enabled, web_enabled, profiles}`
- `/v1/profiles/disable|enable`: `{"profile","channel"="all"}` → `cli|web` ใช้ `persist_channel_profile_state`, `all` ใช้ `pm.mark_disabled()`/`pm.enable()`
- `/v1/profiles/config`: `{"profiles":[...]}` hot‑reload (เขียน `~/.config/antigravity/bridge_config.json` **แบบ hardcode path** ไม่ผ่าน `get_bridge_config_path()`)
- extension callbacks → 3.3

### 3.8 การไหลของ chat request และ streaming

1. parse body (OpenAI/Anthropic), แปลง messages เป็น `prompt_text` (โค้ดเดิม), คำนวณ `prof_timeout`, `total_timeout`, `stall_timeout`
2. ถ้า `stream` → ส่ง header SSE ให้ client ทันที + เริ่ม `SSEHeartbeat(self.wfile, interval=3.0, is_anthropic)` ซึ่งเขียนทุก 3 วิ: `: keep-alive`, `: active=true elapsed=..s`, และ chunk ว่าง (`choices[0].delta = {}`) หรือ `event: ping` (Anthropic)
3. `execute_cli_with_fallback(custom_tpl, prompt_text, timeout=prof_timeout, total_timeout, profiles, model_name=model, profile_manager, preferred_profile=req_profile, stall_timeout, channel=req_channel)` — **ไม่ส่ง `output_callback`** ⇒ ในโหมด web `WebJob.stream=False`, delta จาก extension ถูกสะสมที่ bridge เท่านั้น **client ไม่ได้รับ token แบบ real‑time** ได้แค่ heartbeat แล้วได้ข้อความทั้งก้อนใน chunk เดียวตอนจบ (`delta.content = final_content_text` แล้ว `data: [DONE]`) — ฝั่ง Anthropic ก็เป็น `content_block_delta` เดียว
4. error → stream: chunk `"\n\n⚠️ **Antigravity Bridge Error:** <exc>"` + `[DONE]`; non‑stream: 500 `{error:{message,type:"api_error"}}`
5. สำเร็จ: `used_profile`, `actual_model = exec_result.effective_model` (สำหรับ web = โมเดลที่ส่งให้ extension เช่น `gemini-3.8-flash-thinking`); ต่อท้าย quota banner (`build_profile_quota_banner`) เว้นแต่ `--hide-profile-status`; headers `X-Antigravity-Active-Profile`, `X-Antigravity-Effective-Model` + `X-Antigravity-Model-Fallback: true` (เมื่อ actual ≠ requested), `X-Antigravity-Profiles-Ready/Total`, `X-Antigravity-Profile-Quota-Percent`, `X-Antigravity-Concurrency-In-Flight`, `X-Antigravity-Profile-Concurrency-Status`, `X-Antigravity-*-Timeout`; field `model` ใน JSON = โมเดลที่ client ขอ (ไม่ใช่ effective)

### 3.9 CLI subcommands ที่เกี่ยวข้อง

- `python3 antigravity_bridge.py profile list` (`profiles`) — ตารางคอลัมน์ `Profile Name | Google Account Email | CLI | Web | Status | Concurrency | Gemini Quota | Model Mode | Success`; คอลัมน์ Web แสดง `🟢 Connected` (web enabled + client ต่ออยู่) / `⚪ Standby` (enabled แต่ไม่ต่อ) / `🔴 Off`; ดึงจาก live server `http://127.0.0.1:8000/v1/profiles` (**port 8000 hardcode**) ไม่งั้นคำนวณ local
- `profile disable <name> [--channel cli|web|all]` / `-c` และ `profile enable ...` — ยิง `POST /v1/profiles/disable|enable` ไป live server (port 8000) แล้ว `persist_channel_profile_state` ลงไฟล์เสมอ
- **ไม่มี** subcommand `profile toggle` ใน `handle_profile_cli` (README กล่าวถึง `profile toggle <name> <cli|web> [on|off]` แต่โค้ดไม่มี — มีเฉพาะ HTTP `/v1/profiles/toggle`)
- `main()` ไม่มี flag เฉพาะ web; Docker รันด้วย `--host 0.0.0.0 --port 8000`

### 3.10 ตารางกรณี error (ข้อความจริง)

| จุดกำเนิด | ข้อความ | ความหมาย/สาเหตุ |
| --- | --- | --- |
| `execute_web_command` | `No active Chrome extension connected for profile '<p>'` | ไม่มี `WebClient` alive ของ profile (extension ไม่ได้เปิด SSE, tab ยังไม่ detect อีเมล, profile ชื่อไม่ตรง) |
| `execute_web_command` | `Profile '<p>' has Web channel disabled in configuration` | `web:false`/`web_disabled_profiles` |
| `execute_web_command` | `Failed to dispatch job to Chrome extension for profile '<p>'` | client หายไประหว่างตรวจกับ dispatch |
| `execute_web_command` | `Web execution timed out after Xs (profile=...)` (TimeoutError) | เกิน attempt timeout |
| `execute_web_command` | `Web Extension Execution Error: <job.error>` | ห่อ error ที่มาจาก extension หรือจาก bridge เอง (ด้านล่าง) |
| `execute_web_command` (FIX) | `Web Extension returned only a thinking placeholder with no answer text (profile=..., chars=N)` | ผลลัพธ์มีแต่ `<think>...</think>` |
| `unregister_client` | `Web extension client '<cid>' disconnected while job was running` | SSE ปิดระหว่างทำงานและไม่มี client อื่นให้ re‑dispatch |
| SSE writer | `Client socket error sending job: <exc>` | เขียน job ลง socket ไม่ได้ |
| background.js | `Web extension channel is currently disabled in settings.` | popup ปิด toggle "Web Extension Channel" (ค่า local `webEnabled=false`) |
| background.js | `Failed to deliver job to Gemini tab <id> for profile '<p>'. Tab may still be loading or unready.` | `chrome.tabs.sendMessage` ล้มเหลว 3 ครั้ง |
| page.js | `Unable to locate Gemini prompt input box. Please verify you are on gemini.google.com/app or /canvas.` | selector กล่องข้อความไม่ตรง |
| page.js | `Timeout waiting for Gemini response container to appear. (url=..., baseline=N, isGenerating=..., stopDetectionReliable=...). The response container selectors in page.js are likely out of date.` | ภายใน 45 วิ ไม่พบ block คำตอบใหม่ |
| page.js (FIX) | `Gemini finished the thinking phase but never rendered an answer (url=..., elapsed=Ns, isGenerating=..., stopDetectionReliable=...). Only the thinking header was extracted, so no answer is being returned.` | reasoning prompt จบโดยไม่มีคำตอบ |
| page.js | `Gemini finished responding but no text could be extracted from the page (url=..., canvas=...). The response DOM selectors in page.js are likely out of date.` | มีปุ่ม Copy แล้วแต่ดึงข้อความไม่ได้ |
| page.js | `Execution timed out after <N>s` | เกิน `job.timeout` |
| ข้อความ **`Web Extension Execution Error: canceled`** | — | **ไม่พบ string "canceled"/"cancelled" ในโค้ด Python หรือ JS ของ branch นี้เลย**; ถ้าเคยเห็นใน log แสดงว่า `job.error` ถูกตั้งจาก runtime (เช่นข้อความจาก browser) ที่ไม่ได้อยู่ในซอร์ส — ยืนยันที่มาไม่ได้ (ดูหัวข้อ 9) |

### 3.11 สิ่งที่ commit `fb3898e` (FIX) เปลี่ยนฝั่ง bridge (จาก `git diff 2fdbf3c fb3898e -- antigravity_bridge.py`, 93 บรรทัด)

1. `WebJob.client_id` + `dispatch_job` ตั้งค่า + `unregister_client` ล้าง/ย้ายเฉพาะ job ของ client นั้น (ก่อนหน้า match ตาม profile)
2. `register_client` ไม่ retire client ที่มี job in‑flight (แก้กรณี SSE cycle 4 นาทีทำให้คำตอบหาย)
3. `is_profile_connected("default")` เข้มงวดขึ้น (ชื่อ default หรืออีเมลตรงกับ config)
4. `_THINK_ONLY_RE` / `is_thinking_only_text()` และ `execute_web_command` raise เมื่อได้แต่ think block → ให้ fallback chain ไปลอง profile/CLI อื่น
5. `do_GET` ยกเว้น auth สำหรับ extension GET จาก loopback
6. `/extension/events` ให้ `bridge_config.json` เป็นผู้ตัดสิน profile จากอีเมลเสมอ (remap แม้ extension ส่งชื่อมาแล้ว)
7. เพิ่ม unit tests 6 ตัว: `test_is_thinking_only_text`, `test_execute_web_command_rejects_thinking_only_result`, `test_default_profile_not_connected_via_unrelated_client`, `test_default_profile_connected_via_configured_email`, `test_unregister_client_leaves_other_clients_jobs_alone`, `test_register_client_does_not_retire_busy_client`

"sanitize configuration" ใน commit message หมายถึงส่วน deploy (`CONTAINER_NAME`, `BRIDGE_PORT=8002`, compose `name:`, `reset.sh`/`test-docker.sh` อ่าน `.env`, supervisorctl socket, dedupe tabs) — ดูหัวข้อ 5.9

---

## 4. ฝั่ง Extension (`extension/`)

### 4.1 `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "Antigravity Web Bridge", "version": "1.0.0",
  "permissions": ["storage", "alarms", "tabs", "scripting", "offscreen"],
  "host_permissions": ["https://gemini.google.com/*", "https://*.google.com/*", "http://127.0.0.1/*", "http://localhost/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{ "matches": ["https://gemini.google.com/*"], "js": ["content.js"], "run_at": "document_idle" }],
  "web_accessible_resources": [{ "resources": ["page.js"], "matches": ["https://gemini.google.com/*"] }],
  "action": { "default_popup": "popup.html", "default_icon": {...} }, "icons": { "16": "icons/icon16.png", "48": ..., "128": ... }
}
```
- `host_permissions` ต่อ `127.0.0.1`/`localhost` จำเป็นเพื่อ `fetch()` ไปที่ bridge จาก service worker โดยไม่ติด CORS; ถ้า bridge อยู่ host/port อื่นต้องเพิ่ม pattern
- `scripting` ใช้ `chrome.scripting.executeScript({files:['content.js']})` ก่อนส่ง job ทุกครั้ง (กัน content script หลุดหลัง worker restart)
- `offscreen` ใช้สร้าง offscreen document keepalive

### 4.2 `background.js` (service worker, ~757 บรรทัด)

**ค่าคงที่:** `DEFAULT_BRIDGE='http://127.0.0.1:8000'`, `RECONNECT_INTERVAL_MS=3000`, `CYCLE_MS=4*60*1000` (cycle SSE ก่อน browser ตัด stream), `SCAN_INTERVAL_MS=10000`, `CONNECT_STALE_MS=30000`, `HEARTBEAT_STALE_MS=60000`

**State (in‑memory ของ worker — หายเมื่อ worker ถูก restart):**
- `openGeminiTabs: Map<tabId, {tabId,url,email,profile,firstSeen,lastSeen,warnedUnresolved?}>`
- `profileConnections: Map<profile, {profile,email,controller:AbortController,clientId,isConnected,isConnecting,connectStartedAt,lastHeartbeat,cycleTimer}>`
- `activeJobs: Map<jobId, {tabId,profile,startTime}>`
- `emailByAccountIndex: Map<N, email>` — เรียนรู้ index `/u/N/` ↔ อีเมลจริง (ไม่ hardcode)
- `cachedBridgeProfiles: Array<{name, account_email, cli_enabled, web_enabled, ...}>`, `lastProfileFetchTime`

**Config (`chrome.storage.local`, อ่านด้วย `getConfig()`):** `bridgeUrl` (default `DEFAULT_BRIDGE`), `assignedProfile` ('' = auto), `webEnabled` (default true), `canvasMode` (**default false** — comment: Canvas ทำให้ chat bubble เหลือ stub บรรทัดเดียว), `preferredWebModel` (default `'gemini-3.8-flash-thinking'`)

**ฟังก์ชันหลัก:**

| ฟังก์ชัน | หน้าที่ |
| --- | --- |
| `accountIndexFromUrl(url)` | `/u/(\d+)/` → N; `gemini.google.com/(app\|canvas)` → 0; อื่น → null |
| `accountIndexForProfile(profile, email)` | หา N ที่ `emailByAccountIndex[N]` ตรงกับ email (หรือ `account_email` ของ profile ใน cache) |
| `touchWorker()` | `chrome.storage.local.get('lastTouch')` เพื่อ reset idle timer |
| `ensureOffscreenDocument()` | `chrome.offscreen.createDocument({url:'offscreen.html', reasons:['BLOBS'], justification:'Keep service worker and SSE streams alive 24/7 ...'})` (กัน error "single offscreen document") |
| `postToBridge(path, data)` | `fetch(bridgeUrl+path, {method:'POST', JSON})` คืน `res.ok` |
| `fetchBridgeProfiles()` | `GET /v1/profiles` → `cachedBridgeProfiles` (array หรือ object→array) |
| `resolveProfile(email, url)` | (1) `account_email` ตรงเป๊ะ → name; (2) ชื่อ profile == username ของอีเมล หรือ username มีชื่อ profile; (3) index จาก URL → อีเมลที่เรียนรู้ → profile ที่ `account_email` ตรง; (4) bridge มี profile เดียว → ใช้ถ้าไม่มีอีเมลขัดแย้งหรือ index 0; (5) **FIX:** คืน username ของอีเมลเฉพาะเมื่อโหลดรายชื่อ profile แล้ว (`profiles.length>0`) ไม่งั้น warn "Bridge profile list not loaded yet — deferring..." + `fetchBridgeProfiles()` + คืน `''`; (6) ไม่มีอีเมล → `''`; exception → `'default'` |
| `ensureConnectionForProfile(profile, email)` | ถ้า `webEnabled=false` ไม่ทำ; ถ้ามี connection ที่ `isConnected` และ heartbeat ยังไม่เกิน 60 วิ → return; ถ้า `isConnecting` และยังไม่เกิน 30 วิ → return; ไม่งั้น abort ของเก่า, สร้าง `conn` ใหม่ (set ลง Map **ก่อน** await ใดๆ กัน race), `ensureOffscreenDocument()`, `fetch(`${bridgeUrl}/extension/events?profile=..&email=..`, {headers:{Accept:'text/event-stream'}, signal})`; `!res.ok` → log "SSE refused with status"; อ่าน `response.body.getReader()` + `TextDecoder`, parse บรรทัด `event:`/`data:` (data หลายบรรทัด join ด้วย `\n`; บรรทัดว่าง = จบ event); `connected` → `conn.clientId`; `job` → `handleJobEvent(parsed, profile, conn.email)`; ทุกครั้งที่อ่านได้ → `touchWorker()` + `lastHeartbeat=now`; ตั้ง `cycleTimer` 4 นาที abort แล้วต่อใหม่; `finally`: `isConnected=false`, `isConnecting=false` (FIX‑style comment: ต้องล้างที่นี่ไม่งั้น latch), หลัง 3 วิถ้า Map ยังชี้ conn นี้ และยังมี tab ของ profile หรือ `assignedProfile` ตรง → ต่อใหม่ ไม่งั้นลบ |
| `handleJobEvent(job, assignedProfile, assignedEmail)` | ดู flow ด้านล่าง |
| `scanOpenTabs()` | ทุก 10 วิ (setInterval) และทุก 15 วิ (alarm `bridge_health_check`, `periodInMinutes: 0.25`) + เมื่อ tab `onUpdated` status complete + onStartup/onInstalled: refetch profiles ถ้าเกิน 60 วิ; `chrome.tabs.query({url:['https://gemini.google.com/*','https://*.gemini.google.com/*']})`; ลบ tab ที่ปิดไปแล้ว; ส่ง `CHECK_EMAIL` ทุก tab (ไม่ discarded); tab ใหม่ลงทะเบียนด้วย `email:'', profile:''` (**ไม่เดาบัญชี** — comment บอกว่าเวอร์ชันก่อนเคย hardcode 2 บัญชีตาม URL); tab ที่มี profile → `ensureConnectionForProfile`; tab ที่ยังไม่ resolve เกิน 30 วิ → warn ครั้งเดียว; ถ้า `assignedProfile` ตั้งไว้และ `webEnabled` → ต่อให้ profile นั้นด้วย (`email=''`) |
| `chrome.tabs.onRemoved` | ลบ tab; ถ้าไม่มี tab อื่นของ profile และไม่ใช่ `assignedProfile` → abort connection + ลบ |
| `chrome.runtime.onConnect` | รับ port `keepalive`, `gemini-tab`, `offscreen-keepalive` → `touchWorker()` ทุกข้อความ; onDisconnect → `ensureOffscreenDocument()` |
| `chrome.runtime.onMessage` | router ตาม 2.4; `DETECTED_EMAIL`: เรียนรู้ `emailByAccountIndex` จาก `sender.tab.url`, `resolveProfile`, บันทึก tab, `ensureConnectionForProfile` ถ้า resolve ได้ ไม่งั้น warn "matches no bridge profile — not connecting" |
| startup | `ensureOffscreenDocument(); fetchBridgeProfiles().then(scanOpenTabs); setInterval(scanOpenTabs, 10000)` |

**Flow `handleJobEvent(job)` (การเลือก tab):**
1. `jobId = job.jobId || job.job_id`; ถ้า `webEnabled=false` → `POST /extension/error` "Web extension channel is currently disabled in settings." แล้วจบ
2. ถ้า `job.model` ว่าง/`default`/`gemini-web` → แทนด้วย `preferredWebModel`; ถ้า `job.canvas === undefined` → `cfg.canvasMode`
3. `targetProfile = job.profile || assignedProfile`, `targetEmail = assignedEmail.toLowerCase()`
4. หา tab ใน `openGeminiTabs` ที่ `profile === targetProfile` หรือ `email === targetEmail`; **เลือก tab สะอาด** (URL ไม่ match `/(app|canvas)/<threadId>`) ก่อน; ถ้ามี tab สะอาดและมี tab อื่นที่ค้างอยู่ใน thread เก่า → `chrome.tabs.remove` tab เก่า
5. ถ้าไม่เจอ: `targetIndex = accountIndexForProfile(...)`; query tab ทั้งหมดที่ไม่ discarded; ถ้ารู้ index → หา tab ที่ index ตรง (สะอาดก่อน); **ถ้ารู้ index แต่หาไม่เจอ จะไม่หยิบ tab อื่นมั่วๆ** (กันส่ง prompt ไปบัญชีคนอื่น) — เดาได้เฉพาะเมื่อไม่รู้ index เลย (`live[0]`)
6. ถ้ายังไม่มี tab → `chrome.tabs.create({url: 'https://gemini.google.com[/u/N]' + (job.canvas!==false ? '/canvas' : '/app'), active:false})` แล้วรอ 4 วิ
7. `activeJobs.set`; `chrome.tabs.update(tabId,{active:true})` + รอ 150ms (ให้ `execCommand`/MutationObserver ทำงานเมื่อ tab มี focus); `chrome.scripting.executeScript({target:{tabId}, files:['content.js']})`
8. `chrome.tabs.sendMessage(tabId, {type:'EXECUTE_JOB', job})` ลองสูงสุด 3 ครั้ง ห่าง 1 วิ; ล้มเหลวทั้งหมด → ลบ activeJob + `POST /extension/error` "Failed to deliver job to Gemini tab ..."

### 4.3 `content.js` (isolated world)
- IIFE; ถ้ามี `window.__ANTIGRAVITY_CLEANUP__` จากรอบก่อนให้เรียกก่อน (กัน listener ซ้ำเมื่อ `executeScript` ซ้ำ)
- **Guard "Extension context invalidated":** ห่อทุก `chrome.runtime.*` ใน try/catch + `.catch`; เมื่อพบข้อความ `Extension context invalidated` / `context invalidated` / `Cannot read properties of undefined` → cleanup แล้ว `window.location.reload()` หลัง 2 วิ (ให้ผล job ที่ค้างมีเวลาอ่านก่อน)
- **Inject page.js:** ลบ `<script id="antigravity-page-script">` เดิม แล้วสร้างใหม่ `src = chrome.runtime.getURL('page.js?t=' + Date.now())` ต่อเข้า `document.head`
- **Keepalive:** `chrome.runtime.connect({name:'gemini-tab'})` (reconnect หลัง 2 วิเมื่อ disconnect) + ทุก 10 วิส่ง `port.postMessage({type:'content-heartbeat'})` และ `sendMessage({type:'content-ping'})`
- **Relay** ตามตาราง 2.4 (`event.source === window` เท่านั้น); `EXECUTE_JOB` → `window.postMessage({type:'AG_EXECUTE_JOB', job}, '*')`
- ตั้ง `window.__ANTIGRAVITY_CONTENT_INITIALIZED__ = true` และ `window.__ANTIGRAVITY_CLEANUP__`

### 4.4 `page.js` (main world ของหน้า Gemini, ~1,403 บรรทัด)

**ทำไมต้องมี script ใน main world:** content script อยู่ใน isolated world เห็น DOM แต่ไม่เห็น JS object ของหน้า (เช่น `inputEl.__quill`) และ event ที่สร้างจาก isolated world บางอย่างไม่ทำให้ Angular/Quill ของ Gemini อัปเดต state — page.js จึงถูก inject เป็น `<script src>` (ต้องประกาศใน `web_accessible_resources`) และคุยกับ content.js ผ่าน `window.postMessage`

**Guard:** `window.__ANTIGRAVITY_PAGE_LOADED__` โหลดครั้งเดียว; state ระดับโมดูล `activeObserver`, `activeJobId`, `idleTimer`, `activePollInterval`, `jobSequence` (token ต่อ job — job ที่ถูกแทนที่หยุดแตะ state ร่วม); `cleanupActiveJob()` ปิด observer/timer/poll ของ job ก่อน

**4.4.1 ตรวจอีเมลบัญชี — `detectAccountEmail()`**: regex `([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})` บน attribute `aria-label`/`alt`/`title`/`data-profile-email`/`data-user-email`/`innerText` ของ selector ตามลำดับ:
`a[aria-label*="บัญชี Google"]`, `a[aria-label*="Google Account"]`, `button[aria-label*="บัญชี Google"]`, `button[aria-label*="Google Account"]`, `a[href*="SignOutOptions"]`, `a[aria-label*="@"]`, `button[aria-label*="@"]`, `img[alt*="@"]`, `a[href*="accounts.google.com"]`, `[data-profile-email]`, `[data-user-email]`, `header [aria-label*="@"]`, `.gb_d [aria-label*="@"]`, `.gb_Fa [aria-label*="@"]`, `div[aria-label*="@"]`, `span[aria-label*="@"]`; แล้ว `meta[name="user-email"]`; แล้ว regex บน `innerHTML` ของ `header, [role="banner"], .gb_rd, .gb_d`; ตัด `googlers@google.com` และ `user@example.com` ทิ้ง (`isValidUserEmail`). ประกาศ `AG_DETECTED_EMAIL` ที่ 0.5 วิ, 2 วิ แล้วทุก 3 วิ; ตอนโหลดถ้ายังไม่เจอจะ poll ทุก 1 วิ ≤ 20 ครั้ง; ตอบ `AG_CHECK_EMAIL` ทันที

**4.4.2 กล่อง prompt — `findInputElement()`** (ตัวแรกที่มองเห็น; ถ้าไม่มีที่มองเห็นใช้ตัวแรก): `input-container rich-textarea .ql-editor`, `rich-textarea .ql-editor`, `chat-window .textarea`, `input-container [contenteditable="true"][role="textbox"]`, `chat-window [contenteditable="true"][role="textbox"]`, `div.ql-editor[contenteditable="true"]`, `div[contenteditable="true"][role="textbox"]`, `div[contenteditable="true"]`, `textarea[aria-label*="prompt" i]`, `rich-textarea`, `textarea`

**4.4.3 ปุ่ม Send — `GEMINI_SEND_BUTTON_SELECTORS`**: `chat-window button.send-button`, `button.send-button`, `button[aria-label*="Send" i]`, `button[aria-label*="ส่ง" i]`, `button[aria-label*="送出" i]`, `button[aria-label*="傳送" i]`, `button[aria-label*="Submit" i]`, `button[data-test-id*="send" i]`, `button[data-testid*="send" i]`, `.send-button-container button`, `button:has(mat-icon[fonticon="send"])`, `button:has([data-mat-icon-name="send"])`; fallback สแกน `button` ทุกตัวที่มองเห็นด้วย token `send/submit/ส่ง/ส่งข้อความ/送出/傳送/提交` ใน aria‑label/test‑id/text/icon; `isSendButtonEnabled` เช็ค `disabled`, `aria-disabled`, class `mat-mdc-button-disabled`

**4.4.4 ปุ่ม Stop (กำลัง generate) — `STOP_BUTTON_SELECTORS`**: `button.stop-button`, `button.stop`, `button[aria-label*="Stop response" i]`, `button[aria-label*="Stop generating" i]`, `button[aria-label="Stop" i]`, `button[aria-label*="หยุดการตอบกลับ" i]`, `button[aria-label*="หยุดการสร้าง" i]`, `button[aria-label*="หยุดสร้าง" i]`, `button[aria-label="หยุด" i]`, `button[data-test-id*="stop" i]`, `button[data-testid*="stop" i]`, `button:has(mat-icon[fonticon="stop"])`, `button:has([data-mat-icon-name="stop"])`, `button:has(mat-icon[fonticon="pause"])`, `button:has([data-mat-icon-name="pause"])`; ค้นเฉพาะใน composer (`input-container, .input-area, form.chat-input, .send-button-container`) แล้ว `chat-window, main`; fallback token `STOP_TOKENS = ['stop','หยุด','停止','중지','arrêter','detener','parar','anhalten']` (ตัดปุ่ม option/menu/copy ออก) — **`isGenerating()` เชื่อถือได้เฉพาะเมื่อ `stopButtonEverSeen`** (`isGeneratingDetectionReliable()`); ไม่เคยเห็นเลย → `warnStopDetectionOnce()`

**4.4.5 ตรวจว่าเสร็จ — `hasResponseFinished(el)`**: ปุ่ม `button[aria-label*="Copy" i], button[aria-label*="คัดลอก" i]` หรือ `button[aria-label*="Good response" i], button[aria-label*="คำตอบดี" i]` ที่มองเห็น หรือ `.response-footer.complete, .complete` (comment: container แบบ `.response-container-footer`/`message-actions` มีตั้งแต่เริ่ม turn ห้ามใช้เป็นสัญญาณ)

**4.4.6 Thinking placeholder — `isOnlyThinkingSoFar(text)`**: ตัด `<think>…</think>` ออก; ว่าง → true; หรือเหลือแค่ header `^(Interpreting the Prompt|Assessing the Prompt|Reviewing the Input|Considering the Prompt|Evaluating the Math|Formulating the Response|Thinking\.{0,3}|กำลังคิด\.{0,3})$`

**4.4.7 บล็อกคำตอบ — `getAllResponseBlocks()`**: selector ตามลำดับ (ใช้ชุดแรกที่เจอ ≥1 หลังกรอง `isAssistantBlock` = ไม่ใช่/ไม่มี `USER_QUERY_SELECTOR` = `user-query, .user-query, .query-text, .query-text-line, [data-test-id="user-query"]`): `model-response`, `response-container`, `.model-response-container`, `[data-test-id="model-response"]`, `message-content`, `.conversation-container:has(message-content)`, `.conversation-container`; Strategy 2: หา container จากปุ่ม Copy/Good response/Modify (`btn.closest('model-response, response-container, .conversation-container, [data-test-id="model-response"]')`)

**4.4.8 ดึงข้อความ — `extractCleanText(el)`**:
- target = `el.querySelector('.markdown, message-content, .response-container-content, [class*="markdown"], .model-response-text')` หรือ el
- thought = ตัวแรกของ `thinking-overlay`, `.thought-content`, `.thoughts-container`, `[data-test-id*="thought"]`, `.thinking-process`, `details.thought`, `.collapse-thought`
- clone แล้วลบ `button, mat-icon, response-action-buttons, message-actions, .response-container-footer, .action-button, thinking-overlay, .thought-content, .thoughts-container, [data-test-id*="thought"], .thinking-process, details.thought, .collapse-thought, [class*="processing-state"], [class*="thinking"], [class*="thought"], .model-response-label-announcer, [class*="model-response-label"], [class*="screen-reader"], .visually-hidden, [class*="visually-hidden"], [class*="sr-only"], .speaker-label, [aria-hidden="true"]` → `innerText`
- ตัด `Gemini บอกว่า`/`Gemini says`, ตัด header `^(Initiating|Interpreting|Assessing|Reviewing|Considering|Evaluating|Formulating|Analyzing|Exploring|Synthesizing)\s+[A-Za-z\s]+|Thinking...|กำลังคิด...`
- ถ้า mainText เท่ากับ/ขึ้นต้นด้วย thought → ตัดออก; ห่อ thought เป็น `<think>\n…\n</think>\n\n` นำหน้า (นี่คือที่มาของ `<think>` block ที่ client เห็น)
- ต่อท้าย `extractCanvasContent()` ถ้ายาว >30 และยังไม่อยู่ในข้อความ — `CANVAS_PANEL_SELECTORS`: `canvas-workspace`, `canvas-editor`, `immersive-editor`, `code-immersive-panel`, `text-immersive-panel`, `.immersive-editor`, `[data-test-id*="immersive"]`, `[data-test-id*="canvas-content"]`, `.canvas-container`, `.canvas-document`, `.canvas-code`, `.workspace-content`, `mat-card.canvas-card`, `.canvas-body`; ภายในหา `code, pre, .monaco-editor, .cm-content, textarea, .code-viewer` ก่อน

**4.4.9 `reconcileFinalText(streamed, onScreen)`**: onScreen ขึ้นต้นด้วย streamed → onScreen; streamed ขึ้นต้น `<think>…</think>` (FIX: `[ \t\r\n]*` ไม่บังคับ `\n\n`) และ onScreen ไม่มี think → `think + "\n\n" + onScreen`; ไม่งั้นเอาที่ยาวกว่า

**4.4.10 เตรียมหน้า:**
- `ensureFreshChatIfNeeded()`: ถ้า URL เป็น thread (`/(app|canvas)/<id>`) หรือมี response block เดิม → คลิกลิงก์ New chat: `a[data-test-id="side-nav-sparkle-button"]`, `a[aria-label*="แชทใหม่" i]`, `a[aria-label*="New chat" i]`, `[data-test-id="new-chat-button"] a`, `gem-nav-list-item[data-test-id="new-chat-button"] a` (หรือ host `[data-test-id="new-chat-button"]`, `button[aria-label*="แชทใหม่" i]`, `button[aria-label*="New chat" i]`) รอ ≤4 วิ; ยังไม่สะอาด → `window.location.assign('/u/N/app' หรือ '/app')` แล้วรอ 3 วิ (**การ navigate นี้ reload หน้า → page.js ถูกโหลดใหม่ และ job ที่กำลังทำจะหาย** — โค้ดยอมรับความเสี่ยงนี้เฉพาะกรณีบังคับ)
- `ensureCanvasMode()` (เมื่อ `job.canvas !== false`): ถ้า path มี `/canvas` ข้าม; ไม่งั้นหา `button, gem-button, [data-test-id], mat-icon-button` ที่ label match `/canvas|แคนวาส/i` (ไม่ใช่ ยกเลิก/deselect) แล้ว click รอ 600ms; **ห้าม** ใช้ `window.location.href` (จะ reload)
- `selectBestModel(targetModel)`: ตีความชื่อ → `wantPro`/`wantProThinking`/`wantFlashThinking`/`wantLite`/`wantFlashStandard` (`gemini-web`/`default` → flash thinking); ปุ่มสวิตช์ `[data-test-id="bard-mode-menu-button"]`, `button.model-picker-btn`, `button:has([data-test-id="logo-pill-label-container"])`, `[data-test-id="model-switcher"]`, `button[aria-label*="model" i]`, `button[aria-label*="โมเดล" i]`, `button[aria-label*="โหมด" i]`, `div[role="combobox"]`; ถ้าข้อความปุ่มบ่งว่าอยู่โหมดที่ต้องการแล้ว (เช่น มี `flash`/`3.8` + `thinking`/`extended`/`คิดที่นานขึ้น`) ข้าม; click → รอ 500ms → รายการ `gem-menu-item, [role="menuitem"], [role="option"], .mat-mdc-menu-item, mat-option` ที่มองเห็น → เลือกตาม intent (เช่น flash thinking = มี thinking/extended/คิดที่นานขึ้น และ (flash/3.8 หรือไม่ใช่ pro/advanced/เหตุผลขั้นสูง)) → click รอ 600ms; ไม่เจอ → ส่ง `Escape`

**4.4.11 `executeJob(job)` — ลำดับเต็ม**
1. `jobToken = ++jobSequence`; `cleanupActiveJob()`; `ensureFreshChatIfNeeded()`; `ensureCanvasMode()` (ถ้าไม่ปิด); `selectBestModel(job.model || 'gemini-3.8-flash-thinking')`
2. `findInputElement()` ไม่เจอ → `AG_JOB_ERROR` "Unable to locate Gemini prompt input box..."
3. **baseline snapshot**: `baselineBlocks` (identity `WeakSet` + 120 ตัวอักษรแรกของ innerText ใน `Set`) — เทียบ identity ไม่ใช่นับจำนวน (comment อธิบายว่านับอย่างเดียวพังเมื่อ thread เก่ายัง teardown ไม่เสร็จ)
4. ใส่ prompt: `focus()`; contentEditable → select all + `document.execCommand('insertText', false, prompt)`; ถ้าว่างอยู่ → ใส่ `<p>` ต่อบรรทัด; ถ้ามี `inputEl.__quill` หรือ `closest('rich-textarea').__quill` → `q.setText(prompt)`; textarea → `.value`; dispatch `InputEvent('beforeinput'/'input', {inputType:'insertText', data})` + `Event('beforeinput'/'input'/'change')`; ล้มเหลว → `textContent = prompt`
5. รอ ≤3.5 วิให้ปุ่ม Send enabled → `focus()+click()`; ไม่ได้ → dispatch `KeyboardEvent` Enter (keydown/keyup, keyCode 13, composed) รอ 300ms แล้ว click ปุ่มถ้าเจอ
6. รอ container คำตอบ ≤45 วิ (poll 350ms): baseline 0 → block ใดๆ ที่โผล่; baseline >0 → ต้อง `count > baselineCount` **และ** ไม่อยู่ใน baseline identity/text; ไม่เจอ → `AG_JOB_ERROR` "Timeout waiting for Gemini response container..." (**ตั้งใจไม่มี fallback ไปเฝ้า `chat-window`/`main` ทั้งหน้า** เพราะเคยคืนทั้งบทสนทนาและ finish ทันที)
7. เฝ้าคำตอบ: `emittedText` (high‑water mark), `lastExtraction`, `sawAnyText`, `sawRerender`; `emitDeltas()`:
   - re‑acquire target ถ้า `!isConnected` หรืออยู่ใน baseline
   - `current = extractCleanText(target)`; เปลี่ยนอะไรก็ตาม (แม้สั้นลง) → reset `lastTextChangeTime`
   - `normalizedCurrent` = ถ้า `emittedText` ขึ้นต้นด้วย `<think>…</think>` แต่ current ไม่มี → เติม think กลับ (FIX: regex ไม่บังคับ `\n\n`)
   - ถ้า `normalizedCurrent.length <= emittedText.length` → ไม่ส่ง (แค่ mark rerender)
   - ไม่งั้น `delta = normalizedCurrent.slice(commonPrefixLength(emittedText, normalizedCurrent))`; `emittedText = normalizedCurrent`; `AG_JOB_DELTA`
   - `rescueAnswerFromFreshBlocks()` (FIX): สแกนทุก block จากท้าย หา block ที่ไม่ใช่ target/baseline และมีข้อความที่ไม่ใช่ thinking → ย้าย observer ไปที่นั่น
   - `MutationObserver` (`childList, subtree, characterData`): `emitDeltas()`; ถ้า `hasResponseFinished && sawAnyText && !thinkingOnly` → timer 800ms → `finishJob()`; หรือ `sawAnyText && reliable && !isGenerating && !thinkingOnly` → timer 1200ms → finish
   - **poll ทุก 400ms**: C1 `hasResponseFinished && sawAnyText && !thinkingOnly && quiet>800ms` → finish; C2 `sawAnyText && reliable && !isGenerating && !thinkingOnly && quiet>2500ms` → finish; C3 stall: threshold = thinkingOnly ? `THINKING_STALL_MS`(45 000) : (isGenerating ? 20 000 : 10 000) — ถ้า thinkingOnly: ลอง rescue → finish; ยัง generating และ elapsed < `THINKING_MAX_MS`(300 000) → reset นาฬิกา รอต่อ; ไม่งั้น `AG_JOB_ERROR` "Gemini finished the thinking phase but never rendered an answer…" (FIX; FEAT จะ `finishJob()` แล้วส่ง `<think>Initiating the Calculation</think>` เป็นคำตอบ); ไม่ใช่ thinkingOnly → finish (stalled); F1 `!sawAnyText && elapsed>15s` → last‑chance extraction จาก block ใหม่ล่าสุด → finish, หรือถ้าดูเสร็จแล้ว → `AG_JOB_ERROR` "…no text could be extracted…"; F2 `elapsed > (job.timeout||600)*1000` → `AG_JOB_ERROR` "Execution timed out after Ns"
8. `finishJob()`: `cleanupActiveJob()`, `emitDeltas()` ครั้งสุดท้าย, `finalText = reconcileFinalText(emittedText, extractCleanText(target))`; canvas เปิดแต่ได้ <80 ตัวอักษรและไม่มี canvas content → `warnCanvasMissOnce()`; ส่ง `AG_JOB_DONE {jobId, text: finalText, finishReason:'stop'}`; หลัง 1 วิคลิก New chat (selector ชุดเดียวกับ 4.4.10) เพื่อเตรียม tab ให้ job ถัดไป

### 4.5 `offscreen.html` / `offscreen.js`
เอกสาร offscreen (สร้างด้วย reason `BLOBS`) เป็น DOM context ที่ Chrome ไม่ทิ้ง ใช้กัน MV3 service worker ถูก evict หลัง idle 30 วิ (สำคัญใน Docker 24/7): เชื่อม `chrome.runtime.connect({name:'offscreen-keepalive'})` (reconnect 1–2 วิ) และทุก 10 วิส่ง `port.postMessage({type:'offscreen-heartbeat', time})` + `chrome.runtime.sendMessage({type:'offscreen-ping', time})` (สอง channel เพื่อให้เกิด IPC event reset idle timer)

### 4.6 `popup.html` / `popup.js`
- แสดง badge `Connected (N accounts)` / `Disconnected` / `Error` จาก `GET_STATUS`
- ฟิลด์: **Bridge Server URL** (`bridgeUrl`), **Active Gemini Sessions (Multi‑Login)** รายการ tab (อีเมล + profile + จุดสีเขียว/ส้มตาม `connected`), **Target Bridge Profile (Optional Override)** (`profileSelect` เติมจาก `GET /v1/profiles`; ค่าว่าง = auto‑match ตามอีเมล), **Preferred Gemini Web Model** (`gemini-3.8-flash-thinking` (default), `gemini-3.8-flash`, `gemini-3.1-pro`, `gemini-3.5-flash-lite`), **Canvas Mode** toggle, **CLI Channel** (แสดงอย่างเดียว `🟢 Enabled`/`🔴 Disabled`/`🟢 Auto / Default`), **Web Extension Channel** toggle
- ปุ่ม **Save & Connect** → `SET_CONFIG` แล้ว reload popup; **Reload Ext** → `chrome.runtime.reload()`; **Open Gemini** → `chrome.tabs.create({url:'https://gemini.google.com/app'})`; เปิด popup ด้วย `?reload=true` = reload extension ทันที
- **ข้อบกพร่อง:** เมื่อสลับ toggle Web channel และมี profile override จะยิง `POST /v1/profiles/toggle` ด้วย body `{"profile", "channel":"web"}` **ไม่มี `enabled`** → bridge ใช้ default `enabled=True` เสมอ ⇒ ปิด toggle ในหน้าต่างไม่ได้ปิดฝั่ง bridge (ปิดได้เฉพาะฝั่ง extension เมื่อกด Save ซึ่งทำให้ `handleJobEvent` ตอบ error กลับ)

### 4.7 สิ่งที่ `fb3898e` เปลี่ยนฝั่ง extension
- `background.js` (+18/−4): `resolveProfile` ข้อ (5) ไม่เดาชื่อจาก username จนกว่าจะโหลด `/v1/profiles` แล้ว (กัน phantom profile)
- `page.js` (+107/−10): เพิ่ม `THINKING_STALL_MS`, `THINKING_MAX_MS`; regex think block ใน `reconcileFinalText`/`emitDeltas` ไม่บังคับ `\n\n`; เพิ่ม `rescueAnswerFromFreshBlocks()`; C3 stall ในสถานะ thinking‑only ไม่ถือว่าเสร็จอีกต่อไป (rescue → รอต่อ → error)

---

## 5. ฝั่ง Docker / noVNC (`deploy/`)

### 5.1 ภาพรวม
Container เดียว (`python:3.11-slim-bookworm`) รัน **supervisord** ที่คุม 6 โปรแกรม: `xvfb` (display `:99`, `1280x800x24`) → `fluxbox` (WM) → `x11vnc` (`start-vnc.sh`, port 5900 loopback) → `websockify` (`--web /usr/share/novnc 6080 127.0.0.1:5900` = noVNC) → `bridge` (`python3 /app/antigravity_bridge.py --host 0.0.0.0 --port 8000`) → `browser` (`start-browser.sh`, `stopsignal=TERM`, `stopwaitsecs=25`) ตาม priority 10→50; log แต่ละตัวที่ `/var/log/<name>.log` และ `<name>_err.log`

**ข้อสังเกตสำคัญ:** เอกสาร `deploy/README.md` และ Dockerfile พูดถึง "Chromium ×N (profile0…profile9)" และสร้างโฟลเดอร์ `/app/chrome-data/profile0..9` แต่ **`start-browser.sh` (ทั้ง FEAT และ FIX) รัน Chromium instance เดียว ใช้ `--user-data-dir=/app/chrome-data` เดียว และเปิด N *tab* ในหน้าต่างเดียวด้วย Google multi‑login (`/app`, `/u/1/app`, …)** — โฟลเดอร์ `profileN` ไม่ถูกใช้

### 5.2 `Dockerfile`
- apt: `wget curl gnupg ca-certificates xvfb fluxbox x11vnc novnc websockify supervisor procps net-tools dbus-x11 fonts-liberation fonts-thai-tlwg fonts-noto-color-emoji chromium`
- `ENV DISPLAY=:99 PYTHONUNBUFFERED=1`; `WORKDIR /app`; symlink `/usr/share/novnc/index.html → vnc.html` ถ้าไม่มี
- สร้าง `/app/chrome-data/profile0..9`, `/var/log`, `/var/run`
- `COPY deploy/{supervisord.conf,start-vnc.sh,start-browser.sh}` (แต่ compose ก็ mount ทับอีกที) ; `EXPOSE 6080 8000`; `CMD supervisord -c /app/deploy/supervisord.conf`
- **ไม่ COPY** `antigravity_bridge.py`, `extension/`, `bridge_config.json` — ทั้งหมดมาจาก bind mount

### 5.3 `docker-compose.yml` (FIX)
```yaml
name: antigravity-bridge2            # FIX (FEAT ไม่มี name:, ใช้ชื่อ antigravity-bridge)
services:
  antigravity-bridge:
    build: { context: .., dockerfile: deploy/Dockerfile }
    image: antigravity-bridge2:latest
    container_name: antigravity-bridge2
    restart: unless-stopped
    ports:
      - "127.0.0.1:${NOVNC_PORT:-6080}:6080"
      - "127.0.0.1:${BRIDGE_PORT:-8000}:8000"     # deploy/.env ของ FIX ตั้ง BRIDGE_PORT=8002
    volumes:
      - ./machine-id:/etc/machine-id:ro
      - ./machine-id:/var/lib/dbus/machine-id:ro
      - ./policies.json:/etc/chromium/policies/managed/policies.json:ro
      - ./chrome-data:/app/chrome-data                       # cookie/session ถาวร
      - ./supervisord.conf:/app/deploy/supervisord.conf:ro
      - ./start-browser.sh:/app/deploy/start-browser.sh:ro
      - ./start-vnc.sh:/app/deploy/start-vnc.sh:ro
      - ../extension:/app/extension:ro                       # unpacked extension
      - ../antigravity_bridge.py:/app/antigravity_bridge.py:ro
      - ../test_bridge.py:/app/test_bridge.py:ro
      - ../bridge_config.json:/app/bridge_config.json        # rw (bridge เขียนกลับได้)
      - ~/.gemini:/root/.gemini                              # OAuth ของ agy สำหรับ CLI fallback
    environment:
      - NOVNC_PASSWORD=${NOVNC_PASSWORD:-changeme}
      - PYTHONUNBUFFERED=1
      - CHROME_SCALE=${CHROME_SCALE:-0.8}
      - CHROME_ACCOUNTS=${CHROME_ACCOUNTS:-2}
      - CHROME_URLS=${CHROME_URLS:-}
      - ANTIGRAVITY_WEB_PRIORITY=${ANTIGRAVITY_WEB_PRIORITY:-true}
    shm_size: '2gb'
    security_opt: [ "seccomp:unconfined" ]
```
- port ผูกกับ `127.0.0.1` ของ host เท่านั้น (ตั้งใจให้ผ่าน SSH tunnel/Nginx)
- **กับดัก bind mount ไฟล์เดี่ยว:** Docker ผูกด้วย inode; ถ้าไฟล์ `bridge_config.json`/`antigravity_bridge.py` บน host ถูก *แทนที่* (git checkout/stash, editor ที่เขียนแบบ rename) mount จะหลุดเงียบๆ → bridge เห็นไฟล์ว่าง/เก่า → เหลือ profile `default` เดียว (test-docker.sh ใน FIX ตรวจเรื่องนี้; แก้ด้วย `docker compose up -d --force-recreate`)

### 5.4 `deploy/.env.example` (FIX)
```
NOVNC_PASSWORD=change_this_password
CHROME_ACCOUNTS=2                 # 1–10 tab/บัญชี
# CHROME_URLS=https://gemini.google.com/app,https://gemini.google.com/u/1/app
CHROME_SCALE=0.8
BRIDGE_PORT=8002                  # FEAT: 8000
NOVNC_PORT=6080
CONTAINER_NAME=antigravity-bridge2   # FIX (reset.sh/test-docker.sh อ่าน)
ANTIGRAVITY_WEB_PRIORITY=true
```

### 5.5 `start-browser.sh` (ผู้ควบคุม Chromium)
1. trap `SIGTERM/SIGINT` → `kill -TERM` Chromium รอ ≤20 วิ (ให้ SQLite cookie/WAL flush) แล้ว `kill -9`
2. รอ `/tmp/.X11-unix/X99` (≤15 วิ) และรอ `curl http://127.0.0.1:8000/health` (≤60 วิ)
3. ลบ lock ค้าง: `/app/chrome-data/Singleton*`, `/app/chrome-data/Default/Singleton*`, `.org.chromium.Chromium.*`, `/tmp/Singleton*`
4. Python inline แก้ `Default/Preferences` และ `Local State`: `profile.exit_type="Normal"`, `profile.exited_cleanly=true`, และ `session.restore_on_startup=1` (คง session cookie ข้าม restart)
5. หา binary: `/usr/lib/chromium/chromium` → `/usr/bin/chromium` → `/usr/bin/chromium-browser` → `/usr/bin/google-chrome`
6. `CHROME_ACCOUNTS` default 3 (compose ให้ 2), cap 10; `DEFAULT_URLS[i]` = `https://gemini.google.com/app` (i=0) หรือ `https://gemini.google.com/u/<i>/app`; `CHROME_URLS` (comma) override รายตำแหน่ง; `CHROME_SCALE` default 0.8
7. เปิด Chromium:
   ```
   --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=9222
   --user-data-dir=/app/chrome-data --load-extension=/app/extension
   --no-first-run --no-default-browser-check --password-store=basic
   --disable-session-crashed-bubble --hide-crash-restore-bubble
   --force-device-scale-factor=$CHROME_SCALE --high-dpi-support=1
   --disable-background-timer-throttling --disable-backgrounding-occluded-windows
   --disable-sync --disable-features=TranslateUI,DeviceBoundSessions
   --window-size=1280,800 --start-maximized  <URL0> <URL1> ...
   ```
   (`--load-extension` = โหลดแบบ **unpacked** จาก bind mount; แก้ไฟล์แล้วต้อง reload ที่ `chrome://extensions` หรือ `supervisorctl restart browser`)
8. รอ CDP `http://127.0.0.1:9222/json/version` (≤30 วิ), รอ 8 วิให้ tab โหลด
9. **FIX: `dedupe_tabs()`** — อ่าน `/json/list`, จัดกลุ่มตาม index `/u/N/` (ไม่มี = 0), เก็บ 1 tab ต่อ index โดยชอบ tab ที่ไม่ได้อยู่ใน thread (`/(app|canvas)/<id>`), ปิดที่เหลือด้วย `/json/close/<id>` (เหตุ: `RestoreOnStartup=1` restore session เก่า + URL จาก command line ⇒ tab เพิ่มขึ้นทุกครั้งที่ restart และ extension อาจเลือก tab เก่าที่ค้างใน thread)
10. background loop ทุก 300 วิ: `dedupe_tabs`; นับ tab `gemini.google.com`/`accounts.google.com`; ถ้าน้อยกว่า `CHROME_ACCOUNTS` → เปิด tab ที่หายด้วย `curl -X PUT "http://127.0.0.1:9222/json/new?<URL>"` (ตรวจ pattern `gemini\.google\.com/(app|canvas)` สำหรับ i=0 และ `/u/<i>/(app|canvas)` สำหรับอื่น)
11. `wait $BROWSER_PID`

### 5.6 `start-vnc.sh`
รอ X99; เขียน `/usr/share/novnc/index.html` ใหม่ให้ redirect ไป `vnc.html?autoconnect=true&resize=scale`; รหัสผ่านจาก env `noVNC_PASSWORD`/`NOVNC_PASSWORD` หรือ `/app/.env`; มีรหัส → `x11vnc -storepasswd` แล้ว `x11vnc -display :99 -forever -shared -rfbauth /tmp/.vnc_passwd -rfbport 5900 -listen 127.0.0.1`; ไม่มี → `-nopw` (loopback เท่านั้น)

### 5.7 `policies.json` (Chromium managed policy)
`SigninAllowed:false` (ปิด Chrome‑level sign‑in/sync — ไม่กระทบ web login ของ google.com), `SyncDisabled:true`, `RestoreOnStartup:1` (restore session เดิม → คง cookie), `DefaultCookiesSetting:1`, `BlockThirdPartyCookies:false`, `CookiesAllowedForUrls: ["https://[*.]google.com","https://[*.]google.co.th","https://[*.]youtube.com","https://gemini.google.com"]`

### 5.8 `machine-id`
ไฟล์ 32 hex ตัวเดียว mount เป็น `/etc/machine-id` และ `/var/lib/dbus/machine-id` (อ่านอย่างเดียว) — คอมเมนต์ใน compose: "fixed identity across container recreates" เพื่อไม่ให้ identity ของเครื่อง (ที่ Chromium/ระบบใช้) เปลี่ยนทุกครั้งที่ build/recreate container ซึ่งอาจทำให้ session/cookie ที่เข้ารหัสไว้ใช้ไม่ได้ (เหตุผลเชิงลึกเป็นการอนุมานจากคอมเมนต์ ไม่มีอธิบายเพิ่มในโค้ด)

### 5.9 `reset.sh`, `test-docker.sh`, `deploy/README.md`
- `reset.sh [restart|clean|logs]`: `restart` = `docker exec $CONTAINER_NAME supervisorctl restart browser` (ไม่เสีย cookie); `clean` = ถามยืนยัน → `docker compose down`, ลบ `./chrome-data`, `up -d` (login ใหม่ทั้งหมด); `logs` = `docker logs -f`; FIX อ่าน `CONTAINER_NAME` จาก `deploy/.env`
- `test-docker.sh [--check|--build|--logs]`: ตรวจไฟล์, สร้าง `bridge_config.json` = `{}` ถ้าไม่มี (กัน Docker สร้างเป็น directory), copy `.env` จาก example, ตรวจ docker/compose, `compose config`, (`--build`), container รันอยู่ไหม (`name=^${CONTAINER_NAME}$`), `curl :${NOVNC_PORT}/`, `/health`, `/extension/status` (FIX: regex รองรับ JSON pretty‑print `"connected_clients_count" : N`), **FIX: ตรวจว่า `/app/bridge_config.json` ในคอนเทนเนอร์ยังมี `"profiles"`** (bind mount ไม่หลุด), CDP 9222 + นับ tab Gemini, `--logs` = tail 30 บรรทัดของ supervisord/bridge/browser
- `deploy/README.md` (ไทย): ขั้นตอน Ubuntu 24.04 (install docker → clone → `.env` → `docker compose up -d --build` → SSH tunnel `ssh -L 6080:127.0.0.1:6080 -L 8000:127.0.0.1:8000 user@SERVER` → เปิด `http://127.0.0.1:6080` → login แต่ละ tab), ตัวอย่าง Nginx (vnc.yourdomain.com → 6080 พร้อม Upgrade header; api.yourdomain.com → 8000), คำสั่ง maintenance (`supervisorctl restart browser`, `stop/start x11vnc websockify`, `status`), troubleshooting (ตาราง), security checklist (รหัส noVNC, Nginx+SSL, ปิด 6080 เมื่อไม่ใช้, UFW, API key)
- FEAT→FIX diff ของ deploy: `.env.example` (+`CONTAINER_NAME`, `BRIDGE_PORT` 8000→8002), compose (`name:`, ชื่อ image/container/hostname `antigravity-bridge2`), `reset.sh`/`test-docker.sh` อ่าน `.env`, `supervisord.conf` เพิ่ม `[unix_http_server]`/`[rpcinterface:supervisor]`/`[supervisorctl]` (ไม่มี = `supervisorctl` ใช้ไม่ได้ → `reset.sh restart` พังเงียบ), `start-browser.sh` dedupe

### 5.10 มนุษย์ login Google ครั้งแรกอย่างไร
1. `cd deploy && cp .env.example .env` (ตั้ง `NOVNC_PASSWORD`, `CHROME_ACCOUNTS=N`) → `docker compose up -d --build`
2. จากเครื่องตัวเอง: `ssh -L 6080:127.0.0.1:6080 -L 8002:127.0.0.1:8002 user@SERVER` แล้วเปิด `http://127.0.0.1:6080` (auto‑connect, ใส่รหัส noVNC)
3. เห็นเดสก์ท็อป fluxbox + Chromium 1 หน้าต่างที่มี N tab: tab แรก `gemini.google.com/app` → กด Sign in → login บัญชี #1; tab ที่สอง `gemini.google.com/u/1/app` → Google จะพาไปหน้าเลือก/เพิ่มบัญชี → login บัญชี #2 (index 1) ฯลฯ (ลำดับ index ของ multi‑login ขึ้นกับลำดับที่ login — extension เรียนรู้ `emailByAccountIndex` เอง)
4. cookie ถูกเก็บใน `deploy/chrome-data/` (volume) จึงไม่ต้อง login ใหม่หลัง restart ตราบใดที่ไม่ลบโฟลเดอร์
5. ตรวจ: `curl http://127.0.0.1:8002/health | python3 -m json.tool | grep -E "web_connected|account_email"` และ `curl http://127.0.0.1:8002/extension/status`; หรือ `bash deploy/test-docker.sh`
6. ทดสอบ: `curl http://127.0.0.1:8002/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"gemini-web","messages":[{"role":"user","content":"Hello! What model are you?"}]}'`
7. reload extension หลังแก้โค้ด: ใน noVNC เปิด `chrome://extensions/` กด Reload หรือ `bash deploy/reset.sh restart`

---

## 6. ขั้นตอนติดตั้ง/ใช้งานตามที่ branch ออกแบบ และแผนการทำใหม่

### 6.1 ใช้งานบนเครื่องเดสก์ท็อป (ไม่ใช้ Docker)
1. รัน bridge: `python3 antigravity_bridge.py` (ฟัง `127.0.0.1:8000`); ถ้าจะให้เว็บมาก่อน: `ANTIGRAVITY_WEB_PRIORITY=1` หรือใส่ `"web_priority": true` ใน `~/.config/antigravity/bridge_config.json`
2. เตรียม `bridge_config.json` ให้มี `profiles.<name>.account_email` (หรือ `profile_emails`) ครบทุกบัญชีที่จะใช้ผ่านเว็บ — ไม่มี = extension จะ resolve ไม่ได้/เกิด phantom profile
3. Chrome → `chrome://extensions` → Developer mode → Load unpacked → เลือกโฟลเดอร์ `extension/`
4. เปิด `https://gemini.google.com/app` (และ `/u/1/app`, … ถ้ามีหลายบัญชี) ให้ login ครบ
5. คลิกไอคอน extension: ต้องเห็น badge Connected และรายการ session ที่มีอีเมล + profile; ถ้า auto‑match ไม่ได้ให้เลือก "Target Bridge Profile" แล้ว Save & Connect
6. ตรวจ `curl http://127.0.0.1:8000/extension/status`, `python3 antigravity_bridge.py profile list` (คอลัมน์ Web = 🟢 Connected)
7. ส่ง request: `{"model":"gemini-web", ...}` หรือ `{"model":"gemini-3.8-flash-thinking","channel":"web", ...}` หรือ header `X-Bridge-Channel: web`; `python3 test_bridge.py --chat "Hello" --channel web`
8. ปิด/เปิดช่องทาง: `python3 antigravity_bridge.py profile disable <p> --channel web` / `enable`

### 6.2 ใช้งานบนเซิร์ฟเวอร์ headless — ตาม 5.10

### 6.3 แผนการทำใหม่ (re‑implementation plan) — ลำดับงานและกับดัก
**ขั้น 0 — ตัดสินใจเรื่อง transport ก่อน:** ของเดิมใช้ SSE (bridge→ext) + HTTP POST (ext→bridge) ซึ่งทำงานได้กับ `BaseHTTPRequestHandler` แบบ thread‑per‑connection โดยไม่ต้องมี dependency; ถ้าจะทำใหม่บน Node.js edition ก็ใช้ SSE ได้เหมือนกัน (WebSocket ทำให้ต้องเพิ่ม lib) — จุดสำคัญคือ **ต้องมี keepalive ทุก ≤10 วิ** และ extension ต้อง **cycle การเชื่อมต่อทุก ~4 นาที** (Chrome ตัด fetch stream ที่ยาวมาก) โดย bridge ต้องไม่ retire client ที่มี job ค้าง

**ขั้น 1 — bridge core (ทำและทดสอบด้วย unit test ได้โดยไม่ต้องมีเบราว์เซอร์):**
1. `WebJob`/`WebClient`/`WebClientManager` ตาม 3.3 (รวมข้อแก้ของ FIX: `client_id` ownership, ไม่ retire busy client, `default` ต้องผูกกับอีเมล)
2. endpoints `/extension/events`, `/extension/{delta,done,error,debug}`, `/extension/status`; ยกเว้น auth บน loopback ทั้ง GET/POST
3. `execute_web_command()` + guard thinking‑only + reconcile "เอาที่ยาวกว่า"
4. เชื่อมเข้า fallback chain (`channel` param, `use_web` rules, Tier‑2, in‑flight, safety net) และ `get_ordered_profiles` (web buckets, `web_priority`)
5. ฟิลด์ `web_enabled/web_connected/account_email` ใน `/v1/profiles` และ `/health`; `bridge_config.json` (`profiles`, `profile_emails`, `web_priority`, `*_disabled_profiles`) — **แนะนำให้อ่าน `web_enabled`/`cli_enabled` ด้วย** เพื่อไม่ให้ตัวอย่าง config หลอกผู้ใช้เหมือนของเดิม
6. **ส่ง `output_callback` เข้าไปด้วยเมื่อ `stream=true`** ถ้าต้องการ streaming จริง (ของเดิมไม่ทำ)
7. unit tests: port ชุดใน `test_antigravity_bridge.py` (`test_web_client_manager_lifecycle`, `test_dynamic_fallback_cli_gemini_to_sonnet_to_web`, `test_in_flight_cli_quota_exhausted_falls_back_to_web`, `test_get_ordered_profiles_prioritizes_cli_gemini_then_sonnet_then_web`, `test_channel_disabling_and_persistence`, `test_channel_filtering_in_profile_manager`, `test_handle_done_*` 3 ตัว, `test_find_profile_by_email*`, `test_cli_execution_result_preserves_attributes`, `test_web_priority_routing_orders_web_first`, + 6 ตัวของ FIX)

**ขั้น 2 — extension โครง (ยังไม่แตะ DOM ของ Gemini):** manifest ตาม 4.1; background: config/storage, SSE client (parser `event:`/`data:`), reconnect/cycle/stale‑guards, offscreen keepalive, alarms, tab registry, `resolveProfile` (อย่าเดาชื่อ profile ก่อนได้รายชื่อจาก bridge), `handleJobEvent` (tab selection rules; อย่าหยิบ tab ของบัญชีอื่น); content.js relay + context‑invalidated reload; popup ขั้นต่ำ (bridge URL, override, model, canvas)

**ขั้น 3 — page.js DOM automation (ส่วนที่เปราะที่สุด — ทำทีละอย่างและมี log ชัดเจน):**
1. ตรวจอีเมล (selector 4.4.1) — ทดสอบทั้ง UI ภาษาไทย/อังกฤษ
2. หา input/ปุ่ม Send/ปุ่ม Stop/ปุ่ม Copy — เก็บ selector ไว้เป็น list ด้านบนไฟล์ + `warnOnce` เมื่อไม่พบ
3. new‑chat reset, model picker, canvas (ค่า default ปิด)
4. baseline‑snapshot + container wait + observer/poll + high‑water‑mark delta + thinking guard (`THINKING_STALL_MS` 45 s / `THINKING_MAX_MS` 300 s + rescue) + reconcile
5. ห้าม fallback ไปเฝ้าทั้ง `chat-window`; ล้มเหลวให้ส่ง error ที่บอกว่า selector ไหนน่าจะเก่า

**ขั้น 4 — Docker/noVNC:** ทำตาม 5.x โดยเก็บบทเรียน: `supervisorctl` socket sections, dedupe tab หลัง restart, ตรวจ bind mount, `CONTAINER_NAME`/port ใน `.env`, `shm_size`, `--disable-features=DeviceBoundSessions`, cookie policy

**ขั้น 5 — เครื่องมือทดสอบ:** `test_bridge.py` (ควรอ่าน field ของ `/health` ให้ตรงของจริง) และ `deploy/test-docker.sh`

**กับดักที่ควรจำ (สรุปจากคอมเมนต์ในโค้ด):**
- MV3 worker ถูก restart บ่อยมาก: state ใน memory หาย → ทุกอย่างต้อง re‑derive ได้ (scan tab ใหม่, refetch profiles) และอย่าตัดสินใจจาก cache ที่ยังว่าง
- `chrome.tabs.sendMessage` ล้มเหลวได้ถ้า content script ยังไม่พร้อม → `executeScript(content.js)` ก่อนเสมอ + retry
- Gemini re‑render ข้อความสั้นลง (thoughts panel ยุบ, markdown re‑render) → delta ต้องเทียบ common prefix ไม่ใช่ offset และ final text ต้อง reconcile
- ระหว่าง extended reasoning **ไม่มี** response container จนกว่า SPA จะ navigate `/app → /app/<threadId>` แล้วสลับ container → ต้อง re‑scan ด้วยเนื้อหา (rescue) ไม่ใช่นับจำนวน block
- Stop button label เปลี่ยนบ่อย → ใช้ `stopButtonEverSeen` เป็นเงื่อนไขก่อนเชื่อ `!isGenerating()`
- Canvas mode ทำให้ bubble เหลือ stub 11–25 ตัวอักษร → default off
- ทั้งสองฝั่งมี timeout เท่ากัน (`job.timeout`) → bridge ควรเผื่อมากกว่า extension เล็กน้อยเพื่อให้ได้ error message ที่ถูกต้องจากหน้าเว็บ
- `profile list`/`disable`/`enable` CLI ยิง `127.0.0.1:8000` แบบ hardcode — ควรอ่าน `ANTIGRAVITY_PORT`

---

## 7. ปัญหาที่พบ / ข้อจำกัด (จากคอมเมนต์ในโค้ด, README troubleshooting, tests และ commit แก้ไข)

### 7.1 ปัญหาที่ `fb3898e` แก้ (ชื่อ branch: "web-channel-no-response")
| อาการ | สาเหตุ | การแก้ |
| --- | --- | --- |
| reasoning prompt ได้คำตอบเป็น `<think>Initiating the Calculation</think>` ทั้งก้อน หรือไม่ได้คำตอบ | Gemini ไม่ render container ระหว่างคิด; C3 stall 45 วิ `finishJob()` ทั้งที่มีแต่ header; `getAllResponseBlocks` นับได้ 1 ทั้งก่อน/หลัง navigate (คนละ selector family) จึงไม่ re‑acquire | `THINKING_MAX_MS`, `rescueAnswerFromFreshBlocks`, error แทนการส่ง placeholder, bridge `is_thinking_only_text` raise → fallback |
| คำตอบถูกทิ้ง/ต่อผิดเมื่อ stream ลงท้ายที่ `</think>` พอดี | regex บังคับ `\n\n` หลัง `</think>` | regex `[ \t\r\n]*` |
| job หายกลางคันทุก ~4 นาที | SSE cycle → `register_client` retire client ที่ถือ job | ไม่ retire busy client |
| job ของ tab อื่นถูกล้มเมื่อ tab หนึ่งหลุด | `unregister_client` match ตาม profile | match ตาม `client_id` |
| `default` ดูเหมือนต่ออยู่แต่ job ตกลง queue ที่ไม่มีใครอ่าน | `is_profile_connected("default")` = มี client ใดก็ได้ | ต้องชื่อ default หรืออีเมลตรง |
| ตั้ง API key แล้ว web ไม่ทำงานเลย (ทุก request ตกไป CLI แล้ว timeout) | SSE/`/v1/profiles` โดน 401 | ยกเว้น loopback ใน `do_GET` |
| มี client ชื่อ `user1` ข้างๆ `default` (phantom) ไม่มี job ไปถึง | extension เดาชื่อจาก username ก่อน cache profile เต็ม | bridge remap ตามอีเมลเสมอ + extension defer |
| tab ซ้ำหลัง restart (3→6→9) และ prompt ถูกพิมพ์ลง thread เก่า | RestoreOnStartup + URL บน command line | `dedupe_tabs` |
| `deploy/reset.sh restart` ไม่ทำงาน | ไม่มี supervisorctl socket | เพิ่ม sections |
| `test-docker.sh` รายงาน 0 client เสมอ; ชน container ชื่อซ้ำ/พอร์ตซ้ำกับ bridge เดิม | regex/hardcode | อ่าน `.env`, `CONTAINER_NAME`, `BRIDGE_PORT=8002` |
| `bridge_config.json` หายในคอนเทนเนอร์หลัง git checkout | bind mount inode หลุด | ตรวจใน test-docker.sh |

### 7.2 ข้อจำกัดที่ยังอยู่ใน FIX
- **DOM drift:** ทุกอย่างพึ่ง selector/aria‑label (ไทย/อังกฤษ/จีน/เกาหลี/ฯลฯ) ของ Gemini; Google เปลี่ยนบ่อย → ต้องแก้ `page.js` ตามหลัง; thinking header regex เป็นภาษาอังกฤษ/ไทยเท่านั้น
- **Canvas:** ยังไม่มั่นใจว่าดึงจาก panel ได้ (default off + warn)
- **Streaming ไม่จริง:** API client ได้ heartbeat แล้วได้ทั้งก้อน (handler ไม่ส่ง `output_callback`)
- **Concurrency:** 1 tab ทำได้ทีละ job (job ใหม่ใน tab เดิม supersede job เก่าผ่าน `jobSequence`); bridge จำกัดด้วย `concurrency_per_profile`/sandbox lock ที่ออกแบบมาเพื่อ CLI
- **ไม่มี web cooldown จริง:** `family_cooldowns.web` ไม่เคยถูกตั้ง → ถ้าเว็บโดน rate‑limit bridge จะยังส่งไปเรื่อยๆ (แต่ error จะทำให้ fallback ไป CLI ใน auto)
- **การเลือกช่องทางแบบ implicit:** โมเดลที่มีคำว่า `thinking`/`high` ถูกส่งไปเว็บอัตโนมัติเมื่อ extension ต่ออยู่ แม้ไม่เปิด priority (อาจทำให้พฤติกรรมเปลี่ยนโดยผู้ใช้ไม่รู้)
- **Extension ↔ bridge อยู่คนละเครื่องไม่ได้** (auth ยกเว้นเฉพาะ loopback; `host_permissions` เฉพาะ 127.0.0.1/localhost)
- **popup toggle bug** (4.6); `last_heartbeat` ไม่อัปเดต; `test_bridge.py` อ่าน field ที่ไม่มี; `profile` CLI hardcode port 8000; README กล่าวถึง WebSocket `/ws` และ `profile toggle` ที่ไม่มีจริง
- **ความปลอดภัย:** `bridge_config.json` (มีอีเมลบัญชี) และ `~/.gemini` (OAuth credential ของ agy) ถูก mount เข้า container; noVNC เข้าถึง Chromium ที่ login Google ทุกบัญชี — รหัสผ่าน noVNC จึงเป็นด่านเดียว (compose default `changeme`!); Chromium รัน `--no-sandbox` + `seccomp:unconfined`; extension endpoint ไม่ต้องใช้ key จาก loopback (process ใดๆ ในเครื่อง/คอนเทนเนอร์ยิง `/extension/done` ปลอมได้ถ้ารู้ `job_id`); CDP 9222 เปิดใน container (loopback); API key ต้องตั้งเองเมื่อเปิด 8000 ออกอินเทอร์เน็ต
- **ข้อกำหนดของ Google:** การ automate หน้าเว็บ Gemini อาจขัด ToS/ถูกตรวจจับ — โค้ดไม่ได้จัดการเรื่องนี้ (ไม่ได้ตรวจสอบเชิงนโยบายในเอกสารนี้)

### 7.3 ตารางแก้ปัญหาจาก `deploy/README.md`
| อาการ | ทำอะไร |
| --- | --- |
| `web_connected: false` ทุก profile | ตรวจว่า login Google ครบทุก tab ใน noVNC (และอีเมลตรงกับ `bridge_config.json`) |
| Chromium crash วนซ้ำ | `docker exec <container> cat /var/log/browser.log` |
| noVNC ไม่มีภาพ | `cat /var/log/xvfb_err.log` |
| Extension ไม่ connect | Reload ที่ `chrome://extensions/` |
| Chrome login หาย | ตรวจว่า volume `chrome-data` ไม่ถูกลบ |

---

## 8. การกู้คืนจาก backup

ตำแหน่ง: `/Users/attasit/Library/CloudStorage/OneDrive-Personal/Projects/antigravity-bridge/backups/` (โฟลเดอร์นี้ git‑ignored, sync ผ่าน OneDrive; ตาม `backups/README.md` มีสำเนาบนเซิร์ฟเวอร์ที่ `~/antigravity-bridge-backups/` ด้วย)

| ไฟล์ | เนื้อหา | ขนาด |
| --- | --- | --- |
| `web-extension-branches-20260915.bundle` | git bundle; refs `refs/remotes/origin/feat/web-extension-bridge` (2fdbf3c) และ `refs/remotes/origin/fix/web-channel-no-response` (fb3898e); "records a complete history" (2 root commits) | ~199 KB |
| `feat-web-extension-bridge-2fdbf3c.tar.gz` | tree เต็มของ FEAT | ~181 KB |
| `fix-web-channel-no-response-fb3898e.tar.gz` | tree เต็มของ FIX (เวอร์ชันล่าสุด) | ~187 KB |
| local branches `backup/feat-web-extension-bridge`, `backup/fix-web-channel-no-response` | ยังอยู่ใน clone หลัก (`git branch`) | — |

```bash
cd /Users/attasit/Library/CloudStorage/OneDrive-Personal/Projects/antigravity-bridge

# 1) ตรวจ bundle
git bundle verify backups/web-extension-branches-20260915.bundle
git bundle list-heads backups/web-extension-branches-20260915.bundle
#   2fdbf3c7cf2a9701ef7477c57edb9c82da3c4029 refs/remotes/origin/feat/web-extension-bridge
#   fb3898e2ba1ec89a4509ecd0c4f75e08c8189c7d refs/remotes/origin/fix/web-channel-no-response

# 2) ดึงกลับเป็น branch ใหม่ในclone (ชื่อ restore/* เพื่อไม่ชน backup/*)
git fetch backups/web-extension-branches-20260915.bundle \
  refs/remotes/origin/fix/web-channel-no-response:refs/heads/restore/web-channel \
  refs/remotes/origin/feat/web-extension-bridge:refs/heads/restore/web-extension

# 3) ดูโค้ดโดยไม่กระทบ working tree ปัจจุบัน (แนะนำ worktree)
git worktree add /tmp/web-edition-fix restore/web-channel      # หรือ backup/fix-web-channel-no-response
git worktree add /tmp/web-edition-feat restore/web-extension

# 4) หรือแตกไฟล์จาก tar ตรงๆ
mkdir -p /tmp/web-edition && tar -xzf backups/fix-web-channel-no-response-fb3898e.tar.gz -C /tmp/web-edition
mkdir -p /tmp/web-edition-feat && tar -xzf backups/feat-web-extension-bridge-2fdbf3c.tar.gz -C /tmp/web-edition-feat

# 5) ถ้ามี local branch อยู่แล้ว
git checkout backup/fix-web-channel-no-response          # เวอร์ชันล่าสุด
git diff backup/feat-web-extension-bridge backup/fix-web-channel-no-response   # ดูสิ่งที่ fix เปลี่ยน
git diff main backup/fix-web-channel-no-response -- antigravity_bridge.py       # เทียบกับ main (คนละ lineage ผลจะรวมความต่างอื่นด้วย)

# 6) push กลับ remote (ถ้าต้องการ)
git push origin restore/web-channel:fix/web-channel-no-response
```
หมายเหตุ: หากเผลอลบ `backup/*` local branch ให้ทำข้อ 2 จาก bundle; หาก bundle เสียหายใช้ tar แล้ว `git init` ใหม่ได้ (จะเสีย commit hash เดิม)

---

## 9. สิ่งที่ยังไม่ได้ตรวจสอบ / ข้อสังเกตความคลาดเคลื่อนของเอกสารเดิม

1. **`Web Extension Execution Error: canceled`** — ไม่พบ string `canceled`/`cancelled` ในโค้ด Python/JS ของทั้งสอง branch; ข้อความจริงที่ bridge สร้างคือ `Web Extension Execution Error: <job.error>` โดย `job.error` มาจาก `/extension/error` หรือจาก bridge เอง (ดูตาราง 3.10); ที่มาของคำว่า "canceled" ยืนยันไม่ได้จากซอร์ส
2. **README (EN/TH) ระบุว่า extension ต่อ `ws://127.0.0.1:8000/ws` และใช้ "WebSocket heartbeats"/"simulated interactions"** — ไม่ตรงกับโค้ด (SSE + POST; keepalive ด้วย offscreen doc/port/alarms; ไม่มี simulated interaction) รวมถึงตัวอย่าง Nginx `/ws` ใน README จึงไม่จำเป็น
3. **README ระบุ `profile toggle <name> <cli|web> [on|off]`** — ไม่มี subcommand นี้ในโค้ด (มีแต่ `/v1/profiles/toggle` และ `profile disable|enable --channel`)
4. **`deploy/README.md`/Dockerfile พูดถึง Chromium หลาย instance/profile0..9** — โค้ดจริงใช้ instance เดียว + หลาย tab (multi‑login)
5. `bridge_config.json` ตัวอย่างใช้ `cli_enabled`/`web_enabled` ซึ่งโค้ดไม่อ่าน (อ่าน `cli`/`web`/`disabled`) — ยืนยันจากโค้ดแล้ว แต่ไม่ทราบว่าผู้เขียนตั้งใจหรือไม่
6. เหตุผลเชิงเทคนิคของ `machine-id` คงที่ — อนุมานจากคอมเมนต์ใน compose เท่านั้น
7. พฤติกรรมจริงของ Gemini UI (selector ใดยังใช้ได้ ณ วันนี้) — ไม่ได้ทดสอบกับหน้าเว็บจริงในเอกสารนี้; ทุก selector คัดลอกจากโค้ด ณ `fb3898e`
8. ไม่ได้รัน unit tests ของ branch ในการเขียนเอกสารนี้ (อ่านโค้ด test อย่างเดียว)
9. `test_bridge.py --docker` ใช้ default port 8080 ถ้าไม่มี `deploy/.env` (ขณะที่ FIX ตั้ง 8002) และเมนู interactive เช็ค `":8080"` ในการสลับเป้าหมาย — เป็นค่าตกค้างจาก FEAT
