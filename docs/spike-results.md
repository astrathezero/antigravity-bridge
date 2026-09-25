# Spike results — Desktop edition (Phase 0)

บันทึกผลการทดลองที่อ้างถึงใน `docs/DESKTOP_EDITION_GUIDE.md` (หัวข้อ 4.1, 6.1, 15) — ค่า token/อีเมล/client id ทั้งหมดถูกตัดออก; สำเนา token ชั่วคราวทุกชุดถูกลบหลังทดลอง

| รายการ | ค่า |
| --- | --- |
| วันที่ | 2026-09-24 |
| เครื่อง | macOS 26.7 (25G229), Intel Core i5 (x86_64) — ไม่ใช่ Apple Silicon, ไม่มี Rosetta |
| agy | 1.2.3 ที่ `~/.local/bin/agy` (Mach-O x86_64, 190 MB, signed "Developer ID Application: Google LLC", hardened runtime, xattr มีแค่ `com.apple.provenance`) |
| Node | v26.8.2 ที่ `~/.local/bin/node` |
| Electron | 44.4.5 (ติดตั้งใน scratchpad; `npm install` ไม่ดาวน์โหลด binary ต้องรัน `node node_modules/electron/install.js` เอง) |
| Hermes | Desktop 0.0.1 (`/Applications/Hermes.app`) + CLI v0.21.1 (`~/.local/bin/hermes`, `~/.hermes`) |
| ผู้ทำ | Claude ตามคำขอของเจ้าของโปรเจกต์ บนเครื่องของเจ้าของโปรเจกต์ |
| bridge | `src/` @ `main` `2302ef4` **ไม่แก้ไข**; `npm test` 69/69 ผ่าน |

## S4 (macOS) — agy ใช้ token แบบไฟล์ต่อโปรไฟล์ได้เมื่อเห็นว่าเป็น SSH session — ผ่าน

### หลักฐานจาก binary (`strings`)
- ไลบรารี keyring: `github.com/zalando/go-keyring` (`keyring.macOSXKeychain.*`, `fallbackServiceProvider.*`)
- ตัวตัดสิน: `codeassistclient.shouldBypassKeyring` + detector `sshDetector`, `wslDetector`, `containerDetector`, `dbusDetector`; string ที่พบ: `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, `WSL_DISTRO_NAME`, `WSL_INTEROP`, `/.dockerenv`, `/proc/1/cgroup`, `DBUS_SESSION_BUS_ADDRESS`
- ที่เก็บแบบไฟล์: `auth.CLITokenFilePath`, `codeassistclient.KeyringTokenStorage`, `keyringRecentlyUnavailable`, `memoizeKeyringTimeout`, `composite_token_storage.go`
- changelog ในตัว: "Improved `/logout` execution time by short-circuiting token removal directly to file storage when keyring storage is bypassed or unreachable."
- **ไม่พบ** flag/env/settings key ที่สั่ง bypass ตรง ๆ — detector คือทางเดียว; settings key ที่เห็นแต่ยังไม่รู้ผล: `securityUpdateEnabled`, `allowTriggeredUpdates`, `telemetryEnabled`, `consumerOnboardingComplete`

### วิธีทดลอง
1. HOME ชั่วคราว (700) + คัดลอกไฟล์ auth ของ 1 โปรไฟล์ไป `HOME/.gemini/`, `HOME/.gemini/antigravity-cli/`, `HOME/.config/antigravity/`, `HOME/.config/gemini/`, `HOME/` (เลียนแบบ `getProfileSandboxDir()`)
2. รันภายใต้ `sandbox-exec` ที่ **ห้าม exec `/usr/bin/security` และ `/usr/bin/open`** (กัน Keychain จริง/เบราว์เซอร์) — ใช้เพื่อความปลอดภัยของการทดลองเท่านั้น ไม่ใช่สำหรับใช้งานจริง:
   ```bash
   env -i HOME="$H" USERPROFILE="$H" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 TERM=dumb \
     XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share" XDG_CACHE_HOME="$H/.cache" \
     SSH_CONNECTION="127.0.0.1 50000 127.0.0.1 22" \
     perl -e 'alarm 150; exec @ARGV' -- \
     sandbox-exec -p '(version 1)(allow default)(deny process-exec (literal "/usr/bin/security"))(deny process-exec (literal "/usr/bin/open"))' \
     ~/.local/bin/agy --dangerously-skip-permissions --print-timeout 2m0s --output-format stream-json -p "Reply with exactly one word: OK"
   ```
   (`timeout` ของ coreutils ไม่มีบน macOS → ใช้ `perl alarm`)

### ผล
| การรัน | env เพิ่มเติม | ผล | บรรทัดสำคัญใน `HOME/.gemini/antigravity-cli/log/cli-*.log` |
| --- | --- | --- | --- |
| exp1 | ไม่มี (Keychain เข้าถึงไม่ได้เพราะ sandbox) | exit 0, ตอบ `OK` | `composite_token_storage.go:419] Failed to load stored token from keyring, falling back to file: fork/exec /usr/bin/security: operation not permitted`, `…:237] Failed to save token to keyring, falling back to file` |
| exp2 | `SSH_CONNECTION`+`SSH_CLIENT`+`SSH_TTY` (โปรไฟล์ที่ 2) | exit 0, ตอบ `OK` | `composite_token_storage.go:123] Using file-based token storage because SSH session detected` |
| exp3 | **`SSH_CONNECTION` ตัวเดียว** + stream-json | exit 0, events `init`/`step_update`×3/`result`, `"response":"OK\n"` | บรรทัดเดียวกับ exp2; ตามด้วย `keyring.go:64] keyringAuth: loaded token … expired=false`, `auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)` (ชื่อ provider ไม่ใช่ที่เก็บ) |

- ไฟล์ token ถูกเขียนใหม่ (539 → ~1,660 ไบต์) รูป `{token:{access_token,token_type,refresh_token,expiry},auth_method,id_token}`; `google_accounts.json` = `{active,old:[]}`, `state.json` = `{active}` ถูกเขียนด้วยอีเมลของบัญชี; Keychain ไม่ถูกแตะ
- บรรทัด `You are not logged into Antigravity` ตอน start-up เป็น noise ก่อน token storage พร้อม ตามด้วย `Auth succeeded`

## E2E — bridge ตัวจริง (โค้ดเดิม) + agy จริงใน file mode — ผ่าน
- ตั้งค่า: HOME ชั่วคราวที่มี `.config/antigravity/profiles/spike/` (สำเนาไฟล์ auth 1 โปรไฟล์), `ANTIGRAVITY_BRIDGE_CONFIG` → `{"profiles":["spike"]}`, `ANTIGRAVITY_QUOTA_CACHE_FILE`/`ANTIGRAVITY_SANDBOX_BASE` ชี้ temp, `ANTIGRAVITY_NO_AUTO_REFRESH=1`, `ANTIGRAVITY_API_KEY` ทดสอบ, และ `ANTIGRAVITY_BRIDGE_CMD="<wrapper> --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p \"{prompt}\""` โดย wrapper คือ
  ```bash
  #!/bin/bash
  export SSH_CONNECTION="127.0.0.1 0 127.0.0.1 22"
  exec /Users/<user>/.local/bin/agy "$@"
  ```
  รัน `node src/index.mjs --port 8077 --host 127.0.0.1` ทั้งก้อนภายใต้ `sandbox-exec` เดียวกัน (child สืบทอด) → bridge เรียก `syncProfileToSystem()` → `security` ถูกปฏิเสธ (คืน false เงียบ ๆ) → agy ใช้ไฟล์
- ผล: `GET /health` (มี key) `status:ok`, `active_profile: spike`; `POST /v1/chat/completions` model `gemini-3.8-flash` → HTTP 200 ใน 13.2 s, `X-Antigravity-Active-Profile: spike`, เนื้อหา `OK` + banner โปรไฟล์/อีเมลถูกต้อง; journal: `[REQUEST]` → `[EXEC] … tools_allowed=false` → `[EXEC] … finished in 13.2s exit=0 status=SUCCESS` → `[DONE]`; log ของ agy ใน `sandboxes/spike/.gemini/antigravity-cli/log/`: `Using file-based token storage because SSH session detected`
- token: ไฟล์ใน sandbox 1,685 ไบต์ (refresh แล้ว) ขณะ `profiles/spike/antigravity-oauth-token` ยัง 539 ไบต์ → ต้องทำ copy-back (คู่มือ 4.1 ข้อ 3)
- `kill -TERM` → `[INFO] Gracefully shutting down` → `[OK] Server stopped.` ภายใน 1 s
- **ยังไม่ได้ทดสอบ:** หลายโปรไฟล์พร้อมกัน, stream + disconnect, quota fast-fail ใน file mode (คาดว่าเหมือน Linux เพราะ transcript อยู่ใต้ sandbox เช่นเดิม)

## S7 (macOS) — สภาพแวดล้อมของแอป GUI — ผ่านบางส่วน
- `launchctl getenv PATH` → ว่าง (แอปที่เปิดจาก Finder/Dock ได้ PATH ระบบเท่านั้น); cwd ของ Finder = `/` (`lsof -d cwd`)
- `node` ของเครื่องอยู่ที่ `~/.local/bin/node` (ไม่ใช่ Homebrew) — ยืนยันว่าสคริปต์บริการต้อง resolve absolute path
- Electron ดู "Electron" ด้านล่าง

## S8 (macOS) — หน้าจอล็อกอินของ agy ใน SSH mode — ผ่านบางส่วน (ไม่ได้ล็อกอินจริง)
- `-p "hi"` ใน HOME ว่าง: stderr `Error: authentication required. Run 'agy' to log in, then retry.` / `error: authentication failed or timed out` → print mode ไม่เริ่ม login
- TUI (`expect` ที่ตอบ terminal query + `stty rows/cols`; `script` เปล่า ๆ ค้างที่ query `ESC[>c`, `ESC[?2026$p`, `ESC[?2027$p`): หน้าจอ "Welcome to the Antigravity CLI. You are currently not signed in." → "Signing in..." → "Select login method: > 1. Google OAuth / 2. Use a Google Cloud project" → (Enter) "Open the URL below in your browser:" + URL เป็น OSC 8 hyperlink: `https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=…&code_challenge=…&code_challenge_method=S256&prompt=consent&redirect_uri=https://antigravity.google/oauth-callback&response_type=code&scope=cloud-platform,userinfo.email,userinfo.profile,cclog,…`
- log ของ agy ตอนล็อกอิน: `Using file-based token storage because SSH session detected`; language server ฟัง localhost 2 พอร์ตสุ่ม (gRPC HTTPS + HTTP)
- ยังไม่ได้เห็น: ช่องกรอกโค้ด (ตามเอกสารทางการมี), หน้า onboarding หลัง sign-in, จังหวะที่ไฟล์ token ปรากฏ (ก่อน/หลังพิมพ์ `hi`) → ต้องทำล็อกอินจริง 1 ครั้งต่อ OS

## Electron 44.4.5 (macOS)
| การทดลอง | ผล |
| --- | --- |
| `npm install electron` | ติดตั้ง package แต่ **ไม่มี `dist/Electron.app`** (`ignore-scripts=false`); `node node_modules/electron/install.js` ดาวน์โหลดสำเร็จ |
| main แบบ CommonJS (`app.whenReady().then(...)`) | started → ready → quit, exit 0 |
| main แบบ ESM `.mjs` ที่ `await app.whenReady()` ที่ top level | เขียน "started" แล้ว **ค้างตลอดกาล** (ฆ่าที่ 40 s) — ไม่มี error ใน stderr |
| main แบบ ESM ที่ `await new Promise(r => app.once("ready", r))` ที่ top level | ค้างเหมือนกัน |
| main แบบ ESM ที่ `app.whenReady().then(main)` | started → ready → quit, exit 0 ✅ |
| `utilityProcess.fork("bootstrap.mjs")` ที่ `import("src/index.mjs")` (bridge เดิม) + `/health` + shutdown ผ่าน `parentPort` → `process.kill(pid,"SIGTERM")` | ผ่านเมื่อเปิดจาก terminal (ตารางด้านล่าง); เปิดผ่าน `open` ยังไม่สรุป |

### utilityProcess + bridge เดิม (Electron 44.4.5, Node 24.21.0 ในตัว)
| ขั้น | Run A (เปิดจาก terminal) | Run B (เปิดผ่าน `open -n -a Electron.app --args <dir>`) |
| --- | --- | --- |
| main ESM ประเมิน + `ready` (ผ่าน `.then`) | 0.12 s | 0.26 s |
| cwd / PATH ของ main | cwd = โฟลเดอร์ที่เรียก; PATH เต็มของ shell | **cwd = `/`** (ยืนยันพฤติกรรม GUI); PATH ยังเต็ม เพราะ `open` ส่งต่อ env ของ shell ที่เรียก → ไม่ใช่การจำลอง Finder ที่แท้จริง |
| `app.getPath('logs')` / `userData` | `~/Library/Logs/<app>` / `~/Library/Application Support/<app>` | เหมือนกัน |
| `utilityProcess.fork(bootstrap.mjs)` (ESM) | spawn ใน 0.1 s; `parentPort` message `{hello, node:"24.21.0", esm:true}` | spawn + hello เหมือนกัน |
| bridge `src/index.mjs` เดิม listen 8078 | `/health` ตอบ `status:ok, active_profile:spike, auth_required:true` หลัง 0.5 s | **ไม่ตอบภายใน 30 s**, `bridge-stdout.log` ไม่มีบรรทัด "running on"; utility ออก 0 เมื่อสั่งปิด — สาเหตุยังไม่ทราบ (ลอง 1 ครั้ง, 3 s หลัง Run A ปล่อยพอร์ตเดียวกัน) → ผู้ implement ต้องทำซ้ำแบบดับเบิลคลิกจาก Finder และ log ตั้งแต่บรรทัดแรก |
| chat ผ่าน fake agy | HTTP 500 `All agy profile attempts failed … exit=9` — **ไม่ใช่ปัญหาของ bridge/Electron**: template `"<node>" fake.cjs {prompt}` ถูก bridge แทรก `--model gemini-3.8-flash --effort high` ต่อจาก argv[0] (node ไม่รู้จัก flag → exit 9); ใช้ wrapper ที่ `exec agy "$@"` หรือ model `antigravity` แทน | ไม่ถึงขั้นนี้ |
| shutdown protocol: `postMessage({type:"shutdown"})` → bootstrap `process.kill(pid,"SIGTERM")` → handler เดิมของ bridge | `[INFO] Gracefully shutting down` → utility `exit code=0` ภายใน ~10 ms | utility ออก 0 |
| หน่วยความจำ (`app.getAppMetrics`) | Browser 80 MB, GPU 33 MB, NetworkService 25 MB, **node utility (bridge) 57 MB** | — |

สรุป: กลไกหลักของสถาปัตยกรรม (ESM bridge ในตัว utility process, health ผ่าน HTTP, ปิดผ่าน parentPort → SIGTERM) **ทำงานได้จริง**; สิ่งที่ค้างคือการเปิดจาก Finder แท้ ๆ และการยืนยันว่า bridge ขึ้นในบริบทนั้น (Run B)

## Hermes 0.21.1 (config บนเครื่องพัฒนา, ปิดบังความลับ)
- `~/.hermes/config.yaml` ใช้ `providers:` → `<id>: { api: http://127.0.0.1:<port>/v1, api_key, name, models: { <model>: { context_length } } }`, ไม่ใช่ `custom_providers:` ตาม README เดิม; `model: { default, provider, base_url }`; `agent: { max_turns: 150, ... }`
- Hermes Desktop ติดตั้ง runtime ใน `~/.hermes` (CLI `hermes` v0.21.1 ที่ `~/.local/bin/hermes`) — ไม่ได้ทดสอบคุยกับ bridge จริง (ไม่แก้ config ของผู้ใช้)

## ข้อมูลเครื่องอื่นที่วัดได้
- ดิสก์: `~/.config/antigravity/sandboxes` (Python, 22 โปรไฟล์) 402 MB; `sandboxes-node` 14 MB; `profiles` 464 KB; `~/.gemini/antigravity-cli` 217 MB (log 1,030 ไฟล์, brain 501 conversations)
- log ของ run ใน sandbox: `auto_updater.go:305] Spawned background update process with PID …`, `Last check was less than 15 minutes ago, skipping update (fast path)`, `telemetry.go … recordTrajectoryAnalytics: context canceled` (ถูกฆ่าตอนจบ run)

## Windows — ยังไม่ได้ทำ
รันสคริปต์ `docs/spike-windows.ps1` (อ่าน Credential Manager อย่างเดียว; ทดสอบ S1 file mode, S2 transcript path, S5 ขีดจำกัด argv, S6 ภาษาไทย, snapshot env สำหรับ S3) แล้วนำ `%TEMP%\agy-spike\agy-spike-report.txt` มาใส่ที่นี่ และลบโฟลเดอร์ `%TEMP%\agy-spike` (มีสำเนา token)
