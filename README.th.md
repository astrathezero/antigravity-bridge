# Antigravity Bridge Server 🌉 (ภาษาไทย)

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![Node.js 18+](https://img.shields.io/badge/node-18+-brightgreen.svg)](https://nodejs.org/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange.svg)](https://docs.anthropic.com/en/api/messages)
[![Imagen 3](https://img.shields.io/badge/Image-Google%20Imagen%203-purple.svg)](https://ai.google.dev/gemini-api/docs/imagen)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**ภาษา:** [🇺🇸 English](README.md) | **ภาษาไทย**

> **สถานะ release (v1.0.0, 2026-09-19)** v1.0.0 คือ release สุดท้ายที่มีทั้งสองรุ่น **รุ่น Python (`antigravity_bridge.py`, พอร์ต 8000) ถูก freeze ไว้ที่ v1.0.0** ยังใช้งานได้ตามที่ release ไว้แต่จะไม่มีฟีเจอร์ใหม่ **การพัฒนาหลังจากนี้มีเฉพาะรุ่น Node.js เท่านั้น** (`src/`, พอร์ต 8008) ถ้าเพิ่งเริ่มใช้วันนี้ให้เลือก Node.js

**Antigravity Bridge Server** คือ REST API Bridge แบบ Zero External Dependencies ที่รองรับมาตรฐาน OpenAI และ Anthropic สำหรับระบบนิเวศของ `antigravity` / `agy` CLI โดยเปลี่ยนบัญชี Google ที่ล็อกอินไว้ใน CLI บนเครื่องของคุณให้กลายเป็น API Cluster หลายโปรไฟล์ที่ทนทาน พร้อมระบบสลับโปรไฟล์อัจฉริยะ, fallback ทันทีเมื่อโควตาเต็ม, รีเฟรช OAuth อัตโนมัติในเบื้องหลัง, Tool Calling, SSE Streaming และการสร้างรูปภาพ

Repository นี้มี **เซิร์ฟเวอร์ตัวเดียวกันสองรุ่น (edition)** อยู่ใน folder เดียวกัน ใช้ `.env` เดียวกัน, ที่เก็บโปรไฟล์เดียวกัน และมีฟีเจอร์ครบเท่ากัน:

| | 🐍 รุ่น Python | ⚡ รุ่น Node.js |
| :--- | :--- | :--- |
| ไฟล์หลัก | `antigravity_bridge.py` | `src/index.mjs` |
| พอร์ตเริ่มต้น | `8000` | `8008` |
| Runtime | Python 3.8+ (Standard Library เท่านั้น) | Node.js 18+ (Native ESM ไม่ต้อง `npm install`) |
| โครงสร้างโค้ด | ไฟล์เดียว | แยกโมดูล (`src/core`, `src/translators`, `src/cli`, `src/image`) |
| Concurrency | Threads | Event loop แบบ non-blocking |
| หน่วยความจำโดยประมาณ | ~80–150 MB | ~35–55 MB |
| ชุดทดสอบ | `test_antigravity_bridge.py` (73 tests) | `tests/*.test.mjs` (37 tests) |

เลือกใช้รุ่นใดรุ่นหนึ่ง หรือรันทั้งสองรุ่นพร้อมกันบนพอร์ตเริ่มต้นของแต่ละรุ่นก็ได้ ดู [การเลือกรุ่นที่จะใช้](#-การเลือกรุ่นที่จะใช้-choosing-an-edition)

---

> [!IMPORTANT]
> ### 📢 ข้อควรทราบ: การใช้งานข้ามเครื่อง (Cross-Machine Notice)
> **Antigravity Bridge ทำงานบนเครื่องเดียวกันกับที่ติดตั้ง `antigravity`/`agy` CLI และโปรไฟล์ Google** แต่ client จากเครื่องอื่นสามารถเรียกใช้ได้
> - โปรแกรมปลายทาง (Hermes Agent, OpenAI SDK, Anthropic SDK, บอท, Webhook) เชื่อมต่อเข้ามาที่ Bridge ผ่าน HTTP จากเครื่องหรือเครือข่ายใดก็ได้
> - หากต้องการเปิดให้เข้าถึงจากภายนอก ให้ bind Bridge ไว้ที่ `127.0.0.1` ตามเดิม แล้วตั้ง **Nginx** เป็น reverse proxy พร้อม TLS ไว้ด้านหน้า (ดู [Nginx reverse proxy](#nginx-reverse-proxy-รองรับสตรีมมิ่ง)) เพิ่ม hostname สาธารณะใน `ANTIGRAVITY_ALLOWED_HOSTS` และ **เปิดใช้ API key** เพื่อให้เฉพาะ client ของคุณเรียกได้
> - **ระมัดระวังเรื่องความปลอดภัย:** Bridge รัน `agy` แบบปิดการขออนุญาต พอร์ตที่เปิดสู่ภายนอกโดยไม่มี auth จึงเท่ากับให้ remote shell บนเครื่อง Host อ่าน [โมเดลความปลอดภัย](#-โมเดลความปลอดภัย-security-model) ก่อนเปิดใช้งาน
> - ตัว Bridge จะรัน CLI บนเครื่อง Host เท่านั้น ยังไม่รองรับการกระจายงานไปยัง worker บนเครื่องอื่น

> [!WARNING]
> ### ⚠️ คำเตือนและข้อกำหนดการใช้งาน (Terms of Service Notice)
> - **เพื่อการศึกษา วิจัย และการใช้งานส่วนบุคคลเท่านั้น:** โปรเจกต์นี้เป็นเครื่องมือโอเพนซอร์สอิสระสำหรับการทดสอบ การเชื่อมต่อระบบเฉพาะบุคคล และการทำงานอัตโนมัติในเครื่อง
> - **ข้อกำหนดการให้บริการ (ToS):** การครอบ REST API หรือการสลับหลายบัญชีอาจไม่สอดคล้องกับ Terms of Service, Acceptable Use Policy หรือขีดจำกัดการใช้งานของ Google, Gemini และ Antigravity
> - **ความเสี่ยงต่อการถูกจำกัดสิทธิ์ / ระงับบัญชี:** การส่งคำขอถี่เกินไปหรือสลับบัญชีบ่อยอาจทำให้บัญชีติด Cooldown หรือถูกระงับจากผู้ให้บริการ
> - **ผู้ใช้ยอมรับความเสี่ยงด้วยตนเอง:** ผู้พัฒนาไม่รับผิดชอบต่อการถูกระงับบัญชี ข้อมูลสูญหาย หรือความเสียหายใดๆ

---

## 📖 สารบัญ (Table of Contents)

- [🧭 การเลือกรุ่นที่จะใช้](#-การเลือกรุ่นที่จะใช้-choosing-an-edition)
- [🌟 สถาปัตยกรรมและการทำงาน](#-สถาปัตยกรรมและการทำงาน-overview--architecture)
- [✨ ฟีเจอร์หลัก](#-ฟีเจอร์หลัก-key-features)
- [📦 การติดตั้งและเริ่มต้นใช้งานด่วน](#-การติดตั้งและเริ่มต้นใช้งานด่วน-quick-start)
- [🤖 ตารางโมเดลที่รองรับ](#-ตารางโมเดลที่รองรับ-supported-models-matrix)
- [👤 คำสั่งจัดการโปรไฟล์ CLI](#-คำสั่งจัดการโปรไฟล์-cli-profile-manager-cli)
- [🔑 คำสั่งจัดการ API Key](#-คำสั่งจัดการ-api-key-api-key-manager-cli)
- [📡 รายละเอียด REST API Endpoints](#-รายละเอียด-rest-api-endpoints)
- [🔒 โมเดลความปลอดภัย](#-โมเดลความปลอดภัย-security-model)
- [⚙️ การตั้งค่าและตัวแปรสภาพแวดล้อม](#️-การตั้งค่าและตัวแปรสภาพแวดล้อม-environment-variables)
- [🤖 การเชื่อมต่อกับ Hermes Agent](#-การเชื่อมต่อกับ-hermes-agent-configyaml)
- [🦞 การเชื่อมต่อกับ OpenClaw](#-การเชื่อมต่อกับ-openclaw-openclawjson)
- [💻 ตัวอย่างการเรียกใช้งานผ่าน SDK](#-ตัวอย่างการเรียกใช้งานผ่าน-sdk-client-sdks)
- [⏱️ ตัวเลือก Timeout และ Prompt ขนาดใหญ่](#️-ตัวเลือก-timeout-และการจัดการ-prompt-ขนาดใหญ่)
- [🚀 การติดตั้งเพื่อใช้งานจริง](#-การติดตั้งเพื่อใช้งานจริง-production-deployment)
- [🔧 การแก้ไขปัญหาที่พบบ่อย](#-การแก้ไขปัญหาที่พบบ่อย-troubleshooting--faq)
- [🧪 การรันชุดทดสอบ](#-การรันชุดทดสอบ-unit-tests)
- [🗄️ แบบเก็บถาวร: Web Extension Edition](#️-แบบเก็บถาวร-web-extension-edition)
- [📄 สัญญาอนุญาต](#-สัญญาอนุญาต-license)

---

## 🧭 การเลือกรุ่นที่จะใช้ (Choosing an Edition)

ทั้งสองรุ่นเปิด HTTP API แบบเดียวกัน อ่าน `.env` ไฟล์เดียวกัน และสลับโปรไฟล์ชุดเดียวกันใน `~/.config/antigravity/profiles/` จนถึง **v1.0.0** ทั้งสองรุ่นถูกพัฒนาไปพร้อมกัน (ทุก commit ที่เพิ่มฟีเจอร์แก้ทั้งสองรุ่น) หลังจากนั้น **พัฒนาเฉพาะรุ่น Node.js** ส่วนรุ่น Python คงไว้ตามที่ release ใน v1.0.0 ความต่างที่มีผลในการใช้งานประจำวันคือ:

| หัวข้อ | Python (`8000`) | Node.js (`8008`) |
| :--- | :--- | :--- |
| คำสั่งเริ่มรัน | `python3 antigravity_bridge.py` | `node src/index.mjs` หรือ `npm start` |
| ตัวแปร API key | `ANTIGRAVITY_BRIDGE_API_KEYS` / `ANTIGRAVITY_BRIDGE_API_KEY` | `ANTIGRAVITY_API_KEYS` / `ANTIGRAVITY_API_KEY` |
| จำนวน request พร้อมกันต่อโปรไฟล์ | `ANTIGRAVITY_PROFILE_CONCURRENCY` หรือ `--profile-concurrency` | `ANTIGRAVITY_CONCURRENCY_PER_PROFILE` |
| CLI สำหรับ login โปรไฟล์ / doctor | `profile login`, `doctor` | ไม่มีในตัว ให้ใช้ CLI ของ Python (หรือ `agy` โดยตรง) ครั้งเดียว |
| สคริปต์ติดตั้งเป็น service | `setup_systemd.sh` | `setup_systemd_node.sh`, `setup_launchd_mac.sh`, `setup_service_windows.ps1`, `run_windows.bat` |
| ตัวช่วย deploy แบบ staging-first | `safe_deploy.sh` (ดู `AGENTS.md`) | แก้โค้ด, รัน `npm test`, restart |

เนื่องจากชื่อตัวแปร key ต่างกัน `.env` ไฟล์เดียวจึงเก็บ key สำหรับพอร์ต Python ไว้ได้โดยพอร์ต Node ยังเปิดแบบไม่ต้องใช้ key (หรือกลับกัน) key ที่อยู่ในตัวแปรของอีกรุ่นจะถูกละเว้น ไม่ได้ถูกรวมกัน

**การรันทั้งสองรุ่นพร้อมกัน:** พอร์ตเริ่มต้นไม่ชนกันอยู่แล้ว หากต้องการแยก state ขณะรันด้วย ให้กำหนด quota cache และ sandbox root ของรุ่น Node แยกต่างหาก (ทั้งสองรุ่นรองรับตัวแปรนี้):

```ini
ANTIGRAVITY_QUOTA_CACHE_FILE=~/.config/antigravity/quota_cache_node.json
ANTIGRAVITY_SANDBOX_BASE=~/.config/antigravity/sandboxes-node
```

ใส่ค่าเหล่านี้ใน environment ของ service Node (สคริปต์ systemd ทำให้อัตโนมัติ) ไม่ใช่ใน `.env` ที่ใช้ร่วมกัน

---

## 🌟 สถาปัตยกรรมและการทำงาน (Overview & Architecture)

Antigravity Bridge เป็น HTTP gateway ระหว่างแอปพลิเคชันของคุณกับ subprocess ของ `antigravity`/`agy` CLI ในเครื่อง:

```
┌────────────────────────────────────────────────────────────────────────┐
│      External AI Clients (Hermes / OpenClaw / OpenAI & Anthropic SDK)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST / SSE Stream
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│     Antigravity Bridge Server  (Python :8000  และ/หรือ  Node.js :8008)  │
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

## ✨ ฟีเจอร์หลัก (Key Features)

- 🔑 **จัดการ API Key หลายชุดและแยก Agent**
  - กำหนด key แยกต่อ agent (Cursor, Hermes, Cline, Claude Dev) ใน `.env` จัดการผ่านคำสั่ง `key` ของรุ่นใดก็ได้
  - รองรับ `Authorization: Bearer <key>`, `x-api-key: <key>` หรือ `api-key: <key>`
- ⚡ **Profile Pool แบบรันพร้อมกันหลายคำขอ**
  - **Sandbox แยกต่อโปรไฟล์:** แต่ละโปรไฟล์รันใน runtime directory ของตัวเอง (`~/.config/antigravity/sandboxes/<profile>/`) ตัดปัญหา SQLite lock และไฟล์ auth ชนกัน
  - **ขยายความจุได้:** กำหนดจำนวนคำขอพร้อมกันต่อโปรไฟล์ (เช่น 14 โปรไฟล์ × 2 = 28 คำขอพร้อมกัน)
- 🔄 **รองรับสองมาตรฐาน:** ใช้แทน **OpenAI** (`/v1/chat/completions`) และ **Anthropic** (`/v1/messages`) ได้ทันที
- 🛠️ **Tool & Function Calling:** แปลง `tools`/`functions` ของ OpenAI และ `tools` ของ Anthropic ได้ทั้งสองทาง
- 🌊 **SSE Streaming และ Heartbeat:** สตรีมแบบ `text/event-stream` พร้อมส่ง heartbeat comment เป็นระยะ ป้องกัน proxy ตัดการเชื่อมต่อระหว่างโมเดลคิดนาน
- 🔀 **Smart Fallback & Fast-Fail**
  - สลับไปยังทุกโปรไฟล์ใน `~/.config/antigravity/profiles/`
  - ตรวจจับ `429`, `RESOURCE_EXHAUSTED` และ error โควตา แล้วอ่านเวลารีเซ็ต (`Resets in 74h 7m 25s`) เพื่อสลับไปโปรไฟล์ถัดไปโดยไม่ทำให้คำขอล้มเหลว
  - ข้ามโปรไฟล์ที่ติด cooldown โดยไม่ยิงคำขอซ้ำ และล้มเหลวทันทีเมื่อ pool หมดทั้งชุด
- 🚀 **รองรับ Prompt ขนาดใหญ่และการบีบอัด Context**
  - Prompt ไม่เกิน `ANTIGRAVITY_MAX_CLI_ARG_BYTES` (120 KB) ส่งให้ agy เป็น CLI argument ส่วนที่ใหญ่กว่านั้นส่งผ่าน stdin เป็น NDJSON ได้ถึง `ANTIGRAVITY_MAX_STDIN_PROMPT_BYTES` (2 MB) จึงไม่ติดขีดจำกัด `ARG_MAX` ของ Linux
  - เมื่อเกินงบ context (`ANTIGRAVITY_MAX_PROMPT_CHARS`, 200 KB) จะบีบอัดผลลัพธ์ tool เก่าๆ แทนการตัดบทสนทนาทิ้ง
- ⏱️ **Timeout แบบไดนามิก:** ขอเวลาได้สูงสุด **2 ชั่วโมง** ผ่าน header, body, query, ต่อท้ายชื่อโมเดล หรือ directive ใน prompt และขยายเวลาอัตโนมัติสำหรับ prompt เกิน 10 KB ดู [ตัวเลือก Timeout](#️-ตัวเลือก-timeout-และการจัดการ-prompt-ขนาดใหญ่)
- 🔒 **สถานะโปรไฟล์คงอยู่:** `profile disable <name>` ถูกบันทึกลง `~/.config/antigravity/bridge_config.json` และคงอยู่หลัง restart
- 🔄 **รีเฟรช OAuth อัตโนมัติ:** รีเฟรช access token ของ Google ทุก 55 นาที
- 🌐 **ตรวจจับ SOCKS5 / Cloudflare WARP อัตโนมัติ:** หา proxy ในเครื่องที่พอร์ต `40000`, `10808`, `7890` ฯลฯ
- 🎨 **สร้างรูปภาพ:** Google Imagen 3 (`imagen-3.0-generate-002`) และ Gemini image router ผ่าน `/v1/images/generations`
- 🩺 **Diagnostic Doctor** (CLI ของ Python): ตรวจ OAuth, เส้นทาง IP สาธารณะ และล้าง lock ค้าง
- 📦 **Zero External Dependencies** ทั้งสองรุ่น: Python ใช้ Standard Library เท่านั้น, Node.js เป็น native ESM ไม่ต้อง `npm install`

---

## 📦 การติดตั้งและเริ่มต้นใช้งานด่วน (Quick Start)

### 1. สิ่งที่ต้องมีก่อน (Prerequisites)
- **Antigravity CLI** (`antigravity` หรือ `agy`) ติดตั้งแล้วและอยู่ใน `PATH`
- **Git**
- **Python 3.8+** สำหรับรุ่น Python, **Node.js 18+** สำหรับรุ่น Node.js ผู้ใช้รุ่น Node ควรมี Python ด้วย เพราะคำสั่ง login โปรไฟล์และ `doctor` อยู่ใน CLI ของ Python

### 2. โคลนโปรเจกต์
```bash
git clone https://github.com/astrathezero/antigravity-bridge.git
cd antigravity-bridge
```

### 3. ตั้งค่า `.env`
```bash
cp .env.example .env
nano .env
```
ทั้งสองรุ่นค้นหาไฟล์ตามลำดับ: `./.env` (Python ดูใน directory ของสคริปต์ด้วย), `~/.config/antigravity/bridge.env`, `~/.config/antigravity/.env`, `~/.env` ค่าที่มีอยู่แล้วใน environment ของ process จะมีผลเหนือค่าในไฟล์

```ini
ANTIGRAVITY_HOST=127.0.0.1
ANTIGRAVITY_PORT=8000                 # Python; Node ไม่ใช้ค่านี้ถ้าไม่ระบุ --port (ค่าเริ่มต้น 8008)
ANTIGRAVITY_PROFILE_CONCURRENCY=1     # Python
# ANTIGRAVITY_CONCURRENCY_PER_PROFILE=1   # Node.js
# ANTIGRAVITY_DISABLED_PROFILES=reserve_profile
```

### 4. สร้าง API key (แนะนำอย่างยิ่ง)
หากไม่มี key เซิร์ฟเวอร์ทั้งสองรุ่นจะเริ่มในโหมด anonymous พร้อมแจ้งเตือน (ดู [โมเดลความปลอดภัย](#-โมเดลความปลอดภัย-security-model))

```bash
# รุ่น Python → เขียนลง ANTIGRAVITY_BRIDGE_API_KEYS
python3 antigravity_bridge.py key create agent-hermes
python3 manage_keys.py list

# รุ่น Node.js → เขียนลง ANTIGRAVITY_API_KEYS
node src/index.mjs key generate agent-hermes
node src/index.mjs key list
```

### 5. เพิ่มโปรไฟล์บัญชี Google
```bash
python3 antigravity_bridge.py login profile_1
python3 antigravity_bridge.py login profile_2
```
> **ขั้นตอน login:**
> 1. เบราว์เซอร์จะเปิดหน้า Google OAuth เลือกบัญชีและกดอนุญาต
> 2. เมื่อ terminal แสดง `>` ให้พิมพ์ `hi` แล้วกด `Enter` เพื่อ activate
> 3. พิมพ์ `/exit` (หรือ `Ctrl+D`) ข้อมูลจะถูกบันทึกที่ `~/.config/antigravity/profiles/<name>/`
>
> โปรไฟล์ใช้ร่วมกัน: login ครั้งเดียว ทั้งสองรุ่นมองเห็น

### 6. เริ่มรัน

**รุ่น Python (พอร์ต 8000)**
```bash
python3 antigravity_bridge.py                      # key จาก .env
python3 antigravity_bridge.py --api-key sk-agv-... # หรือระบุ key โดยตรง
./setup_systemd.sh                                 # หรือติดตั้งเป็น systemd service
```

**รุ่น Node.js (พอร์ต 8008)**
```bash
node src/index.mjs                                 # key จาก .env
node src/index.mjs --port 8008 --host 127.0.0.1 --api-key sk-agv-...
npm start                                          # เท่ากับ node src/index.mjs --port 8008
./setup_systemd_node.sh                            # service บน Linux
./setup_launchd_mac.sh                             # launchd บน macOS
.\setup_service_windows.ps1                        # service บน Windows (หรือ run_windows.bat)
```

### 7. ทดสอบและตรวจสอบสถานะ
```bash
python3 antigravity_bridge.py profiles             # สถานะ profile pool (ใช้ CLI รุ่นไหนก็ได้)
node src/index.mjs profile list

curl http://127.0.0.1:8000/health                  # liveness เท่านั้น ไม่ต้องใช้ key
curl http://127.0.0.1:8008/health
curl -H "Authorization: Bearer sk-agv-..." http://127.0.0.1:8000/health   # สถานะเต็ม
```

---

## 🤖 ตารางโมเดลที่รองรับ (Supported Models Matrix)

| Model ID (`model`) | คำสั่ง CLI ที่ใช้จริง | Reasoning Effort | คำอธิบาย | Max Context |
| :--- | :--- | :---: | :--- | :---: |
| **`gemini-3.8-flash-high`** | `--model gemini-3.8-flash` | `high` | Gemini 3.8 Flash (คิดละเอียดสูง) | 1,000,000 |
| **`gemini-3.8-flash-medium`** | `--model gemini-3.8-flash` | `medium` | Gemini 3.8 Flash (คิดละเอียดปานกลาง) | 1,000,000 |
| **`gemini-3.8-flash-low`** | `--model gemini-3.8-flash` | `low` | Gemini 3.8 Flash (คิดละเอียดต่ำ) | 1,000,000 |
| **`gemini-3.8-flash`** | `--model gemini-3.8-flash` | `high` | Gemini 3.8 Flash (มาตรฐาน) | 1,000,000 |
| **`gemini-3.7-flash-high`** | `--model gemini-3.7-flash` | `high` | Gemini 3.7 Flash (คิดละเอียดสูง) | 1,000,000 |
| **`gemini-3.7-flash-medium`** | `--model gemini-3.7-flash` | `medium` | Gemini 3.7 Flash (คิดละเอียดปานกลาง) | 1,000,000 |
| **`gemini-3.7-flash-low`** | `--model gemini-3.7-flash` | `low` | Gemini 3.7 Flash (คิดละเอียดต่ำ) | 1,000,000 |
| **`gemini-3.7-flash`** | `--model gemini-3.7-flash` | - | Gemini 3.7 Flash (มาตรฐาน) | 1,000,000 |
| **`gemini-3.6-flash-high`** | `--model gemini-3.6-flash` | `high` | Gemini 3.6 Flash (คิดละเอียดสูง) | 1,000,000 |
| **`gemini-3.6-flash`** | `--model gemini-3.6-flash` | - | Gemini 3.6 Flash (มาตรฐาน) | 1,000,000 |
| **`gemini-3.5-flash-medium`** | `--model gemini-3.5-flash` | `medium` | Gemini 3.5 Flash (คิดละเอียดปานกลาง) | 1,000,000 |
| **`gemini-3.5-flash`** | `--model gemini-3.5-flash` | - | Gemini 3.5 Flash (มาตรฐาน) | 1,000,000 |
| **`gemini-3.1-pro-high`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (คิดละเอียดสูง) | 2,000,000 |
| **`gemini-3.1-pro-low`** | `--model gemini-3.1-pro` | `low` | Gemini 3.1 Pro (คิดละเอียดต่ำ) | 2,000,000 |
| **`gemini-3.1-pro`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (มาตรฐาน) | 2,000,000 |
| **`claude-sonnet-4.6-thinking`** | `--model claude-sonnet-4.6` | `thinking` | Claude Sonnet 4.6 (Extended Thinking) | 200,000 |
| **`claude-sonnet-4.6`** | `--model claude-sonnet-4.6` | - | Claude Sonnet 4.6 | 200,000 |
| **`claude-opus-4.6-thinking`** | `--model claude-opus-4.6` | `thinking` | Claude Opus 4.6 (Extended Thinking) | 200,000 |
| **`claude-opus-4.6`** | `--model claude-opus-4.6` | - | Claude Opus 4.6 | 200,000 |
| **`gpt-oss-120b-medium`** / **`gpt-oss-128b`** | `--model gpt-oss-120b` | `medium` | GPT-OSS 120B / 128B (คิดละเอียดปานกลาง) | 128,000 |
| **`gpt-oss-120b`** | `--model gpt-oss-120b` | - | GPT-OSS 120B | 128,000 |
| **`imagen-3.0-generate-002`** | Google Imagen 3 API | - | สร้างรูปคุณภาพสูง (`/v1/images/generations`) | - |
| **`imagen-3.0-fast-generate-001`**| Google Imagen 3 Fast API | - | สร้างรูปแบบเร็ว (`/v1/images/generations`) | - |
| **`gemini-3.1-flash-image`** | Gemini Image Router | - | สร้างรูปผ่าน Gemini แบบเร็ว | - |
| **`antigravity`** / **`agy`** | CLI backend เริ่มต้น | - | เส้นทาง fallback เริ่มต้น | 1,000,000 |

---

## 👤 คำสั่งจัดการโปรไฟล์ CLI (Profile Manager CLI)

CLI ของทั้งสองรุ่นทำงานกับที่เก็บโปรไฟล์ชุดเดียวกัน จึงใช้สลับกันได้

| งาน | Python | Node.js |
| :--- | :--- | :--- |
| แสดงโปรไฟล์, อีเมล, lease, cooldown, โควตา | `python3 antigravity_bridge.py profile list` (ย่อ `profiles`) | `node src/index.mjs profile list` |
| Login / ลงทะเบียนโปรไฟล์ Google ใหม่ | `python3 antigravity_bridge.py login <name>` | — (ใช้คำสั่งของ Python) |
| ทดสอบโควตาและการตอบสนองของโมเดล | `python3 antigravity_bridge.py profile test [name]` | `node src/index.mjs profile probe [name]` |
| กำหนด pool และลำดับการหมุนเวียน | `python3 antigravity_bridge.py profile set p1,p2` (ย่อ `order`) | `node src/index.mjs profile set p1,p2` (ย่อ `order`) |
| ปิด / เปิดโปรไฟล์แบบถาวร | `profile disable <name>` / `profile enable <name>` | `profile disable <name>` / `profile enable <name>` |
| รีเซ็ต cooldown และสถานะ exhausted | `profile reset [name]` | `profile reset [name]` |
| บังคับรีเฟรช OAuth token | `profile refresh [name]` | `profile refresh [name]` |
| Sync โปรไฟล์ไปเครื่องอื่นผ่าน SSH | `profile sync <user@vps>` | — |
| คัดลอกโปรไฟล์เดียวผ่าน SCP / ลบโปรไฟล์ | `profile copy <name> <vps>` / `profile remove <name>` | — |
| Sync token ของโปรไฟล์เข้า credential store ของระบบ | — | `profile sync <name>` |
| วินิจฉัย (IP, proxy, token, ล้าง lock) | `python3 antigravity_bridge.py doctor` (ย่อ `diag`) | — |

---

## 🔑 คำสั่งจัดการ API Key (API Key Manager CLI)

Key ถูกเก็บใน `.env` รุ่น Python อ่านและเขียน `ANTIGRAVITY_BRIDGE_API_KEYS` ส่วนรุ่น Node.js ใช้ `ANTIGRAVITY_API_KEYS` ทั้งคู่ใช้รูปแบบ `label:key,label2:key2` เหมือนกัน

| งาน | Python | Node.js |
| :--- | :--- | :--- |
| แสดง key และ label | `python3 antigravity_bridge.py key list` หรือ `python3 manage_keys.py list` | `node src/index.mjs key list` |
| สร้าง key สุ่มใหม่ | `key create <label>` (ย่อ `generate`) | `key generate <label>` (ย่อ `create`) |
| ลงทะเบียน key ที่มีอยู่แล้ว | `key add <label> <key>` / `manage_keys.py add` | — |
| ยกเลิก key | `key revoke <label\|key>` | `key revoke <label>` |
| ทดสอบ key กับเซิร์ฟเวอร์ที่รันอยู่ | `key test <key>` / `manage_keys.py test <key>` | `curl -H "Authorization: Bearer <key>" http://127.0.0.1:8008/health` |

```ini
# รุ่น Python
ANTIGRAVITY_BRIDGE_API_KEYS=agent-cursor:sk-agv-a1b2c3d4,agent-hermes:sk-agv-e5f6g7h8
# รุ่น Node.js
ANTIGRAVITY_API_KEYS=agent-cursor:sk-agv-a1b2c3d4,agent-hermes:sk-agv-e5f6g7h8
```

ทั้งสองรุ่นยังมี `GET /v1/keys`, `POST /v1/keys/create` และ `POST /v1/keys/revoke` สำหรับทำงานเดียวกันผ่าน HTTP (ต้อง auth)

---

## 📡 รายละเอียด REST API Endpoints

Endpoint ด้านล่างเหมือนกันทั้งสองรุ่น ต่างกันเพียงพอร์ต ตัวอย่างใช้ `8000` เปลี่ยนเป็น `8008` สำหรับ Node.js

### 1. ตรวจสอบสถานะเซิร์ฟเวอร์ (`GET /health`)
```bash
curl http://127.0.0.1:8000/health                                        # → {"status":"ok","service":"antigravity-bridge","auth_required":true}
curl -H "Authorization: Bearer sk-agv-..." http://127.0.0.1:8000/health  # สถานะเต็มตามด้านล่าง
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

### 2. แสดงรายชื่อโมเดล (`GET /v1/models`)
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
    "messages": [{"role": "user", "content": "อธิบาย async concurrency ใน Python"}],
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
    "messages": [{"role": "user", "content": "เปรียบเทียบ Redis กับ Memcached"}]
  }'
```

### 5. สั่งสร้างรูปภาพ (`POST /v1/images/generations`)
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

### 6. API จัดการโปรไฟล์ (`/v1/profiles/*`)
- `GET /v1/profiles` — แสดง metric ของทุกโปรไฟล์
- `POST /v1/profiles/reset` — รีเซ็ต cooldown (`{"profile": "profile_1"}`)
- `POST /v1/profiles/check` — สั่งตรวจโควตาแบบ active (`{"model": "gemini-3.7-flash"}`)
- `POST /v1/profiles/config` — โหลดลำดับการหมุนเวียนใหม่ทันที (`{"profiles": ["p1", "p2"]}`)
- `POST /v1/profiles/disable` / `POST /v1/profiles/enable` — ปิด/เปิดโปรไฟล์ (`{"profile": "p1"}`)
- `GET /v1/config` — ค่าคอนฟิกที่มีผลอยู่ปัจจุบัน

---

## 🔒 โมเดลความปลอดภัย (Security Model)

Bridge รัน `agy` CLI ด้วย `--dangerously-skip-permissions` ดังนั้น **ใครก็ตามที่เข้าถึงพอร์ตได้ สามารถสั่งให้ agent รันคำสั่งและเขียนไฟล์บนเครื่องนี้ได้** ให้ปฏิบัติกับพอร์ตนี้เหมือน SSH การควบคุมด้านล่างใช้กับทั้งสองรุ่น

| การควบคุม | ค่าเริ่มต้น | หมายเหตุ |
| :--- | :---: | :--- |
| API key auth | แนะนำ | ไม่มี key เซิร์ฟเวอร์จะเริ่มในโหมด anonymous พร้อมแจ้งเตือน ทุก endpoint จะเปิดให้ทุกคนที่เข้าถึงพอร์ตได้ |
| ช่องทางส่ง key | Header เท่านั้น | `Authorization: Bearer`, `x-api-key` หรือ `api-key` **ไม่รับ** key ใน query string |
| การเปรียบเทียบ key | Constant-time | ต้องตรงกับ key ที่ตั้งไว้เท่านั้น |
| Bind address | `127.0.0.1` | การ bind `0.0.0.0` เปิด agent สู่เครือข่าย ถ้าจำเป็นให้วางหลัง reverse proxy ที่มี TLS |
| Host header | Allow-list | Loopback + bind host และ `ANTIGRAVITY_ALLOWED_HOSTS` ป้องกัน DNS-rebinding จากหน้าเว็บ |
| CORS | **ปิด** | `--enable-cors` ส่ง `Access-Control-Allow-Origin: *` เปิดเฉพาะกับ browser client ที่คุณควบคุมเอง |
| `/health` | Liveness เท่านั้น | ไม่มี key จะได้แค่ `{"status":"ok"}` รายละเอียดโปรไฟล์ต้องใช้ key |
| ไฟล์ token | `0600` | OAuth token, `.env` และ quota cache ถูกเขียนแบบเจ้าของอ่านได้คนเดียว การเขียน Keychain ส่งผ่าน stdin ไม่ใช่ argv |
| ชื่อโปรไฟล์ | `[A-Za-z0-9._-]` | ตรวจสอบทุก endpoint และ CLI (ห้าม `..`, `/`, control character) |
| การใช้ tool ของ agy | **บล็อก** | โหมด API: prompt บอกโมเดลไม่ให้ใช้ tool ของ agy หาก agy ยังเริ่ม tool step จะถูก kill ภายในหนึ่งวินาที ถ้า request กำหนด client-side tool ที่ทำงานเดียวกันไว้ (tool แบบ terminal สำหรับ `run_command` / `list_dir` / `grep_search` / `find_by_name`, tool อ่านไฟล์สำหรับ `view_file`) bridge จะตอบกลับเป็น client tool call นั้นแทน โดย log ว่า `[TOOL TRANSLATED]` (`ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS=0` ปิด) ไม่เช่นนั้นจะ retry หนึ่งครั้งบนโปรไฟล์เดิมพร้อมข้อความย้ำห้ามใช้ tool ซึ่งระบุชื่อ client-side tools ของ request นั้นด้วย (`ANTIGRAVITY_TOOL_BLOCK_RETRIES`, ค่าเริ่มต้น `1`) จากนั้นจึงล้มเหลวพร้อม error ที่ชัดเจน กรณีที่ agy จบการรันด้วย error `improperly formatted function call` ของมันเองทั้งที่โมเดลตอบ tool call ของฝั่ง client มาถูกต้องแล้ว bridge จะไม่นับเป็นความล้มเหลว แต่ log `[SALVAGED]` แล้วส่งคำตอบนั้นกลับแทนการย้ายไปโปรไฟล์อื่น `ANTIGRAVITY_ALLOW_CLI_TOOLS=1` เปิดโหมด agentic กลับมา มีตัวเลือกแคบกว่าหนึ่งตัวคือ `ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1` อนุญาตให้ agy อ่านเฉพาะ log บทสนทนาที่มันเขียนเองระหว่างรัน (agy ชี้โมเดลไปอ่านไฟล์นี้เมื่อ prompt ใหญ่เกินหนึ่ง turn) |
| โปรไฟล์ที่ quota หมด | Fast fail | **Node.js เท่านั้น** เมื่อ quota ของบัญชีหมด (`RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in 64h`) agy จะ retry เองซ้ำ ๆ ราว 2.5 นาทีทั้งที่ไม่มีทางสำเร็จ bridge จะอ่านข้อความ error จาก transcript ของการรันทันทีที่ agy บันทึก error step แล้วจบการรันภายในไม่กี่วินาที (`[QUOTA]` ใน journal) ใส่โปรไฟล์นั้นเข้า cooldown จนถึงเวลา reset และย้ายไปโปรไฟล์ถัดไป (`[FALLBACK]` หนึ่งบรรทัดต่อการสลับ) `ANTIGRAVITY_QUOTA_FAST_FAIL=0` ปิด โปรไฟล์ว่างจะถูกหมุนเวียนแบบ least-recently-used เพื่อกระจายการใช้ quota ไปทุกบัญชี (`ANTIGRAVITY_PROFILE_SELECTION=ordered` กลับไปใช้ลำดับตาม config) |
| Client ตัดการเชื่อมต่อ | ยกเลิก CLI | เมื่อ client ปิด connection (เช่น Hermes `/stop`) process ของ agy จะถูก kill แทนที่จะรันต่อ |

---

## ⚙️ การตั้งค่าและตัวแปรสภาพแวดล้อม (Environment Variables)

ใช้ร่วมกันทั้งสองรุ่น ยกเว้นที่ระบุว่าเป็นของรุ่นใดรุ่นหนึ่ง

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
| :--- | :---: | :--- |
| **`ANTIGRAVITY_HOST`** | `127.0.0.1` | Interface ที่ bind (`0.0.0.0` สำหรับทุก interface) |
| **`ANTIGRAVITY_PORT`** | `8000` / `8008` | พอร์ตที่รับฟัง Node รับ `PORT` / `BRIDGE_PORT` ด้วย |
| **`ANTIGRAVITY_PROFILE_CONCURRENCY`** | `1` | **Python เท่านั้น** จำนวนคำขอพร้อมกันสูงสุดต่อโปรไฟล์ |
| **`ANTIGRAVITY_CONCURRENCY_PER_PROFILE`** | `1` | **Node.js เท่านั้น** ความหมายเดียวกัน |
| **`ANTIGRAVITY_PROFILES`** | *อัตโนมัติ* | รายชื่อโปรไฟล์ที่จะหมุนเวียน คั่นด้วยจุลภาค |
| **`ANTIGRAVITY_PROFILE`** | — | ล็อกให้ใช้โปรไฟล์เดียว |
| **`ANTIGRAVITY_DISABLED_PROFILES`** | — | โปรไฟล์ที่ไม่เอาเข้าการหมุนเวียนและ fallback |
| **`ANTIGRAVITY_BRIDGE_API_KEYS`** / **`ANTIGRAVITY_BRIDGE_API_KEY`** | — | **Python เท่านั้น** รายการ key พร้อม label / key เดี่ยว |
| **`ANTIGRAVITY_API_KEYS`** / **`ANTIGRAVITY_API_KEY`** | — | **Node.js เท่านั้น** รายการ key พร้อม label / key เดี่ยว (อ่าน `BRIDGE_API_KEYS`, `API_KEYS` ด้วย) |
| **`ANTIGRAVITY_ALLOWED_HOSTS`** | — | ค่า `Host` header เพิ่มเติมที่ยอมรับ นอกเหนือจาก loopback และ bind host |
| **`ANTIGRAVITY_HIDE_PROFILE_STATUS`** | `0` | `1` ซ่อน footer สถานะโปรไฟล์ในคำตอบของ AI |
| **`ANTIGRAVITY_NO_PROXY`** | `0` | `1` ปิดการตรวจจับ proxy อัตโนมัติ |
| **`ANTIGRAVITY_NO_AUTO_REFRESH`** | `0` | `1` ปิด daemon รีเฟรช OAuth ทุก 55 นาที |
| **`ANTIGRAVITY_ALLOW_CLI_TOOLS`** | `0` | `1` อนุญาตให้ agy รัน tool ของตัวเอง (terminal/ไฟล์/เบราว์เซอร์) ระหว่างคำขอ API |
| **`ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS`** | `1` | ตอบ tool step ของ agy ที่ถูกบล็อกด้วย client-side tool call ที่เทียบเท่า เมื่อ request กำหนด tool นั้นไว้ (tool แบบ terminal สำหรับ `run_command`, `list_dir`, `grep_search`, `find_by_name`; tool อ่านไฟล์สำหรับ `view_file`) `0` ปิด |
| **`ANTIGRAVITY_TOOL_BLOCK_RETRIES`** | `1` | จำนวนครั้งที่ retry การรันที่ถูกบล็อกเพราะ tool บนโปรไฟล์เดิมพร้อมข้อความย้ำห้ามใช้ tool (ระบุชื่อ client-side tools ของ request ด้วยถ้ามี) `0` ปิด จะข้ามเมื่อมีข้อความสตรีมออกไปแล้ว |
| **`ANTIGRAVITY_ALLOW_TRANSCRIPT_READS`** | `0` | `1` อนุญาตให้ agy อ่านเฉพาะ log บทสนทนาของการรันปัจจุบัน (`<sandbox>/.gemini/antigravity-cli/brain/<conversation>/…`) คำสั่ง การเขียน และบทสนทนาอื่นยังถูกบล็อก |
| **`ANTIGRAVITY_QUOTA_FAST_FAIL`** | `1` | **Node.js เท่านั้น** จบการรัน agy ภายในไม่กี่วินาทีเมื่อ transcript ของการรันแสดง error quota แบบหมดจริง (`Individual quota reached … Resets in …`) แทนการรอ agy retry เอง ~2.5 นาที โปรไฟล์จะ cooldown จนถึงเวลา reset `0` ปิด |
| **`ANTIGRAVITY_PROFILE_SELECTION`** | `lru` | **Node.js เท่านั้น** เลือกโปรไฟล์ว่างตัวไหนรับคำขอถัดไป: `lru` = ตัวที่ไม่ได้ใช้นานที่สุด (กระจายการใช้ quota ไปทุกบัญชี โปรไฟล์ที่ปักหมุดด้วย `ANTIGRAVITY_PROFILE` ยังมาก่อนเสมอ), `ordered` = โปรไฟล์ว่างตัวแรกตามลำดับ config โปรไฟล์ที่อยู่ใน error back-off สั้น ๆ จะถูกลองเป็นตัวสุดท้ายในทั้งสองโหมด |
| **`ANTIGRAVITY_MAX_CLI_ARG_BYTES`** | `120000` | ขนาด prompt สูงสุดที่ส่งเป็น CLI argument ใหญ่กว่านี้จะส่งผ่าน stdin เป็น NDJSON ได้ถึง `ANTIGRAVITY_MAX_STDIN_PROMPT_BYTES` (2 MB) |
| **`ANTIGRAVITY_MAX_PROMPT_CHARS`** | `200000` | งบ context (UTF-8 bytes) เมื่อเกิน ผลลัพธ์ tool เก่าจะถูกบีบเหลือ `ANTIGRAVITY_OLD_TOOL_OUTPUT_CHARS` (2000) และของล่าสุดเหลือ `ANTIGRAVITY_RECENT_TOOL_OUTPUT_CHARS` (20000) |
| **`ANTIGRAVITY_PROFILE_TIMEOUT`** / **`ANTIGRAVITY_TOTAL_TIMEOUT`** | `600` / `1800` | วินาทีต่อการลองหนึ่งโปรไฟล์ / งบเวลารวมของ fallback |
| **`ANTIGRAVITY_MAX_AUTOSCALE_TIMEOUT`** / **`ANTIGRAVITY_MAX_TOTAL_TIMEOUT`** | `900` / `3600` | เพดานของ timeout ที่ขยายอัตโนมัติและที่ client ขอ |
| **`ANTIGRAVITY_STALL_TIMEOUT`** | `600` | วินาทีที่ CLI เงียบก่อนยกเลิกการรัน โมเดลที่คิดนานจะไม่พิมพ์อะไรระหว่างคิด จึงควรตั้งสูง |
| **`ANTIGRAVITY_FALLBACK_CHAIN`** / **`ANTIGRAVITY_MODEL_FALLBACK_ENABLED`** | — / `true` | ลำดับ fallback ระดับโมเดลเมื่อ family หนึ่งติด cooldown |
| **`ANTIGRAVITY_QUOTA_CACHE_FILE`** | `~/.config/antigravity/quota_cache.json` | ที่เก็บสถานะโควตา ควรแยกไฟล์ต่อรุ่นเมื่อรันทั้งสองรุ่น |
| **`ANTIGRAVITY_SANDBOX_BASE`** | `~/.config/antigravity/sandboxes` | Root ของ sandbox ต่อโปรไฟล์ ควรแยกต่อรุ่นเมื่อรันทั้งสองรุ่น |
| **`ANTIGRAVITY_BRIDGE_CMD`** | *อัตโนมัติ* | Template คำสั่ง CLI แบบกำหนดเอง (หรือ `--cmd`) |
| **`GEMINI_API_KEY`** | — | Google AI Studio key สำหรับ Imagen 3 โดยตรง |
| **`ANTIGRAVITY_IMAGE_ROUTER_URL`** / **`ANTIGRAVITY_IMAGE_ROUTER_KEY`** | — | Image gateway ภายนอกที่เข้ากับ OpenAI |

---

## 🤖 การเชื่อมต่อกับ Hermes Agent (`config.yaml`)

**Hermes Agent** ใช้ Bridge เป็น custom provider แบบ OpenAI-compatible ได้ทั้ง streaming และ tool calling เพิ่ม provider ใต้ `custom_providers` ใน `~/.hermes/config.yaml` หรือ `~/.hermes/profiles/<profile>/config.yaml` ชี้ `api` ไปยังรุ่นที่รัน (`8000` Python, `8008` Node.js) จะกำหนด provider แยกต่อพอร์ตก็ได้

```yaml
model:
  default: gemini-3.7-flash-high
  provider: agy-cli

custom_providers:
  agy-cli:
    api: http://127.0.0.1:8000/v1
    api_key: sk-antigravity  # key จากรายการ key ของรุ่นนั้น หรือค่าอะไรก็ได้ถ้าปิด auth
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
hermes models                                  # ดู custom model ที่โหลด
hermes model set agy-cli/gemini-3.7-flash-high # ตั้งค่าเริ่มต้น
hermes chat -m agy-cli/gemini-3.7-flash-high   # แชตผ่าน Bridge
```

---

## 🦞 การเชื่อมต่อกับ OpenClaw (`openclaw.json`)

**OpenClaw** เชื่อมต่อกับ Bridge เป็น custom provider แบบ OpenAI-compatible แก้ไข `~/.openclaw/openclaw.json` (หรือ path ใน `OPENCLAW_CONFIG_PATH`):

```json5
{
  "models": {
    "mode": "merge",
    "providers": {
      "antigravity": {
        "baseUrl": "http://127.0.0.1:8000/v1",   // หรือ :8008 สำหรับรุ่น Node.js
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

หรือผ่าน CLI:
```bash
openclaw config set models.providers.antigravity.baseUrl "http://127.0.0.1:8000/v1"
openclaw config set models.providers.antigravity.apiKey "sk-antigravity"
openclaw config set models.providers.antigravity.api "openai-completions"
openclaw models set antigravity/gemini-3.7-flash-high
openclaw config validate && openclaw models list
```

**OpenClaw บน Docker:** เข้าถึง host ด้วย `http://172.17.0.1:8000/v1` หรือ `http://host.docker.internal:8000/v1` (บน Linux เพิ่ม `extra_hosts: ["host.docker.internal:host-gateway"]`) เช่นตั้ง `OPENAI_BASE_URL=http://172.17.0.1:8000/v1` และ `OPENAI_API_KEY=sk-antigravity` ใน `.env` ของ container

---

## 💻 ตัวอย่างการเรียกใช้งานผ่าน SDK (Client SDKs)

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-antigravity")

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "อธิบาย event loop ของ Node.js เทียบกับ Python"}],
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
    messages=[{"role": "user", "content": "เขียน binary search ด้วยภาษา Rust"}],
)
print(message.content[0].text)
```

### Node.js (OpenAI SDK)
```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8008/v1", apiKey: "sk-antigravity" });

const stream = await client.chat.completions.create({
  model: "gemini-3.7-flash-high",
  messages: [{ role: "user", content: "สรุป CAP theorem" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

### Python (กำหนด Timeout ยาวพิเศษ: 20–30 นาทีสำหรับ Prompt ขนาดใหญ่)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="sk-antigravity",
    timeout=1800.0,  # client timeout 30 นาที
    default_headers={"X-Profile-Timeout": "30m"},
)

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "วิเคราะห์และ refactor โค้ดทั้ง repository ขนาด 100k token นี้..."}],
    extra_body={"profile_timeout": "30m"},
)
print(response.choices[0].message.content)
```

---

## ⏱️ ตัวเลือก Timeout และการจัดการ Prompt ขนาดใหญ่

สำหรับ prompt ขนาดใหญ่หรือการคิดที่ใช้เวลานาน คุณขอเวลาประมวลผลได้สูงสุด **2 ชั่วโมง** ด้วยวิธีใดวิธีหนึ่งด้านล่าง Bridge จะรายงานงบเวลาที่ใช้จริงใน response header `X-Antigravity-Profile-Timeout` และ `X-Antigravity-Total-Timeout` และจะขยายเวลาให้อัตโนมัติ (สูงสุด 60 นาที) สำหรับ prompt เกิน 10 KB เมื่อไม่ได้ระบุ

| วิธี | ตัวอย่าง |
| :--- | :--- |
| **HTTP header** | `X-Profile-Timeout: 30m`, `X-Execution-Timeout: 20m`, `OpenAI-Timeout: 1800`, `X-Timeout: 1800`, `Prefer: wait=1800` |
| **JSON body** | `{"model": "gemini-3.7-flash-high", "profile_timeout": "30m", ...}` หรือ `"timeout": 1800` |
| **`extra_body`** | `client.chat.completions.create(..., extra_body={"profile_timeout": "30m"})` |
| **URL query** | `POST /v1/chat/completions?timeout=30m` หรือ `?profile_timeout=20m` |
| **ต่อท้ายชื่อโมเดล** | `model: "gemini-3.7-flash-high:timeout=30m"`, `"gemini-3.7-flash-high:30m"`, `"gemini-3.7-flash?timeout=1800"` |
| **Directive ใน prompt** | `[antigravity:timeout=30m]` หรือ `<!-- timeout: 30m -->` ไว้ต้น prompt หรือ system instruction |

---

## 🚀 การติดตั้งเพื่อใช้งานจริง (Production Deployment)

### Systemd (Linux)
แต่ละรุ่นมีสคริปต์ติดตั้งของตัวเอง รันจาก directory ของ repo ได้ทั้งสองตัว สคริปต์จะสร้าง unit ที่ชี้มาที่ checkout นี้ ดังนั้น clone เดียวให้บริการได้ทั้งสองพอร์ต

```bash
./setup_systemd.sh          # antigravity-bridge.service      → Python, พอร์ต 8000
./setup_systemd_node.sh     # antigravity-bridge-node.service → Node.js, พอร์ต 8008 (quota cache + sandbox root แยก)

sudo systemctl status antigravity-bridge antigravity-bridge-node
sudo systemctl restart antigravity-bridge-node
sudo journalctl -u antigravity-bridge-node -f
```

การอัปเดตคือ `git pull --ff-only` ใน checkout แล้ว restart unit ที่เกี่ยวข้อง ควรรันชุดทดสอบก่อน ([การรันชุดทดสอบ](#-การรันชุดทดสอบ-unit-tests)) สำหรับรุ่น Python มี `safe_deploy.sh` ที่ครอบขั้นตอน stage → test → สลับไฟล์แบบ atomic → ตรวจ health → rollback (ดู `AGENTS.md`)

### macOS (launchd) และ Windows — รุ่น Node.js
```bash
./setup_launchd_mac.sh                # LaunchAgent สำหรับ node src/index.mjs
```
```powershell
.\setup_service_windows.ps1           # Windows service
.\run_windows.bat                     # หรือรัน foreground ธรรมดาที่พอร์ต 8008
```

### PM2 (ทุก OS) — รุ่น Node.js
```bash
npm install -g pm2
pm2 start src/index.mjs --name antigravity-bridge -- --port 8008
pm2 save && pm2 startup
```

### Nginx reverse proxy รองรับสตรีมมิ่ง
```nginx
server {
    listen 80;
    server_name bridge.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;      # หรือ 8008
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # จำเป็นสำหรับ SSE streaming และงานคิดนาน
        proxy_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
```
เพิ่ม `bridge.yourdomain.com` ใน `ANTIGRAVITY_ALLOWED_HOSTS` เพื่อให้ allow-list ของ Host ยอมรับคำขอที่ผ่าน proxy

---

## 🔧 การแก้ไขปัญหาที่พบบ่อย (Troubleshooting & FAQ)

### Q1: เพิ่มโปรไฟล์ใหม่แล้ว แต่ `profile list` ไม่แสดง
- **สาเหตุ:** ถ้ามีไฟล์ `~/.config/antigravity/bridge_config.json` Bridge จะล็อกรายชื่อโปรไฟล์ตามไฟล์นั้นแทนการสแกน folder
- **วิธีแก้:**
  ```bash
  rm -f ~/.config/antigravity/bridge_config.json
  python3 antigravity_bridge.py profiles      # หรือ: node src/index.mjs profile list
  ```

### Q2: ต้องการตรวจว่า OAuth token ของทุกบัญชียังใช้ได้หรือไม่
```bash
python3 antigravity_bridge.py doctor
```

### Q3: โปรไฟล์ติด cooldown ค้าง จะรีเซ็ตอย่างไร
```bash
python3 antigravity_bridge.py profile reset   # หรือ: node src/index.mjs profile reset
```

### Q4: ตั้ง API key แล้ว แต่อีกรุ่นยังตอบ `auth_required: false`
แต่ละรุ่นอ่านตัวแปรของตัวเอง: Python ใช้ `ANTIGRAVITY_BRIDGE_API_KEYS`, Node.js ใช้ `ANTIGRAVITY_API_KEYS` ให้สร้าง key ด้วย CLI ของรุ่นนั้น (`key create` / `key generate`) หรือเพิ่มตัวแปรตัวที่สองลง `.env`

### Q5: คำขอล้มเหลวด้วย `CLI tool execution blocked … view_file … transcript_full.jsonl`
Prompt ใหญ่เกินหนึ่ง turn ของ agy และโมเดลพยายามอ่าน transcript ของ agy เอง ให้ลดขนาด prompt หรือตั้ง `ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1` เพื่ออนุญาตการอ่านแบบ read-only นี้เพียงอย่างเดียว (ดู [โมเดลความปลอดภัย](#-โมเดลความปลอดภัย-security-model))

---

## 🧪 การรันชุดทดสอบ (Unit Tests)

```bash
# รุ่น Python (73 tests)
python3 -m unittest test_antigravity_bridge.py -v

# รุ่น Node.js (37 tests ใช้ node:test ไม่ต้องติดตั้ง dev dependency)
npm test
```

ทั้งสองชุดครอบคลุมการแปลง API, streaming, การเรียงลำดับโปรไฟล์, fallback routing, cooldown fast-fail, การส่ง prompt ขนาดใหญ่, การควบคุมความปลอดภัย และ CLI handler ชุดของ Node เขียนไฟล์เฉพาะใน `tests/.tmp-sandbox/`

---

## 🗄️ แบบเก็บถาวร: Web Extension Edition

"Web Extension Edition" รุ่นก่อนหน้า (Chrome extension + Docker/noVNC browser session เป็นช่องทางที่สองควบคู่กับ CLI) ถูกถอดออกจาก branch ที่ใช้งานเมื่อ 2026-09-15 การออกแบบ โปรโตคอล และบันทึกการ deploy เก็บไว้ที่ [docs/WEB_EXTENSION_BRIDGE_APPROACH.md](docs/WEB_EXTENSION_BRIDGE_APPROACH.md) ส่วนโค้ดเก็บเป็น git bundle นอก repository (ดูหัวข้อ 8 ของเอกสารนั้น)

---

## 📄 สัญญาอนุญาต (License)

โปรเจกต์นี้ใช้สัญญาอนุญาต [MIT License](LICENSE)
