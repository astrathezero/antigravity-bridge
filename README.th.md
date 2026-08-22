# Antigravity Bridge Server 🌉 (ภาษาไทย)

[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![Anthropic Compatible](https://img.shields.io/badge/API-Anthropic%20Compatible-orange.svg)](https://docs.anthropic.com/en/api/messages)
[![Imagen 3](https://img.shields.io/badge/Image-Google%20Imagen%203-purple.svg)](https://ai.google.dev/gemini-api/docs/imagen)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**ภาษา:** [🇺🇸 English](README.md) | **ภาษาไทย**

**Antigravity Bridge Server** คือ REST API Bridge Server ประสิทธิภาพสูง แบบ **Zero External Dependencies** (ใช้เฉพาะ Standard Library ของ Python 3) ที่ออกแบบมาเพื่อเชื่อมต่อระบบนิเวศของ `antigravity` / `agy` CLI เข้ากับมาตรฐาน **OpenAI API** และ **Anthropic Messages API** โดยเปลี่ยนบัญชี Google ในเครื่องของคุณให้กลายเป็น **Multi-Concurrent API Pool** พร้อมระบบสลับ Profile อัตโนมัติเมื่อโควตาเต็ม, รีเฟรช Token อัตโนมัติในเบื้องหลัง, รองรับ Tool/Function Calling และการสร้างรูปภาพผ่าน Google Imagen 3

---

> [!IMPORTANT]
> ### 📢 ข้อควรทราบ: การใช้งานข้ามเครื่อง (Cross-Machine Notice & Roadmap)
> **ปัจจุบัน Antigravity Bridge ทำงานบนเครื่อง Local / Host เดียวกันกับที่ติดตั้ง `antigravity`/`agy` CLI และ Profiles เท่านั้น**
> - โปรแกรมปลายทาง (เช่น Hermes Agent, OpenAI SDK, บอทเทรด, Webhook) สามารถเชื่อมต่อเข้ามาที่ Bridge ผ่านเครือข่าย HTTP จากเครื่องใดก็ได้
> - แต่ตัว Bridge Server เองจะประมวลผลคำสั่ง CLI บนเครื่อง Host ที่รัน Bridge เท่านั้น
> - **ยังไม่รองรับการกระจายงานไปประมวลผลบนหลายโหนดเครื่องข้ามระบบ (Cross-Machine / Distributed Worker)** โดยฟีเจอร์นี้อยู่ในแผนการพัฒนาสำหรับเวอร์ชันถัดไป (Roadmap)

> [!WARNING]
> ### ⚠️ คำเตือนและข้อกำหนดการใช้งาน (Terms of Service Notice)
> **โปรดอ่านอย่างละเอียดก่อนเริ่มใช้งาน:**
> - **เพื่อการศึกษา วิจัย และการใช้งานส่วนบุคคลเท่านั้น:** โปรเจกต์นี้เป็นเครื่องมือโอเพนซอร์สอิสระที่พัฒนาขึ้นเพื่อการทดสอบ การเชื่อมต่อระบบเฉพาะบุคคล และการทำงานอัตโนมัติในเครื่อง
> - **การปฏิบัติตามข้อกำหนดการให้บริการ (ToS):** การใช้สคริปต์อัตโนมัติ การครอบ REST API หรือการสลับบัญชีหลายบัญชีอาจไม่สอดคล้องกับข้อกำหนดการให้บริการ (Terms of Service) หรือนโยบายการใช้งานของ Google, Gemini หรือ Antigravity
> - **ความเสี่ยงต่อการถูกจำกัดสิทธิ์ / ระงับบัญชี:** การส่งคำขอจำนวนมากเกินไปหรือการสลับบัญชีถี่อาจส่งผลให้บัญชีติด Cooldown ชั่วคราว หรือถูกจำกัดการใช้งานจากผู้ให้บริการ
> - **ผู้ใช้ยอมรับความเสี่ยงด้วยตนเอง:** ผู้พัฒนาไม่มีส่วนรับผิดชอบต่อการถูกระงับบัญชี ข้อมูลสูญหาย หรือความเสียหายใดๆ ที่เกิดขึ้นจากการใช้งานซอฟต์แวร์นี้

---

## 📖 สารบัญ (Table of Contents)

- [🌟 สถาปัตยกรรมและการทำงาน (Overview & Architecture)](#-สถาปัตยกรรมและการทำงาน-overview--architecture)
- [✨ ฟีเจอร์หลัก (Key Features)](#-ฟีเจอร์หลัก-key-features)
- [📦 การติดตั้งและเริ่มต้นใช้งานด่วน (Quick Start)](#-การติดตั้งและเริ่มต้นใช้งานด่วน-quick-start)
  - [1. สิ่งที่ต้องมีก่อน (Prerequisites)](#1-สิ่งที่ต้องมีก่อน-prerequisites)
  - [2. โคลนและเตรียมไฟล์โปรเจกต์](#2-โคลนและเตรียมไฟล์โปรเจกต์)
  - [3. ตั้งค่าสภาพแวดล้อม (.env)](#3-ตั้งค่าสภาพแวดล้อม-env)
  - [4. เพิ่มโปรไฟล์บัญชี Google](#4-เพิ่มโปรไฟล์บัญชี-google)
  - [5. เริ่มรัน Bridge Server](#5-เริ่มรัน-bridge-server)
  - [6. ทดสอบและตรวจสอบสถานะ](#6-ทดสอบและตรวจสอบสถานะ)
- [🤖 ตารางโมเดลที่รองรับ (Supported Models Matrix)](#-ตารางโมเดลที่รองรับ-supported-models-matrix)
- [👤 คำสั่งจัดการโปรไฟล์ CLI (Profile Manager CLI)](#-คำสั่งจัดการโปรไฟล์-cli-profile-manager-cli)
- [📡 รายละเอียด REST API Endpoints](#-รายละเอียด-rest-api-endpoints)
  - [1. ตรวจสอบสถานะเซิร์ฟเวอร์ (`GET /health`)](#1-ตรวจสอบสถานะเซิร์ฟเวอร์-get-health)
  - [2. แสดงรายชื่อโมเดล (`GET /v1/models`)](#2-แสดงรายชื่อโมเดล-get-v1models)
  - [3. ส่งคำขอ OpenAI Chat Completions (`POST /v1/chat/completions`)](#3-ส่งคำขอ-openai-chat-completions-post-v1chatcompletions)
  - [4. ส่งคำขอ Anthropic Messages (`POST /v1/messages`)](#4-ส่งคำขอ-anthropic-messages-post-v1messages)
  - [5. สั่งสร้างรูปภาพ (`POST /v1/images/generations`)](#5-สั่งสร้างรูปภาพ-post-v1imagesgenerations)
  - [6. API จัดการสถานะโปรไฟล์แบบเรียลไทม์ (`/v1/profiles/*`)](#6-api-จัดการสถานะโปรไฟล์แบบเรียลไทม์-v1profiles)
- [⚙️ การตั้งค่าและตัวแปรสภาพแวดล้อม (Environment Variables)](#️-การตั้งค่าและตัวแปรสภาพแวดล้อม-environment-variables)
- [🤖 การเชื่อมต่อกับ Hermes Agent (`config.yaml`)](#-การเชื่อมต่อกับ-hermes-agent-configyaml)
- [🦞 การเชื่อมต่อกับ OpenClaw (`openclaw.json`)](#-การเชื่อมต่อกับ-openclaw-openclawjson)
- [💻 ตัวอย่างการเขียนโค้ดเรียกใช้งาน (Client SDKs)](#-ตัวอย่างการเขียนโค้ดเรียกใช้งาน-client-sdks)
- [🚀 การติดตั้งเพื่อใช้งานจริงในระดับ Production](#-การติดตั้งเพื่อใช้งานจริงในระดับ-production)
- [🔧 การแก้ไขปัญหาที่พบบ่อย (Troubleshooting & FAQ)](#-การแก้ไขปัญหาที่พบบ่อย-troubleshooting--faq)
- [🧪 การรันชุดทดสอบ (Unit Tests)](#-การรันชุดทดสอบ-unit-tests)
- [📄 สัญญาอนุญาต (License)](#-สัญญาอนุญาต-license)

---

## 🌟 สถาปัตยกรรมและการทำงาน (Overview & Architecture)

Antigravity Bridge ทำหน้าที่เป็น HTTP Gateway ตัวกลางในการรับคำขอมาตรฐานจาก Client ภายนอก แล้วกระจายไปยังโปรเซสย่อยของ `antigravity` / `agy` CLI ภายในเครื่อง:

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
│  ├── Smart Quota Detector (คำนวณ Cooldown อัตโนมัติ & สลับ Profile)    │
│  ├── Context Compactor & Heartbeat Generator (ป้องกัน Proxy Timeout)   │
│  ├── Background OAuth Auto-Refresh Daemon (รีเฟรชทุก 55 นาที)          │
│  └── Google Imagen 3 & Gemini Image Router                             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ แยก Sandbox ย่อยรายโปรไฟล์
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│         Isolated Runtime Sandboxes (~/.config/antigravity/sandboxes/)   │
│  ├── Sandbox [Profile 1] (ไร้ปัญหา DB Lock) ──► Google Gemini API      │
│  ├── Sandbox [Profile 2] (ไร้ปัญหา DB Lock) ──► Google Gemini API      │
│  └── Sandbox [Profile N] (ไร้ปัญหา DB Lock) ──► Google Gemini API      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ ฟีเจอร์หลัก (Key Features)

- ⚡ **Multi-Concurrent Profile Pool & การประมวลผลแบบขนาน**:
  - **Isolated Sandboxes**: รันแต่ละโปรไฟล์ในไดเรกทอรีเฉพาะแยกขาดจากกัน (`~/.config/antigravity/sandboxes/<profile>/`) หมดปัญหา SQLite database lock (`conversation_summaries.db`) และการชนกันของไฟล์ Auth
  - **ความจุขนานสูง**: กำหนดจำนวนคำขอพร้อมกันต่อโปรไฟล์ได้ (เช่น 14 โปรไฟล์ × 2 Concurrency = **รองรับพร้อมกันสูงสุด 28 คำขอ**)
- 🔄 **รองรับ 2 มาตรฐาน API (Dual Format)**: เข้ากันได้ 100% ทั้ง **OpenAI API** (`/v1/chat/completions`) และ **Anthropic API** (`/v1/messages`)
- 🛠️ **รองรับ Tool Calling & Function Calling**: แปลงคำจำกัดความเครื่องมือของ OpenAI และ Anthropic เข้าสู่ระบบ Prompt ของ CLI พร้อมดึงผลลัพธ์กลับมาเป็น Tool Call JSON แม่นยำ
- 🌊 **Real-Time SSE Streaming & Heartbeat**: ส่งข้อมูลแบบสตรีมมิ่งผ่าน Server-Sent Events พร้อมระบบส่งสัญญาณ Heartbeat เป็นระยะเพื่อป้องกัน Gateway/Reverse Proxy ตัดการเชื่อมต่อขณะโมเดลใช้เหตุผลลึก (Deep Reasoning)
- 🔀 **Zero-Downtime Smart Fallback & Fast-Fail**:
  - สลับหมุนเวียนโปรไฟล์ใน `~/.config/antigravity/profiles/` อัตโนมัติ
  - ตรวจจับข้อผิดพลาด `429 Too Many Requests` และ `RESOURCE_EXHAUSTED` ทันที
  - อ่านระยะเวลาฟื้นฟูโควตาจากข้อความระบบ (เช่น `Resets in 74h 7m 25s`) เพื่อตั้ง Cooldown แม่นยำ และสลับไปใช้โปรไฟล์ถัดไปทันทีโดยที่ Client ไม่หลุด
  - **Cooldown Skip & Fast-Fail**: ข้ามโปรไฟล์ที่กำลังติด Cooldown ทันทีโดยไม่เสียเวลายิงซ้ำ และแจ้ง Error ชัดเจนทันทีหากทุกโปรไฟล์ใน Pool ติด Limit ทั้งหมด
- 🚀 **รองรับ Prompt ขนาดใหญ่ (Large Prompt) & Adaptive Compaction**:
  - ส่งข้อความ Prompt ขนาดใหญ่เข้าสู่ CLI Argument ได้สูงถึง **350KB (~85,000 คำ)** โดยตรง ไม่ติดข้อจำกัด `ARG_MAX` ของระบบปฏิบัติการ
  - มีระบบบีบอัดประวัติและตัดข้อความตรงกลางอย่างชาญฉลาดเมื่อบริบทการสนทนายาวเกิน 350KB เพื่อให้การประมวลผลยังคงรวดเร็ว
- 🔒 **บันทึกสถานะโปรไฟล์ถาวร (Persistent Profile State)**: คำสั่ง `profile disable <name>` จะบันทึกลงไฟล์การตั้งค่า (`~/.config/antigravity/bridge_config.json`) และคงสถานะปิดไว้แม้จะ Restart เซิร์ฟเวอร์
- 🔄 **ระบบรีเฟรช Token อัตโนมัติในเบื้องหลัง**: Background Daemon ทำงานทุก 55 นาทีเพื่อต่ออายุ Google OAuth Access Token ป้องกัน Session หมดอายุ
- 🌐 **ตรวจจับ SOCKS5 / Cloudflare WARP Proxy อัตโนมัติ**: ตรวจหาพอร์ต Local Proxy (เช่น `40000`, `10808`, `7890`) อัตโนมัติเพื่อเชื่อมต่ออินเทอร์เน็ตได้ราบรื่น
- 🎨 **สร้างรูปภาพผ่าน Google Imagen 3**: รองรับเอนด์พอยต์ `/v1/images/generations` และแปลงคำสั่งสร้างภาพในแชท
- 🩺 **ระบบหมอตรวจเช็คระบบ (`doctor` / `diag`)**: ตรวจสอบการเชื่อมต่อ IP, ตรวจสถานะ Token กับ Google UserInfo API และล้างไฟล์ขยะ
- 🚀 **Zero External Dependencies**: พัฒนาด้วย Python 3 Standard Library ล้วน ไม่ต้องติดตั้งไลบรารีภายนอกด้วย `pip`

---

## 📦 การติดตั้งและเริ่มต้นใช้งานด่วน (Quick Start)

### 1. สิ่งที่ต้องมีก่อน (Prerequisites)
- **Python 3.8 ขึ้นไป** (`python3 --version`)
- ติดตั้ง **Antigravity CLI** (`antigravity` หรือ `agy`) และอยู่ใน PATH
- ติดตั้ง **Git**

### 2. โคลนและเตรียมไฟล์โปรเจกต์
```bash
git clone https://github.com/astrathezero/antigravity-bridge.git
cd antigravity-bridge
```

### 3. ตั้งค่าสภาพแวดล้อม (`.env`)
```bash
cp .env.example .env
nano .env
```
ตัวอย่างการตั้งค่าหลักใน `.env`:
```ini
ANTIGRAVITY_HOST=127.0.0.1
ANTIGRAVITY_PORT=8000
ANTIGRAVITY_PROFILE_CONCURRENCY=2
# ANTIGRAVITY_DISABLED_PROFILES=reserve_profile
# ANTIGRAVITY_BRIDGE_API_KEY=sk-antigravity
```

### 4. เพิ่มโปรไฟล์บัญชี Google
เพิ่มบัญชี Google เข้าสู่ระบบแบบ Interactive:
```bash
python3 antigravity_bridge.py login profile_1
python3 antigravity_bridge.py login profile_2
```
> **ขั้นตอนการล็อกอิน:**
> 1. เบราว์เซอร์จะเปิดหน้าต่าง Google OAuth ให้เลือกบัญชี Google และกดยินยอมสิทธิ์
> 2. เมื่อหน้าจอ Terminal กลับมาและแสดงเครื่องหมาย `>` ให้พิมพ์ว่า `hi` แล้วกด `Enter` เพื่อเริ่มใช้งาน
> 3. พิมพ์คำสั่ง `/exit` (หรือกด `Ctrl+D`) เพื่อบันทึกข้อมูล Token ลงใน `~/.config/antigravity/profiles/<ชื่อโปรไฟล์>/`

### 5. เริ่มรัน Bridge Server

#### วิธีที่ 1: ติดตั้งเป็น Systemd Service อัตโนมัติ (แนะนำสำหรับ Linux VPS)
```bash
chmod +x setup_systemd.sh
./setup_systemd.sh
```

#### วิธีที่ 2: รันตรงผ่าน Terminal
```bash
python3 antigravity_bridge.py
```

### 6. ทดสอบและตรวจสอบสถานะ
```bash
# ตรวจสอบสถานะโปรไฟล์และความจุ Concurrency:
python3 antigravity_bridge.py profiles

# ทดสอบเรียก Health Check ผ่าน cURL:
curl http://127.0.0.1:8000/health
```

---

## 🤖 ตารางโมเดลที่รองรับ (Supported Models Matrix)

| Model ID (`model`) | การแมปคำสั่ง CLI | ระดับ Reasoning | คำอธิบาย | ขนาด Context |
| :--- | :--- | :---: | :--- | :---: |
| **`gemini-3.7-flash-high`** | `--model gemini-3.7-flash` | `high` | Gemini 3.7 Flash (คิดวิเคราะห์ระดับสูง) | 1,000,000 |
| **`gemini-3.7-flash-medium`** | `--model gemini-3.7-flash` | `medium` | Gemini 3.7 Flash (คิดวิเคราะห์ระดับกลาง) | 1,000,000 |
| **`gemini-3.7-flash-low`** | `--model gemini-3.7-flash` | `low` | Gemini 3.7 Flash (คิดวิเคราะห์ระดับเร็ว) | 1,000,000 |
| **`gemini-3.7-flash`** | `--model gemini-3.7-flash` | - | Gemini 3.7 Flash (ค่ามาตรฐาน) | 1,000,000 |
| **`gemini-3.6-flash-high`** | `--model gemini-3.6-flash` | `high` | Gemini 3.6 Flash (คิดวิเคราะห์ระดับสูง) | 1,000,000 |
| **`gemini-3.6-flash`** | `--model gemini-3.6-flash` | - | Gemini 3.6 Flash (ค่ามาตรฐาน) | 1,000,000 |
| **`gemini-3.5-flash-medium`** | `--model gemini-3.5-flash` | `medium` | Gemini 3.5 Flash (คิดวิเคราะห์ระดับกลาง) | 1,000,000 |
| **`gemini-3.5-flash`** | `--model gemini-3.5-flash` | - | Gemini 3.5 Flash (ค่ามาตรฐาน) | 1,000,000 |
| **`gemini-3.1-pro-high`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (โมเดลเรือธงคิดวิเคราะห์สูง) | 2,000,000 |
| **`gemini-3.1-pro-low`** | `--model gemini-3.1-pro` | `low` | Gemini 3.1 Pro (โมเดลเรือธงคิดวิเคราะห์เร็ว) | 2,000,000 |
| **`gemini-3.1-pro`** | `--model gemini-3.1-pro` | `high` | Gemini 3.1 Pro (ค่ามาตรฐาน) | 2,000,000 |
| **`claude-sonnet-4.6-thinking`** | `--model claude-sonnet-4.6` | `thinking` | Claude Sonnet 4.6 (เปิดระบบ Extended Thinking) | 200,000 |
| **`claude-sonnet-4.6`** | `--model claude-sonnet-4.6` | - | Claude Sonnet 4.6 (มาตรฐาน) | 200,000 |
| **`claude-opus-4.6-thinking`** | `--model claude-opus-4.6` | `thinking` | Claude Opus 4.6 (เปิดระบบ Extended Thinking) | 200,000 |
| **`claude-opus-4.6`** | `--model claude-opus-4.6` | - | Claude Opus 4.6 (มาตรฐาน) | 200,000 |
| **`gpt-oss-120b-medium`** | `--model gpt-oss-120b` | `medium` | GPT-OSS 120B (Reasoning ปานกลาง) | 128,000 |
| **`gpt-oss-120b`** | `--model gpt-oss-120b` | - | GPT-OSS 120B (มาตรฐาน) | 128,000 |
| **`imagen-3.0-generate-002`** | Google Imagen 3 API | - | สร้างรูปภาพคุณภาพสูง (`/v1/images/generations`) | - |
| **`imagen-3.0-fast-generate-001`**| Google Imagen 3 Fast API | - | สร้างรูปภาพความเร็วสูง (`/v1/images/generations`) | - |
| **`gemini-3.1-flash-image`** | Gemini Image Router | - | สร้างรูปภาพรวดเร็วผ่าน Gemini Router | - |
| **`antigravity`** / **`agy`** | Default CLI backend | - | โมเดลสำรองอัตโนมัติ | 1,000,000 |

---

## 👤 คำสั่งจัดการโปรไฟล์ CLI (Profile Manager CLI)

เซิร์ฟเวอร์มีชุดคำสั่งจัดการโปรไฟล์ในตัวอย่างครบครัน:

| คำสั่ง | คำสั่งลัด | คำอธิบายการทำงาน |
| :--- | :--- | :--- |
| `python3 antigravity_bridge.py profile list` | `profiles` | แสดงตารางโปรไฟล์ อีเมล บัญชี สถานะ Cooldown โควตา และจำนวนคิว |
| `python3 antigravity_bridge.py profile login <ชื่อ>` | `login <ชื่อ>` | ล็อกอินและเพิ่มโปรไฟล์บัญชี Google ใหม่ |
| `python3 antigravity_bridge.py profile test [ชื่อ]` | - | ส่งคำขอทดสอบความพร้อมของโควตาและการตอบสนองของโมเดล |
| `python3 antigravity_bridge.py profile set <p1,p2>` | `profile order` | ปรับเปลี่ยนลำดับการสลับโปรไฟล์แบบ Live ทันที |
| `python3 antigravity_bridge.py profile disable <ชื่อ>` | - | ปิดการใช้งานโปรไฟล์แบบถาวร (คงสถานะปิดไว้แม้รีสตาร์ท Service จนกว่าจะเปิดใหม่) |
| `python3 antigravity_bridge.py profile enable <ชื่อ>` | - | เปิดใช้งานโปรไฟล์ที่เคยปิดไว้กลับคืนมา |
| `python3 antigravity_bridge.py profile reset [ชื่อ]` | - | รีเซ็ตสถานะ Cooldown และเคลียร์สถานะ Exhausted |
| `python3 antigravity_bridge.py profile refresh [ชื่อ]` | - | บังคับรีเฟรช OAuth Token กับทาง Google โดยตรง |
| `python3 antigravity_bridge.py profile sync <user@vps>` | - | คัดลอกโปรไฟล์ทั้งหมดไปยัง VPS ปลายทางผ่าน SSH |
| `python3 antigravity_bridge.py profile copy <ชื่อ> <vps>` | - | คัดลอกโปรไฟล์เดียวไปยังเครื่องปลายทางผ่าน SCP |
| `python3 antigravity_bridge.py profile remove <ชื่อ>` | - | ลบโฟลเดอร์โปรไฟล์ที่ไม่ได้ใช้ออกจากระบบ |
| `python3 antigravity_bridge.py doctor` | `diag` | ตรวจสุขภาพระบบ (เช็ค IP, Proxy, ตรวจสอบ Token และล้างไฟล์ขยะ) |

---

## 📡 รายละเอียด REST API Endpoints

### 1. ตรวจสอบสถานะเซิร์ฟเวอร์ (`GET /health`)
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

### 2. แสดงรายชื่อโมเดล (`GET /v1/models`)
```bash
curl http://127.0.0.1:8000/v1/models   -H "Authorization: Bearer sk-antigravity"
```

### 3. ส่งคำขอ OpenAI Chat Completions (`POST /v1/chat/completions`)

#### แบบสตรีมมิ่ง (Streaming SSE):
```bash
curl -N -X POST http://127.0.0.1:8000/v1/chat/completions   -H "Content-Type: application/json"   -H "Authorization: Bearer sk-antigravity"   -d '{
    "model": "gemini-3.7-flash-high",
    "messages": [
      {"role": "user", "content": "อธิบายสถาปัตยกรรม Microservices สั้นๆ 3 ข้อ"}
    ],
    "stream": true
  }'
```

### 4. ส่งคำขอ Anthropic Messages (`POST /v1/messages`)
```bash
curl -X POST http://127.0.0.1:8000/v1/messages   -H "Content-Type: application/json"   -H "x-api-key: sk-antigravity"   -H "anthropic-version: 2023-06-01"   -d '{
    "model": "claude-sonnet-4.6-thinking",
    "system": "คุณคือผู้เชี่ยวชาญด้านการออกแบบระบบ",
    "messages": [
      {"role": "user", "content": "เปรียบเทียบ Redis กับ Memcached"}
    ]
  }'
```

### 5. สั่งสร้างรูปภาพ (`POST /v1/images/generations`)
```bash
curl -X POST http://127.0.0.1:8000/v1/images/generations   -H "Content-Type: application/json"   -H "Authorization: Bearer sk-antigravity"   -d '{
    "model": "imagen-3.0-generate-002",
    "prompt": "A cybernetic dragon flying over futuristic Bangkok skyline at night, 8k photorealistic",
    "size": "1024x1024",
    "n": 1
  }'
```

### 6. API จัดการสถานะโปรไฟล์แบบเรียลไทม์ (`/v1/profiles/*`)
- `GET /v1/profiles` — ดูสถานะและสถิติของทุกโปรไฟล์
- `POST /v1/profiles/reset` — สั่งปลดล็อค Cooldown (`{"profile": "profile_1"}`)
- `POST /v1/profiles/check` — สั่งทดสอบโควตาสด (`{"model": "gemini-3.7-flash"}`)
- `POST /v1/profiles/config` — อัปเดตรายชื่อโปรไฟล์ที่ทำงานอยู่โดยไม่ต้องรีสตาร์ท (`{"profiles": ["p1", "p2"]}`)
- `POST /v1/profiles/disable` — สั่งปิดโปรไฟล์ชั่วคราว (`{"profile": "p1"}`)
- `POST /v1/profiles/enable` — สั่งเปิดใช้งานโปรไฟล์ (`{"profile": "p1"}`)

---

## ⚙️ การตั้งค่าและตัวแปรสภาพแวดล้อม (Environment Variables)

### ตัวแปรในไฟล์ `.env`

| ตัวแปร | ประเภท | ค่าเริ่มต้น | คำอธิบาย |
| :--- | :---: | :---: | :--- |
| **`ANTIGRAVITY_HOST`** | `str` | `127.0.0.1` | IP Interface ที่เซิร์ฟเวอร์จะเปิดรับคำขอ (`0.0.0.0` เพื่อรับจากทุก IP) |
| **`ANTIGRAVITY_PORT`** | `int` | `8000` | หมายเลขพอร์ตที่เปิดให้บริการ |
| **`ANTIGRAVITY_PROFILE_CONCURRENCY`** | `int` | `1` | จำนวนคำขอพร้อมกันสูงสุดต่อโปรไฟล์ (เช่น `2` เพื่อเพิ่ม Throughput) |
| **`ANTIGRAVITY_PROFILES`** | `str` | *Auto* | รายชื่อโปรไฟล์ที่ต้องการหมุนเวียน (คั่นด้วยจุลภาค) |
| **`ANTIGRAVITY_BRIDGE_API_KEY`** | `str` | `None` | API Key ที่บังคับให้ Client ต้องแนบมาเพื่อความปลอดภัย |
| **`ANTIGRAVITY_HIDE_PROFILE_STATUS`** | `int/bool`| `0` | ตั้งเป็น `1` เพื่อซ่อนข้อความสรุปโปรไฟล์/โควตาที่ท้ายคำตอบของโมเดล |
| **`ANTIGRAVITY_NO_PROXY`** | `int/bool`| `0` | ตั้งเป็น `1` เพื่อปิดระบบตรวจจับ Proxy และต่อเน็ตโดยตรง |
| **`ANTIGRAVITY_NO_AUTO_REFRESH`** | `int/bool`| `0` | ตั้งเป็น `1` เพื่อปิดระบบเบื้องหลังที่รีเฟรช Token ทุก 55 นาที |
| **`GEMINI_API_KEY`** | `str` | `None` | Google AI Studio Key สำหรับสร้างภาพด้วย Imagen 3 โดยตรง |
| **`ANTIGRAVITY_IMAGE_ROUTER_URL`** | `str` | *9router* | URL สำหรับเกตเวย์สร้างภาพภายนอก |

---

## 🤖 การเชื่อมต่อกับ Hermes Agent (`config.yaml`)

**Hermes Agent** สามารถเชื่อมต่อกับ Antigravity Bridge เพื่อใช้เป็น Custom OpenAI-Compatible Provider ที่รองรับทั้ง Real-time Streaming และ Tool/Function Calling เต็มรูปแบบ

### 1. แก้ไขไฟล์คอนฟิก `config.yaml`
เพิ่มบล็อก `agy-cli` ภายใต้ `custom_providers` ในไฟล์คอนฟิกของ Hermes (`~/.hermes/config.yaml` หรือ `~/.hermes/profiles/<ชื่อโปรไฟล์>/config.yaml`):

```yaml
model:
  default: gemini-3.7-flash-high
  provider: agy-cli

custom_providers:
  agy-cli:
    api: http://127.0.0.1:8000/v1
    api_key: sk-antigravity  # ตรงกับ ANTIGRAVITY_BRIDGE_API_KEY หรือใส่ข้อความใดๆ ก็ได้หากไม่ได้ตั้งรหัส
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

### 2. ตรวจสอบและสลับโมเดลผ่าน Hermes CLI
```bash
# 1. ตรวจสอบรายชื่อโมเดลที่เชื่อมต่อได้:
hermes models

# 2. สลับโมเดลเริ่มต้น:
hermes model set agy-cli/gemini-3.7-flash-high

# 3. เริ่มต้นเปิดแชทโดยเรียกผ่าน Antigravity Bridge:
hermes chat -m agy-cli/gemini-3.7-flash-high
```

---

## 🦞 การเชื่อมต่อกับ OpenClaw (`openclaw.json`)

**OpenClaw** (Autonomous Agent Gateway & Multi-Channel Runtime) สามารถเชื่อมต่อกับ Antigravity Bridge ผ่านโครงสร้าง Custom OpenAI-Compatible Provider:

### 1. แก้ไขไฟล์ `openclaw.json` (JSON5)
แก้ไขไฟล์คอนฟิก (`~/.openclaw/openclaw.json` หรือพาธที่ระบุใน `OPENCLAW_CONFIG_PATH`):

```json5
{
  "models": {
    "mode": "merge",
    "providers": {
      "antigravity": {
        "baseUrl": "http://127.0.0.1:8000/v1",
        "apiKey": "sk-antigravity", // รหัส API Key ที่ตั้งใน .env ของ Bridge
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

### 2. ตั้งค่าผ่านคำสั่ง OpenClaw CLI
สามารถใช้ CLI ของ OpenClaw ในการตั้งค่าได้โดยตรง:

```bash
# 1. กำหนด Endpoint และ API Key ของ Custom Provider
openclaw config set models.providers.antigravity.baseUrl "http://127.0.0.1:8000/v1"
openclaw config set models.providers.antigravity.apiKey "sk-antigravity"
openclaw config set models.providers.antigravity.api "openai-completions"

# 2. ตั้งค่าโมเดลหลักที่ต้องการใช้งาน
openclaw models set antigravity/gemini-3.7-flash-high

# 3. ตรวจสอบความถูกต้องของคอนฟิกและเช็คโมเดล
openclaw config validate
openclaw models list
```

### 3. สำหรับการรัน OpenClaw บน Docker (`openclaw-in-docker`)
หากรัน OpenClaw อยู่ใน Docker Container ให้ชี้ Base URL ไปยัง IP ของ Host เครื่องหลัก:

* **Linux Docker Host**: ชี้ไปที่ `http://172.17.0.1:8000/v1` หรือ `http://host.docker.internal:8000/v1` (โดยเพิ่ม `extra_hosts: ["host.docker.internal:host-gateway"]` ใน `docker-compose.yml`)
* ในไฟล์ `.env` ของ OpenClaw Docker:
  ```ini
  OPENAI_BASE_URL=http://172.17.0.1:8000/v1
  OPENAI_API_KEY=sk-antigravity
  ```

---

## 💻 ตัวอย่างการเขียนโค้ดเรียกใช้งาน (Client SDKs)

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8000/v1",
    api_key="sk-antigravity"
)

response = client.chat.completions.create(
    model="gemini-3.7-flash-high",
    messages=[{"role": "user", "content": "อธิบายหลักการทำงานของ Event Loop ใน Python"}]
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
    messages=[{"role": "user", "content": "เขียนโค้ด Binary Search ด้วยภาษา Rust"}]
)
print(message.content[0].text)
```

---

## 🚀 การติดตั้งเพื่อใช้งานจริงในระดับ Production

### 1. ติดตั้งผ่าน Systemd (Linux)
รันสคริปต์ติดตั้งอัตโนมัติ:
```bash
chmod +x setup_systemd.sh
./setup_systemd.sh
```

การจัดการเซอร์วิสผ่านคำสั่ง:
```bash
sudo systemctl status antigravity-bridge
sudo systemctl restart antigravity-bridge
sudo journalctl -u antigravity-bridge -f
```

### 2. ตั้งค่า Nginx Reverse Proxy รองรับสตรีมมิ่ง
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

        # ปิด Buffering เพื่อให้สตรีมมิ่งแบบเรียลไทม์ได้ลื่นไหล
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
```

---

## 🔧 การแก้ไขปัญหาที่พบบ่อย (Troubleshooting & FAQ)

### Q1: เพิ่มโปรไฟล์ใหม่แล้ว แต่ทำไมคำสั่ง `profiles` ไม่แสดงโปรไฟล์ใหม่?
- **สาเหตุ**: หากมีไฟล์ `~/.config/antigravity/bridge_config.json` อยู่ ระบบจะล็อกรายชื่อโปรไฟล์ตามไฟล์นั้นแทนการสแกนหาโฟลเดอร์ใหม่
- **วิธีแก้**: ลบไฟล์คอนฟิกล็อกทิ้งเพื่อให้ระบบสแกนหาโฟลเดอร์อัตโนมัติ:
  ```bash
  rm -f ~/.config/antigravity/bridge_config.json
  python3 antigravity_bridge.py profiles
  ```

### Q2: ต้องการทดสอบว่า Token ของแต่ละโปรไฟล์ยังใช้งานได้หรือไม่ ทำอย่างไร?
- **วิธีแก้**: ใช้คำสั่ง Diagnostic Doctor:
  ```bash
  python3 antigravity_bridge.py doctor
  ```

### Q3: โปรไฟล์ติด Cooldown ค้าง ต้องการปลดล็อกทำอย่างไร?
- **วิธีแก้**:
  ```bash
  python3 antigravity_bridge.py profile reset
  ```

---

## 🧪 การรันชุดทดสอบ (Unit Tests)

รันชุดทดสอบครอบคลุมทุก Endpoint, ระบบสตรีมมิ่ง, การตัดข้อความ, อัลกอริทึมการกระจายงาน, การข้าม Cooldown, รองรับ Large Prompt และคำสั่ง CLI (**ผ่านครบ 25/25 tests**):

```bash
python3 -m unittest test_antigravity_bridge.py -v
```

---

## 📄 สัญญาอนุญาต (License)

โปรเจกต์นี้เผยแพร่ภายใต้สัญญาอนุญาต [MIT License](LICENSE)
