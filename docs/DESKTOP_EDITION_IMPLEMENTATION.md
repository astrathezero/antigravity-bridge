# Antigravity Bridge Desktop Edition — สถานะการ implement และผล audit

| รายการ | ค่า |
| --- | --- |
| สถานะ | **ยังไม่พร้อม release.** `npm test` ผ่าน 113/113 บน macOS และ smoke test ของแอป Electron (dev mode) ผ่าน แต่ยังไม่เคยรันบน Windows, ยังไม่เคย build installer และยังไม่เคยล็อกอิน Google จริงผ่านแอป (หัวข้อ 4) |
| ผู้ implement | Gemini (Antigravity), 2026-09-24 |
| audit และแก้ไข | Claude, 2026-09-25 (ยังไม่ commit) |
| สเปก | [DESKTOP_EDITION_GUIDE.md](DESKTOP_EDITION_GUIDE.md) |
| หลักฐานการทดลอง | [spike-results.md](spike-results.md) |

> ฉบับก่อนหน้าของเอกสารนี้ (เขียนโดย Gemini) อ้างถึงสิ่งที่ไม่มีอยู่จริงหลายข้อ เช่น wizard 4 ขั้น, หน้าจัดการ API key, การตรวจ request ค้างก่อน restart, ความพร้อม notarization, "รันเสถียรบน Windows" และรายชื่อไฟล์ test ที่ไม่มีใน repo (`auth.test.mjs`, `executor.test.mjs`, `profile-manager.test.mjs`, `token-daemon.test.mjs`). ฉบับนี้เขียนใหม่จากโค้ดและผลรันจริง

---

## 1. `SSH_CONNECTION`: ทำไมตัวแปรชื่อ "SSH" ถึงทำให้ token แยกต่อโปรไฟล์ได้

**ไม่มีการเชื่อมต่อ SSH ใด ๆ เกิดขึ้น.** bridge ใส่ตัวแปร environment ชื่อ `SSH_CONNECTION` ให้โปรเซส `agy` เท่านั้น เพื่อสลับวิธีที่ agy เก็บ token

**ปัญหาที่แก้:** agy (โปรแกรม Go ใช้ไลบรารี `zalando/go-keyring`) เก็บ OAuth token ไว้ใน keyring ของ OS คือ macOS Keychain, Windows Credential Manager หรือ Linux Secret Service. keyring มี entry `gemini`/`antigravity` **ช่องเดียวต่อเครื่อง** ถ้า bridge หมุนหลายบัญชี ก็ต้องเขียนทับช่องนั้นก่อนทุก run ผลคือ run ที่ทับซ้อนกันอาจอ่าน token ของบัญชีอื่น (โควตาถูกหักผิดบัญชี) และ token ที่ผู้ใช้ล็อกอิน agy ไว้ใช้เองก็ถูกทับ

**กลไกที่ใช้:** agy มี "composite token storage" ในตัว. ฟังก์ชัน `codeassistclient.shouldBypassKeyring()` ตรวจว่ากำลังรันในสภาพแวดล้อมที่ keyring ใช้ไม่ได้หรือไม่ ได้แก่ SSH session (`SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`), WSL, container และเครื่องที่ไม่มี D-Bus. ถ้าใช่ agy จะเก็บ token เป็น **ไฟล์** ที่ `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` แทน keyring. Google ทำไว้สำหรับคนที่ SSH เข้าเครื่องอื่น เพราะในกรณีนั้นไม่มีหน้าจอให้ Keychain หรือ Credential Manager ถามสิทธิ์ (เอกสารทางการระบุด้วยว่าใน SSH agy จะพิมพ์ URL ให้ล็อกอินแทนการเปิดเบราว์เซอร์)

`sshd` ตั้ง `SSH_CONNECTION="<client-ip> <client-port> <server-ip> <server-port>"` ให้ทุก SSH session. agy ดูเพียงว่าตัวแปรนี้มีค่า bridge จึงใส่ค่าคงที่ `127.0.0.1 0 127.0.0.1 22` ซึ่งไม่ใช่ที่อยู่จริง (`AGY_FILE_MODE_ENV` ใน `src/config.mjs`)

```
keyring mode (ไม่มี SSH_CONNECTION)               file mode (bridge ใส่ SSH_CONNECTION ให้ agy)
┌──────────┐  ┌──────────┐                        ┌──────────┐              ┌──────────┐
│ agy (A)  │  │ agy (B)  │                        │ agy (A)  │              │ agy (B)  │
│HOME=sb/A │  │HOME=sb/B │                        │HOME=sb/A │              │HOME=sb/B │
└────┬─────┘  └────┬─────┘                        └────┬─────┘              └────┬─────┘
     └──────┬──────┘                                   ▼                         ▼
            ▼                                sb/A/.gemini/antigravity-cli/  sb/B/.gemini/antigravity-cli/
  Keychain / Credential Manager                antigravity-oauth-token        antigravity-oauth-token
  "gemini/antigravity" ช่องเดียว                 (บัญชี A)                      (บัญชี B)
  → ต้องเขียนทับก่อนทุก run, run ชนกัน = สลับบัญชี   → แยกขาด, รันพร้อมกันได้, ไม่แตะ keyring ของผู้ใช้
```

ทุกโปรไฟล์รันด้วย HOME = sandbox ของตัวเอง (`~/.config/antigravity/sandboxes-node/<profile>`) อยู่แล้ว เมื่อเข้า file mode token จึงแยกเป็นไฟล์ต่อโปรไฟล์โดยอัตโนมัติ

**production (Linux) ได้ผลแบบนี้อยู่แล้วโดยไม่มีใครตั้งใจ:** เซิร์ฟเวอร์ headless ไม่มี D-Bus session ตัวตรวจ D-Bus ของ agy จึงเลือกไฟล์เอง ส่วน macOS และ Windows มี keyring จริง desktop จึงต้องส่ง `SSH_CONNECTION` ให้

**หลักฐาน:** log ของ agy `composite_token_storage.go:123] Using file-based token storage because SSH session detected`
- spike 2026-09-24 (`spike-results.md`, S4 และ E2E)
- run จริงบนเครื่องนี้ 2026-09-24 19:46 ใน sandbox `astraleno` (`cli-20260924_194646.log`)

**ข้อควรระวัง:**
1. เป็นพฤติกรรมภายในที่ Google ไม่ได้ทำเอกสารไว้ ทุกครั้งที่ agy อัปเดตต้องตรวจว่า log ยังมีบรรทัดนี้ ถ้าวันหนึ่งใช้ไม่ได้ ทางถอยคือ `ANTIGRAVITY_AGY_TOKEN_MODE=keyring` (ช้ากว่า เพราะบน mac/Windows ต้องรันทีละ request)
2. ตั้งเฉพาะใน env ของ agy (`buildChildEnvironment()`, token daemon และ `profile login`) ไม่ใช่ทั้ง bridge
3. SSH mode เปลี่ยนวิธีล็อกอิน: agy ไม่เปิดเบราว์เซอร์เอง แต่แสดงเมนู → URL → ช่องกรอกโค้ดที่ Google ให้หลังล็อกอิน (ข้อความในแอปและ CLI เขียนตามนี้แล้ว)
4. `SSH_CONNECTION` ตัวเดียวพอ (ทดลองยืนยันแล้ว). สคริปต์ล็อกอินของ Gemini ตั้ง `SSH_CLIENT` และ `SSH_TTY="pty"` เพิ่ม ซึ่งถูกเอาออก เพราะ `SSH_TTY` ควรเป็น path ของ tty device และบางโปรแกรมจะพยายามเปิดมัน
5. **ยังไม่ยืนยันบน Windows** (spike S1): ตัวตรวจเป็นโค้ดชุดเดียวกันทุก OS แต่ต้องรัน `docs/spike-windows.ps1` ก่อน release

---

## 2. ผล audit: สิ่งที่พบและแก้แล้ว

ระดับ: **C** = ทำให้ใช้งานไม่ได้ เสียข้อมูล หรือเป็นช่องโหว่; **H** = ฟีเจอร์หลักพัง; **M** = พังบางกรณี หรือความปลอดภัยระดับรอง; **L** = คุณภาพ

### 2.1 แกนกลาง `src/` (มีผลกับ CLI และ production เมื่อ merge)

| # | ระดับ | สิ่งที่พบ | หลักฐาน | การแก้ | test |
| --- | --- | --- | --- | --- | --- |
| 1 | C | บน macOS/Windows ใน file mode ทุก run ถูก mutex ทั้งเครื่อง จึงรันได้ทีละ request และ request ที่รอคิวไม่มี timeout (`keyringSerialized()` เปิดตาม platform โดยไม่ดู token mode) | 2 โปรไฟล์พร้อมกันใช้ 3.3 s แทน 1.5 s | serialize เฉพาะ keyring mode | `file-mode.test.mjs`, `config.test.mjs` |
| 2 | C | **copy-back token ไม่เคยทำงาน** และยังเขียนไฟล์โปรไฟล์ใหม่ทุก run: `finally` เรียก `getProfileSandboxDir()` ก่อน ซึ่งปลูก token เก่าจาก `oauth_creds.json` ทับ token ที่ agy เพิ่ง refresh แล้วค่อย "คัดลอกกลับ" ของเก่านั้น | เครื่องนี้ 2026-09-24 19:46: log agy `expired=true` แล้ว refresh สำเร็จ แต่ `profiles/astraleno` ยังถือ token ที่หมดอายุ 09-15 (539 B ไม่มี `id_token`) | จำ access token ที่ปลูกไว้; หลัง run อ่าน sandbox ตามที่ agy ทิ้งไว้ **ก่อน** ปลด lock; รับเฉพาะเมื่อ agy เปลี่ยน token, `refresh_token` เป็นของโปรไฟล์เอง และ expiry ใหม่กว่า; log `[TOKEN]` | `file-mode.test.mjs` (3) |
| 3 | C | **`profile login` ลบโปรไฟล์เดิม:** `prepareLogin()` ลบไฟล์ใน `profiles/<name>` ก่อนผู้ใช้ล็อกอิน และเมื่อยกเลิก ล้มเหลว หรือเจออีเมลซ้ำ ก็ลบทั้งโฟลเดอร์ | จำลองแล้ว: โปรไฟล์เดิมหายหลังยกเลิก | เขียนโปรไฟล์หลังได้ token และตรวจบัญชีแล้วเท่านั้น; cleanup ลบเฉพาะ login HOME; ล็อกอินซ้ำเปลี่ยนบัญชีจะไม่ทิ้งอีเมลเก่า; ถ้า userinfo ติดต่อไม่ได้ใช้อีเมลที่ agy บันทึกเอง | `profile-login.test.mjs` (6) |
| 4 | H | `profile login` spawn agy ไม่ได้ เพราะ argv[0] ออกมาเป็น `"/path/agy"` (มีเครื่องหมายคำพูดติดมา) และ token daemon spawn `"agy"` เปล่า ๆ ซึ่งแอป GUI (PATH ว่าง) หาไม่เจอ ทำให้ auto-refresh ล้มทุกโปรไฟล์ | จำลองแล้ว: ENOENT | `detectCliCommand().binary` เป็น path เต็ม; `splitCommandLine()` ใช้ร่วมกัน | `config.test.mjs`, `profile-login.test.mjs` |
| 5 | H | Windows: allow-list ของ env เทียบชื่อแบบตรงตัวพิมพ์ แต่ Windows สะกด `Path`, `SystemRoot`, `ComSpec`, `ProgramData` ทำให้ agy ไม่ได้ PATH และ SYSTEMROOT (net/crypto ของ Go ต้องใช้). test เดิมใช้ชื่อตัวพิมพ์ใหญ่จึงไม่เห็น | อ่านโค้ด | เทียบแบบ upper-case บน win32 | `executor-env.test.mjs` |
| 6 | H | ปิด bridge แล้ว agy ค้าง: `host.shutdown()` รอ `server.close()` (คือรอ request จบ) ก่อนฆ่า agy; SIGTERM handler ของ `index.mjs` ไม่ฆ่า agy เลย (agy detached จึงรอดหลัง bridge ตาย); ระหว่างปิด fallback loop ยัง spawn โปรไฟล์ถัดไป | test ใหม่ด้วยโปรเซสจริง | `beginShutdown()` ห้าม spawn ใหม่และฆ่า agy ทั้ง tree ก่อน แล้วปิด server แบบมีเพดาน (ปิด socket ที่ว่างต่อเนื่อง) | `shutdown.test.mjs`, `desktop-bootstrap.test.mjs` |
| 7 | H | **key ที่ revoke ผ่าน `POST /v1/keys/revoke` ยังใช้ได้จนกว่าจะ restart** (มีมาก่อน Gemini): แก้ไฟล์แต่ไม่แก้ `process.env` (production 8008 ไม่ได้ตั้ง key จึงยังไม่กระทบ) | test ล้มบนโค้ดเดิม | ลบออกจาก `process.env` ด้วย | `server.test.mjs` |
| 8 | M | `profile remove ../../x` ทำ `rm -rf` นอกโฟลเดอร์โปรไฟล์ (CLI และ IPC ของ desktop) และไม่ลบ sandbox ที่มีสำเนา token | อ่านโค้ด | ตรวจชื่อ + ลบ sandbox และ `.token-refresh` | `profile-cli.test.mjs` |
| 9 | M | test ของ Gemini (`shutdown.test.mjs`) ส่ง SIGKILL จริงไปที่ process group 20002 ของเครื่อง (PID ปลอม ซึ่งอาจเป็นโปรเซสอื่นของผู้ใช้); test ไม่แยก HOME จึงอ่าน `.env` จริงและเขียน copy-back ลงโปรไฟล์จริงได้ | อ่านโค้ด | `_env.mjs` แยก HOME/USERPROFILE ให้ทั้งชุด; เขียน test ใหม่ด้วยโปรเซสจริง | ทั้งชุด |
| 10 | L | ปุ่ม Probe ของ desktop ไม่มี endpoint ให้ probe ทีละโปรไฟล์ (`/v1/profiles/check` รันทุกโปรไฟล์) | อ่านโค้ด | `{"profile": "<name>"}` | `server.test.mjs` |

### 2.2 แอปเดสก์ท็อป `desktop/`

| # | ระดับ | สิ่งที่พบ | การแก้ | test |
| --- | --- | --- | --- | --- |
| 11 | C | **แอปที่ build แล้วจะเปิดไม่ขึ้น:** `main.mjs`, `profile-login.mjs`, `bridge-bootstrap.mjs` import `../src/...` แต่ installer บรรจุแค่ `bridge/src/**` | `bridge-paths.mjs` (checkout ใช้ `../src`, packaged ใช้ `app.asar.unpacked/bridge/src`), import แบบ dynamic, bootstrap รับ path ทาง `ANTIGRAVITY_DESKTOP_BRIDGE_SRC` | `desktop-modules`, smoke |
| 12 | C | ปุ่มติดตั้ง agy ใช้ URL ที่ตอบ **404** (`/install.sh`, `/install.ps1`); URL จริงคือ `https://antigravity.google/cli/install.sh` และ `/cli/install.ps1` (ตรวจด้วย curl 2026-09-25) | แก้ URL | `desktop-modules` |
| 13 | C | **API key ใช้ไม่ได้:** สร้างหรือ revoke ใน main process เขียน `.env` ลง cwd ของแอป (`/` เมื่อเปิดจาก Finder → EACCES; `desktop/.env` ตอน dev ซึ่ง bridge ไม่อ่าน) และ bridge ที่รันอยู่ไม่รู้; ไม่มี UI สร้าง key ทำให้ desktop รันแบบ anonymous (ขัด A6) | สร้าง key ให้อัตโนมัติใน `~/.config/antigravity/bridge.env` ก่อน start ครั้งแรก; create/revoke ผ่าน HTTP ของ bridge; มีหน้าจัดการ key ใน Settings; bridge ได้ env ณ ตอนเปิดแอป (ไม่ใช่ `process.env` ที่ `config.mjs` เติมจาก `.env` ไว้แล้ว) เพื่อให้โหลด key ล่าสุดจากไฟล์ทุกครั้งที่ start | `desktop-modules`, smoke |
| 14 | H | supervisor race: `restart()` ไม่รอโปรเซสเก่าออก exit handler ของตัวเก่าจึงเคลียร์ตัวใหม่ แล้ว fork ซ้ำจนพอร์ตชน | ตรวจตัวตน child ในทุก handler; `stop()` รอ exit จริงก่อน kill | `desktop-supervisor.test.mjs` |
| 15 | H | ไม่มีการตรวจ request ค้างก่อน stop/restart/quit (เอกสารเดิมอ้างว่ามี): poll `/health` โดยไม่ส่ง key จึงได้แค่ liveness | poll พร้อม key; `stop()` ปฏิเสธเมื่อมี request ค้าง (เว้นแต่ `force`) และแอปถามยืนยันก่อน | `desktop-supervisor.test.mjs` |
| 16 | H | ปุ่ม Disable/Enable/Reset ทำงานกับ ProfileManager อีกตัวที่อยู่ใน main process จึงไม่กระทบ bridge; Probe ตอบ "passed" โดยไม่ทำอะไร; รายชื่อโปรไฟล์ไม่ส่ง key จึงได้ 401 | เรียก HTTP ของ bridge ทั้งหมด | smoke |
| 17 | H | Windows: `spawn("wt.exe")` ล้มแบบ async (event `error`) fallback ใน try/catch จึงไม่ทำงานและ main process เกิด exception; Windows 10 ไม่มี wt.exe; wt ตีความ `;` เป็นตัวคั่นคำสั่ง ทำให้คำสั่งติดตั้งแตก; สคริปต์ `.cmd` ที่มี path ภาษาไทยถูก cmd.exe อ่านด้วย code page จึงได้ HOME ผิดและล็อกอินไม่เสร็จ | `terminal.mjs`: cmd.exe ใน console ของตัวเอง, สคริปต์ ASCII ล้วน, ค่าทุกค่าส่งทาง env, รอ `spawn`/`error` | `desktop-modules` |
| 18 | H | Hermes snippet ผิดรูป: `api: "openai"` + `base_url` + models เป็น list และมีโมเดล `gemini-3.8-pro` ซึ่งไม่มีใน bridge. Hermes 0.21 ใช้ `providers.<id>.api` = URL และ models เป็น map (ตรวจจาก config จริงบนเครื่องนี้) | `hermes.mjs` (+ `request_timeout_seconds`) | `desktop-modules` |
| 19 | M | ล็อกอินต้องรอ marker (agy ออก): ถ้าผู้ใช้ปิดหน้าต่าง terminal หลังล็อกอิน แอปจะรอ 10 นาทีแล้วลบ login ที่สำเร็จทิ้ง; ไม่มีปุ่มยกเลิก | เก็บเมื่อไฟล์ token ครบและนิ่ง 3 s; มีปุ่ม Cancel | `desktop-modules` |
| 20 | M | `bridge_config.json` ครั้งแรกที่ desktop สร้างมีแค่โปรไฟล์ใหม่ โปรไฟล์อื่นที่ bridge เคยหมุนจากการสแกนโฟลเดอร์จึงหลุดจาก rotation | เริ่มรายการจาก `getAvailableProfiles()` | `desktop-modules` |
| 21 | M | สคริปต์ล็อกอินตั้ง `SSH_CLIENT` และ `SSH_TTY="pty"` (หัวข้อ 1 ข้อ 4) | ใช้ `AGY_FILE_MODE_ENV` ตัวเดียว | `desktop-modules` |
| 22 | M | `shell:openPath` รับ path ใดก็ได้จาก renderer (เปิดโปรแกรมได้); IPC ไม่ตรวจชื่อโปรไฟล์ | allow-list โฟลเดอร์; ตรวจชื่อทุก IPC | — |
| 23 | M | `npm start` เป็น `electron main.mjs` ทำให้แอปรันในชื่อ "Electron" (userData ร่วมกับแอป Electron อื่น; Gemini ทดลองแบบนี้กับ `~/.config/antigravity` จริง); instance ที่ 2 ยังรัน `main()`; ไม่เติม PATH ให้แอป GUI; `agyPath` ใน Settings ไม่ถูกส่งให้ bridge; เปลี่ยน port แล้วไม่มีผล | `electron .`; single-instance ถูกต้อง; `ANTIGRAVITY_BRIDGE_CMD` จาก path ที่หาเจอ; restart เมื่อ port/proxy/agy path เปลี่ยน | smoke |
| 24 | M | log: mask ทีละ chunk (token ที่ถูกตัดข้าม chunk หลุดไปครึ่งหนึ่ง); `appendFileSync` + `statSync` ทุกบรรทัดบน main thread | แบ่งบรรทัดก่อน mask; write stream; mask refresh token, Bearer และ key ที่รู้จัก | `desktop-supervisor.test.mjs` |
| 25 | L | UI โหลด Google Fonts จากอินเทอร์เน็ต; ปุ่ม Setup Wizard ไม่ทำงาน; `closeToTray` ค่าเริ่มต้นปิด (ปิดหน้าต่างแล้ว bridge หยุด ต่างจากแอป tray ในสเปก) | system fonts + CSP ห้าม remote; "Getting started" checklist; `closeToTray: true` | — |
| 26 | L | `sync-src` ไม่ลบไฟล์เก่า; ไม่มี entitlements สำหรับ hardened runtime; `npm --prefix desktop test` ชี้โฟลเดอร์ที่ไม่มี | แก้ครบ (`desktop/build/entitlements.mac.plist`) | — |

### 2.3 ผลต่อ production (เมื่อ commit + deploy ตาม `AGENTS.md`)

- Linux: agy ได้ `SSH_CONNECTION` เพิ่ม ไม่เปลี่ยนพฤติกรรม เพราะเดิมใช้ไฟล์อยู่แล้ว (ไม่มี D-Bus)
- token ที่ agy refresh ระหว่าง request ถูกเก็บลงโปรไฟล์แล้ว run ถัดไปจึงไม่ต้อง refresh ซ้ำ (log `[TOKEN]`); ยังต้องมี refresh_token ของโปรไฟล์เอง จึงไม่เกิด account mix-up แบบก่อน 5f8951c
- restart (SIGTERM จาก systemd) จะฆ่า agy ที่วิ่งอยู่ทันทีและไม่ลอง fallback ระหว่างปิด (เดิม systemd ก็ฆ่าทั้ง cgroup อยู่แล้ว)
- revoke key มีผลทันที

---

## 3. สิ่งที่ยืนยันแล้ว

| รายการ | ผล |
| --- | --- |
| `npm test` (macOS 26.7, Node 26.8.2) | **113/113** ผ่าน (เดิม 86); test ทุกไฟล์รันใต้ HOME ชั่วคราว ตรวจแล้วว่าไม่แตะ `~/.config/antigravity` จริง |
| test ใหม่ | `file-mode` (4), `profile-login` (6, เขียนใหม่), `shutdown` (3, เขียนใหม่), `desktop-bootstrap` (1), `desktop-supervisor` (4), `desktop-modules` (12), `profile-cli` (2), เพิ่มใน `config`, `server`, `executor-env` |
| smoke ของแอปจริง (Electron 32.3.3, dev, macOS) | healthy ด้วย key ที่แอปสร้างเอง; `POST /v1/chat/completions` ผ่าน bridge ใน utility process ได้ **200**; UI ได้รับสถานะ ("🟢 Serving") และแสดง Hermes snippet; ปิดแล้วไม่มีโปรเซสค้าง; log ไม่มี key หลุด |

คำสั่ง smoke (แยก HOME, agy ปลอม, หน้าต่างไม่แสดง):

```bash
T=$(mktemp -d); printf 'process.stdout.write("OK\\n")' > "$T/agy.cjs"
cd desktop && HOME="$T" ANTIGRAVITY_DESKTOP_SMOKE=1 ANTIGRAVITY_NO_AUTO_REFRESH=1 \
  ANTIGRAVITY_BRIDGE_CMD="\"$(command -v node)\" \"$T/agy.cjs\" {prompt}" \
  ./node_modules/.bin/electron . --user-data-dir="$T/userData"
# บรรทัด "SMOKE {...}" + exit 0 = ผ่าน
```

---

## 4. สิ่งที่ยังไม่ได้ทำ / ยังไม่ยืนยัน

รายการงานที่เหลือ วิธีทำ เกณฑ์ "เสร็จเมื่อ" และสถานะว่าข้อไหนเสร็จแล้ว อยู่ที่ [DESKTOP_EDITION_TASKS.md](DESKTOP_EDITION_TASKS.md) ที่เดียว ส่วนที่ใหญ่ที่สุดคือ Windows ทั้งหมด, การล็อกอิน Google จริงผ่านแอป, แอปที่ build แล้ว และ Electron 32 ที่หมดอายุการสนับสนุน

---

## 5. แผนผังโมดูล

| ไฟล์ | หน้าที่ |
| --- | --- |
| `src/config.mjs` | `agyTokenMode()`, `AGY_FILE_MODE_ENV`, `keyringSerialized()`, `splitCommandLine()`, `detectCliCommand()` (คืน path เต็ม), `defaultMaxCliArgBytes()` (win32 24,000) |
| `src/core/executor.mjs` | `buildChildEnvironment()` (allow-list, ไม่ส่ง `*_KEY(S)`, file mode), copy-back หลัง run, ปฏิเสธ run ใหม่ระหว่างปิด |
| `src/core/sandbox.mjs` | `profileSourceDir()`, `readSandboxAccessToken()`, `copyRefreshedTokenBack()` |
| `src/core/host.mjs` | ทะเบียน agy ที่วิ่งอยู่ + server; `beginShutdown()`, `shutdown()`; callback ให้ desktop |
| `src/core/profile-login.mjs` | ล็อกอินแบบ Node (file mode / keyring mode) ที่ไม่ทำลายโปรไฟล์เดิม |
| `src/core/keyring.mjs` | keyring abstraction (สำหรับ keyring mode เท่านั้น) |
| `desktop/main.mjs` | หน้าต่าง, tray, IPC → HTTP ของ bridge, key อัตโนมัติ, ยืนยันก่อนตัด request, smoke hook |
| `desktop/bridge-supervisor.mjs` | utility process, health พร้อม key, backoff/crash loop, stop/restart ที่ปลอดภัย, log mask |
| `desktop/bridge-bootstrap.mjs` | entry ของ utility process (parentPort หรือ IPC ของ Node) → `src/index.mjs` |
| `desktop/bridge-paths.mjs` | หา `src/` ทั้งใน checkout และในแอปที่ build แล้ว |
| `desktop/terminal.mjs` | เปิด terminal ข้าม OS อย่างปลอดภัย (Windows: ASCII + env) |
| `desktop/profile-login.mjs` | ล็อกอินผ่าน terminal, รอ token, ยกเลิก, rotation |
| `desktop/keys.mjs` / `hermes.mjs` / `agy-installer.mjs` / `settings.mjs` | อ่าน key แบบเดียวกับ bridge / snippet ของ Hermes 0.21 / หา+ติดตั้ง agy / settings.json |

## 6. คำสั่ง

| งาน | คำสั่ง |
| --- | --- |
| ตรวจ syntax + test | `node --check src/server.mjs src/core/executor.mjs src/translators/tools.mjs src/config.mjs && npm test` |
| test เฉพาะ desktop | `npm --prefix desktop test` |
| เปิดแอป (dev) | `npm --prefix desktop start` (ใช้ `~/.config/antigravity` จริงของเครื่อง) |
| ล็อกอินโปรไฟล์ผ่าน CLI | `node src/index.mjs profile login <name>` |
| ลบโปรไฟล์ | `node src/index.mjs profile remove <name>` |
