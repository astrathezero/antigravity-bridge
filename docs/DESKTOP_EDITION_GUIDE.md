# Antigravity Bridge Desktop Edition — แนวทางปรับ Node.js edition ให้เป็นแอปเดสก์ท็อป (Windows + macOS) พร้อม installer

| รายการ | ค่า |
| --- | --- |
| สถานะเอกสาร | สเปกและแผน. implement แล้วบางส่วน (Gemini 2026-09-24; audit และแก้ไขโดย Claude 2026-09-25) **แต่ยังไม่พร้อม release**: สถานะจริงอยู่ใน [DESKTOP_EDITION_IMPLEMENTATION.md](DESKTOP_EDITION_IMPLEMENTATION.md), งานที่เหลืออยู่ใน [DESKTOP_EDITION_TASKS.md](DESKTOP_EDITION_TASKS.md) |
| ขอบเขต | **Node.js edition เท่านั้น** (`src/`, port 8008) ตาม `AGENTS.md`; Python edition ถูก freeze ที่ v1.0.0 และ **ไม่** อยู่ในแผนนี้ |
| เป้าหมาย | ผู้ใช้ทั่วไปบน Windows 10/11 และ macOS 12+ ดาวน์โหลด installer หนึ่งไฟล์ → ติดตั้ง → เพิ่มบัญชี Google → ได้ `http://127.0.0.1:8008/v1` ให้ **Hermes Desktop** (หรือ client อื่น) ใช้ได้ทันที โดยไม่ต้องติดตั้ง Node.js/Python/Git เอง |
| ผลการทดสอบพื้นฐาน (baseline) | ตอนเขียนสเปก: `npm test` 69/69 บน `main` @ `2302ef4`; หลัง implement + audit: 113/113 บน macOS (ยังไม่ commit, ยังไม่เคยรันบน Windows) |
| ผู้เขียน | Claude (Fable 5.1) ตามคำขอของเจ้าของโปรเจกต์ |

> **วิธีอ่าน:** หัวข้อ 0–2 คือสรุปและข้อเท็จจริง, หัวข้อ 3 สถาปัตยกรรม, หัวข้อ 4 คือ **ช่องว่างในโค้ดปัจจุบันที่ต้องแก้ก่อน** (สำคัญที่สุด), หัวข้อ 5 การ bundle โปรแกรมที่จำเป็นและ installer, หัวข้อ 6–8 แผนงานและรายละเอียดการ implement, หัวข้อ 9 การทดสอบ, หัวข้อ 10 แคตตาล็อกความผิดพลาด, หัวข้อ 11–14 ความปลอดภัย การดูแล การตัดสินใจ และภาคผนวก
>
> ทุกจุดที่เป็นการ **คาดเดา/ยังไม่ได้ตรวจบนเครื่องจริง** จะติดป้าย **[ต้องตรวจใน spike]** และรวมไว้ในหัวข้อ 6.1 (Phase 0)

---

## 0. สรุปสั้น (TL;DR)

1. **ทำได้** — bridge เป็น Node.js zero-dependency อยู่แล้ว (`src/index.mjs`) จึงยกไปรันใน **Electron `utilityProcess`** ได้ทั้งชุดโดยไม่ต้องแก้ตรรกะหลัก; Electron มี Node runtime ในตัว ผู้ใช้จึง **ไม่ต้องติดตั้ง Node.js**
2. **ข่าวดีที่พบระหว่างตรวจ (ทดลองจริง 2026-09-24):** `agy` มีโหมดเก็บ token เป็น **ไฟล์** อยู่ในตัว เปิดได้ด้วยการตั้ง env `SSH_CONNECTION` ให้โปรเซส agy (log ของ agy: `Using file-based token storage because SSH session detected`) → token แยกไฟล์ต่อโปรไฟล์ใน sandbox HOME ได้บนทุก OS ด้วยกลไกเดียวกับที่ production Linux ใช้อยู่แล้ว **ไม่ต้องเขียนโค้ด Windows Credential Manager/Keychain และไม่มี race ข้ามโปรไฟล์** (หัวข้อ 4.1) — เหลือยืนยันซ้ำบน Windows ใน spike S1
3. **โค้ดปัจจุบันยังไม่พร้อมสำหรับ Windows** ใน 3 จุด (หัวข้อ 4.3–4.5): (ก) ขีดจำกัด command line ของ Windows คือ 32,767 ตัวอักษร แต่ bridge ตั้ง `MAX_CLI_ARG_BYTES=120000` ตาม Linux → prompt ยาวจะ spawn ไม่ได้ (ข) allow-list ของ environment ใน `executor.mjs` ตัด `APPDATA`/`LOCALAPPDATA` ฯลฯ ที่โปรแกรม Go บน Windows ต้องใช้ (ค) หา `agy.exe` ไม่เจอเพราะ fallback มีแค่ `~/.local/bin`; **บน macOS** แอป GUI ไม่ได้ PATH ของ shell และ cwd เป็น `/` (หัวข้อ 4.5–4.6)
4. **การ bundle โปรแกรมที่จำเป็น (หัวข้อ 5):** Node.js → มากับ Electron; PowerShell (Windows) และ `security` (macOS) → มีในระบบอยู่แล้ว; Python → **ไม่ต้องใช้** ถ้าย้ายคำสั่ง `profile login` มาเป็น Node (หัวข้อ 4.7); **`agy` CLI (~190 MB) แนะนำ "ไม่ bundle binary"** แต่ให้ installer/first-run เรียก official installer ของ Google ตามความยินยอมของผู้ใช้ (เหตุผล: สิทธิ์ redistribute ยังไม่ชัด, ขนาด, agy อัปเดตตัวเองได้, และการ notarize binary ของคนอื่นบน macOS มีปัญหา) — ถ้าเจ้าของโปรเจกต์ยืนยันว่า bundle ได้ ก็มีแนวทางสำรองให้ในหัวข้อ 5.3
5. **Installer:** ใช้ `electron-builder` → Windows **NSIS per-user** (ไม่ต้องสิทธิ์ admin) และ macOS **DMG + ZIP (notarized)**; มี first-run wizard (ตรวจ/ติดตั้ง agy → เพิ่มบัญชี Google → สร้าง API key → แสดง config สำหรับ Hermes Desktop → เริ่ม bridge); auto-update ผ่าน GitHub Releases แบบ **ไม่ restart ระหว่างมี request วิ่งอยู่**
6. **ลำดับงาน:** Phase 0 spike บนเครื่อง Windows/macOS จริง (ตอบคำถามที่ยังไม่รู้) → Phase 1 แก้ `src/` ให้ cross-platform + tests + CI 3 OS → Phase 2 Electron shell → Phase 3 installer/signing/update → Phase 4 ทดสอบครบ (unit/integration/E2E/installer/soak) → Phase 5 release
7. **อย่าข้ามการทดสอบ** ในหัวข้อ 9 และแคตตาล็อกความผิดพลาดหัวข้อ 10 (35+ รายการ) — ส่วนใหญ่มาจากพฤติกรรมจริงของ OS ที่ต่างจาก Linux server ที่ bridge ถูกพัฒนามา
8. **สิ่งที่ยืนยันแล้วจริงบน macOS (2026-09-24, ดู `docs/spike-results.md` และหัวข้อ 15):** E2E ผ่าน bridge ตัวจริง (โค้ดเดิม ไม่แก้) + agy จริงใน file mode ตอบสำเร็จโดยไม่แตะ Keychain; หน้าจอล็อกอินของ agy ใน SSH mode; PATH/cwd ของแอป GUI; รูปแบบ config ของ Hermes 0.21; agy signed โดย Google; **Electron ESM: `await app.whenReady()` ที่ top level ทำให้แอปค้าง**; สิ่งที่ยังไม่ได้ยืนยันคือทุกข้อบน Windows (มีสคริปต์ `docs/spike-windows.ps1` ให้รัน) และการล็อกอินจริงจนจบ

---

## 1. เป้าหมาย ผู้ใช้ และสิ่งที่ "ใช้ได้เลย" ต้องหมายถึง

### 1.1 ผู้ใช้เป้าหมาย

- ใช้ **Hermes Desktop** (Nous Research) บน Windows/macOS และอยากใช้บัญชี Google Antigravity ของตัวเองผ่าน bridge บนเครื่องเดียวกัน (loopback)
- ไม่ถนัด terminal/Node/Python; ไม่มี server; ต้องการ "ติดตั้ง → ล็อกอิน Google → เปิด Hermes → ใช้"
- อาจมีหลายบัญชี Google (โปรไฟล์) เพื่อหมุนโควตา — ฟีเจอร์เด่นของ bridge นี้

### 1.2 นิยาม "ใช้ได้เลย" (acceptance ระดับสูง)

| ข้อ | เกณฑ์ |
| --- | --- |
| A1 | ติดตั้งจากไฟล์เดียว ไม่ต้องสิทธิ์ admin (Windows per-user), ไม่ต้องติดตั้ง Node.js/Python/Git |
| A2 | first-run wizard พาไปจนถึงหน้าจอ "Hermes ใช้ URL นี้ + API key นี้" ภายใน ≤ 5 นาที (รวมเวลาล็อกอิน Google) |
| A3 | ปิด/เปิดเครื่องแล้ว bridge กลับมาเอง (autostart) และ Hermes ต่อได้โดยไม่แก้ config |
| A4 | หลายโปรไฟล์หมุนโควตาได้ **ถูกบัญชี** (ไม่มี account mix-up) บนทั้ง 2 OS — มี test พิสูจน์ |
| A5 | เมื่อพัง ผู้ใช้เห็นสาเหตุเป็นภาษาคน (port ชน / agy ไม่พบ / โควตาหมด / token หมดอายุ) และมีปุ่ม "Export diagnostics" |
| A6 | ความปลอดภัยไม่ต่ำกว่า CLI edition: bind 127.0.0.1, API key บังคับโดยค่าเริ่มต้น, CORS ปิด, Host allow-list, ไม่ log token |

### 1.3 สิ่งที่ **ไม่** อยู่ในขอบเขตรุ่นแรก

- Linux desktop (ทำ AppImage ได้ทีหลังด้วย config เดียวกัน แต่ไม่ทดสอบในรุ่นแรก)
- Web channel / extension (ถูกยกเลิกแล้ว — ดู `docs/WEB_EXTENSION_BRIDGE_APPROACH.md`)
- การเปิด bridge ให้เครื่องอื่นใช้ (0.0.0.0) — ยังทำได้ผ่าน env เหมือนเดิม แต่ UI ไม่มีปุ่มให้ และไม่แนะนำ UI ไม่ทำการเปิดให้เครื่องอื่นใช้
- Mobile

---

## 2. ข้อเท็จจริงที่ตรวจสอบแล้ว (ใช้เป็นฐานของทุกการตัดสินใจ)

### 2.1 พฤติกรรมของ bridge (จากโค้ด `src/` @ `main`)

| หัวข้อ | ข้อเท็จจริง | ไฟล์ |
| --- | --- | --- |
| จุดเข้า | `src/index.mjs` แยก subcommand `profile`/`key` แล้วสร้าง server; ติดตั้ง `uncaughtException`/`unhandledRejection` ที่ **`process.exit(1)`** เมื่อไม่ใช่ socket error; `SIGINT`/`SIGTERM` → graceful shutdown 10 s | `src/index.mjs` |
| การหา `agy` | `ANTIGRAVITY_BRIDGE_CMD` > ค้น `PATH` (Windows ค้น `agy.exe`, แยก `;`) > `~/.local/bin/agy(.exe)` > ใช้ชื่อ `agy` ตรง ๆ; template: `"<path>" --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p "{prompt}"` | `src/config.mjs` `detectCliCommand()` |
| การรัน agy | `spawn(argv[0], argv.slice(1), { cwd: sandboxDir, env, detached: !win32, stdio })`; env ถูก **allow-list** (`PATH USER LOGNAME SHELL TERM LANG LC_ALL SYSTEMROOT TEMP TMP DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK` + `ANTIGRAVITY_*` + proxy vars) แล้วตั้ง `HOME`/`USERPROFILE`/`XDG_*` = sandbox ของโปรไฟล์; ก่อน spawn เรียก `syncProfileToSystem(profile)` (คัดลอกไฟล์ auth ไป `~/.gemini`, `~/.config/antigravity` ฯลฯ **และเขียน keyring ของ OS**) | `src/core/executor.mjs`, `src/core/keyring-sync.mjs` |
| Sandbox | `ANTIGRAVITY_SANDBOX_BASE` หรือ `~/.config/antigravity/sandboxes-node/<profile>`; lock file `.sandbox.lock` (PID) + in-memory lock; ต่อโปรไฟล์ concurrency = `ANTIGRAVITY_CONCURRENCY_PER_PROFILE` (1) | `src/core/sandbox.mjs`, `profile-manager.mjs` |
| โปรไฟล์ | อยู่ที่ `os.homedir()/.config/antigravity/profiles/<name>/` มีไฟล์ `oauth_creds.json`, `google_accounts.json`, `state.json`, (`settings.json`), `antigravity-oauth-token`; รายชื่อจาก `ANTIGRAVITY_PROFILES` > `bridge_config.json` > สแกนโฟลเดอร์ | `profile-manager.mjs`, `token-daemon.mjs` |
| Keyring | macOS: `security add-generic-password -U -s gemini -a antigravity` ผ่าน stdin, ค่า = `go-keyring-base64:<base64(JSON)>`; Linux: `secret-tool`; **Windows: `injectOsKeyringToken()` คืน `false` และ `extractOsKeyringToken()` คืน `null` (ไม่มีโค้ด)** | `keyring-sync.mjs` |
| Token refresh | ทุก 55 นาที; darwin ใช้ Keychain (ช่องเดียวต่อเครื่อง), linux/**windows** ใช้ HOME แยกต่อโปรไฟล์ (`.token-refresh/<profile>`) แล้วอ่านไฟล์ token กลับ | `token-daemon.mjs` |
| Prompt ยาว | เกิน `MAX_CLI_ARG_BYTES` (120000) ส่งทาง stdin เป็น NDJSON `--input-format stream-json` (cap 2 MB) | `executor.mjs` `parseCmdTemplate()` |
| Config/`.env` | อ่านตามลำดับ `./.env` (cwd), `~/.config/antigravity/bridge.env`, `~/.config/antigravity/.env`, `~/.env`; `key generate` **สร้าง `.env` ใน cwd** ถ้ายังไม่มีไฟล์ใด; `bridge_config.json` ใน cwd มาก่อน `~/.config/antigravity/bridge_config.json` | `config.mjs`, `auth.mjs` |
| ความปลอดภัย | API key (constant-time), Host allow-list, CORS ปิด, `/health` liveness-only เมื่อไม่มี key, ไฟล์ลับ chmod 0600 (**no-op บน Windows**), API mode ฆ่า run ที่ agy เริ่มใช้ tool เอง | `security.mjs`, `server.mjs` |
| การ login โปรไฟล์ | **มีเฉพาะใน Python** (`python3 antigravity_bridge.py profile login <name>`): ย้ายไฟล์ auth ใน `~/.gemini` ออกชั่วคราว, ลบ Keychain (macOS), รัน `agy` แบบ interactive ให้ผู้ใช้ล็อกอินผ่านเบราว์เซอร์ พิมพ์ `hi` แล้ว `/exit`, จากนั้นดึง token จาก keyring/ไฟล์ → เขียนลง profile dir, ยืนยันอีเมลผ่าน `https://www.googleapis.com/oauth2/v3/userinfo`, คืนไฟล์เดิม | `antigravity_bridge.py` บรรทัด ~6387–6570 |
| Tests | 69 tests (`node --test`), fake `agy` เป็นสคริปต์ Node (`node <fake>.cjs {prompt}`); `token-refresh.test.mjs` ใช้ไฟล์ shebang + chmod 755 จึง **skip บน win32** | `tests/` |

### 2.2 `agy` (Antigravity CLI) — จากเอกสารทางการและแหล่งอิสระ

| หัวข้อ | Windows | macOS |
| --- | --- | --- |
| ติดตั้ง | `irm https://antigravity.google/cli/install.ps1 \| iex` (PowerShell) หรือ `install.cmd`; ติดตั้งที่ **`%LOCALAPPDATA%\agy\bin\agy.exe`** | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`; ติดตั้งที่ **`~/.local/bin/agy`** (เครื่องนี้: Mach-O x86_64, 190 MB, v1.2.3) |
| ที่เก็บ credential | **Windows Credential Manager**, generic credential target **`gemini:antigravity`**, blob เป็น **JSON UTF-8** รูป `{"token":{"access_token","refresh_token","token_type","expiry"},"auth_method"}` (ไม่มี prefix base64) — agy **ไม่เขียนไฟล์** `antigravity-oauth-token` บน Windows | **Keychain** service `gemini` account `antigravity` (go-keyring; ค่าอาจมี prefix `go-keyring-base64:`) |
| config | `~/.gemini/antigravity-cli/settings.json` (โครงเดียวกันทุก OS) | เหมือนกัน |
| ล็อกอิน | รัน `agy` แล้ว "attempts keyring access first"; ไม่มี credential → เปิดเบราว์เซอร์ OAuth อัตโนมัติ; `/logout` ลบ credential ออกจาก keyring; headless ใช้ `GEMINI_API_KEY` ได้ (แต่คนละโควตา/โมเดล — ไม่ใช่กรณีของ bridge) | เหมือนกัน |
| binary | Go binary, ไม่ต้องใช้ Node; auto-update ตัวเอง (`agy update`) | เหมือนกัน |
| **โหมดเก็บ token เป็นไฟล์** (จาก binary v1.2.3 + ทดลองจริง) | ฟังก์ชัน `codeassistclient.shouldBypassKeyring` ตัดสินจาก detector `sshDetector` (`SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`), `wslDetector` (`WSL_DISTRO_NAME`/`WSL_INTEROP`), `containerDetector` (`/.dockerenv`, `/proc/1/cgroup`), `dbusDetector` (`DBUS_SESSION_BUS_ADDRESS`); เป็นจริงตัวใดตัวหนึ่ง → ใช้ไฟล์ `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` (รูป `{token:{access_token,token_type,refresh_token,expiry},auth_method,id_token}`) แทน keyring; ถ้า keyring เข้าถึงไม่ได้ก็ตกมาใช้ไฟล์เช่นกัน (`Failed to load stored token from keyring, falling back to file`) — ต้องยืนยันบน Windows | **ยืนยันแล้วบน macOS 26.7**: ตั้ง `SSH_CONNECTION` ตัวเดียว → `Using file-based token storage because SSH session detected` และ run `-p` สำเร็จโดยไม่แตะ Keychain (ดู `docs/spike-results.md`) |

### 2.3 Hermes Desktop — จากเอกสาร Nous Research

- เป็นแอป **Electron** ที่ติดตั้ง Hermes runtime ลง `HERMES_HOME` (`~/.hermes` บน macOS/Linux, **`%LOCALAPPDATA%\hermes`** บน Windows) และรัน `hermes serve` ในเครื่องเอง (bind loopback)
- **เพิ่ม endpoint แบบ OpenAI-compatible ได้จาก UI**: Settings → Providers → **Custom Endpoints** (base URL + API key, มี **API Mode**: Auto-detect / Chat Completions / Responses API / Anthropic Messages); ค่าถูกบันทึกลง `config.yaml` ของโปรไฟล์ใน `~/.hermes` (README ของ repo นี้มีตัวอย่าง `custom_providers:` แบบ YAML อยู่แล้ว)
- ผลต่อเรา: bridge ต้องอยู่ที่ `http://127.0.0.1:8008/v1`, เลือก API Mode = **Chat Completions** (bridge ไม่มี Responses API), และ timeout ฝั่ง Hermes ต้อง ≥ 300 s ตาม README หัวข้อ Agent Client Tuning

### 2.4 Electron — จากเอกสารทางการ

- `utilityProcess.fork(modulePath, args, { env, cwd, stdio: 'pipe', serviceName, execArgv })` เรียกได้ **หลัง `app` `ready`** เท่านั้น; มี `pid`, `stdout/stderr` (เมื่อ `pipe`), `kill()`, `postMessage()`, events `spawn`/`exit(code)`/`message`/`error`
- ESM รองรับตั้งแต่ **Electron 28** รวม entrypoint ของ utility process (`.mjs`); main process โหลด ESM แบบ async → ต้อง `await` สิ่งที่ต้องเสร็จก่อน `ready` (เช่น `app.setPath`)
- **[ทดลองแล้ว Electron 44.4.5, macOS, 2026-09-24]** ห้ามเขียน `await app.whenReady()` (หรือ `await` event `ready`) ที่ **top level ของ ESM main** — โปรเซสค้างตลอดกาลโดยไม่มี error (Electron รอให้โมดูล entry ประเมินเสร็จก่อนจึงยิง `ready` → deadlock); ต้องใช้ `app.whenReady().then(main)`; CommonJS main ไม่มีปัญหานี้ (ดู `docs/spike-results.md`)

---

## 3. สถาปัตยกรรมที่เสนอ

### 3.1 ทางเลือกและเหตุผล

| ทางเลือก | ข้อดี | ข้อเสีย | ตัดสิน |
| --- | --- | --- | --- |
| **Electron + `utilityProcess`** (รัน `src/index.mjs` เดิมทั้งชุด) | ไม่ต้องแก้ตรรกะ bridge, มี Node runtime ในตัว, ทีมเป็น JS ล้วน, ecosystem installer/updater ครบ (`electron-builder`, `electron-updater`), UI ทำได้ทันที | ขนาดแอป ~100 MB, RAM ~150 MB (แต่ Hermes Desktop ก็เป็น Electron อยู่แล้ว) | **เลือก** |
| Tauri 2 + Node sidecar | เล็กกว่า | ต้อง bundle Node เป็น sidecar เอง (SEA/pkg), ต้องเขียน Rust สำหรับ tray/IPC, สองภาษา | ไม่เลือกในรุ่นแรก (ทำภายหลังได้เพราะตรรกะอยู่ใน `src/`) |
| Service-only installer (ไม่มี UI) — NSIS/pkg ห่อ Node + `src/` + สคริปต์ `setup_service_windows.ps1`/`setup_launchd_mac.sh` ที่มีอยู่แล้ว | เร็วที่สุด, ใช้ของที่มี | ไม่มี wizard ล็อกอิน/ตั้งค่า → ไม่ตอบโจทย์ "ใช้ได้เลย" สำหรับคนไม่ถนัด terminal | เป็น **Tier A** สำรอง (หัวข้อ 3.5) |
| Node SEA (single executable) | ไฟล์เดียว | SEA รับ CommonJS เท่านั้น → ต้อง bundle ESM ด้วย esbuild; ไม่มี UI; ต้องทำ tray เอง | ใช้เฉพาะ Tier A ถ้าต้องการ |

### 3.2 แผนภาพ

```
┌──────────────────────────────── เครื่องผู้ใช้ (Windows / macOS) ────────────────────────────────┐
│                                                                                                   │
│  Hermes Desktop (Electron)                     Antigravity Bridge Desktop (Electron)             │
│  ┌─────────────────────────┐                   ┌──────────────────────────────────────────────┐  │
│  │ hermes serve (loopback) │  HTTP :8008/v1    │ main process                                 │  │
│  │ custom endpoint =       │──────────────────▶│  • tray icon, status window, first-run wizard │  │
│  │ http://127.0.0.1:8008/v1│  Bearer sk-agv-…  │  • spawn/restart/monitor utilityProcess       │  │
│  └─────────────────────────┘                   │  • log files, autostart, updater, port check  │  │
│                                                │  • IPC ↔ renderer (contextIsolation, preload) │  │
│                                                └───────────────┬──────────────────────────────┘  │
│                                                                │ utilityProcess.fork              │
│                                                ┌───────────────▼──────────────────────────────┐  │
│                                                │ bridge utility process (Electron's Node)      │  │
│                                                │  desktop/bridge-bootstrap.mjs                 │  │
│                                                │   └─ import("../src/index.mjs")  ← โค้ดเดิม   │  │
│                                                │  HTTP server 127.0.0.1:8008                   │  │
│                                                │  executor → spawn agy (child, per profile)    │  │
│                                                └───────────────┬──────────────────────────────┘  │
│                                                                │ spawn                            │
│              ┌─────────────────────────────┐   ┌───────────────▼──────────────────────────────┐  │
│              │ OS keyring                  │◀──│ agy.exe / agy  (Go binary ของ Google)          │  │
│              │ Win: Credential Manager     │   │ HOME/USERPROFILE = sandbox ของโปรไฟล์          │  │
│              │ mac: login Keychain         │   │ อ่าน token จาก keyring ก่อนเสมอ                 │  │
│              └─────────────────────────────┘   └──────────────────────────────────────────────┘  │
│                                                                                                   │
│  ข้อมูลถาวร: ~/.config/antigravity/{profiles,sandboxes-node,bridge.env,bridge_config.json,        │
│              quota_cache_node.json}   (ใช้ร่วมกับ CLI edition ได้)                                │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 หลักการออกแบบ (design rules)

1. **`src/` ยังเป็น CLI edition ที่รันด้วย `node src/index.mjs` ได้เหมือนเดิม** — desktop เป็นเพียง "host" เพิ่ม; การแก้ใน `src/` ต้องเป็น cross-platform fix ที่ CLI ก็ได้ประโยชน์ และมี test ตาม `AGENTS.md`
2. **bridge รันในโปรเซสแยก (`utilityProcess`) ไม่ใช่ใน main process** เพราะ `index.mjs` เรียก `process.exit()` และติดตั้ง global handlers — ถ้า import ใน main จะปิดทั้งแอป; การแยกโปรเซสยังให้พฤติกรรมเทียบเท่า `systemd Restart=always` (main เห็น `exit` แล้ว spawn ใหม่แบบ backoff)
3. **ไม่ restart bridge ขณะมี request วิ่งอยู่** (เหตุผลเดียวกับ "Self-Hosting Danger" ใน `AGENTS.md`): main ถาม `/health` (authenticated) ดู `concurrency.active_in_flight` ก่อน restart/update เสมอ
4. **ค่าเริ่มต้นปลอดภัย:** bind `127.0.0.1`, wizard **สร้าง API key ให้เสมอ** (ไม่มีโหมด anonymous ใน desktop), CORS ปิด, ไม่มีปุ่มเปิด `0.0.0.0`
5. **ใช้ที่เก็บข้อมูลเดียวกับ CLI** (`~/.config/antigravity`) เพื่อให้คนที่เคยใช้ CLI/Python ย้ายมาแล้วเห็นโปรไฟล์เดิม — แต่ **cwd ของ bridge ต้องเป็นโฟลเดอร์ที่แอปควบคุม** และตั้ง `ANTIGRAVITY_BRIDGE_CONFIG`, `ANTIGRAVITY_QUOTA_CACHE_FILE`, `ANTIGRAVITY_SANDBOX_BASE` ชัดเจน (หัวข้อ 4.6)
6. **Zero-dependency ของ bridge คงเดิม**: dependencies ของ Electron/installer อยู่ใน `desktop/package.json` แยกต่างหาก; `npm test` ที่ root ยังไม่ต้องติดตั้งอะไร

### 3.4 ส่วนประกอบและหน้าที่

| ส่วน | หน้าที่ | หมายเหตุ |
| --- | --- | --- |
| `desktop/main.mjs` | single-instance lock, tray, สร้าง/ดูแล bridge process, log rotation, autostart, updater, dialog ข้อผิดพลาด | ESM (Electron ≥ 28) |
| `desktop/bridge-bootstrap.mjs` | entry ของ utility process: รับ config ผ่าน env/argv, ฟัง `process.parentPort` (`shutdown`, `reload-keys`), แล้ว `import("../src/index.mjs")`; ตอน shutdown ฆ่า agy ที่ยังวิ่ง (Windows: `taskkill /t`) ก่อนออก | ไม่แก้ `index.mjs` |
| `desktop/preload.mjs` + `desktop/ui/*.html` | wizard (agy → บัญชี → key → Hermes), หน้า status (โปรไฟล์/โควตา/cooldown/log tail), Doctor | HTML/CSS/JS ธรรมดา ไม่ใช้ framework |
| `desktop/agy-installer.mjs` | ตรวจ `agy`, เปิด terminal ของ OS เพื่อรัน official installer, ตรวจเวอร์ชัน | หัวข้อ 5.3 |
| `desktop/profile-login.mjs` | เปิด terminal ให้ผู้ใช้ล็อกอิน `agy` แบบ interactive แล้วเก็บ token ลงโปรไฟล์ (port มาจาก Python) | หัวข้อ 4.7, 8.6 |
| `src/core/keyring.mjs` (ใหม่) | abstraction ของ keyring: darwin (`security`), linux (`secret-tool`), **win32 (Credential Manager ผ่าน PowerShell)**, `file` (สำหรับ tests) | หัวข้อ 4.1, 8.1 |

### 3.5 ระดับของ deliverable (เลือกได้ตามเวลา)

| Tier | คืออะไร | เหมาะกับ |
| --- | --- | --- |
| **A — Service installer** | NSIS/pkg ที่ห่อ Node runtime + `src/` แล้วลง Scheduled Task (Windows) / LaunchAgent (macOS) ด้วยสคริปต์ที่มีอยู่; ตั้งค่า/ล็อกอินผ่าน CLI ในเครื่อง | power user; ทำได้ใน 1–2 วันหลัง Phase 1 |
| **B — Tray app (แนะนำ)** | Electron tray + wizard + status + Doctor + updater | ผู้ใช้ Hermes Desktop ทั่วไป |
| C — Full UI | เพิ่มหน้าจัดการโปรไฟล์ละเอียด, กราฟโควตา, log viewer, ทดสอบ prompt | ภายหลัง |

Tier A และ B ใช้ Phase 0–1 ร่วมกันทั้งหมด (การแก้ `src/` ให้ cross-platform) — งานส่วนนั้นจึงคุ้มค่าไม่ว่าจะเลือก tier ใด

---

## 4. ช่องว่างในโค้ดปัจจุบันที่ต้องแก้ก่อนทำ desktop (gap analysis)

รูปแบบแต่ละข้อ: **อาการ → สาเหตุในโค้ด → การแก้ → test ที่ต้องมี** เรียงตามความรุนแรง

### 4.1 [ทุก OS — ทางหลัก, พิสูจน์แล้วบน macOS 2026-09-24] ให้ agy เก็บ token เป็น "ไฟล์ต่อโปรไฟล์" (file mode) แทน keyring ของ OS

- **ข้อค้นพบ:** ใน binary ของ agy 1.2.3 มีฟังก์ชัน `codeassistclient.shouldBypassKeyring` ที่ตัดสินจาก detector 4 ตัว (`sshDetector`, `wslDetector`, `containerDetector`, `dbusDetector`) ถ้าตัวใดตัวหนึ่งเป็นจริง agy จะใช้ **file-based token storage** ที่ `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` แทน Keychain / Credential Manager / Secret Service — นี่คือเหตุผลที่ production Linux headless (ไม่มี D-Bus) ใช้ไฟล์ใน sandbox HOME ได้อยู่แล้วโดยไม่มีใครตั้งใจ
- **การทดลอง (macOS 26.7, agy 1.2.3):** คัดลอกไฟล์ auth ของโปรไฟล์หนึ่งไป HOME ชั่วคราว, ตั้ง `SSH_CONNECTION="127.0.0.1 50000 127.0.0.1 22"` เพียงตัวเดียว, กัน Keychain จริงด้วย `sandbox-exec` (ห้าม exec `/usr/bin/security` และ `/usr/bin/open`) → log ของ agy: `composite_token_storage.go:123] Using file-based token storage because SSH session detected` → `--output-format stream-json -p "Reply with exactly one word: OK"` ได้ `init`/`step_update`/`result` และคำตอบ `OK`; token ที่ refresh แล้วถูกเขียนกลับลงไฟล์ในสandbox โดยไม่แตะ Keychain (รายละเอียดและคำสั่งใน `docs/spike-results.md`)
- **ผลต่อการออกแบบ:** ทุกโปรไฟล์มี HOME (sandbox) ของตัวเองอยู่แล้ว → token แยกไฟล์ต่อโปรไฟล์บนทุก OS ด้วยกลไกเดียวกับ Linux; **ไม่ต้องเขียนโค้ด Windows Credential Manager, ไม่ต้อง inject Keychain ก่อน run, race ข้ามโปรไฟล์ (4.2) หายไป และ concurrency ข้ามโปรไฟล์ยังใช้ได้** — ตรงกับที่เจ้าของโปรเจกต์ถามว่า "ให้ agy เก็บเป็นโปรไฟล์แยกเป็นไฟล์ไม่ได้หรือ" (ได้)
- **การแก้ใน `src/`:**
  1. `config.mjs`: `agyTokenMode()` คืน `"file"` (ค่าเริ่มต้นทุก OS) หรือ `"keyring"` เมื่อ `ANTIGRAVITY_AGY_TOKEN_MODE=keyring` (ทางย้อนกลับถ้า agy รุ่นใหม่เปลี่ยนพฤติกรรม)
  2. `executor.mjs`: ใน file mode ใส่ `SSH_CONNECTION="127.0.0.1 0 127.0.0.1 22"` (ค่าคงที่ ไม่ใช่ที่อยู่จริง) ลง env ของ child และ **ไม่เรียก** `injectOsKeyringToken()`/ไม่เขียน `~/.gemini` จริง; sandbox ยังคัดลอกไฟล์ auth ของโปรไฟล์เข้า `.gemini/antigravity-cli/` เหมือนเดิม (`getProfileSandboxDir()`) ซึ่งเป็นสิ่งที่การทดลองใช้
  3. หลัง run จบ: ถ้า `antigravity-oauth-token` ในสandbox ใหม่กว่าของโปรไฟล์ **และ** `refresh_token` ตรงกัน → คัดลอกกลับไป `profiles/<name>/` (agy refresh access token ให้เองในไฟล์; token-daemon จึงมีงานน้อยลง)
  4. `token-daemon.mjs`: ใช้เส้นทาง "HOME แยก + อ่านไฟล์กลับ" (ของ linux/windows เดิม) กับ **ทุก OS** โดยตั้ง `SSH_CONNECTION` เช่นกัน; เส้นทาง darwin/Keychain คงไว้เฉพาะ keyring mode
  5. `profile login` (4.7): รัน agy interactive ด้วย HOME = โฟลเดอร์ชั่วคราวของโปรไฟล์ + `SSH_CONNECTION` → token ใหม่ลงไฟล์โดยตรง ไม่ต้องดึงจาก keyring และไม่ต้องสำรอง/ลบ Keychain หรือ `~/.gemini` ของผู้ใช้
- **ข้อควรระวัง:** (1) ใน "SSH mode" agy จะไม่เปิดเบราว์เซอร์เองตอนล็อกอิน แต่แสดง URL ให้คัดลอกและช่องกรอกโค้ด (ตามเอกสารทางการ) → wizard ต้องรองรับ UX นี้ (เปิด URL ให้ ผู้ใช้วางโค้ดใน terminal) **[ต้องตรวจใน spike]** (2) log ของ agy ยังพิมพ์ `ChainedAuth: authenticated via keyring (effective: keyring)` แม้ใช้ไฟล์ — เป็นชื่อ auth provider ไม่ใช่ที่เก็บ (3) เป็นพฤติกรรมภายในที่ Google ไม่ได้รับรองเป็นเอกสาร → ต้องมี E2E ที่ grep log ของ agy จริงหา `Using file-based token storage` ทุก release และมีทางย้อนกลับ (keyring mode) (4) **[ต้องตรวจใน spike บน Windows]** ว่า `SSH_CONNECTION` ให้ผลเดียวกันและไฟล์อยู่ที่ `%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token` เมื่อ `USERPROFILE` = sandbox (detector เป็นโค้ดชุดเดียวกันทุก OS แต่ต้องยืนยัน) (5) `SSH_CONNECTION` ต้องส่งให้ **เฉพาะ agy** ไม่ใช่ทั้ง bridge (บาง tool ของ agy อาจเปลี่ยนพฤติกรรมใน SSH mode — ใน API mode ที่ห้าม tool อยู่แล้วไม่กระทบ)
- **test:** unit: env ของ child มี `SSH_CONNECTION` ใน file mode และไม่มีใน keyring mode; ใน file mode ต้องไม่มีการเรียก keyring (ตรวจผ่าน `ANTIGRAVITY_KEYRING_BACKEND=file:` ที่ต้องไม่ถูกเขียน); copy-back เกิดเฉพาะเมื่อ `refresh_token` ตรง; integration/E2E (E3): grep log ของ agy จริงหาบรรทัด file-based storage และเทียบอีเมลใน banner กับโปรไฟล์

### 4.2 [macOS + Windows — เฉพาะ keyring mode] keyring เป็น "ช่องเดียวต่อเครื่อง" → run พร้อมกันหลายโปรไฟล์อาจสลับบัญชี (race)

- **ใช้กับใคร:** เฉพาะเมื่อตั้ง `ANTIGRAVITY_AGY_TOKEN_MODE=keyring` (เช่น agy รุ่นใหม่เลิกใช้ SSH detector) — ใน file mode (4.1) ปัญหานี้ไม่มี
- **อาการ:** เมื่อโปรไฟล์ A กำลังรันและ request ของโปรไฟล์ B เข้ามา `syncProfileToSystem(B)` เขียน Keychain/Credential Manager ทับ; agy(A) ที่เพิ่ง spawn (init ~1 s) หรือ refresh token กลางทางอาจอ่านได้ token ของ B → โควตาถูกหักผิดบัญชี, `X-Antigravity-Active-Profile` รายงานผิด
- **สาเหตุ:** `executor.mjs` ล็อกแค่ sandbox ต่อโปรไฟล์ ไม่มี lock ข้ามโปรไฟล์; และบน Windows ยังต้องมี backend Credential Manager (8.1) เพราะ `injectOsKeyringToken()` คืน `false`
- **การแก้ (keyring mode เท่านั้น):** `keyringSerialized()` เปิดโดยอัตโนมัติเมื่อ mode=keyring บน darwin/win32 → mutex ระดับโปรเซสครอบ "inject → spawn → child ปิด" (รันได้ทีละ 1 request ทั้งเครื่อง), drift check หลัง inject, และ backend win32 ใน `src/core/keyring.mjs`
- **test:** `tests/keyring-serialize.test.mjs` ตามหัวข้อ 9.2 (รันเฉพาะเมื่อตั้ง mode=keyring)

### 4.3 [Windows] ขีดจำกัด command line 32,767 ตัวอักษร แต่ `MAX_CLI_ARG_BYTES` = 120,000

- **อาการ:** prompt ยาว (ประวัติแชตยาว, มี tool definitions, ภาษาไทย 3 ไบต์/ตัว) → `spawn agy.exe ENAMETOOLONG`/`E2BIG` → ทุกโปรไฟล์ล้มเหลวเหมือนกัน → "All agy profile attempts failed"
- **สาเหตุ:** ค่าเริ่มต้นใน `config.mjs` อิง `MAX_ARG_STRLEN` ของ Linux (131072 ไบต์ต่อ argv); Windows `CreateProcessW` จำกัดทั้งบรรทัดที่ 32,767 UTF-16 code units
- **การแก้:** ใน `config.mjs` ให้ค่าเริ่มต้นขึ้นกับ platform: win32 = **24,000 ไบต์** (เผื่อ path ของ agy + flags + การ quote; ไทย 3 ไบต์/ตัว ≈ 8,000 ตัว ≈ 8,000 code units จึงปลอดภัย) — prompt ที่ยาวกว่านั้นไปทาง stdin NDJSON ซึ่งมีอยู่แล้ว; ให้ `parseCmdTemplate()` รับ `platform` แบบ inject ได้เพื่อ test บนทุก OS
- **test:** prompt 30,000 ไบต์บน "platform=win32" ต้องได้ `stdinInput` ไม่ใช่ argv; บน linux ยังเป็น argv; test บน Windows CI จริง spawn `node` ด้วย argv 40,000 ตัวอักษรเพื่อยืนยันว่าล้มเหลวจริง (documenting the limit)

### 4.4 [Windows] allow-list ของ environment ตัดตัวแปรที่โปรแกรม Go/Windows ต้องใช้

- **อาการ:** agy บน Windows ล้มทันทีหรือทำงานผิด (`%APPDATA% not defined`, หา `cmd.exe` ไม่เจอ, TLS/DNS ผิดพลาด) [ต้องตรวจใน spike ว่าตัวไหนจำเป็นจริง]
- **สาเหตุ:** `executor.mjs` ส่งผ่านเฉพาะ `PATH USER LOGNAME SHELL TERM LANG LC_ALL SYSTEMROOT TEMP TMP …`; Go ใช้ `APPDATA` (`os.UserConfigDir`), `LOCALAPPDATA` (`os.UserCacheDir`), และ Windows ต้องการ `SYSTEMROOT` (มีแล้ว), `COMSPEC`, `PATHEXT`, `USERNAME`, `HOMEDRIVE`/`HOMEPATH`, `PROGRAMDATA`, `ProgramFiles`, `windir`, `NUMBER_OF_PROCESSORS`
- **การแก้:** allow-list แยกตาม platform (win32 เพิ่มรายการข้างต้น) — **แต่ยังคง** ตั้ง `USERPROFILE`/`HOME` = sandbox และ **ต้องตัดสินใจเรื่อง `APPDATA`/`LOCALAPPDATA`**: ถ้า agy เก็บอะไรใต้ `%APPDATA%` ต่อโปรไฟล์จะไม่แยก → ถ้าจำเป็นให้ชี้ `APPDATA`/`LOCALAPPDATA` ไปใต้ sandbox ด้วย (ต้องแน่ใจว่าโปรแกรมยังหา system DLL ได้ — โดยทั่วไปไม่กระทบ) [ต้องตรวจใน spike]
- **test:** unit ตรวจว่าชุด env ที่สร้างบน "platform=win32" มีคีย์ที่ต้องมีและ **ไม่มี** คีย์ลับ (เช่น `ANTIGRAVITY_API_KEYS` ถูกส่งผ่านเพราะขึ้นต้น `ANTIGRAVITY_` — ดู 4.12)

### 4.5 [ทั้งสอง OS] หา `agy` ไม่เจอเมื่อรันจาก GUI

- **อาการ macOS (ยืนยันบนเครื่องพัฒนา: `launchctl getenv PATH` ว่าง และ cwd ของแอปที่เปิดจาก Finder คือ `/`):** เปิดจาก Finder/Dock แล้ว `PATH` เป็นค่าระบบ (`/usr/bin:/bin:/usr/sbin:/sbin`) ไม่มี `~/.local/bin` หรือ Homebrew (บนเครื่องพัฒนา `node` เองก็อยู่ที่ `~/.local/bin/node`) → `detectCliCommand()` ยังเจอเพราะ fallback `~/.local/bin/agy` แต่ **`agy` เองก็ต้องการ PATH เพื่อเรียก tool/เบราว์เซอร์** (เช่น `open`) และถ้าผู้ใช้ติดตั้ง agy ที่อื่นจะไม่เจอ
- **อาการ Windows:** installer ของ Google ใส่ `%LOCALAPPDATA%\agy\bin` ลง user PATH (registry) → แอปที่เปิดจาก Explorer ได้ PATH นั้น **แต่ถ้าเพิ่งติดตั้ง agy ขณะแอปเปิดอยู่ PATH ในโปรเซสยังเป็นค่าเก่า** → หาไม่เจอจนกว่าจะเปิดแอปใหม่; และ fallback ของ bridge มีแค่ `~/.local/bin/agy.exe` ซึ่งไม่ใช่ที่ติดตั้งจริง
- **การแก้:** (1) `detectCliCommand()` เพิ่ม fallback `%LOCALAPPDATA%\agy\bin\agy.exe` (win32) และ `/opt/homebrew/bin/agy`, `/usr/local/bin/agy` (darwin) (2) desktop main **resolve absolute path เอง** (ค้นรายการเดียวกัน + ค่าที่ผู้ใช้ตั้งใน settings) แล้วส่ง `ANTIGRAVITY_BRIDGE_CMD` ที่ quote แล้วให้ bridge ทุกครั้ง (ไม่พึ่ง PATH) และ **เติม PATH** ให้ child (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `%LOCALAPPDATA%\agy\bin`) (3) หลังติดตั้ง agy จาก wizard ให้ re-scan โดยไม่ต้องเปิดแอปใหม่
- **test:** unit ของ `detectCliCommand({ platform, env, exists })` ที่ inject ได้; E2E: เปิดแอปจาก Finder (ไม่ใช่จาก terminal) แล้ว `/health` + probe ผ่าน

### 4.6 [ทั้งสอง OS] config ผูกกับ cwd ซึ่งแอป GUI ควบคุมไม่ได้

- **อาการ:** macOS เปิดจาก Finder ได้ cwd = `/`; `key generate` (จาก `/v1/keys/create`) พยายามสร้าง `/.env` → `EACCES` → "Failed to save key"; `bridge_config.json` ถูกอ่านจาก cwd ที่ไม่คาดคิด; Windows cwd = โฟลเดอร์ติดตั้งแอป (เขียนได้แต่ไม่ควรเก็บความลับที่นั่นเพราะถูกลบตอน uninstall/upgrade)
- **สาเหตุ:** `loadDotenv()`, `findPrimaryEnvFile()`, `getBridgeConfigPath()` ดู `process.cwd()` ก่อน
- **การแก้ (ฝั่ง desktop, ไม่ต้องแก้ `src/`):** fork utility process ด้วย `cwd = <userData>/bridge` (โฟลเดอร์ว่างที่แอปสร้าง) และตั้ง env ให้ครบ: `ANTIGRAVITY_BRIDGE_CONFIG=~/.config/antigravity/bridge_config.json`, `ANTIGRAVITY_QUOTA_CACHE_FILE=~/.config/antigravity/quota_cache_node.json`, `ANTIGRAVITY_SANDBOX_BASE=~/.config/antigravity/sandboxes-node`, และให้ wizard เขียน key ลง `~/.config/antigravity/bridge.env` โดยตรง (ตำแหน่งที่ `loadDotenv()` อ่านอยู่แล้ว) — ถ้ามี `.env` เก่าใน cwd ของ CLI จะไม่ถูกมองเห็น ซึ่งตั้งใจ
- **test:** integration: fork ด้วย cwd ชั่วคราวว่างเปล่า → `POST /v1/keys/create` ต้องเขียนไป `bridge.env` ใต้ HOME ทดสอบ

### 4.7 [ทั้งสอง OS] การล็อกอินโปรไฟล์มีเฉพาะใน Python

- **อาการ:** desktop ต้องมี "เพิ่มบัญชี Google" แต่ Node edition ไม่มี `profile login`; จะให้ผู้ใช้ติดตั้ง Python ก็ขัดเป้าหมาย
- **การแก้ (file mode, 4.1):** port `profile login <name>` มาที่ `src/cli/profile-cli.mjs` (CLI ก็ได้ใช้) โดยแยกตรรกะไม่ interactive ไว้ใน `src/core/profile-login.mjs`: `prepareLogin(name)` สร้าง **HOME สำหรับล็อกอินที่ว่างเปล่า** `~/.config/antigravity/.login/<name>/` (ไม่มีไฟล์ auth → agy ต้องล็อกอินใหม่แน่นอน ไม่มีทางหยิบบัญชีเดิมมาเงียบ ๆ); `runInteractiveLogin(name)` = `spawn(agy, { stdio: 'inherit', env: { HOME/USERPROFILE = login HOME, ...AGY_FILE_MODE_ENV } })`; `collectLogin(name)` อ่าน `<loginHome>/.gemini/antigravity-cli/antigravity-oauth-token` + `google_accounts.json`/`state.json` ที่ agy เขียนเอง → เขียน `oauth_creds.json`/`antigravity-oauth-token`/`google_accounts.json`/`state.json` ลง `profiles/<name>/` (0600), ยืนยันอีเมลผ่าน `oauth2/v3/userinfo` ด้วย `fetch` timeout 5 s, ลบ login HOME; **ไม่ต้องสำรอง/คืน `~/.gemini` และไม่ต้องแตะ keyring ของผู้ใช้เลย** (ต่างจาก Python เดิม) — ใน keyring mode ยังใช้ flow เดิม (สำรอง `~/.gemini`, `keyring.deleteToken()` ทุก OS, อ่านกลับจาก keyring)
- **ข้อควรระวัง:** (1) ใน SSH/file mode agy จะไม่เปิดเบราว์เซอร์เอง แต่พิมพ์ URL ให้คัดลอกและรอโค้ด → wizard ต้องแสดงคำอธิบายและปุ่ม "เปิดเบราว์เซอร์" [ต้องตรวจใน spike S8 ว่า URL หาได้อย่างไร — อาจต้องให้ผู้ใช้คลิกลิงก์ใน terminal] (2) ตรวจอีเมลจาก `userinfo` และ **ปฏิเสธถ้าอีเมลซ้ำกับโปรไฟล์อื่น** (3) ใน keyring mode เท่านั้น: ระหว่างล็อกอิน **ต้องหยุด/พัก bridge** มิฉะนั้น request ที่วิ่งอยู่จะ inject token ของโปรไฟล์อื่นทับกลางคัน
- **test:** unit ของ `collectLogin` ด้วย keyring backend `file` และ `fetch` ที่ mock; E2E manual ต่อ OS

### 4.8 [ทั้งสอง OS] การปิดโปรเซสและลูกของ agy

- **อาการ Windows:** ไม่มี `SIGTERM`; `utilityProcess.kill()` = `TerminateProcess` → handler `shutdown()` ใน `index.mjs` ไม่ทำงาน → agy.exe ที่กำลังรันกลายเป็น orphan กิน CPU/โควตาต่อ; ตอน uninstall/upgrade ไฟล์ถูกล็อก
- **อาการ macOS:** `detached: true` + `process.kill(-pid)` ทำงานได้ แต่ถ้า main ตายกะทันหัน (crash) agy ก็ยังอยู่
- **การแก้:** protocol ใน `bridge-bootstrap.mjs`: main ส่ง `postMessage({type:'shutdown'})` → bootstrap ปิด server (`server.close`, `closeIdleConnections`) แล้วฆ่า child ที่ลงทะเบียนไว้ (ให้ `executor.mjs` export registry ของ child ที่ยังวิ่ง หรือส่งสัญญาณผ่าน `AbortController` กลางที่ bootstrap ถือ) → `process.exit(0)`; main รอสูงสุด 10 s แล้วค่อย `kill()`; Windows ใช้ `taskkill /pid <agy> /t /f` (มีใน `killProcessTree()` แล้ว) และ spawn ทุกอย่างด้วย **`windowsHide: true`** (ไม่งั้นมีหน้าต่าง console กระพริบทุก request — agy/taskkill/powershell ล้วนเป็น console app)
- **test:** integration บน Windows CI: เริ่ม bridge ด้วย fake agy ที่ค้าง → สั่ง shutdown → assert ว่า PID ของ fake agy และ grandchild ตายภายใน 5 s (แบบเดียวกับ `killLeftovers` ใน `quota-fastfail.test.mjs`)

### 4.9 [Windows] สิทธิ์ไฟล์ 0600 เป็น no-op

- **อาการ:** `oauth_creds.json`, `bridge.env` (มี API key), quota cache อ่านได้โดยทุก process ของผู้ใช้เดียวกัน (ปกติสำหรับ Windows) แต่ถ้าโฟลเดอร์ผู้ใช้แชร์/ถูก sync (OneDrive) ความลับอาจรั่ว
- **การแก้:** ยอมรับตามมาตรฐาน Windows แต่ให้ Doctor เตือนถ้า `~/.config/antigravity` อยู่ใต้โฟลเดอร์ที่ sync (`OneDrive`, `Dropbox`); ตัวเลือก: หลังเขียนไฟล์ลับบน win32 รัน `icacls <file> /inheritance:r /grant:r "%USERNAME%:F"` (ต้องวัดผลกระทบเวลา)

### 4.10 [Windows] path และ encoding

- `getCanonicalAntigravityDir()` ตรวจ `"/sandboxes/"` ด้วย forward slash — ไม่กระทบเพราะ bridge เองไม่ได้รันใต้ sandbox บน desktop แต่ควรใช้ `path.sep` ให้ถูก
- ชื่อผู้ใช้ Windows เป็นภาษาไทย (`C:\Users\สมชาย`) → path ทุกอย่างมี non-ASCII: ทดสอบ spawn agy, เขียน sandbox, PowerShell (`-EncodedCommand` เป็น UTF-16 อยู่แล้ว), และ **stdout ของ agy ต้องเป็น UTF-8** ไม่ใช่ code page ของ console — bridge `chunk.toString("utf-8")`; ถ้า agy ใช้ CP874/CP1252 ข้อความไทยจะเพี้ยน [ต้องตรวจใน spike]; CRLF ใน stream-json ไม่เป็นปัญหาเพราะ parser `trim()` ทีละบรรทัด
- ความยาว path: sandbox path ยาว (`...\sandboxes-node\<profile>\.gemini\antigravity-cli\brain\<conv>\.system_generated\logs\transcript_full.jsonl`) ยังต่ำกว่า 260 แต่ถ้า username ยาว/`ANTIGRAVITY_SANDBOX_BASE` ลึก อาจชน `MAX_PATH` → ใช้ path สั้น (`%USERPROFILE%\.config\antigravity\sandboxes-node`) และเปิด long-path support ไม่ได้เพราะต้องแก้ registry (admin) → หลีกเลี่ยงแทน

### 4.11 tests ที่ผูกกับ POSIX

- `token-refresh.test.mjs` เขียน fake agy เป็นไฟล์ shebang + chmod 755 แล้ว spawn ตรง → skip บน win32 → **การแก้ 4.1 จะไม่มี test คุ้มกันบน Windows** → ปรับให้ `refreshProfileToken()` รับ `agyExec` เป็น array (`[process.execPath, script]`) หรือให้ test สร้าง `.cmd` shim; `security.test.mjs` และ `quota-fastfail.test.mjs` ใช้ `node <script>` อยู่แล้ว (ผ่านบน Windows ได้ แต่ `process.kill(pid, 'SIGKILL')` บน Windows = TerminateProcess ซึ่งใช้ได้)
- ต้องมี **CI matrix 3 OS** ตั้งแต่ Phase 1 มิฉะนั้นจะไม่มีวันรู้ว่า Windows พังเมื่อไร

### 4.12 ความลับหลุดไปยัง child ผ่าน `ANTIGRAVITY_*`

- allow-list ส่งทุกตัวแปรที่ขึ้นต้น `ANTIGRAVITY_` รวม `ANTIGRAVITY_API_KEYS`/`ANTIGRAVITY_API_KEY`/`ANTIGRAVITY_IMAGE_ROUTER_KEY` ไปให้ agy (และ tool ที่ agy อาจรันถ้าเปิด `ALLOW_CLI_TOOLS`) — เดิมก็เป็นเช่นนี้ใน CLI แต่ desktop ทำให้ผู้ใช้ทั่วไปเจอ → ตัด `*_KEY`, `*_KEYS` ออกจาก env ของ child (test: env ที่สร้างต้องไม่มีคีย์เหล่านี้)

### 4.13 การ restart ตัวเองและ "Self-Hosting Danger"

- desktop ต้องไม่ auto-restart/auto-update ขณะ `active_in_flight > 0`; ถ้า bridge exit เอง (FATAL) ให้ restart แบบ backoff (1 s, 2 s, 5 s, 10 s, สูงสุด 60 s) และหยุดหลัง 10 ครั้งใน 5 นาที พร้อมแจ้งผู้ใช้ (กัน crash loop กินโควตา/CPU)
- ถ้าผู้ใช้ให้ agent (ผ่าน bridge นี้) แก้โค้ดของ desktop app เอง คำเตือนใน `AGENTS.md` ใช้เหมือนกัน: อย่า restart จนกว่าจะ verify

---

## 5. การ bundle โปรแกรมที่จำเป็นและการทำ installer

### 5.1 สิ่งที่ผู้ใช้ต้องมี และใครเป็นคนจัดหา

| สิ่งที่ต้องมี | ใช้ทำอะไร | Windows | macOS | วิธีจัดหาใน desktop edition |
| --- | --- | --- | --- | --- |
| Node.js runtime | รัน bridge | — | — | **มากับ Electron** (ฝังใน `electron.exe` / `Electron Framework`) ผู้ใช้ไม่ต้องติดตั้ง Node; เวอร์ชัน = Node ของ Electron รุ่นที่ใช้ (Electron 28 = Node 18.18; รุ่นล่าสุด = Node 22) ซึ่งผ่าน `engines >= 18` |
| โค้ด bridge (`src/`) | ตรรกะทั้งหมด | — | — | **bundle ในแอป** (`app.asar` + `asarUnpack: src/**` เพื่อให้เป็นไฟล์จริงบนดิสก์ — debug ง่าย, `node --check` ได้, ไม่ต้องพึ่ง asar hook ของ utility process) |
| `agy` CLI (~190 MB/แพลตฟอร์ม) | คุยกับ Google | `%LOCALAPPDATA%\agy\bin\agy.exe` | `~/.local/bin/agy` | **ไม่ bundle binary (ค่าเริ่มต้นของแผนนี้)** — wizard ตรวจพบ/ติดตั้งผ่าน official installer ของ Google (5.3) |
| PowerShell | Credential Manager, `taskkill`-like งาน, installer ของ agy | มีในระบบ (5.1) — ใช้ `pwsh` 7 ถ้ามี | — | ไม่ต้อง bundle |
| `security` (Keychain CLI), `open`, Terminal.app | Keychain, เปิดเบราว์เซอร์/terminal สำหรับล็อกอิน | — | มีในระบบ | ไม่ต้อง bundle |
| Python | (เคยใช้สำหรับ `profile login`/`doctor`) | — | — | **ไม่ต้องใช้** หลัง port มา Node (4.7) |
| Git | อัปเดต | — | — | ไม่ต้องใช้ — ใช้ `electron-updater` แทน `git pull` |
| ใบรับรอง/ลายเซ็น | ให้ OS ไว้ใจ installer | Authenticode (OV/EV หรือ Azure Trusted Signing) | Developer ID Application + notarization | ฝั่งผู้พัฒนา (5.6) |

**สรุป:** installer ตัวเดียวจึงประกอบด้วย Electron + โค้ด bridge + UI + (ตัวเลือก) สคริปต์ติดตั้ง agy — ขนาดประมาณ 90–120 MB ต่อแพลตฟอร์ม; `agy` ถูกดาวน์โหลดเพิ่ม ~190 MB ตอน first-run ถ้ายังไม่มี

### 5.2 หลักการเรื่องการ bundle ของบุคคลที่สาม

- **อย่า redistribute binary ที่ไม่มีสิทธิ์** — ต้องตรวจ Terms of Service ของ Antigravity CLI ก่อน; เอกสารนี้ **ไม่ยืนยัน** ว่าอนุญาต จึงตั้งค่าเริ่มต้นเป็น "ไม่ bundle" และให้ผู้ใช้กดยอมรับการติดตั้งจาก Google เอง (wizard แสดง URL ของสคริปต์ที่จะรัน)
- binary ที่ bundle ใน `.app` บน macOS ต้องถูก **sign ด้วย Developer ID ของเรา** ทุกไฟล์ (nested code) ไม่งั้น notarization ล้มเหลว; การ re-sign binary ของ Google อาจทำลายลายเซ็นเดิม/ผิดเงื่อนไข และ `agy update` จะเขียนทับไฟล์ในแอป (ทำให้ลายเซ็นของแอปพัง → Gatekeeper ปฏิเสธเปิดครั้งถัดไป) — เหตุผลเชิงเทคนิคที่ **ไม่ควร** วาง agy ไว้ใน bundle แม้ได้รับอนุญาต
- agy มีระบบอัปเดตตัวเอง; การผูกเวอร์ชัน agy กับ installer จะทำให้ผู้ใช้ค้างเวอร์ชันเก่า

### 5.3 ตัวเลือกการจัดหา `agy` (เลือกได้ใน `electron-builder` config/feature flag)

| ตัวเลือก | วิธี | ข้อดี | ข้อเสีย/ความเสี่ยง |
| --- | --- | --- | --- |
| **O1 — ตรวจพบ + ติดตั้งจาก official installer ตอน first-run (ค่าเริ่มต้น)** | wizard ตรวจ path มาตรฐาน + PATH; ถ้าไม่พบ แสดงปุ่ม "ติดตั้ง Antigravity CLI" ที่เปิด terminal ของ OS แล้วรัน `irm https://antigravity.google/cli/install.ps1 \| iex` (Win) / `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (mac); เสร็จแล้ว re-scan | ถูกต้องเรื่องสิทธิ์, ได้เวอร์ชันล่าสุด, agy อัปเดตเองได้ | ต้องมีอินเทอร์เน็ต (ซึ่ง bridge ต้องมีอยู่แล้ว), ผู้ใช้เห็นหน้าต่าง terminal, สคริปต์ของ Google เปลี่ยนได้ (ต้องมี fallback แสดงคำสั่งให้รันเอง) |
| O2 — ติดตั้งจากใน installer (NSIS custom page / pkg postinstall) | installer เรียกสคริปต์เดียวกับ O1 ระหว่างติดตั้ง | ผู้ใช้เสร็จในขั้นเดียว | installer ต้องใช้อินเทอร์เน็ต; ล้มเหลวกลางทางทำให้ installer ดู "พัง"; per-user NSIS รันสคริปต์ในบริบทผู้ใช้ได้ แต่ pkg บน macOS รัน postinstall เป็น root → ต้อง `sudo -u $USER` และ HOME ถูกต้อง — ซับซ้อนกว่า O1 |
| O3 — bundle binary ใน `extraResources` (ต้องได้รับอนุญาตก่อน) | วาง `agy(.exe)` ใน `resources/agy/<os>-<arch>/`; bridge ใช้ `ANTIGRAVITY_BRIDGE_CMD` ชี้ไปที่นั่น | ออฟไลน์ได้ | ขนาด +190 MB ×2 arch, ปัญหา sign/notarize (5.2), ต้อง disable auto-update ของ agy หรือคัดลอกไป `~/.local/bin` ตอน first-run แล้วใช้สำเนานั้นแทน (ทำให้กลับไปคล้าย O1) |
| O4 — bundle เฉพาะ **สคริปต์ติดตั้ง** ของ Google พร้อม checksum ที่ pin | เหมือน O1 แต่ไม่ต้องดึงสคริปต์สด | ลดความเสี่ยงสคริปต์เปลี่ยน | ยังต้องดาวน์โหลด binary; checksum จะเก่าเมื่อ Google อัปเดตสคริปต์ → ต้องมีทาง fallback ไป O1 |

**ตัดสินแล้ว (เจ้าของโปรเจกต์, 2026-09-24): ไม่ bundle binary — ใช้ O1 (ให้ installer/first-run ดาวน์โหลดและติดตั้งจากแพ็กเกจ/สคริปต์ทางการของ Google หรือ trigger ให้ผู้ใช้รัน) + O4 เป็น fallback แบบ offline-script**; O3 เก็บไว้เป็น build flag (`BUNDLE_AGY=1`) ที่ปิดไว้เท่านั้น

### 5.4 เครื่องมือ installer: `electron-builder`

| แพลตฟอร์ม | รูปแบบ | เหตุผล |
| --- | --- | --- |
| Windows | **NSIS, per-user** (`perMachine: false`, `oneClick: false`, `allowToChangeInstallationDirectory: true`) → ติดตั้งที่ `%LOCALAPPDATA%\Programs\Antigravity Bridge` | ไม่ต้อง admin (Credential Manager และ `~/.config` เป็นของผู้ใช้อยู่แล้ว), auto-update ทำงานได้โดยไม่ขอสิทธิ์ |
| Windows (ทางเลือก) | MSIX/AppX | Store-ready แต่ sandbox ของ MSIX ทำให้เขียน `~/.config` และ spawn ยุ่งยาก | ไม่เลือก |
| macOS | **DMG** (สำหรับดาวน์โหลด) + **ZIP** (สำหรับ `electron-updater`) — build แยก `x64` และ `arm64` (หรือ `universal` ถ้ายอมขนาด ×2) | มาตรฐานของแอปนอก App Store |
| macOS (ทางเลือก) | `.pkg` | ใช้ได้ถ้าต้องการ postinstall แต่รันเป็น root → ปัญหา HOME (O2) | ไม่เลือก |
| Linux (ภายหลัง) | AppImage/deb | config เดียวกัน | ไม่ทดสอบในรุ่นแรก |

### 5.5 สิ่งที่ installer/first-run ทำ (ลำดับ)

1. **Installer (NSIS/DMG):** วางไฟล์แอป, สร้าง shortcut/Start Menu, **ไม่แตะ** `~/.config/antigravity` (ข้อมูลผู้ใช้อยู่นอกโฟลเดอร์แอปเสมอ); uninstaller ถาม "ลบข้อมูลโปรไฟล์และ API key ด้วยหรือไม่" (ค่าเริ่มต้น **ไม่ลบ**)
2. **เปิดแอปครั้งแรก → wizard**
   1. ตรวจสภาพแวดล้อม: OS/arch, พื้นที่ดิสก์, port 8008 ว่างไหม (ถ้าไม่ว่างและเป็น bridge เดิม → เสนอใช้ต่อ/หยุด/เปลี่ยน port), proxy ที่ตรวจพบ (`detectLocalProxy()` เดิม)
   2. ตรวจ `agy`: พบ → แสดงเวอร์ชัน (`agy --version`); ไม่พบ → O1 (เปิด terminal พร้อมคำสั่ง; แสดงคำสั่งให้คัดลอกด้วย) → re-scan
   3. เพิ่มบัญชี Google อย่างน้อย 1 โปรไฟล์ (4.7/8.6) — แสดงอีเมลที่ยืนยันได้; เพิ่มได้หลายบัญชี
   4. สร้าง API key (label เช่น `hermes-desktop`) เขียนลง `~/.config/antigravity/bridge.env`; แสดงครั้งเดียวพร้อมปุ่มคัดลอก (ดูซ้ำได้จากหน้า Settings แบบ mask + reveal)
   5. เริ่ม bridge → poll `/health` จนขึ้น → ทดสอบ 1 prompt สั้น (`profile probe`) แบบไม่บังคับ
   6. หน้า "เชื่อมกับ Hermes Desktop": URL `http://127.0.0.1:8008/v1`, API key, API Mode = Chat Completions, รายชื่อโมเดล, ปุ่มคัดลอก YAML (ภาคผนวก A) และปุ่มเปิดโฟลเดอร์ `~/.hermes`
   7. ตั้งค่า autostart (ค่าเริ่มต้นเปิด) และย่อลง tray
3. **ทุกครั้งที่เปิด:** single-instance → ตรวจ agy → เริ่ม bridge → tray

### 5.6 การ sign และ notarize (บังคับสำหรับผู้ใช้ทั่วไป)

| แพลตฟอร์ม | ต้องมี | ถ้าไม่ทำ |
| --- | --- | --- |
| macOS | Apple Developer Program → ใบรับรอง **Developer ID Application**; `hardenedRuntime: true`, `gatekeeperAssess: false`, entitlements ขั้นต่ำของ Electron (`com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation` ถ้ามี native module); notarize ผ่าน `electron-builder` (`notarize: true` + env `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); **ห้ามเปิด App Sandbox** (`com.apple.security.app-sandbox`) เพราะต้อง spawn agy, เขียน `~/.config`, เรียก `security` | ผู้ใช้เห็น "แอปเสียหาย/ไม่สามารถเปิดได้" ต้อง `xattr -dr com.apple.quarantine "/Applications/Antigravity Bridge.app"` หรือคลิกขวา > Open; auto-update ของ mac **ต้องการแอปที่ sign** |
| Windows | ใบรับรอง Authenticode (OV ธรรมดาจะโดน SmartScreen จนกว่าจะสะสม reputation; EV หรือ **Azure Trusted Signing** ผ่านทันที) ตั้งใน `win.signtoolOptions`/`azureSignOptions` ของ electron-builder | SmartScreen "Windows protected your PC" → ผู้ใช้ต้องกด More info > Run anyway; AV บางตัวกักไฟล์ |
| ทั้งคู่ | เก็บความลับใน CI secrets เท่านั้น; build ที่ไม่ได้ sign ให้ตั้งชื่อไฟล์ว่า `-unsigned` และเขียนวิธีเปิดในหน้า release | |

### 5.7 Auto-update

- `electron-updater` + GitHub Releases (ไฟล์ `latest.yml`, `latest-mac.yml`, blockmap) — ต้องเป็น **ค่าปกติของ `electron-builder`** อยู่แล้ว
- นโยบาย: ตรวจทุก 6 ชม.; ดาวน์โหลดเบื้องหลัง; **ติดตั้งเมื่อ `active_in_flight == 0` เท่านั้น** และถามผู้ใช้ก่อน (`autoInstallOnAppQuit: true` เป็นทางเลือกปลอดภัย); ห้ามอัปเดตขณะ wizard ล็อกอินค้างอยู่
- เวอร์ชันของ desktop = เวอร์ชันของ bridge (`package.json` root) — release ทุกครั้งต้อง `npm test` ผ่านบน 3 OS ก่อน package (CI ในหัวข้อ 8.9)
- macOS ต้อง sign+notarize ถึงจะอัปเดตได้; Windows ต้อง sign ด้วย cert เดิม (เปลี่ยน cert → ต้องออก release ที่ sign ด้วยทั้งสองแบบ)

### 5.8 ตำแหน่งไฟล์หลังติดตั้ง

| สิ่ง | Windows | macOS |
| --- | --- | --- |
| แอป | `%LOCALAPPDATA%\Programs\Antigravity Bridge\` (มี `resources\app.asar`, `resources\app.asar.unpacked\src\…`) | `/Applications/Antigravity Bridge.app/Contents/Resources/…` |
| ข้อมูลแอป (`app.getPath('userData')`) | `%APPDATA%\Antigravity Bridge\` (settings.json ของ desktop, cwd ของ bridge) | `~/Library/Application Support/Antigravity Bridge/` |
| log (`app.getPath('logs')`) | `%APPDATA%\Antigravity Bridge\logs\bridge.log` (หมุนไฟล์ 5 MB × 5) | `~/Library/Logs/Antigravity Bridge/bridge.log` |
| ข้อมูล bridge (ร่วมกับ CLI) | `C:\Users\<u>\.config\antigravity\{profiles,sandboxes-node,bridge.env,bridge_config.json,quota_cache_node.json}` | `~/.config/antigravity/…` |
| credential ของ agy | Credential Manager `gemini:antigravity` | Keychain `gemini`/`antigravity` |
| agy | `%LOCALAPPDATA%\agy\bin\agy.exe` | `~/.local/bin/agy` |

### 5.9 คำถาม "ทำ installer แบบออฟไลน์ทั้งหมดได้ไหม"

ได้ก็ต่อเมื่อ bundle `agy` (O3) และได้รับอนุญาต; แม้เช่นนั้นการล็อกอิน Google และการใช้งานยังต้องอินเทอร์เน็ต ประโยชน์ของออฟไลน์จึงจำกัดที่ "ติดตั้งในเครื่องที่ curl/PowerShell ถูกบล็อกโดยนโยบายองค์กร" — ให้เป็นการตัดสินใจของเจ้าของโปรเจกต์ (หัวข้อ 13)

---

## 6. แผนงานทีละเฟส

### 6.1 Phase 0 — Spike บนเครื่องจริง (1–3 วัน, ไม่มีโค้ดถาวร)

ต้องมีเครื่อง/VM: **Windows 11** (ผู้ใช้ชื่อภาษาไทย 1 เครื่อง + ชื่ออังกฤษ 1 เครื่อง), **macOS** Apple Silicon และ Intel (หรือ Rosetta) — ทุกข้อจดผลลง `docs/spike-results.md` พร้อมเวอร์ชัน agy

| # | คำถามที่ต้องตอบ | วิธีทดสอบ | ผลที่เปลี่ยนแผน |
| --- | --- | --- | --- |
| S1 | **file mode บน Windows:** ตั้ง `SSH_CONNECTION="127.0.0.1 0 127.0.0.1 22"` + `USERPROFILE`/`HOME` = โฟลเดอร์ sandbox ที่มี `.gemini\antigravity-cli\antigravity-oauth-token` ของโปรไฟล์ → `agy.exe --output-format stream-json -p "Reply with exactly one word: OK"` ต้องสำเร็จ และ `cli-*.log` ต้องมี `Using file-based token storage because SSH session detected`; ทำซ้ำ 2 โปรไฟล์คนละ sandbox → อีเมล/quota แยกกัน; ตรวจ Credential Manager (`cmdkey /list`) ว่าไม่ถูกเขียน | ผ่าน = ไม่ต้องทำ backend Credential Manager (8.1 เป็น fallback); ไม่ผ่าน = ทำ 8.1 + keyring mode |
| S2 | agy บน Windows เคารพ `USERPROFILE`=sandbox สำหรับ `.gemini/antigravity-cli/brain/...` และ `settings.json` | รันด้วย env ตาม `executor.mjs` (allow-list ใหม่ 4.4) แล้วดูว่า transcript เกิดใต้ sandbox หรือใต้ `%USERPROFILE%` จริง/`%APPDATA%` | ถ้าไม่: `readLatestAgyRunError()`/quota fast-fail ใช้ไม่ได้บน Windows → ต้องหา path จริง |
| S3 | env ขั้นต่ำที่ agy.exe ต้องการ (ไล่ตัดจาก allow-list 4.4) | รันด้วย env ว่าง + เพิ่มทีละตัว | กำหนด allow-list win32 ที่แน่นอน |
| S4 | ~~มีวิธีบังคับ agy ใช้ไฟล์แทน keyring หรือไม่~~ **ตอบแล้วบน macOS (2026-09-24): มี — `SSH_CONNECTION` (หรือ `SSH_CLIENT`/`SSH_TTY`, `WSL_DISTRO_NAME`, container, no-D-Bus)** ดู 4.1 และ `docs/spike-results.md` | เหลือยืนยัน UX ของการล็อกอินใน SSH mode (URL + โค้ด) บนทั้ง 2 OS | กำหนดขั้นตอน wizard 8.6 |
| S5 | ขีดจำกัด argv บน Windows กับ `spawn` ของ Node/Electron (`ENAMETOOLONG` ที่กี่ตัวอักษร) และ stdin NDJSON ทำงานกับ agy.exe | ยิง prompt 25 k / 40 k ไบต์ | ยืนยันค่า 24,000 ใน 4.3 |
| S6 | stdout ของ agy.exe เป็น UTF-8 หรือ code page; ภาษาไทยใน prompt/response ไม่เพี้ยน | prompt ไทย + response ไทย เทียบ byte | ถ้าเพี้ยน: ตั้ง `chcp 65001`/env `PYTHONIOENCODING`-like ของ agy? หรือ decode ตาม code page |
| S7 | เปิด Electron จาก Finder/Explorer แล้ว spawn agy ได้ (PATH, Gatekeeper กับ agy ที่ติดตั้งจาก curl) | แอป Electron เปล่า + `utilityProcess` รัน `src/index.mjs` | **macOS ทำแล้วบางส่วน (2026-09-24):** GUI PATH ว่าง/cwd `/` ยืนยัน; agy จาก installer ทางการ **signed โดย Google LLC (Developer ID) + hardened runtime** และไม่มี quarantine → Gatekeeper ไม่ขวาง; ผล `utilityProcess` ดู `docs/spike-results.md`; Windows ยังไม่ทำ |
| S8 | ล็อกอิน interactive ในหน้าต่าง terminal ที่แอปเปิดให้ แล้วเก็บ token ได้ | ทำมือตาม 8.6 | **macOS ทำแล้วบางส่วน (2026-09-24, ไม่ได้ล็อกอินจริง):** ใน `-p` mode ไม่มี credential agy พิมพ์ `authentication required. Run 'agy' to log in` (ไม่เริ่ม login เอง → ต้อง TUI); TUI ใน SSH mode แสดงเมนู → URL (redirect `antigravity.google/oauth-callback`) → รอโค้ด; ยังต้องทำจริงจนจบ 1 ครั้งต่อ OS เพื่อดูช่องกรอกโค้ดและว่า token ไฟล์ปรากฏก่อนหรือหลังพิมพ์ `hi` |
| S9 | พฤติกรรมหลัง sleep/wake: request ที่ค้างระหว่าง sleep, stall watchdog, Hermes reconnect | เริ่ม request ยาว → sleep 5 นาที → wake | ข้อความใน error catalogue; อาจต้อง reset `lastActivity` เมื่อ `powerMonitor` resume |
| S10 | Windows Defender/SmartScreen กับ build ที่ยังไม่ sign; เวลา PowerShell `Add-Type` | วัดจริง | budget ใบรับรอง; cache ของ wincred script |
| S11 | Hermes Desktop: เพิ่ม Custom Endpoint ชี้ 127.0.0.1:8008 แล้วคุยได้ครบ (stream, tool call, `/stop` → `[CLIENT DISCONNECTED]`) | ทำมือบนทั้ง 2 OS | **รูปแบบ config ยืนยันแล้ว** จาก Hermes 0.21.1 บนเครื่องพัฒนา (`providers.<id>.{api,api_key,name,models}`); การคุยจริงยังไม่ได้ทำ (ไม่แก้ config ของผู้ใช้) |

**Exit criteria:** ทุกข้อมีคำตอบพร้อมหลักฐาน (log/ภาพหน้าจอ) และรายการ "สิ่งที่ต้องแก้ใน src/" ถูกอัปเดตจากหัวข้อ 4

### 6.2 Phase 1 — ทำ `src/` ให้ cross-platform (CLI edition ได้ประโยชน์ด้วย)

| งาน | อ้างอิง | test |
| --- | --- | --- |
| **file mode:** `agyTokenMode()`, ใส่ `SSH_CONNECTION` ใน env ของ agy, ไม่ inject keyring, copy-back token ที่ refresh แล้ว, `token-daemon.mjs` ใช้ HOME แยกทุก OS, `profile login` แบบไฟล์ | 4.1 | `tests/token-mode.test.mjs` (+ E2E grep log ของ agy จริง) |
| (keyring mode เท่านั้น) `src/core/keyring.mjs` + backend win32/file, keyring mutex, drift check | 4.2, 8.1 | `tests/keyring.test.mjs`, `tests/keyring-serialize.test.mjs` |
| `MAX_CLI_ARG_BYTES` ตาม platform + inject ได้ | 4.3 | เพิ่มใน `tests/config.test.mjs`, `tests/security.test.mjs` |
| env allow-list ตาม platform, ตัด `*_KEY(S)` | 4.4, 4.12 | `tests/executor-env.test.mjs` |
| `detectCliCommand()` fallback ใหม่ + inject ได้ | 4.5 | `tests/config.test.mjs` |
| `windowsHide: true` ทุก spawn/spawnSync | 4.8 | ตรวจด้วย grep ใน test (ทุก `spawn(` ต้องมี `windowsHide`) |
| `profile login` ใน Node (`src/core/profile-login.mjs`, CLI) | 4.7 | `tests/profile-login.test.mjs` |
| shutdown hook สำหรับ host (export `registerShutdown()`/child registry จาก executor หรือ `parentPort` ใน bootstrap) | 4.8 | `tests/shutdown.test.mjs` |
| tests ที่ skip บน win32 → รันได้ | 4.11 | CI |
| **CI matrix** `ubuntu-latest`, `windows-latest`, `macos-latest` × `npm test` | 4.11 | `.github/workflows/test.yml` |
| README/README.th: หัวข้อ Windows notes (Credential Manager, arg limit) | | |

**Exit criteria:** `npm test` เขียวบน 3 OS; CLI edition บน Windows จริง (จาก PowerShell) ทำ `profile login` → `profile probe` → `curl` chat ผ่าน 2 โปรไฟล์ **ถูกอีเมล** (ตรวจจาก `X-Antigravity-Active-Profile` + อีเมลใน banner + drift check ไม่เตือน)

### 6.3 Phase 2 — Electron shell (Tier B)

`desktop/` workspace: main, bootstrap, preload, ui (wizard/status/settings/doctor), tray, autostart, port check, log rotation, agy installer flow, profile login flow, Hermes snippet — รายละเอียดหัวข้อ 8.3–8.7
**Exit criteria:** จาก `npm run dev` ใน `desktop/` ทำ A1–A6 ได้บน 2 OS ด้วย build แบบ unpacked

### 6.4 Phase 3 — Installer, signing, updater

`electron-builder.yml`, `installer.nsh`, `entitlements.mac.plist`, notarize, `electron-updater`, release workflow (8.8–8.9)
**Exit criteria:** ติดตั้งจาก DMG/NSIS บนเครื่องสะอาด (VM ใหม่) ผ่าน 5.5 ทั้งหมด; อัปเดตจากเวอร์ชันก่อนหน้าได้; uninstall แล้วข้อมูลยังอยู่

### 6.5 Phase 4 — ทดสอบครบตามหัวข้อ 9 + beta กับผู้ใช้ Hermes Desktop จริง 3–5 คน (mix Windows/mac)

### 6.6 Phase 5 — Release v1.1.0-desktop, เอกสาร, support runbook (หัวข้อ 12)

---

## 7. โครงสร้าง repo ที่เสนอ

```
antigravity-bridge/
├── src/                          # bridge (ไม่เปลี่ยนบทบาท) + ไฟล์ใหม่:
│   ├── core/keyring.mjs          #   keyring abstraction (darwin/linux/win32/file)
│   ├── core/wincred.ps1.mjs      #   สคริปต์ PowerShell เป็น string constant (หรือ .ps1 ใน asarUnpack)
│   ├── core/profile-login.mjs    #   prepareLogin/collectLogin/runInteractiveLogin
│   └── ...
├── tests/                        # + keyring/profile-login/executor-env/shutdown tests
├── desktop/                      # Electron host (มี package.json ของตัวเอง)
│   ├── package.json              #   deps: electron, electron-builder, electron-updater (dev/runtime ของ desktop เท่านั้น)
│   ├── main.mjs
│   ├── bridge-bootstrap.mjs      #   entry ของ utilityProcess
│   ├── bridge-supervisor.mjs     #   spawn/restart/backoff/health/shutdown protocol
│   ├── agy-installer.mjs
│   ├── profile-login.mjs         #   เปิด terminal + poll + เรียก src/core/profile-login.mjs
│   ├── settings.mjs              #   settings.json ของ desktop (port, autostart, agyPath override)
│   ├── preload.mjs
│   ├── ui/ {wizard.html, status.html, settings.html, doctor.html, app.css, app.js}
│   ├── build/ {icon.icns, icon.ico, icon.png, entitlements.mac.plist, installer.nsh, dmg-background.png}
│   ├── electron-builder.yml
│   └── test/ {smoke.spec.mjs}    #   Playwright for Electron
├── .github/workflows/ {test.yml, desktop-release.yml}
└── docs/DESKTOP_EDITION_GUIDE.md (ไฟล์นี้), docs/spike-results.md
```

- root `package.json` ยัง `"dependencies": {}`; เพิ่ม script `"test:desktop": "npm --prefix desktop test"` เท่านั้น
- `desktop/package.json` ใช้ `"type": "module"`, `main: "main.mjs"`, และ `extraMetadata.version` ดึงจาก root ตอน build (สคริปต์ `sync-version.mjs`) เพื่อให้เลขเวอร์ชันเดียวกัน
- `electron-builder` ต้องเห็น `../src` → ตั้ง `directories.app` เป็น root หรือใช้ `files` ที่รวม `../src/**` (electron-builder ไม่ชอบ path นอก app dir → ทางที่เรียบง่ายกว่าคือให้ `desktop/` เป็น app dir และ **copy `src/` เข้า `desktop/bridge/src` ในขั้น prebuild** ด้วยสคริปต์ `sync-src.mjs` + `.gitignore` โฟลเดอร์นั้น)

---

## 8. รายละเอียดการ implement (ร่างโค้ด — ต้องผ่าน test ก่อนใช้จริง)

> ทุก snippet ในหัวข้อนี้เป็น **ร่าง** เพื่อสื่อสารรูปแบบ ไม่ใช่โค้ดที่ทดสอบแล้ว; ให้ยึด test ในหัวข้อ 9 เป็นตัวตัดสิน

### 8.1 `src/core/keyring.mjs` — abstraction + backend Windows Credential Manager **(fallback สำหรับ keyring mode เท่านั้น; ทางหลักคือ file mode ใน 4.1/8.2)**

```js
// src/core/keyring.mjs (ร่าง)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { macKeychainStore } from "./security.mjs";

export const KEYRING_TARGET = { service: "gemini", account: "antigravity" }; // ที่ agy ใช้ทุก OS
const WINCRED_TARGET = "gemini:antigravity";                                  // go-keyring: service + ":" + user

export function keyringBackend(platform = process.platform) {
  const forced = (process.env.ANTIGRAVITY_KEYRING_BACKEND || "").trim();   // "file:<path>" สำหรับ tests
  if (forced.startsWith("file:")) return { kind: "file", path: forced.slice(5) };
  if (platform === "darwin") return { kind: "darwin" };
  if (platform === "win32") return { kind: "win32" };
  if (platform === "linux") return { kind: "linux" };
  return { kind: "none" };
}

// ---- Windows: PowerShell + P/Invoke (ไม่มี native module) ----
// blob = JSON UTF-8 ดิบ (ตรงกับที่ agy เขียน ตามหลักฐานหัวข้อ 2.2); ค่าเข้าทาง stdin เท่านั้น
const WINCRED_PS = String.raw`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class CredNative {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize;
    public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, uint type, uint f, out IntPtr c);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWriteW(ref CREDENTIAL c, uint f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDeleteW(string t, uint type, uint f);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr b);
}
"@
$op = $args[0]; $target = $args[1]
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if ($op -eq "read") {
  $p = [IntPtr]::Zero
  if (-not [CredNative]::CredReadW($target, 1, 0, [ref]$p)) { exit 2 }          # 1 = CRED_TYPE_GENERIC
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type][CredNative+CREDENTIAL])
  $b = New-Object byte[] $c.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)
  [CredNative]::CredFree($p)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b)); exit 0
} elseif ($op -eq "write") {
  $bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
  if ($bytes.Length -gt 2560) { exit 4 }                                        # CRED_MAX_CREDENTIAL_BLOB_SIZE
  $c = New-Object CredNative+CREDENTIAL
  $c.Type = 1; $c.TargetName = $target; $c.UserName = "antigravity"; $c.Persist = 2   # CRED_PERSIST_LOCAL_MACHINE (เหมือน go-keyring)
  $c.CredentialBlobSize = $bytes.Length
  $c.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
  $ok = [CredNative]::CredWriteW([ref]$c, 0)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
  if (-not $ok) { exit 3 }; exit 0
} elseif ($op -eq "delete") {
  if (-not [CredNative]::CredDeleteW($target, 1, 0)) { exit 2 }; exit 0
}
exit 1
`;

function runWincred(op, input = null, target = WINCRED_TARGET) {
  const exe = process.env.ANTIGRAVITY_POWERSHELL || "powershell.exe";        // หรือ "pwsh" ถ้ามี
  const encoded = Buffer.from(WINCRED_PS, "utf16le").toString("base64");
  const res = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded, op, target], { input: input ?? "", encoding: "utf-8", timeout: 15000, windowsHide: true });
  return res;
}

export function readToken(backend = keyringBackend()) {
  if (backend.kind === "file") { try { return JSON.parse(fs.readFileSync(backend.path, "utf-8")); } catch { return null; } }
  if (backend.kind === "win32") { const r = runWincred("read"); return r.status === 0 && r.stdout ? safeParse(r.stdout) : null; }
  if (backend.kind === "darwin") { /* security find-generic-password -w + strip go-keyring-base64: (โค้ดเดิมใน keyring-sync.mjs) */ }
  if (backend.kind === "linux") { /* secret-tool lookup (โค้ดเดิม) */ }
  return null;
}
export function writeToken(tokenObj, backend = keyringBackend()) {
  const json = JSON.stringify(tokenObj);
  if (backend.kind === "file") { fs.writeFileSync(backend.path, json, { mode: 0o600 }); return true; }
  if (backend.kind === "win32") return runWincred("write", json).status === 0;   // JSON ดิบ ไม่ใส่ prefix
  if (backend.kind === "darwin") return macKeychainStore("gemini", "antigravity", "go-keyring-base64:" + Buffer.from(json).toString("base64"));
  if (backend.kind === "linux") { /* secret-tool store (โค้ดเดิม) */ }
  return false;
}
export function deleteToken(backend = keyringBackend()) { /* file: unlink, win32: runWincred("delete"), darwin: security delete-generic-password, linux: secret-tool clear */ }
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
```

- `keyring-sync.mjs`: `injectOsKeyringToken(raw)` → `writeToken(JSON.parse(raw))`, `extractOsKeyringToken()` → `readToken()`
- `token-daemon.mjs`: เส้นทาง darwin เดิม (เขียน payload ที่ access_token ว่าง → รัน agy → poll) ใช้กับ win32 ด้วย โดยเรียกผ่าน `readToken/writeToken` และถือ keyring mutex
- **drift check** (executor, หลัง inject): `const seen = readToken(); if (seen?.token?.refresh_token && seen.token.refresh_token !== ownRefresh) throw KEYRING_DRIFT`

### 8.2 การแก้อื่นใน `src/` (สั้น ๆ)

```js
// config.mjs — file mode (4.1): agy เก็บ token เป็นไฟล์ใน HOME ของ sandbox เมื่อเห็นว่าเป็น SSH session
export function agyTokenMode() {
  return (process.env.ANTIGRAVITY_AGY_TOKEN_MODE || "file").trim().toLowerCase() === "keyring" ? "keyring" : "file";
}
export const AGY_FILE_MODE_ENV = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" }; // ค่าคงที่ ไม่ใช่ที่อยู่จริง

// executor.mjs — ใน executeCliCommand() หลังสร้าง env:
//   if (agyTokenMode() === "file") { Object.assign(env, AGY_FILE_MODE_ENV); } else if (profile) { syncProfileToSystem(profile); }
// และหลัง child ปิด (สำเร็จหรือไม่ก็ตาม):
//   copyRefreshedTokenBack(sandboxDir, profile)  // เฉพาะเมื่อไฟล์ใน sandbox ใหม่กว่าและ refresh_token ตรงกับของโปรไฟล์

export function defaultMaxCliArgBytes(platform = process.platform) {
  return platform === "win32" ? 24000 : 120000;   // Windows: ทั้ง command line ≤ 32,767 UTF-16 units
}
export const MAX_CLI_ARG_BYTES = parseInt(process.env.ANTIGRAVITY_MAX_CLI_ARG_BYTES || "", 10) || defaultMaxCliArgBytes();

export function keyringSerialized(platform = process.platform) {
  const raw = (process.env.ANTIGRAVITY_KEYRING_SERIALIZE || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return platform === "darwin" || platform === "win32";          // keyring ช่องเดียวต่อเครื่อง
}

// detectCliCommand(): fallback เพิ่ม
//   win32: path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe")
//   darwin: "/opt/homebrew/bin/agy", "/usr/local/bin/agy"

// executor.mjs: allow-list ตาม platform
const WIN_EXTRA = ["APPDATA","LOCALAPPDATA","HOMEDRIVE","HOMEPATH","USERNAME","COMSPEC","PATHEXT","PROGRAMDATA",
                   "ProgramFiles","ProgramFiles(x86)","windir","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE"];
// และตัด /(_KEY|_KEYS)$/i ออกจากตัวแปร ANTIGRAVITY_* ที่ส่งให้ child
// spawn(..., { windowsHide: true })  ทุกจุด รวม spawnSync("taskkill"), security, secret-tool, powershell

// keyring mutex (executor.mjs)
let keyringChain = Promise.resolve();
async function withKeyring(fn) {
  if (!keyringSerialized()) return fn();
  let release; const gate = new Promise((r) => (release = r));
  const prev = keyringChain; keyringChain = prev.then(() => gate);
  await prev; try { return await fn(); } finally { release(); }
}
// executeCliCommand(): return withKeyring(async () => { syncProfileToSystem(profile); driftCheck(); return runChild(); });
```

- `parseCmdTemplate(cmdTemplate, promptText, modelName, { maxArgBytes = MAX_CLI_ARG_BYTES } = {})` เพื่อ test ได้ทุก OS
- `src/core/profile-login.mjs`: ตามหัวข้อ 4.7 (ใช้ `keyring.deleteToken()` ก่อนล็อกอินทุก OS; สำรอง `~/.gemini/{oauth_creds.json,google_accounts.json,state.json}`; `collectLogin()` อ่าน `readToken()` ก่อน แล้วค่อย `extractOsFileToken()`; ยืนยันอีเมลด้วย `fetch("https://www.googleapis.com/oauth2/v3/userinfo")`; คืนไฟล์สำรอง; **คืน keyring เดิมด้วย** (อ่านเก็บไว้ก่อนลบ) เพื่อไม่ทำให้ CLI ของผู้ใช้ที่ใช้ agy โดยตรงเสียสถานะ)

### 8.3 `desktop/main.mjs` — โครง

```js
import { app, Tray, Menu, BrowserWindow, dialog, powerMonitor, shell } from "electron";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { BridgeSupervisor } from "./bridge-supervisor.mjs";
import { loadSettings } from "./settings.mjs";
import { findAgy } from "./agy-installer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();          // อินสแตนซ์เดียว (กัน port ชนกับตัวเอง)
app.on("second-instance", () => showStatusWindow());

app.whenReady().then(main).catch((e) => dialog.showErrorBox("Antigravity Bridge", String(e)));
// ห้าม `await app.whenReady()` ที่ top level ของ ESM main: ค้างตลอดกาล (ทดลองแล้ว, หัวข้อ 2.4)

async function main() {
const settings = loadSettings();                            // {port:8008, autostart:true, agyPath:null, apiKeyLabel:"hermes-desktop"}
const supervisor = new BridgeSupervisor({
  entry: path.join(__dirname, "bridge-bootstrap.mjs"),
  cwd: path.join(app.getPath("userData"), "bridge"),        // 4.6
  logFile: path.join(app.getPath("logs"), "bridge.log"),
  env: buildBridgeEnv(settings, findAgy(settings.agyPath)), // ANTIGRAVITY_BRIDGE_CMD, *_CONFIG, *_CACHE_FILE, *_SANDBOX_BASE, PATH เสริม
  port: settings.port,
});
supervisor.on("state", (s) => updateTray(s));               // starting | healthy | degraded | stopped | crashloop | port-busy
supervisor.on("fatal", (why) => dialog.showErrorBox("Antigravity Bridge", why));
await supervisor.start();

powerMonitor.on("resume", () => supervisor.noteResume());   // log marker + health re-check (S9)
app.on("before-quit", async (e) => { e.preventDefault(); await supervisor.stop({ graceful: true }); app.exit(0); });
if (!settings.onboarded) openWizard(); else createTray();
}
```

**`bridge-supervisor.mjs` หน้าที่:**

- `utilityProcess.fork(entry, [], { env, cwd, stdio: "pipe", serviceName: "antigravity-bridge" })`; ท่อ stdout/stderr → ไฟล์ log แบบหมุน (5 MB × 5) + ring buffer 500 บรรทัดสำหรับหน้า status; **mask** ค่าที่ match `sk-agv-[0-9a-f]+`/`access_token` ก่อนเขียน
- health: poll `GET /health` พร้อม `Authorization: Bearer <key จาก bridge.env>` ทุก 5 s → `healthy` เมื่อ `status:"ok"`; `degraded` เมื่อทุกโปรไฟล์ cooldown/disabled
- exit ไม่คาดคิด → backoff 1,2,5,10,…,60 s; > 10 ครั้ง/5 นาที → `crashloop` (หยุด + แสดง log 50 บรรทัดสุดท้าย)
- `stop({graceful})`: ถ้า `active_in_flight > 0` ถาม (หรือถ้า `force`) → `child.postMessage({type:"shutdown"})` → รอ `exit` ≤ 10 s → `kill()`; บน Windows ตามด้วย `taskkill /pid <agy ที่ยังอยู่> /t /f` จากรายชื่อที่ bootstrap รายงานมา (`{type:"children", pids:[…]}`)
- ก่อน start: ตรวจ port (`net.createServer().listen`); ไม่ว่าง → `GET /health` ไม่มี key: ถ้าตอบ `service:"antigravity-bridge"` แสดง "มี bridge อื่นรันอยู่ (CLI/LaunchAgent/Scheduled Task)" ให้เลือกใช้ตัวนั้น/หยุด (แสดงคำสั่ง)/เปลี่ยน port; ไม่ใช่ → "port ถูกใช้โดยโปรแกรมอื่น" ให้เปลี่ยน port

### 8.4 `desktop/bridge-bootstrap.mjs` — entry ของ utility process

```js
// รันใน Electron's Node; process.parentPort มีเฉพาะใน utilityProcess
import { setDesktopHost } from "../bridge/src/core/host.mjs";   // ไฟล์ใหม่เล็ก ๆ ใน src/: registry ของ child + shutdown hook
process.title = "antigravity-bridge";
process.env.ANTIGRAVITY_DESKTOP = "1";
const host = setDesktopHost({
  onChildrenChanged: (pids) => process.parentPort.postMessage({ type: "children", pids }),
});
process.parentPort.on("message", async ({ data }) => {
  if (data?.type === "shutdown") { await host.shutdown(); process.exit(0); }   // ปิด server, ฆ่า agy trees, ออก
  if (data?.type === "reload-keys") host.reloadKeys();                          // หลัง wizard เขียน bridge.env
});
await import("../bridge/src/index.mjs");                                        // โค้ดเดิม: parse argv (ว่าง) → listen
```

- `src/core/host.mjs` (ใหม่, เล็ก): `executor.mjs` ลงทะเบียน child ที่ spawn (`register(child)`/`unregister`) และ `index.mjs` ลงทะเบียน `server` ให้ `host.shutdown()` เรียก `shutdown()` เดิมได้ — เมื่อไม่มี host (CLI) พฤติกรรมเดิมทุกอย่าง
- port/host มาจาก env `ANTIGRAVITY_PORT`/`ANTIGRAVITY_HOST` (index.mjs อ่าน `DEFAULT_PORT` จาก env อยู่แล้ว) — ไม่ต้องส่ง argv
- `process.exit()` ใน `index.mjs` ปิดแค่ utility process; supervisor จัดการ restart

### 8.5 IPC และหน้าจอ (renderer ไม่มีสิทธิ์ Node: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`)

| channel (preload → main) | ใช้ทำ | หมายเหตุ |
| --- | --- | --- |
| `bridge:state` (event) | สถานะ supervisor + `/health` ล่าสุด + log tail | push ทุก 5 s |
| `bridge:restart`, `bridge:stop` | ปุ่มบนหน้า status | ตรวจ in-flight ก่อน |
| `agy:detect`, `agy:install` | wizard ขั้น 2 | `agy:install` เปิด terminal (5.3 O1) แล้ว re-scan |
| `profile:list`, `profile:add`, `profile:remove`, `profile:disable/enable`, `profile:reset` | จัดการโปรไฟล์ | `list` ผ่าน `GET /v1/profiles`; `add` = 8.6; `remove` ลบโฟลเดอร์โปรไฟล์ + state ใน quota cache |
| `key:create`, `key:list`, `key:revoke` | API key | เขียน `bridge.env` แล้วส่ง `reload-keys` ให้ bridge (หรือเรียก `POST /v1/keys/create` ผ่าน HTTP ซึ่งมีอยู่แล้ว) |
| `hermes:snippet` | YAML สำหรับ Hermes | สร้างจาก port/key/models จริง |
| `settings:get/set` | port, autostart, agyPath, openAtLogin | เปลี่ยน port → restart bridge + เตือนแก้ Hermes |
| `doctor:run`, `doctor:export` | ตรวจสุขภาพ + zip diagnostics | 12.2 |
| `shell:openPath`, `shell:openExternal` | เปิดโฟลเดอร์ log / ลิงก์ | allow-list URL |

หน้าจอ: **Wizard** (6 ขั้นตามหัวข้อ 5.5), **Status** (โปรไฟล์: อีเมล/สถานะ/cooldown/โควตาประมาณ, in-flight, log tail, ปุ่ม restart), **Settings**, **Doctor** — HTML ธรรมดา 1 ไฟล์ต่อหน้า, ภาษาไทย/อังกฤษสลับได้ (string table ใน `ui/i18n.js`)

### 8.6 ขั้นตอน "เพิ่มบัญชี Google" (desktop)

1. (file mode) ไม่ต้องหยุด bridge — แต่ละโปรไฟล์มี HOME ของตัวเอง; (keyring mode เท่านั้น) ตรวจ `active_in_flight == 0` → หยุด bridge เพื่อกัน keyring race
2. `prepareLogin(name)`: validate ชื่อ (`PROFILE_NAME_RE`), สร้าง login HOME ว่าง `~/.config/antigravity/.login/<name>/` (สิทธิ์ 700) และ `profiles/<name>/`
3. เขียนสคริปต์ชั่วคราวใน `userData/tmp/` ที่ตั้ง **HOME/USERPROFILE = login HOME** และ **`SSH_CONNECTION="127.0.0.1 0 127.0.0.1 22"`** (file mode) ก่อนเรียก agy:
   - macOS `login-<name>.command` (chmod 755): `#!/bin/bash` + `export HOME="<loginHome>" SSH_CONNECTION="127.0.0.1 0 127.0.0.1 22" ANTIGRAVITY_PROFILE=<name>` + `"<agyPath>"` + `echo done > "<marker>"` → `open -a Terminal "<script>"`
   - Windows `login-<name>.cmd`: `set "USERPROFILE=<loginHome>"` + `set "HOME=<loginHome>"` + `set "SSH_CONNECTION=127.0.0.1 0 127.0.0.1 22"` + `set ANTIGRAVITY_PROFILE=<name>` + `"<agyPath>"` + `echo done > "<marker>"` → ถ้ามี `wt.exe` ใช้ `wt.exe cmd /k "<script>"` ไม่งั้น `cmd.exe /c start "" cmd /k "<script>"`
   (agy ต้องการ TTY จริงสำหรับ TUI; การฝัง terminal ด้วย `node-pty` + xterm.js ต้อง native rebuild ต่อ Electron ABI — เก็บไว้ Tier C)
4. UI แสดงคำแนะนำตามหน้าจอจริงของ agy 1.2.3 ใน SSH mode (จับภาพแล้ว 2026-09-24): หน้าแรก "Welcome to the Antigravity CLI. You are currently not signed in." → "Select login method: 1. Google OAuth / 2. Use a Google Cloud project" (กด Enter เลือกข้อ 1) → "Open the URL below in your browser:" ตามด้วย URL ของ `accounts.google.com/o/oauth2/auth` (พิมพ์เป็น OSC 8 hyperlink คลิกได้ใน Terminal.app / Windows Terminal; PKCE S256, `access_type=offline`, `prompt=consent`, redirect ไป **`https://antigravity.google/oauth-callback`** ไม่ใช่ localhost) → ผู้ใช้ล็อกอินในเบราว์เซอร์ → หน้า callback ของ Google แสดงโค้ดให้คัดลอกกลับมาวางใน terminal (ช่องกรอกโค้ดตามเอกสารทางการ — ข้อความ prompt ยังไม่ได้จับภาพ) → พิมพ์ `hi` Enter → `/exit`; wizard แสดงขั้นตอนนี้พร้อมปุ่ม "ยกเลิก"
   - ทางเลือกอัตโนมัติ (Tier C): ขับ agy ผ่าน pty (`node-pty`) กด Enter เลือกข้อ 1 เอง, ดึง URL จาก OSC 8, เปิดด้วย `shell.openExternal`, รับโค้ดจากช่องในหน้า wizard แล้วส่งเข้า pty — **pty ต้องตอบ terminal query** ที่ agy ส่งตอนเริ่ม (`ESC[?2026$p`, `ESC[?2027$p`, `ESC[>c`, `ESC[c`, `ESC[?u`, `ESC[6n`, kitty graphics `ESC_Gа=q…`) และต้องตั้งขนาดหน้าต่าง มิฉะนั้น TUI ไม่วาดอะไรเลย (สังเกตจาก `script`/`expect` ที่ไม่ตอบ query); xterm.js ตอบให้อยู่แล้ว
5. poll ทุก 1 s: ไฟล์ `<loginHome>/.gemini/antigravity-cli/antigravity-oauth-token` มี `access_token` และ `refresh_token` **และ** marker ปรากฏ (agy ออกแล้ว) → ไป 6; เกิน 10 นาที → ยกเลิก (ลบ login HOME)
6. `collectLogin(name)`: คัดลอก/แปลงเป็น `oauth_creds.json`/`antigravity-oauth-token`/`google_accounts.json`/`state.json` ใน `profiles/<name>/` (0600), ยืนยันอีเมล (`userinfo`); ถ้าอีเมลซ้ำกับโปรไฟล์อื่น → ลบโฟลเดอร์ใหม่ + แจ้ง "บัญชีนี้มีอยู่แล้วในโปรไฟล์ X"; ลบ login HOME
7. อัปเดต `bridge_config.json` (`profiles` เพิ่มชื่อใหม่) → `POST /v1/profiles/config` ให้ bridge ที่รันอยู่รับรายชื่อใหม่ (หรือเริ่ม bridge ถ้าหยุดไว้) → `profile probe <name>` แบบไม่บังคับเพื่อยืนยันว่าใช้งานได้ (ใช้โควตา 1 ครั้ง — ให้ผู้ใช้เลือก) และตรวจว่า log ของ agy ใน sandbox มี `Using file-based token storage`

### 8.7 autostart, port, proxy, sleep

- **autostart:** `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` (Windows: HKCU Run; macOS: Login Items — macOS 13+ ผู้ใช้เห็นใน System Settings > Login Items และแอปต้อง sign ถึงจะแสดงชื่อถูกต้อง); ถ้าผู้ใช้เคยติดตั้ง LaunchAgent/Scheduled Task ของ CLI edition ไว้ → Doctor ตรวจ `launchctl list | grep com.antigravity.bridge.node` / `Get-ScheduledTask AntigravityBridgeNode` และเสนอปิด (ไม่งั้น port ชน)
- **port:** ค่าเริ่มต้น 8008; เปลี่ยนได้ใน Settings (validate 1024–65535, ตรวจว่าง); เปลี่ยนแล้วแสดง snippet Hermes ใหม่
- **proxy:** `detectLocalProxy()` เดิมทำงานใน bridge (WARP 40000, Clash 7890 ฯลฯ); Doctor แสดงผลลัพธ์; ผู้ใช้ปิดได้ด้วย toggle → `ANTIGRAVITY_NO_PROXY=1`
- **sleep/wake:** `powerMonitor.on("resume")` → บันทึก marker ใน log + ตรวจ `/health`; ไม่ restart อัตโนมัติ (request ที่ค้างจะจบด้วย stalled/timeout ตามปกติ และไม่ทำให้โปรไฟล์ cooldown เพราะ `[FALLBACK] ... stalled ... no cooldown`)

### 8.8 `desktop/electron-builder.yml`, `installer.nsh`, entitlements (ร่าง)

```yaml
appId: com.astrathezero.antigravity-bridge
productName: Antigravity Bridge
directories: { buildResources: build, output: dist }
files:
  - "main.mjs"
  - "bridge-*.mjs"
  - "agy-installer.mjs"
  - "profile-login.mjs"
  - "settings.mjs"
  - "preload.mjs"
  - "ui/**"
  - "bridge/src/**"            # คัดลอกจาก ../src ตอน prebuild (sync-src.mjs)
  - "package.json"
asarUnpack:
  - "bridge/src/**"            # ให้เป็นไฟล์จริง (spawn/debug/--check ได้)
  - "bridge-bootstrap.mjs"
extraResources: []             # ใส่ agy ที่นี่เฉพาะเมื่อ BUNDLE_AGY=1 (5.3 O3)
mac:
  category: public.app-category.developer-tools
  target: [{ target: dmg, arch: [arm64, x64] }, { target: zip, arch: [arm64, x64] }]
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true                # ใช้ env APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
win:
  target: [{ target: nsis, arch: [x64, arm64] }]
  # signing: ตั้ง win.signtoolOptions (certificateFile/certificatePassword หรือ certificateSubjectName)
  # หรือ win.azureSignOptions สำหรับ Azure Trusted Signing — เก็บค่าใน CI secrets เท่านั้น
nsis:
  oneClick: false
  perMachine: false             # per-user: ไม่ต้อง admin
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: false
  include: build/installer.nsh
  runAfterFinish: true
  artifactName: "${productName}-${version}-win-${arch}.${ext}"
publish:
  provider: github
  owner: astrathezero
  repo: antigravity-bridge
  releaseType: release
```

```nsis
; build/installer.nsh — ข้อความเป็นอังกฤษเพื่อเลี่ยงปัญหา encoding ของ NSIS
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete Google profiles and API keys in $PROFILE\.config\antigravity?$\r$\n(Choose No to keep them for the CLI edition or a reinstall.)" IDNO keepData
    RMDir /r "$PROFILE\.config\antigravity\sandboxes-node"
    RMDir /r "$PROFILE\.config\antigravity\profiles"
    Delete "$PROFILE\.config\antigravity\bridge.env"
    Delete "$PROFILE\.config\antigravity\quota_cache_node.json"
    Delete "$PROFILE\.config\antigravity\bridge_config.json"
  keepData:
!macroend
```

```xml
<!-- build/entitlements.mac.plist — ไม่มี app-sandbox โดยเจตนา -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
```

- DMG: ใส่ `dmg.sign: false` (ค่าปกติ) และพื้นหลังที่บอกให้ลากไป Applications
- Windows arm64: agy มี build arm64 หรือไม่ [ต้องตรวจใน spike] — ถ้าไม่มี ให้ build แอปเฉพาะ x64 (รันบน ARM ผ่าน emulation ได้)

### 8.9 CI (GitHub Actions)

```yaml
# .github/workflows/test.yml — ตั้งแต่ Phase 1
name: test
on: [push, pull_request]
jobs:
  unit:
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest, macos-latest], node: [18, 22] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}" }
      - run: node --check src/server.mjs src/core/executor.mjs src/translators/tools.mjs src/config.mjs
      - run: npm test
        env: { ANTIGRAVITY_KEYRING_BACKEND: "file:${{ runner.temp }}/keyring.json" }   # ไม่แตะ keyring จริงของ runner
```

```yaml
# .github/workflows/desktop-release.yml — Phase 3
name: desktop-release
on: { push: { tags: ["v*"] }, workflow_dispatch: {} }
jobs:
  build:
    strategy: { matrix: { os: [macos-latest, windows-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm test                                  # bridge ต้องเขียวก่อน package
      - run: npm ci
        working-directory: desktop
      - run: node sync-src.mjs && node sync-version.mjs
        working-directory: desktop
      - run: npx electron-builder --publish always
        working-directory: desktop
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}          # macOS Developer ID (base64 .p12)
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          WIN_CSC_LINK: ${{ secrets.WIN_CERT_PFX_BASE64 }}       # หรือ Azure Trusted Signing env
          WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with: { name: "desktop-${{ matrix.os }}", path: desktop/dist/*.{dmg,zip,exe,yml,blockmap} }
```

- build ที่ไม่มี secrets (PR จาก fork) ต้องยัง package ได้แบบ unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`) เพื่อทดสอบ installer ได้

---

## 9. แผนการทดสอบอย่างละเอียด

### 9.1 หลักการ

- **ทุกการเปลี่ยนแปลงใน `src/` ต้องมี test** (`AGENTS.md`) และ test ต้องรันบน 3 OS ใน CI; ห้าม test ใดแตะ keyring/โปรไฟล์จริงของเครื่อง (ใช้ `ANTIGRAVITY_KEYRING_BACKEND=file:` และ `tests/_env.mjs` ที่ชี้ HOME/config ไปโฟลเดอร์ชั่วคราว — เพิ่ม `HOME`/`USERPROFILE` override ใน `_env.mjs` ด้วย)
- fake `agy` ต้องเป็นสคริปต์ Node ที่ spawn ด้วย `node <script>` (รันได้ทุก OS) ตามแบบ `tests/quota-fastfail.test.mjs`; ห้ามใช้ shebang+chmod
- ผลการทดสอบ manual ต้องบันทึกเป็นตาราง (OS, เวอร์ชัน agy, ผล, log ที่เกี่ยวข้อง) ใน PR

### 9.2 Unit tests (เพิ่มจาก 69 เดิม)

| ไฟล์ | ครอบคลุม |
| --- | --- |
| `tests/keyring.test.mjs` | backend `file`: write/read/delete round-trip, JSON ดิบไม่มี prefix; drift check: token ที่ `refresh_token` ไม่ตรง → `KEYRING_DRIFT`; backend win32 (เฉพาะ `process.platform === "win32"`): เขียน/อ่าน/ลบ target ทดสอบ `gemini-bridge-test:antigravity`, blob 2,561 ไบต์ต้องล้มเหลว (exit 4), ค่าไทย/UTF-8 กลับมาเหมือนเดิม, ล้างใน `t.after` |
| `tests/keyring-serialize.test.mjs` | 2 โปรไฟล์พร้อมกัน + fake agy ที่อ่าน keyring file ตอน start และหน่วง 300 ms: serialize เปิด → แต่ละ run เห็น refresh_token ของตัวเอง; serialize ปิด → ใช้ตัวจับ race (บันทึกลำดับ inject/read) แสดงว่ามีโอกาสสลับ (test นี้เอาไว้พิสูจน์เหตุผลของ default ไม่ใช่ gate) |
| `tests/config.test.mjs` (+) | `defaultMaxCliArgBytes("win32") === 24000`, linux 120000; `keyringSerialized()` ตาม platform/env; `detectCliCommand({platform:"win32", env:{LOCALAPPDATA}, exists})` เจอ `agy.exe` ใน `%LOCALAPPDATA%\agy\bin` |
| `tests/executor-env.test.mjs` | env ของ child บน win32 มี `APPDATA/LOCALAPPDATA/COMSPEC/PATHEXT/SYSTEMROOT` และไม่มี `ANTIGRAVITY_API_KEYS`/`*_KEY`; HOME/USERPROFILE = sandbox; ทุก `spawn(`/`spawnSync(` ใน `src/` มี `windowsHide: true` (grep) |
| `tests/security.test.mjs` (+) | prompt 30 k ไบต์บน `maxArgBytes: 24000` → `stdinInput` NDJSON; argv ไม่มี prompt |
| `tests/profile-login.test.mjs` | `prepareLogin` สำรองไฟล์และลบ keyring (file backend); `collectLogin` เขียนไฟล์โปรไฟล์ 0600 (ยกเว้น win32), ยืนยันอีเมลด้วย `fetch` ที่ mock (200/401/timeout), ปฏิเสธอีเมลซ้ำ, คืนไฟล์และ keyring เดิมเสมอแม้ error |
| `tests/shutdown.test.mjs` | host shutdown: server ปิด, child ที่ลงทะเบียน (fake agy ค้าง + grandchild) ตายภายใน 5 s บนทุก OS (Windows ผ่าน taskkill) |
| `tests/token-refresh.test.mjs` (แก้) | รันบน win32 ด้วย `agyExec: [process.execPath, script]`; เพิ่มกรณี darwin/win32 ผ่าน keyring backend file: payload access_token ว่างถูกเขียนก่อน, token ใหม่ที่ refresh_token ตรงเท่านั้นที่รับ |

### 9.3 Integration (bridge จริง + fake agy) — รันใน CI ทั้ง 3 OS

1. เริ่ม `src/index.mjs` เป็น child ด้วย env แบบ desktop (cwd ว่าง, `ANTIGRAVITY_BRIDGE_CONFIG/…` ชี้ temp, `ANTIGRAVITY_BRIDGE_CMD="node fake.cjs {prompt}"`) → `/health` → `POST /v1/keys/create` ต้องเขียน `bridge.env` ใต้ HOME temp ไม่ใช่ cwd
2. chat ผ่าน 2 โปรไฟล์ → `X-Antigravity-Active-Profile` สลับตาม LRU และ fake agy ยืนยัน refresh_token ที่เห็น
3. stream + client disconnect กลางทาง → `[CLIENT DISCONNECTED]` + fake agy ตาย (Windows: ตรวจด้วย `tasklist`/`process.kill(pid,0)`)
4. quota fast-fail (ใช้ fake จาก `quota-fastfail.test.mjs`) ทำงานบน Windows (transcript path ใต้ sandbox — ขึ้นกับ S2)
5. shutdown protocol ผ่าน `parentPort`-เทียบเท่า (ใน CI ใช้ Node ธรรมดา: ส่ง `SIGTERM`/message ผ่าน IPC channel ของ `child_process.fork`)

### 9.4 Desktop smoke (Playwright for Electron) — `desktop/test/smoke.spec.mjs`

- launch ด้วย env: HOME/USERPROFILE temp, `ANTIGRAVITY_BRIDGE_CMD` = fake, `ANTIGRAVITY_KEYRING_BACKEND=file:`, `AGY_FAKE_PATH` ให้ `findAgy()` เจอ
- ตรวจ: single instance (launch ครั้งที่ 2 ออกทันที), wizard เปิดเมื่อยังไม่ onboarded, ขั้น "ตรวจ agy" ผ่าน, สร้าง key → `bridge.env` มี `ANTIGRAVITY_API_KEYS=`, bridge healthy ภายใน 10 s, หน้า Hermes snippet มี URL/port/key ถูกต้อง, ปิดแอป → ไม่มีโปรเซส `node`/fake ค้าง
- รันบน CI mac/windows (Electron headless ได้บน runner ทั้งสอง; ใช้ `xvfb` เฉพาะ Linux)

### 9.5 E2E manual กับ `agy` จริง (ต่อ OS; บันทึกผลทุกแถว)

| # | สถานการณ์ | ขั้นตอน | ผลที่ต้องได้ |
| --- | --- | --- | --- |
| E1 | เครื่องสะอาด ไม่มี agy | ติดตั้ง → เปิด → wizard | ตรวจไม่พบ agy → ติดตั้งผ่าน terminal → re-scan เจอ + เวอร์ชัน |
| E2 | เพิ่มบัญชี 2 บัญชี | wizard ขั้น 3 สองรอบ | อีเมลตรงกับที่เลือกในเบราว์เซอร์; โฟลเดอร์โปรไฟล์ 4 ไฟล์; `~/.gemini` และ keyring กลับสภาพเดิม |
| E3 | หมุนโปรไฟล์ถูกบัญชี | ยิง 4 request สลับกัน (curl) ดู `X-Antigravity-Active-Profile` + banner อีเมล + drift check ไม่เตือน; บน Windows เปิด Credential Manager ดูว่าค่าเปลี่ยนตาม | ไม่มี mix-up |
| E4 | prompt ยาว 40 KB (ไทย) | curl ด้วยไฟล์ | Windows ใช้ stdin (`[EXEC] … delivering via stdin NDJSON`), ตอบครบ, ไม่มี ENAMETOOLONG |
| E5 | โควตาหมด | ใช้บัญชีที่หมดจริง หรือ disable ทุกโปรไฟล์ยกเว้นตัวที่หมด | `[QUOTA]` ภายในไม่กี่วินาที, `[FALLBACK]` ไปตัวถัดไป, หน้า status แสดง cooldown |
| E6 | ปิดแอปขณะ request วิ่ง | เริ่ม prompt ยาว → Quit | ถามยืนยัน; เลือก Quit → agy ตายภายใน 10 s (ตรวจ Task Manager/Activity Monitor) |
| E7 | sleep/wake | request ยาว → sleep 5 นาที → wake | log marker; request จบด้วย stalled/timeout; request ใหม่ผ่าน; Hermes ต่อใหม่ได้ |
| E8 | port ชน | เปิด CLI bridge บน 8008 ก่อน แล้วเปิดแอป | dialog "มี bridge อื่น" พร้อมตัวเลือก; เลือกเปลี่ยน port → Hermes snippet ใหม่ |
| E9 | autostart | เปิด toggle → logout/login หรือ reboot | tray ขึ้นเอง, `/health` ok ภายใน 30 s |
| E10 | อัปเดต | ติดตั้ง v(n-1) → publish v(n) → รอ/กดตรวจ | ดาวน์โหลดเบื้องหลัง, ติดตั้งเมื่อ idle เท่านั้น, โปรไฟล์/key คงอยู่ |
| E11 | uninstall | ถอน → เลือก "เก็บข้อมูล" | `~/.config/antigravity` ยังอยู่; ติดตั้งใหม่แล้วโปรไฟล์กลับมาโดยไม่ต้องล็อกอิน |
| E12 | ชื่อผู้ใช้ภาษาไทย/มีช่องว่าง (Windows) | ทำ E1–E4 บนบัญชี `สมชาย ใจดี` | ทุกอย่างผ่าน; path ใน log ถูกต้อง |
| E13 | ไม่มีอินเทอร์เน็ต | ปิด Wi-Fi แล้ว chat | error ชัดเจนภายใน timeout; ไม่ crash loop; โปรไฟล์ไม่ถูก cooldown ยาวผิด ๆ |
| E14 | proxy/WARP เปิดอยู่ | เปิด Cloudflare WARP (SOCKS 40000) | Doctor แสดง proxy; agy ยังใช้งานได้; toggle ปิด proxy detection แล้วยังใช้ได้ |
| E15 | Keychain ACL (macOS) | ครั้งแรกหลังติดตั้ง | ถ้ามี dialog ของ Keychain ให้ "Always Allow" → ครั้งต่อไปไม่ถาม |
| E16 | build ไม่ sign | เปิด DMG/EXE ที่ไม่ sign | ข้อความ Gatekeeper/SmartScreen ตรงกับที่เขียนในหน้า release; วิธี workaround ใช้ได้ |
| E17 | CLI edition ร่วมกับ desktop | ใช้ `node src/index.mjs profile list` ขณะ desktop รัน | เห็นโปรไฟล์ชุดเดียวกัน; `profile probe` ผ่าน (sandbox คนละ base ถ้าตั้งต่างกัน) |

### 9.6 Hermes Desktop end-to-end (ทั้ง 2 OS)

1. Settings → Providers → Custom Endpoints → base URL `http://127.0.0.1:8008/v1`, API key จาก wizard, API Mode **Chat Completions**, เพิ่มโมเดล `gemini-3.8-flash`, `claude-sonnet-4.6-thinking`
2. คุยธรรมดา (stream) → คำตอบ + banner โปรไฟล์; ใช้ tool (terminal/read_file ของ Hermes) → `[TOOL TRANSLATED]`/tool_calls ทำงาน; `/stop` → `[CLIENT DISCONNECTED]`
3. prompt ยาว (แนบไฟล์ 100 KB) → ผ่าน stdin path; ตั้ง `agent.gateway_timeout`/timeout ของ endpoint ≥ 300 s ตาม README
4. ปิดเปิด Hermes Desktop และ Bridge Desktop สลับกัน → ต่อกันได้เองทุกลำดับ

### 9.7 Soak และ failure injection

- **Soak 24 ชม.:** Hermes ส่งข้อความทุก 10 นาที (สคริปต์) + auto-refresh ทุก 55 นาที; ตรวจ RSS ของ utility process ไม่โตเกิน 300 MB, ไม่มี agy ค้าง (`tasklist`/`pgrep agy`), log หมุนถูกต้อง, ไม่มี `[FATAL]`
- **Failure injection:** ฆ่า agy กลางทาง (task manager) → request ล้มเหลวอย่างสะอาด; ลบ `bridge.env` ขณะรัน → 401 + Doctor ชี้สาเหตุ; ทำ token เสีย (แก้ refresh_token) → auto-refresh รายงาน failed, drift check ไม่ผิดพลาด, wizard เสนอ "ล็อกอินใหม่"; เต็มดิสก์ (ใช้ RAM disk เล็ก) → quota cache/log เขียนไม่ได้แต่ bridge ยังตอบ
- **Crash loop:** ใส่ syntax error ใน `bridge/src/config.mjs` ของ build ทดสอบ → supervisor หยุดหลัง 10 ครั้ง/5 นาที + แสดง log; ยืนยันว่าไม่กินโควตา (agy ไม่ถูก spawn)

### 9.8 เกณฑ์รับงาน (definition of done) ต่อ release

- [ ] CI unit เขียว 3 OS × Node 18/22; integration เขียว 3 OS; smoke เขียว mac/win
- [ ] E1–E17 ผ่านบน Windows 11 (ผู้ใช้ไทย + อังกฤษ) และ macOS (arm64 + x64) พร้อมหลักฐาน
- [ ] Hermes E2E ผ่านทั้ง 2 OS
- [ ] Soak 24 ชม. ผ่าน; failure injection ทุกข้อผ่าน
- [ ] installer sign/notarize สำเร็จ; `spctl -a -vv` (mac) และ `signtool verify /pa` (win) ผ่าน
- [ ] `docs/spike-results.md` และแคตตาล็อกหัวข้อ 10 อัปเดตตามสิ่งที่พบจริง

---

## 10. แคตตาล็อกความผิดพลาด (อาการ → สาเหตุ → ทางแก้/ป้องกัน)

| # | อาการ | สาเหตุ | ทางแก้ / ป้องกัน | จับได้ที่ |
| --- | --- | --- | --- | --- |
| P1 | Windows: ทุกโปรไฟล์ใช้อีเมลเดียวกัน โควตาหมดเร็ว | agy ใช้ Credential Manager (ช่องเดียว) เพราะ **ไม่ได้ตั้ง `SSH_CONNECTION`** (keyring mode โดยไม่ตั้งใจ) หรือ agy รุ่นใหม่เลิกสนใจ detector | file mode (4.1) + E2E grep log; ถ้าจำเป็น keyring.mjs win32 + drift check | E3, `[KEYRING_DRIFT]` |
| P2 | macOS/Windows: บางครั้งคำตอบมาจากบัญชีอื่น | keyring race ข้ามโปรไฟล์ — เกิดเฉพาะ keyring mode (4.2) | file mode (4.1); ใน keyring mode ต้อง serialize | E3, keyring-serialize test |
| P3 | Windows: `spawn … ENAMETOOLONG`/ทุกโปรไฟล์ล้มเหลวกับ prompt ยาว | arg limit 32,767 (4.3) | MAX_CLI_ARG_BYTES=24000 บน win32 → stdin | E4 |
| P4 | Windows: agy ออกทันที `exit=1` หรือ error เกี่ยวกับ APPDATA/cmd.exe | env allow-list ตัดตัวแปรจำเป็น (4.4) | allow-list win32 | S3 |
| P5 | "agy: command not found"/`ENOENT` แม้ติดตั้งแล้ว | GUI ไม่ได้ PATH ของ shell; PATH ในโปรเซสเก่า (4.5) | resolve path เอง + `ANTIGRAVITY_BRIDGE_CMD`; re-scan หลังติดตั้ง | wizard, Doctor |
| P6 | `key generate` ล้มเหลว `EACCES /.env` (macOS) | cwd = `/` (4.6) | cwd = userData/bridge + `bridge.env` | integration 9.3(1) |
| P7 | มีหน้าต่างดำกระพริบทุกครั้งที่ตอบ (Windows) | spawn console app จาก GUI ไม่มี `windowsHide` | `windowsHide: true` ทุก spawn | executor-env test |
| P8 | ปิดแอปแล้ว agy.exe/`node` ยังค้างใน Task Manager | Windows ไม่มี SIGTERM; TerminateProcess ไม่ฆ่าลูก | shutdown protocol + taskkill /t | E6, shutdown test |
| P9 | ถอนการติดตั้ง/อัปเดตล้มเหลว "file in use" | ข้อ P8 | เหมือน P8; NSIS `!macro customInit` ปิดแอปก่อน (electron-builder มี `allowToChangeInstallationDirectory`+ kill process อยู่แล้ว) | E10, E11 |
| P10 | หลังติดตั้งจากเว็บ macOS บอก "damaged"/"can't be opened" | ไม่ได้ sign/notarize | sign+notarize; workaround `xattr -dr com.apple.quarantine` | E16 |
| P11 | Windows SmartScreen เตือน | cert ไม่มี/ไม่มี reputation | EV/Azure Trusted Signing | E16 |
| P12 | macOS ถามสิทธิ์ Keychain ซ้ำ ๆ | ACL ของ item `gemini` ไม่รวม `security` | คลิก Always Allow ครั้งแรก; Doctor แนะนำ | E15 |
| P13 | wizard เก็บ token ผิดบัญชี | ล็อกอินขณะ bridge ยัง inject โปรไฟล์อื่น (4.7) | หยุด bridge ระหว่างล็อกอิน; ตรวจอีเมลจาก userinfo | profile-login test |
| P14 | ผู้ใช้ล็อกอินบัญชีเดิมซ้ำเป็นโปรไฟล์ที่สอง | เลือกบัญชีผิดในเบราว์เซอร์ | ปฏิเสธอีเมลซ้ำ | profile-login test |
| P15 | ล็อกอินค้าง terminal ไม่ปิด | ผู้ใช้ไม่พิมพ์ `/exit` | marker + timeout 10 นาที + ปุ่มยกเลิก (ฆ่า agy) | E2 |
| P16 | `EADDRINUSE 8008` แล้ว bridge restart วน | CLI/LaunchAgent/Scheduled Task เดิม หรือแอปอื่น | ตรวจ port ก่อน start + dialog | E8 |
| P17 | Hermes: "connection refused"/timeout | bridge ยังไม่ขึ้น, port เปลี่ยน, API key ผิด, timeout ฝั่ง Hermes สั้น | หน้า status + snippet ใหม่; README Agent Client Tuning (≥300 s) | 9.6 |
| P18 | Hermes: 403 Forbidden | Host header ไม่ใช่ loopback (ใช้ชื่อเครื่อง/`host.docker.internal`) | ใช้ `127.0.0.1`; หรือ `ANTIGRAVITY_ALLOWED_HOSTS` | security test เดิม |
| P19 | Hermes: 401 | key ถูก revoke/`bridge.env` หาย | Doctor ตรวจไฟล์ + key list | failure injection |
| P20 | คำตอบไทยเพี้ยนบน Windows | stdout code page ไม่ใช่ UTF-8 (4.10) | ตาม S6 | E4/E12 |
| P21 | path ยาวเกิน/`ENAMETOOLONG` ใน sandbox บน Windows | username/ base ลึก (4.10) | ใช้ base สั้น; Doctor เตือน | E12 |
| P22 | `[QUOTA]` ไม่ทำงานบน Windows (รอ 2.5 นาที) | transcript ไม่อยู่ใต้ sandbox (S2) | หา path จริง/แก้ `agyRunTranscriptPath` ให้รับ base อื่น | 9.3(4) |
| P23 | หลัง wake จาก sleep request แรกล้ม "stalled" | เวลาเงียบระหว่าง sleep ถูกนับ | ยอมรับ + log marker; ไม่ cooldown | E7 |
| P24 | auto-refresh รายงาน failed ทุกโปรไฟล์บน Windows/macOS | token-daemon รัน agy โดยไม่ตั้ง `SSH_CONNECTION` → agy ไปอ่าน keyring แทนไฟล์ใน HOME แยก | ตั้ง `AGY_FILE_MODE_ENV` ใน token-daemon ทุก OS (4.1 ข้อ 4) | token-refresh test |
| P25 | ทุกโปรไฟล์อยู่ใน cooldown ยาวหลังเน็ตหลุด | error ถูกจัดเป็น quota/auth ผิดประเภท | ตรวจ `isQuotaOrRateLimitError` กับข้อความ offline (`dial tcp`, `no such host`) → ควรเป็น error back-off สั้น; เพิ่ม test | E13 |
| P26 | crash loop กิน CPU | โค้ด bridge พัง (อัปเดตแย่) | backoff + หยุดหลัง 10 ครั้ง; ห้ามอัปเดตขณะ in-flight | 9.7 |
| P27 | อัปเดตแล้วโปรไฟล์หาย | เก็บข้อมูลไว้ในโฟลเดอร์แอป | ข้อมูลอยู่ `~/.config/antigravity` เท่านั้น | E10/E11 |
| P28 | AV/Defender ช้า หรือกักไฟล์ sandbox | agy เขียนไฟล์จำนวนมาก | เอกสารแนะนำ exclusion (ตัวเลือก); ไม่บังคับ | soak |
| P29 | OneDrive sync `~/.config` (บางเครื่องตั้ง Known Folder Move ไว้) หรือ Documents | ความลับถูก sync/conflict copies | Doctor เตือนถ้า path อยู่ใต้ OneDrive/Dropbox | Doctor |
| P30 | สองอินสแตนซ์ของแอป | ไม่มี single-instance lock | `requestSingleInstanceLock` | smoke |
| P31 | Windows arm64 ไม่มี agy | Google ไม่มี build | แสดงข้อความ + ใช้ x64 emulation | S-spike |
| P32 | Electron `utilityProcess` โหลด `.mjs` ไม่ได้ (`ERR_REQUIRE_ESM`) | Electron < 28 | ใช้ Electron ≥ 28 (ล่าสุด) | smoke |
| P33 | `app.setPath`/settings ไม่ทันก่อน `ready` | ESM main โหลด async | `await` ก่อน `whenReady`; ไม่ใช้ dynamic import สำหรับ setup | code review |
| P34 | Keychain: token ของผู้ใช้ที่ใช้ `agy` เองหาย/สลับหลังใช้แอป | bridge เขียน keyring ทับ (พฤติกรรมเดิมของ CLI edition) | เอกสารเตือน; wizard คืน keyring เดิมหลังล็อกอิน; ตัวเลือก "restore my own agy login" ใน Doctor | E2 |
| P35 | ความลับใน log | `[AUTO-REFRESH]` เคยพิมพ์ expiry เท่านั้น แต่ error ของ agy อาจมี token | mask ใน supervisor ก่อนเขียนไฟล์ | code review + grep log ใน soak |
| P36 | ผู้ใช้ตั้ง `ANTIGRAVITY_ALLOW_CLI_TOOLS=1` ใน `bridge.env` | เปิดให้ agent รันคำสั่งบนเครื่อง | UI ไม่มี toggle นี้; Doctor เตือนสีแดงถ้าเปิด | Doctor |
| P37 | installer ต้องการ admin/UAC | `perMachine: true` | per-user | E1 |
| P38 | Thai text ใน NSIS แสดงเป็น ??? | encoding ของ .nsh | ข้อความอังกฤษใน installer; ไทยใน UI ของแอป | E1 |

---

## 11. ความปลอดภัย (สรุปสิ่งที่ desktop ต้องรักษาไว้และเพิ่ม)

- **คงเดิมจาก CLI edition:** bind `127.0.0.1`, Host allow-list, CORS ปิด, API key เทียบแบบ constant-time, API mode ฆ่า run ที่ agy ใช้ tool เอง, ไฟล์ลับ 0600 (POSIX)
- **เพิ่มใน desktop:** (1) wizard บังคับสร้าง API key — ไม่มี anonymous mode (2) renderer แยกจาก Node (`contextIsolation`, `sandbox`, preload allow-list) (3) ไม่ส่ง `*_KEY(S)` ให้ agy (4.12) (4) mask token/key ใน log และ diagnostics export (5) auto-update ตรวจลายเซ็น (Windows: electron-updater ตรวจ Authenticode ของ installer ใหม่เทียบกับ `publisherName` ที่ตั้งไว้; macOS: Squirrel.Mac/ระบบปฏิบัติการยอมรับเฉพาะแอปที่ sign+notarize ด้วย identity เดิม) (6) ไม่มี UI สำหรับ `0.0.0.0`/`--enable-cors`/`ALLOW_CLI_TOOLS`; ถ้าผู้ใช้ตั้งเองใน `bridge.env` Doctor เตือน
- **ข้อจำกัดที่ต้องบอกผู้ใช้:** Windows ไม่มี 0600 — โปรเซสใดของผู้ใช้เดียวกันอ่าน token ได้ (เหมือน agy เอง); Keychain/Credential Manager entry `gemini`/`antigravity` เป็นของ agy และ bridge จะเขียนทับตามโปรไฟล์ที่ใช้ (P34)
- **การรายงานช่องโหว่:** ตามที่ README/LICENSE ระบุ; ไม่ใส่ token จริงใน issue

## 12. การดูแลรักษาและ release

### 12.1 Release checklist (ทุกรุ่น)

1. `npm test` เขียว 3 OS (CI) และ `node --check` ตาม `AGENTS.md`
2. เลขเวอร์ชัน root `package.json` = desktop (สคริปต์ sync) และ changelog ระบุการเปลี่ยนแปลงฝั่ง bridge แยกจากฝั่ง desktop
3. tag `vX.Y.Z` → workflow build/sign/notarize/publish → ตรวจ `latest.yml`/`latest-mac.yml` ใน release
4. ติดตั้งจริงบน VM สะอาด 2 OS (E1) + อัปเดตจากรุ่นก่อน (E10) ก่อนกด "Publish release"
5. อัปเดต README/README.th หัวข้อ Desktop (ลิงก์ดาวน์โหลด, ความต้องการระบบ, วิธีเปิด build ที่ไม่ sign ถ้ามี)

### 12.2 Support runbook

| สิ่งที่ผู้ใช้ควรส่งมา | ได้จาก |
| --- | --- |
| Diagnostics zip (ไม่มีความลับ) | Doctor → Export: เวอร์ชันแอป/agy/OS, `settings.json`, `bridge_config.json`, 500 บรรทัดสุดท้ายของ log (mask แล้ว), ผล `/health` (mask key), รายชื่อโปรไฟล์+อีเมล+สถานะ, ผล port/proxy/PATH, ผลตรวจ keyring backend (read ได้/ไม่ได้ — ไม่ใส่ค่า) |
| log เต็ม | Windows `%APPDATA%\Antigravity Bridge\logs\`, macOS `~/Library/Logs/Antigravity Bridge/` |
| transcript ของ run ที่มีปัญหา | `~/.config/antigravity/sandboxes-node/<profile>/.gemini/antigravity-cli/brain/<run>/.system_generated/logs/transcript.jsonl` (มี prompt ทั้งหมด — ให้ผู้ใช้ตรวจก่อนส่ง) |

คำถามแรกที่ support ควรถาม: OS/เวอร์ชัน, agy เวอร์ชัน (`agy --version`), เปิดจาก wizard หรือ CLI, มี bridge อื่นบน 8008 ไหม, สถานะโปรไฟล์ในหน้า status

### 12.3 การอัปเดต agy

- agy อัปเดตตัวเอง (`agy update`/auto) → format ของ credential/stream-json อาจเปลี่ยน → Doctor แสดงเวอร์ชัน agy และ release note ของเราระบุเวอร์ชันที่ทดสอบแล้ว; test ที่ผูกกับ format (stream-json parser, wincred blob) ต้องมี fixture จากเวอร์ชันจริง

## 13. การตัดสินใจที่ต้องการจากเจ้าของโปรเจกต์

| # | คำถาม | ค่าเริ่มต้นในแผนนี้ |
| --- | --- | --- |
| D1 | bundle `agy` binary ในแอป (O3) หรือไม่ | **ตัดสินแล้ว 2026-09-24: ไม่ bundle** — installer/first-run ดาวน์โหลดแพ็กเกจ/สคริปต์ทางการมาติดตั้ง หรือ trigger ให้ผู้ใช้รัน (O1 + O4) |
| D2 | งบใบรับรอง: Apple Developer Program (ปีละ 99 USD) + Windows code signing (EV/Azure Trusted Signing) | ต้องมีทั้งสองก่อน public release |
| D3 | ~~serialize keyring บน mac/Windows~~ | **ไม่ต้องตัดสินแล้ว:** S4 พบว่า agy เก็บ token เป็นไฟล์ต่อโปรไฟล์ได้ (file mode, 4.1) จึงไม่ต้อง serialize; เหลือยืนยันบน Windows (S1) |
| D4 | ที่เก็บโปรไฟล์บน Windows คง `C:\Users\<u>\.config\antigravity` (เข้ากับ CLI) หรือย้ายไป `%APPDATA%` | คงเดิม |
| D5 | รองรับ Linux desktop ในรุ่นแรก | ไม่ |
| D6 | ชื่อผลิตภัณฑ์/ไอคอน/appId (`com.astrathezero.antigravity-bridge`) | ตามที่เขียน |
| D7 | Tier A (service installer) ควรออกก่อน Tier B ไหม | ทำ Phase 0–1 ก่อน แล้วตัดสิน |
| D8 | ให้ desktop รวมโหมด "ใช้ bridge ที่รันบนเครื่องอื่น" (เช่น n8n.mrserm.com) เป็นเพียง client config ไหม | ไม่ — Hermes ชี้ไปที่นั่นได้เองอยู่แล้ว |

## 14. ภาคผนวก

### A. เชื่อม Hermes Desktop กับ Bridge Desktop

**ผ่าน UI:** Settings → Providers → Custom Endpoints → Add: Base URL `http://127.0.0.1:8008/v1`, API key = ค่าจาก wizard, API Mode = **Chat Completions**, เพิ่มโมเดลจากรายการ `GET /v1/models` (เช่น `gemini-3.8-flash`, `gemini-3.7-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4.6-thinking`, `claude-opus-4.6-thinking`, `gpt-oss-120b-medium`)

**หรือใน `config.yaml` ของโปรไฟล์ Hermes** (ตาม README หัวข้อ Hermes Agent Integration; ปุ่ม "คัดลอก YAML" ใน wizard สร้างสิ่งนี้ให้):

```yaml
model:
  default: gemini-3.8-flash
  provider: agy-bridge
providers:                # Hermes 0.21.x ใช้ key นี้ (ตรวจจาก ~/.hermes/config.yaml บนเครื่องพัฒนา 2026-09-24); README เดิมเขียน custom_providers ซึ่งเป็นชื่อรุ่นเก่า
  agy-bridge:
    api: http://127.0.0.1:8008/v1
    api_key: sk-agv-XXXXXXXXXXXXXXXX        # จาก wizard / node src/index.mjs key list
    name: Antigravity Bridge (local)
    models:
      gemini-3.8-flash: { context_length: 1000000 }
      gemini-3.7-flash-high: { context_length: 1000000 }
      gemini-3.1-pro-high: { context_length: 2000000 }
      claude-sonnet-4.6-thinking: { context_length: 200000 }
      claude-opus-4.6-thinking: { context_length: 200000 }
agent:
  max_turns: 150
  gateway_timeout: 1800
```

ข้อควรจำ: timeout ของ endpoint ≥ 300 s, ปิด pre-flight classifier ที่ timeout สั้น, จำกัด tool ที่ส่ง (README หัวข้อ Agent Client Tuning)

### B. Cheat sheet คำสั่งสำหรับ support

| งาน | Windows (PowerShell) | macOS |
| --- | --- | --- |
| agy อยู่ไหน/เวอร์ชัน | `Get-Command agy; & "$env:LOCALAPPDATA\agy\bin\agy.exe" --version` | `which agy; ~/.local/bin/agy --version` |
| ดู credential ของ agy (มี/ไม่มี) | `cmdkey /list \| Select-String gemini` | `security find-generic-password -s gemini -a antigravity` (ไม่ใส่ `-w` เพื่อไม่พิมพ์ค่า) |
| health | `Invoke-RestMethod http://127.0.0.1:8008/health` | `curl -s http://127.0.0.1:8008/health` |
| ใครใช้ port 8008 | `Get-NetTCPConnection -LocalPort 8008 \| % OwningProcess \| % { Get-Process -Id $_ }` | `lsof -nP -iTCP:8008` |
| ฆ่า agy ค้าง | `Get-Process agy \| Stop-Process -Force` | `pkill -9 agy` |
| โปรไฟล์ (CLI edition ในโฟลเดอร์แอป) | `node "$env:LOCALAPPDATA\Programs\Antigravity Bridge\resources\app.asar.unpacked\bridge\src\index.mjs" profile list` (ต้องมี Node) — ปกติใช้หน้า Status แทน | `node "/Applications/Antigravity Bridge.app/Contents/Resources/app.asar.unpacked/bridge/src/index.mjs" profile list` |
| log | `%APPDATA%\Antigravity Bridge\logs\bridge.log` | `~/Library/Logs/Antigravity Bridge/bridge.log` |
| ลบ quarantine (build ไม่ sign) | — | `xattr -dr com.apple.quarantine "/Applications/Antigravity Bridge.app"` |

### C. แหล่งอ้างอิงที่ใช้ตรวจสอบข้อเท็จจริง (เข้าถึง 2026-09-24)

- โค้ดใน repo: `src/index.mjs`, `src/config.mjs`, `src/core/{executor,sandbox,keyring-sync,token-daemon,profile-manager,security}.mjs`, `src/cli/profile-cli.mjs`, `antigravity_bridge.py` (profile login/doctor), `tests/*.test.mjs`, `setup_service_windows.ps1`, `setup_launchd_mac.sh`, `README.md`
- Antigravity CLI — Installation & Auth: <https://antigravity.google/docs/cli/install/> (ตำแหน่งติดตั้ง, keyring ต่อ OS, OAuth flow)
- ที่เก็บ token บน Windows (`gemini:antigravity`, UTF-8 JSON, PowerShell `CredRead`): <https://github.com/uppinote20/claude-dashboard/pull/96>
- ตัวจัดการหลายบัญชี agy (แนวคิด credential drift, ต้อง restart agy หลังสลับ): <https://github.com/KaylaONeal/agy-cli-manager>
- Hermes Desktop: <https://hermes-agent.nousresearch.com/docs/user-guide/desktop> และ <https://hermes-agent.nousresearch.com/desktop>
- Electron `utilityProcess`: <https://www.electronjs.org/docs/latest/api/utility-process> ; ESM: <https://www.electronjs.org/docs/latest/tutorial/esm> ; Electron 28 (ESM รวม utility process): <https://www.electronjs.org/blog/electron-28-0>
- Electron vs Tauri (ภาพรวม trade-off ปี 2026): <https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/> , <https://www.pkgpulse.com/guides/electron-vs-tauri-2026>

---

## 15. ข้อค้นพบและประเด็นที่คิดเพิ่มหลังการทดลอง (2026-09-24)

รายการนี้มาจากการ "ยืนยันสิ่งที่ยังไม่ยืนยัน และคิดสิ่งที่ยังไม่คิด" บน macOS (Intel, macOS 26.7, agy 1.2.3, Electron 44.4.5, Hermes 0.21.1) — หลักฐานอยู่ใน `docs/spike-results.md`

### 15.1 ยืนยันแล้ว (เปลี่ยนแผนตามนี้)
| # | ข้อค้นพบ | ผลต่อแผน |
| --- | --- | --- |
| F1 | **E2E ผ่าน `src/index.mjs` เดิม + agy จริงใน file mode สำเร็จ** (wrapper `agy-ssh.sh` ตั้ง `SSH_CONNECTION` แล้ว exec agy; HOME/config/sandbox แยก; `sandbox-exec` กัน Keychain/เบราว์เซอร์): `/health` ok, chat ตอบ `OK` ใน 13 s, `X-Antigravity-Active-Profile` ถูก, log ของ agy `Using file-based token storage because SSH session detected`, token ใน sandbox ถูก refresh (539 → 1,685 ไบต์) ขณะไฟล์ในโปรไฟล์ยังเก่า, SIGTERM ปิดสะอาด | 4.1 ใช้ได้จริงโดยไม่ต้องแก้ตรรกะอื่น; ต้องทำ **copy-back** ของ token (4.1 ข้อ 3) มิฉะนั้นโปรไฟล์จะไม่ได้ token ใหม่ (ใช้งานได้อยู่เพราะ sandbox เก็บไว้ แต่ `profile login` ซ้ำ/ย้ายเครื่องจะได้ของเก่า) |
| F2 | **Electron ESM deadlock:** `await app.whenReady()` (หรือ `await` event `ready`) ที่ top level ของ `main.mjs` ทำให้แอปค้างเงียบ ๆ; `.then()` และ CommonJS ทำงานปกติ | แก้ร่าง 8.3 แล้ว; ใส่ smoke test ที่ fail ถ้าแอปไม่ถึง `ready` ใน 10 s |
| F3 | `npm install electron` ในสภาพแวดล้อมนี้ **ไม่ได้ดาวน์โหลด binary** (โฟลเดอร์ `dist/` หาย) ทั้งที่ `ignore-scripts=false`; ต้องรัน `node node_modules/electron/install.js` เอง | CI/dev script ต้องตรวจ `electron --version` หลังติดตั้ง และ fail ทันทีถ้าไม่มี binary |
| F4 | agy จาก installer ทางการบน macOS **signed โดย "Developer ID Application: Google LLC" + hardened runtime**, ไม่มี quarantine (มีแค่ `com.apple.provenance`) | ไม่ต้องกังวล Gatekeeper กับ agy; ถ้าแอปดาวน์โหลด binary เองต้องไม่ใส่ quarantine (Electron `net`/Chromium ใส่ให้) — ใช้สคริปต์ทางการที่ curl แทน |
| F5 | GUI PATH ว่าง (`launchctl getenv PATH`), cwd ของแอปที่เปิดจาก Finder = `/`; `node` ของเครื่องอยู่ที่ `~/.local/bin` | 4.5/4.6 ยืนยัน; Tier A ต้อง resolve path ของ node/agy ตอนติดตั้ง (สคริปต์ launchd/PS1 เดิมทำ `which` ตอนติดตั้งอยู่แล้ว) |
| F6 | หน้าจอล็อกอินของ agy ใน SSH mode: เมนูเลือกวิธี → URL (OSC 8 hyperlink) → redirect `https://antigravity.google/oauth-callback` (ไม่ใช่ localhost) → รอโค้ด; ใน `-p` mode ไม่มี credential จะไม่เริ่ม login (`authentication required`) | wizard ต้องใช้ terminal จริง (หรือ pty ที่ตอบ query ได้); การ "เปิดเบราว์เซอร์ให้เอง" ทำได้โดยดึง URL จาก pty; ผู้ใช้ต้องคัดลอกโค้ดกลับ |
| F7 | agy ตอนเริ่มส่ง terminal query หลายชุด (`ESC[>c`, `ESC[c`, `ESC[?2026$p`, `ESC[?2027$p`, `ESC[?u`, `ESC[6n`, kitty graphics query) และ **ไม่วาดอะไรจนกว่าจะได้คำตอบ + มีขนาดหน้าต่าง** (`script`/`expect` เปล่า ๆ ค้าง) | ถ้าฝัง terminal ต้องใช้ xterm.js + node-pty เท่านั้น; ห้ามใช้ pipe ธรรมดา |
| F8 | Hermes 0.21.1 เก็บ endpoint ใน `providers.<id>` (`api`, `api_key`, `name`, `models.<id>.context_length`) ไม่ใช่ `custom_providers` | ภาคผนวก A และ README ต้องแก้; ปุ่ม "คัดลอก YAML" สร้าง `providers:` |
| F9 | agy **spawn โปรเซสอัปเดตเบื้องหลังต่อ HOME** (`auto_updater.go: Spawned background update process`, fast-path ข้าม 15 นาทีต่อ HOME) → N โปรไฟล์ = N ตัวเช็ก และตัวอัปเดตอาจเขียนทับ `~/.local/bin/agy` ระหว่างมี run | Doctor แสดงเวอร์ชัน agy; executor ต้องทน `spawn ENOENT/ETXTBSY` ชั่วคราว (retry 1 ครั้ง); หา switch ปิด auto-update (พบ key `securityUpdateEnabled`, `allowTriggeredUpdates` ใน binary — ยังไม่ทราบตำแหน่ง/ผล) |
| F10 | agy เปิด **language server บน localhost 2 พอร์ตสุ่มต่อ run** (gRPC/HTTP) | ตรวจ macOS Application Firewall / Windows Firewall ว่าไม่ถาม (loopback ปกติไม่ถาม) — ใส่ใน E-matrix |
| F11 | ดิสก์: sandbox ของ Python บนเครื่องพัฒนา 402 MB (22 โปรไฟล์), `~/.gemini/antigravity-cli` 217 MB, log 1,030 ไฟล์, conversations 501; ทุก run สร้าง `log/cli-*.log`, `brain/<conv>`, `conversations/` ใหม่ | ต้องมี retention (log 3 วัน, brain/transcript 7 วัน, ตั้งค่าได้) + ปุ่ม Clean ใน Doctor + แจ้งผู้ใช้ว่า transcript เก็บ prompt ทั้งหมด (ความเป็นส่วนตัว) |
| F12 | **Electron `utilityProcess` รัน `src/index.mjs` เดิมได้** (Electron 44.4.5 = Node 24.21): `bootstrap.mjs` ESM ส่ง `hello` ผ่าน `parentPort`, bridge listen และ `/health` ตอบภายใน 0.5 s, ข้อความ `shutdown` → `process.kill(pid,'SIGTERM')` → handler เดิมของ bridge ปิด server → utility exit 0 ภายใน 10 ms; หน่วยความจำ: Browser 80 MB, GPU 33 MB, network 25 MB, node utility 57 MB | สถาปัตยกรรม 3.2/8.4 ใช้ได้จริง; งบ RAM ~200 MB รวม |
| F13 | สัญญาของ `ANTIGRAVITY_BRIDGE_CMD`: bridge **แทรก `--model <m> --effort <e>` ต่อจาก argv[0] ทันที** (`parseCmdTemplate`) → template `node fake.cjs {prompt}` กับโมเดลจริงทำให้ `node --model …` ออก exit 9; ต้องเป็น executable/wrapper ที่รับ flag เหล่านั้น (`exec agy "$@"`) หรือใช้ model `antigravity` ในการทดสอบ | Tier A/desktop ที่ห่อ agy ด้วยสคริปต์ต้องส่งผ่าน `"$@"`; ใส่ใน test ของ wrapper |
| F14 | เปิดแอปผ่าน `open` (LaunchServices): cwd = `/` ยืนยัน; **แต่ `open` ส่งต่อ env ของ shell ที่เรียกมันด้วย** (PATH ยังเต็ม) จึงไม่ใช่การจำลอง Finder ที่แท้จริง; รอบนี้ bridge ในสandbox ไม่ตอบ `/health` ภายใน 30 s โดยไม่มี error ใน log (utility ออก 0 หลังถูกสั่งปิด) — **สาเหตุยังไม่ทราบ** (ต้องสงสัยลำดับ port/TIME_WAIT จากรอบก่อนหน้า 3 s หรือ stdio pipe ใต้ LaunchServices) | ผู้ implement ต้องทำ smoke test แบบเปิดจาก Finder จริง (ดับเบิลคลิก) และ log ทุกขั้นลงไฟล์ตั้งแต่บรรทัดแรกของ main |

### 15.2 คิดเพิ่ม (ยังไม่อยู่ในแผนเดิม)
- **IPv6 `localhost`:** bridge bind `127.0.0.1` เท่านั้น; client ที่ resolve `localhost` เป็น `::1` ก่อนจะต่อไม่ติด → snippet ใช้ `127.0.0.1` เสมอ และพิจารณา listen ทั้ง `127.0.0.1` และ `::1` ใน desktop (สอง listener)
- **สอง bridge บนเครื่องเดียว** (CLI/LaunchAgent เดิม + desktop) ใช้ `quota_cache_node.json`, `sandboxes-node`, `.token-refresh` ร่วมกัน → เขียนทับกัน/refresh ซ้อน; Doctor ต้องตรวจ LaunchAgent/Scheduled Task/โปรเซส `src/index.mjs` อื่น และแนะนำให้เหลือตัวเดียว
- **refresh token ถูกเพิกถอน** (เปลี่ยนรหัสผ่าน, ไม่ใช้งาน 6 เดือน, เกิน 50 token ต่อ client) → auto-refresh fail ต่อเนื่อง → wizard ต้องมี "ล็อกอินใหม่" ต่อโปรไฟล์ และ Doctor แยก "token หมดอายุ (ปกติ)" กับ "refresh ล้มเหลว (ต้องล็อกอินใหม่)"
- **copy-back ต้องพา `id_token` ไปด้วย** (ไฟล์ที่ agy เขียนมี `id_token` เพิ่มจากที่ bridge สร้าง) และ `google_accounts.json`/`state.json` ที่ agy เขียนเองมีอีเมลถูกต้อง → `collectLogin` ใช้ไฟล์เหล่านี้ได้เลย (userinfo เป็นการยืนยันซ้ำ)
- **path ที่มีช่องว่าง** (เช่น repo นี้อยู่ใน `OneDrive-Personal/Projects`): E2E ควรมีเคส HOME/sandbox ที่มีช่องว่างและอักษรไทยบน macOS ด้วย ไม่ใช่แค่ Windows (E12)
- **onboarding ของ agy ใน HOME ว่าง:** จากการจับภาพไม่มีหน้า Terms/usage mode ก่อน sign-in แต่ **หลัง** sign-in ยังไม่ทราบ (flag `AGY_ONBOARDING_*`, `consumerOnboardingComplete`) → ทำล็อกอินจริง 1 ครั้งต่อ OS ก่อนออกแบบ wizard ให้แน่นอน
- **login HOME ถาวรต่อโปรไฟล์แทน temp:** ถ้าให้ `profiles/<name>/` เป็น HOME ของการล็อกอินโดยตรง (agy เขียน `.gemini/antigravity-cli/antigravity-oauth-token` ที่นั่น) จะไม่ต้องคัดลอกเลย แต่โครงสร้างโปรไฟล์จะเปลี่ยนจากที่ CLI/Python ใช้ → คงรูปแบบเดิม (คัดลอก) เพื่อความเข้ากันได้
- **การรัน bridge หลายโปรไฟล์พร้อมกันใน file mode** ยังไม่ได้ทดสอบจริง (E2E ใช้ 1 โปรไฟล์) → เพิ่มใน E3
- **Windows:** ทุกข้อยังไม่ได้ยืนยัน — ใช้ `docs/spike-windows.ps1` (อ่าน Credential Manager อย่างเดียว, ทดสอบ S1/S2/S5/S6 และ snapshot env สำหรับ S3) แล้วบันทึกผลลง `docs/spike-results.md`

---

## 16. บันทึกส่งมอบสำหรับผู้ implement (AI หรือคน)

เอกสารนี้เป็น **สเปกและแผน** ไม่ใช่โค้ด; เจ้าของโปรเจกต์ตัดสินใจแล้วว่าให้ผู้ implement คนละคนกับผู้ออกแบบ ข้อตกลงที่ต้องถือตาม:

1. **อ่านตามลำดับ:** หัวข้อ 0 → 2 → 15 (ข้อเท็จจริงที่ยืนยันแล้ว) → 4 (ช่องว่างที่ต้องแก้) → 6 (ลำดับงาน) → 8 (ร่างโค้ด) → 9 (test ที่ต้องมี) → 10 (สิ่งที่มักพัง) — ภาคผนวกและ `docs/spike-results.md` ใช้เป็นหลักฐานอ้างอิง
2. **สิ่งที่พึ่งพาได้โดยไม่ต้องทดลองซ้ำ (macOS, 2026-09-24):** file mode ผ่าน `SSH_CONNECTION` (F1/S4), E2E ผ่านโค้ด bridge เดิม (F1), Electron `utilityProcess` + ESM bridge + shutdown protocol (F12), ห้าม top-level `await app.whenReady()` (F2), หน้าจอล็อกอินและ redirect ของ OAuth (F6), GUI PATH/cwd (F5), Hermes 0.21 ใช้ `providers:` (F8), agy signed โดย Google (F4), สัญญา `--model/--effort` ของ `ANTIGRAVITY_BRIDGE_CMD` (F13)
3. **สิ่งที่ต้องยืนยันก่อนเขียนโค้ดส่วนนั้น:** ทุกข้อของ Windows (รัน `docs/spike-windows.ps1` → S1/S2/S3/S5/S6), การล็อกอินจริงจนจบ 1 ครั้งต่อ OS (ช่องกรอกโค้ด, onboarding หลัง sign-in, จังหวะที่ไฟล์ token ปรากฏ — S8), การเปิดจาก Finder จริงแล้ว bridge ขึ้น (F14), หลายโปรไฟล์พร้อมกันใน file mode (E3), sleep/wake (S9), Hermes คุยจริง (S11)
4. **กฎของ repo (`AGENTS.md`):** แก้เฉพาะ Node.js edition; ทุกการเปลี่ยนพฤติกรรมใน `src/` ต้องมี test ใน `tests/*.test.mjs` (fake agy เป็นสคริปต์ Node); `node --check` + `npm test` ก่อน commit; commit message บอกพฤติกรรม ไม่ใช่ชื่อไฟล์ และใส่หลักฐานใน body; ห้าม restart bridge ที่ให้บริการอยู่ก่อน verify (Self-Hosting Danger); Python edition ห้ามแตะ
5. **ลำดับส่งมอบที่แนะนำ (PR ละเรื่อง):** (a) file mode + copy-back + token-daemon ทุก OS + tests + CI 3 OS → (b) Windows fixes (arg limit, env allow-list, agy path, windowsHide) + tests → (c) `profile login` ใน Node + host shutdown hook → (d) `desktop/` Electron shell (supervisor, tray, wizard, Doctor) + Playwright smoke → (e) installer/signing/updater + release workflow → (f) เอกสารผู้ใช้ (README/README.th หัวข้อ Desktop, ภาคผนวก A ใช้ `providers:`)
6. **เกณฑ์รับงานรวม:** หัวข้อ 1.2 (A1–A6) และ 9.8 ทั้งหมด; ทุก PR แนบผลรันจริงตามตาราง E1–E17 ที่เกี่ยวข้อง (OS, เวอร์ชัน agy, log ที่เกี่ยวข้อง — ไม่มี token/อีเมลจริง)
7. **สิ่งที่ห้ามทำโดยไม่ถามเจ้าของโปรเจกต์:** bundle binary ของ agy (D1 ตัดสินแล้ว: ไม่), เปิด `0.0.0.0`/CORS/`ALLOW_CLI_TOOLS` จาก UI, เปลี่ยนตำแหน่ง `~/.config/antigravity` (D4), เพิ่ม runtime dependency ให้ `src/` (ต้อง zero-dependency ต่อไป; dependency ของ Electron อยู่ใน `desktop/package.json` เท่านั้น)

---

## 17. สิ่งที่การ implement และ audit ครั้งแรก (2026-09-25) เปลี่ยนจากสเปก

รายละเอียดและหลักฐานอยู่ใน [DESKTOP_EDITION_IMPLEMENTATION.md](DESKTOP_EDITION_IMPLEMENTATION.md) หัวข้อ 2. ข้อที่ผู้ implement รายต่อไปต้องถือตาม แทนที่ร่างในหัวข้อ 4 และ 8:

1. **`keyringSerialized()` เปิดเฉพาะ keyring mode** (4.2). ถ้าเปิดใน file mode บน mac/Windows ทุก request จะต่อคิวกันทั้งเครื่อง
2. **copy-back (4.1 ข้อ 3) ต้องอ่าน sandbox ก่อนเรียก `getProfileSandboxDir()`** เพราะฟังก์ชันนั้นปลูก token จากโปรไฟล์ทับทุกครั้ง. ใช้ access token ที่ปลูกไว้เป็นตัวเทียบว่า agy refresh แล้วหรือยัง
3. **`profile login` (4.7, 8.6) ห้ามแตะโปรไฟล์เป้าหมายก่อนได้ token ที่ตรวจบัญชีแล้ว.** โปรไฟล์ที่มีอยู่ต้องรอดทั้งกรณียกเลิก ล้มเหลว และอีเมลซ้ำ
4. **8.6 ข้อ 3 (Windows):** ห้ามเขียน path ลงในไฟล์ `.cmd` เพราะ cmd.exe อ่านด้วย code page จึงเพี้ยนเมื่อชื่อผู้ใช้เป็นภาษาไทย ให้ส่งทาง environment และใช้ `cmd.exe` แทน `wt.exe`. **8.6 ข้อ 5:** รับ token เมื่อไฟล์ครบและนิ่ง ไม่ต้องรอ marker (ผู้ใช้อาจปิดหน้าต่างเอง)
5. **allow-list ของ env บน Windows ต้องไม่สนตัวพิมพ์** (4.4): Windows สะกด `Path`, `SystemRoot`, `ComSpec`
6. **URL ติดตั้ง agy ต้องมี `/cli/`** (5.3): `https://antigravity.google/cli/install.sh`, `.../cli/install.ps1`; ไม่มี `/cli/` ตอบ 404
7. **main process ห้ามถือ state ของ bridge** (8.3/8.5): ProfileManager, API key และ `.env` ต้องผ่าน HTTP ของ bridge หรืออ่านจากไฟล์ใหม่ทุกครั้ง. bridge ต้องได้ env ของตอนเปิดแอป ไม่ใช่ `process.env` ที่ `config.mjs` เติมจาก `.env` ไว้แล้ว
8. **ภาคผนวก A:** timeout ต่อ provider ของ Hermes 0.21 คือ `providers.<id>.request_timeout_seconds` (พบใน config จริง)

