# Desktop edition: งานที่เหลือ (สำหรับผู้ implement: agy หรือ AI/คนอื่น)

เอกสารนี้คือรายการงานที่เหลือ **และเป็นที่เดียวที่บันทึกว่างานไหนเสร็จแล้ว** ส่วนสิ่งที่มีอยู่แล้วและเหตุผลของการออกแบบ อ่านจาก:
- [DESKTOP_EDITION_IMPLEMENTATION.md](DESKTOP_EDITION_IMPLEMENTATION.md): หัวข้อ 1 (กลไก `SSH_CONNECTION`), หัวข้อ 2 (บั๊กที่แก้แล้วและเหตุผล), หัวข้อ 3 (คำสั่ง smoke), หัวข้อ 5 (แผนผังโมดูล)
- [DESKTOP_EDITION_GUIDE.md](DESKTOP_EDITION_GUIDE.md): สเปก (แต่ละงานบอกหัวข้อที่เกี่ยวข้อง) และหัวข้อ 17 (จุดที่สเปกเปลี่ยนหลัง audit)
- [spike-results.md](spike-results.md): หลักฐานการทดลองจริง
- `AGENTS.md`: กฎของ repo

## วิธีทำงาน (ทุกงาน)

1. อ่าน `AGENTS.md`, หัวข้อ 1–2 ของ IMPLEMENTATION.md และหัวข้อ "Invariants" กับ "กฎ" ด้านล่าง
2. เลือก **งานเดียว**: งานแรกที่ยังไม่ติ๊กในสถานะด้านล่าง เว้นแต่เจ้าของโปรเจกต์ระบุงานอื่น. งานย่อยที่มีเลข (เช่น 6a, 6b) ถือเป็นงานละหนึ่ง
3. รัน `npm test` ก่อนแก้ ต้อง **เขียว** ทั้งหมด จดจำนวน test ไว้
4. แก้โค้ด ทุกการเปลี่ยนพฤติกรรมต้องมี test ที่ **แดง** บนโค้ดเดิมและ **เขียว** หลังแก้
5. ตรวจตาม "เสร็จเมื่อ" ของงานนั้นให้ครบทุกข้อ แต่ละข้อต้องมี **หลักฐาน** คือคำสั่งที่รันจริงพร้อมบรรทัดท้ายของผลลัพธ์
6. บันทึกสถานะ: ติ๊กงานในรายการด้านล่าง ใส่วันที่และหลักฐานหนึ่งบรรทัด ถ้าผลจริงต่างจากที่เอกสารเขียนไว้ ให้แก้ IMPLEMENTATION.md หรือ spike-results.md ตามนั้น
7. หยุดแล้วรายงานเจ้าของโปรเจกต์: ไฟล์ที่เปลี่ยน, จำนวน test ก่อน/หลัง, หลักฐาน, สิ่งที่ยังไม่ได้ยืนยัน. commit และ push เมื่อเจ้าของบอกให้ทำเท่านั้น

**งานเสร็จเมื่อ** เกณฑ์ "เสร็จเมื่อ" ครบทุกข้อพร้อมหลักฐาน และ `npm test` เขียว ถ้าเกณฑ์ข้อใดทำไม่ได้ (เช่น ต้องใช้เครื่อง Windows) งานนั้นยังไม่เสร็จ ให้เขียนว่าค้างที่ข้อไหน

## Invariants: สิ่งที่แก้แล้ว ต้องจริงอยู่เสมอ

แต่ละข้อมี test คุมอยู่ ถ้า test ข้อไหนแดงหลังแก้โค้ด ให้แก้โค้ด ไม่ใช่แก้ test

| # | Invariant | test ที่คุม |
| --- | --- | --- |
| I1 | file mode ไม่เคย serialize ข้ามโปรไฟล์; เฉพาะ keyring mode บน mac/Windows ที่รันทีละ run | `config.test.mjs`, `file-mode.test.mjs` |
| I2 | `SSH_CONNECTION` อยู่ใน env ของ agy เท่านั้น (executor, token daemon, `profile login`) ไม่อยู่ใน env ของ bridge | `file-mode.test.mjs`, `executor-env.test.mjs` |
| I3 | copy-back อ่าน sandbox **ก่อน** มีการปลูก token ซ้ำ; รับ token เฉพาะเมื่อ agy เปลี่ยน + `refresh_token` เป็นของโปรไฟล์เอง + expiry ใหม่กว่า | `file-mode.test.mjs` |
| I4 | การล็อกอินไม่แตะโปรไฟล์ที่มีอยู่จนกว่าจะได้ token ที่ตรวจบัญชีแล้ว; ยกเลิก/ล้มเหลว/อีเมลซ้ำ ต้องปล่อยโปรไฟล์ไว้ตามเดิม | `profile-login.test.mjs`, `desktop-modules.test.mjs` |
| I5 | `detectCliCommand().binary` เป็น path ที่ spawn ได้ทันที (ไม่มีเครื่องหมายคำพูด) | `config.test.mjs`, `profile-login.test.mjs` |
| I6 | allow-list ของ env บน Windows ไม่สนตัวพิมพ์ (`Path`, `SystemRoot`) | `executor-env.test.mjs` |
| I7 | เมื่อเริ่มปิด: ไม่มี agy ตัวใหม่, ฆ่า agy ทั้ง tree ก่อน `server.close()`, ปิดเสร็จภายในเวลาที่กำหนด | `shutdown.test.mjs`, `desktop-bootstrap.test.mjs` |
| I8 | key ที่ revoke ถูกปฏิเสธทันที | `server.test.mjs` |
| I9 | ชื่อโปรไฟล์ถูกตรวจด้วย `isSafeProfileName()` ก่อนนำไปต่อเป็น path ทุกครั้ง (CLI และ IPC) | `profile-cli.test.mjs` |
| I10 | supervisor มี bridge ได้ทีละตัว; `stop()` ปฏิเสธเมื่อมี request ค้าง ยกเว้น `force` | `desktop-supervisor.test.mjs` |
| I11 | สคริปต์ terminal บน Windows เป็น ASCII ล้วน ค่าทุกค่าส่งทาง env; spawn ล้มต้อง reject ไม่ใช่ throw ทีหลัง | `desktop-modules.test.mjs` |
| I12 | main process ไม่ถือ state ของ bridge: โปรไฟล์และ key ผ่าน HTTP ของ bridge หรืออ่านไฟล์ใหม่ทุกครั้ง; bridge ได้ `LAUNCH_ENV` | `desktop-modules.test.mjs`, smoke |
| I13 | Hermes snippet อยู่ในรูปแบบของ Hermes 0.21 (`providers.<id>.api` = URL) | `desktop-modules.test.mjs` |
| I14 | test ไม่แตะ HOME จริง, keyring จริง หรือ bridge ที่กำลังให้บริการ | `tests/_env.mjs`, `profile-cli.test.mjs` |

## กฎ

- **รักษา working tree ไว้.** ถ้า `git status` ยังแสดง `desktop/` และ `src/core/host.mjs` เป็นไฟล์ที่ยังไม่ commit แปลว่างาน desktop และ fix จาก audit ยังไม่ถูก commit. ให้ทำงานต่อบน working tree นั้นเลย คำสั่งอย่าง `git checkout -- .`, `git stash`, `git reset --hard`, `git clean` จะลบงานเหล่านี้ทิ้งถาวร
- **หลักฐานมาจากการรันจริงเท่านั้น.** ทุกข้อความในเอกสารสถานะต้องมาจากคำสั่งที่รันในงานนั้น ถ้าไม่ได้รันให้เขียนว่า "ยังไม่ยืนยัน". ชื่อไฟล์ test และจำนวน test คัดจากผลของ `npm test` โดยตรง
- **ขอบเขตคือเครื่องของเจ้าของโปรเจกต์ (Mac/Windows) และ repo นี้.** เซิร์ฟเวอร์ production (`n8n.mrserm.com`) ไม่อยู่ในขอบเขต: ไม่ SSH, ไม่ deploy, ไม่ restart bridge ที่มีคนใช้อยู่
- **`AGENTS.md`:** แก้เฉพาะ Node.js edition (`src/`, `tests/`, `desktop/`); Python edition ถูก freeze; `src/` ต้อง zero-dependency ส่วน dependency ของ Electron อยู่ใน `desktop/package.json` เท่านั้น
- **test:** import `./_env.mjs` เป็นบรรทัดแรก; agy ปลอมเป็นสคริปต์ Node ที่เรียกแบบ `"<node>" "<script>" {prompt}`; kill เฉพาะโปรเซสที่ test เป็นคน spawn; test ที่แจ้ง bridge (`/v1/profiles/config` ฯลฯ) ต้องตั้ง `ANTIGRAVITY_PORT` เป็นพอร์ตที่ไม่มีใครฟัง (เพราะบน server `npm test` รันข้าง bridge ตัวจริงที่พอร์ต 8008)
- **การรันบนข้อมูลจริง** (เปิดแอปจาก Finder, ล็อกอินจริง, probe) ใช้ `~/.config/antigravity` จริงและโควตาจริง ต้องบอกเจ้าของก่อนทุกครั้ง. การทดสอบอัตโนมัติใช้ smoke (IMPLEMENTATION.md หัวข้อ 3) ซึ่งแยก HOME ไว้
- **ไฟล์ใหม่ใน `desktop/`** ต้องเพิ่มใน `files:` ของ `desktop/electron-builder.yml` ด้วย มิฉะนั้นตัวที่ build จะไม่มีไฟล์นั้น

## สถานะ

ติ๊กเมื่อเสร็จ รูปแบบ: `- [x] T1 ... (2026-10-01; npm test: ℹ pass 118 ℹ fail 0; CI run <url>)`

- [x] T1 CI 3 OS: agy (2026-09-25; npm test: ℹ pass 113 ℹ fail 0; CI run https://github.com/astrathezero/antigravity-bridge/actions/runs/36097796513)
- [ ] T2 อัปเกรด Electron 44: agy (+ เจ้าของตัดสินเรื่อง macOS 12)
- [ ] T3 build แบบ package + smoke ตัวที่ build + เปิดจาก Finder: agy (+ เจ้าของดับเบิลคลิก)
- [ ] T4 Windows: spike + แก้ + smoke: ต้องมีเครื่อง Windows
- [ ] T5 ล็อกอิน Google จริงผ่านแอป (mac, Windows): เจ้าของล็อกอินในเบราว์เซอร์, agy บันทึกผล
- [ ] T6a probe ล้มด้วยสาเหตุอื่นที่ไม่ใช่โควตา ไม่ทำให้ cooldown ยาว
- [ ] T6b token daemon ข้ามโปรไฟล์ที่ token ยังไม่ใกล้หมดอายุ
- [ ] T6c spawn agy ลองใหม่ 1 ครั้งเมื่อไฟล์ถูกแทนที่ระหว่างอัปเดต
- [ ] T6d จำกัดอายุ log/transcript ใน sandbox
- [ ] T6e ไฟล์ `.env` ที่ใช้บันทึก key ตรงกับไฟล์ที่ bridge โหลด
- [ ] T6f desktop ฟังทั้ง `127.0.0.1` และ `::1`
- [ ] T7 Doctor: ตรวจ service ของ CLI, เตือน `ALLOW_CLI_TOOLS`, Export diagnostics
- [ ] T8 first-run wizard
- [ ] T9 installer: ไอคอน, NSIS uninstall, ค่าสำหรับ signing: agy (+ ใบรับรองจากเจ้าของ)
- [ ] T10 auto-update
- [ ] T11 release workflow
- [ ] T12 README/README.th: หัวข้อ Desktop + Hermes `providers:`
- [ ] T13 (ทำเฉพาะเมื่อ T4 พบว่า S1 ใช้ไม่ได้) keyring mode บน Windows

---

## T1. CI บน 3 OS

**ทำไม:** โค้ดยังไม่เคยรันบน Windows เลย CI ช่วยให้เห็นส่วนที่พังบน Windows ได้โดยไม่ต้องมีเครื่อง (สเปก 4.11, 8.9)

**ขั้นตอน**
1. สร้าง `.github/workflows/test.yml`: matrix `os: [ubuntu-latest, windows-latest, macos-latest]` × `node: [18, 22]`, `fail-fast: false`; ขั้นตอน checkout → setup-node → `node --check` ตามรายการใน `AGENTS.md` → รัน test
2. รัน test ด้วย `shell: bash` และคำสั่ง `node --test --test-reporter=spec tests/*.test.mjs` โดยตรง ไม่ผ่าน `npm test` (บน Windows npm รันสคริปต์ด้วย cmd.exe ซึ่งไม่ขยาย `*` และ Node ก่อน 21 ไม่ขยาย glob เอง) พร้อมตั้ง env `ANTIGRAVITY_KEYRING_BACKEND: file:${{ runner.temp }}/keyring.json`
3. ขอให้เจ้าของ push branch แล้วอ่านผลด้วย `gh run list` / `gh run view <id> --log-failed`
4. แก้โค้ดส่วนที่ล้มบน Windows. `t.skip("<เหตุผล>")` ใช้ได้เฉพาะ test ที่ตั้งอยู่บนพฤติกรรมของ POSIX เท่านั้น (เช่น `token-refresh.test.mjs` ที่ skip อยู่แล้ว) และต้องบันทึกไว้ใน IMPLEMENTATION.md หัวข้อ 4

**เสร็จเมื่อ:** ทั้ง 6 job เขียว (หลักฐาน: URL ของ run และบรรทัด `ℹ pass`/`ℹ fail` ของแต่ละ job)

**ระวัง:** Node 18 ไม่มี `import.meta.dirname` (test ใช้ `fileURLToPath(import.meta.url)` แทน); การตรวจสิทธิ์ไฟล์ 0600 ต้องอยู่ใต้เงื่อนไข `process.platform !== "win32"`; `process.kill(-pid)` ใช้ได้เฉพาะ POSIX

## T2. อัปเกรด Electron 32.3.3 → 44.x

**ทำไม:** 32 หมดการสนับสนุนแล้ว (ไม่มี security fix) และ spike ยืนยันการทำงานไว้บน 44.4.5

**ขั้นตอน**
1. ถามเจ้าของก่อน: **Electron 44 เลิกรองรับ macOS 12** (ต้องใช้ macOS 13 ขึ้นไป) ขณะที่สเปกตั้งเป้า macOS 12+ ให้เลือกระหว่างยอมรับ macOS 13+ กับค้างไว้ที่ Electron 43
2. `cd desktop && npm install --save-dev electron@^44` (หรือ `@^43` ตามที่เจ้าของเลือก). ถ้าไม่มี `node_modules/electron/dist` ให้รัน `node node_modules/electron/install.js` (spike F3: npm ไม่ดาวน์โหลด binary ให้)
3. แก้ `desktop/main.mjs` ตามที่ Electron 44 ถอดออก: `openAsHidden` (ใน `setLoginItemSettings`) และ `wasOpenedAsHidden` (ใน `getLoginItemSettings`) ใช้ใน `applyLoginItem()` และ `startedHidden()`. Windows ใช้ `args: ["--hidden"]` ต่อได้; macOS ให้ดู field ที่ยังมีใน `app.getLoginItemSettings()` ของเวอร์ชันที่ติดตั้ง (<https://www.electronjs.org/docs/latest/api/app>) ถ้าไม่มีทางรู้ว่าเปิดตอน login ให้แสดงหน้าต่างตามปกติ
4. อ่าน breaking changes ของเวอร์ชัน 33–44 (<https://www.electronjs.org/docs/latest/breaking-changes>) แล้วเทียบกับ API ที่ `desktop/*.mjs` ใช้

**เสร็จเมื่อ:** (1) smoke ตาม IMPLEMENTATION.md หัวข้อ 3 พิมพ์บรรทัด `SMOKE` ที่มี `"electron":"44.` `"healthy":true` และ `"chat":{"status":200` แล้ว exit 0 (2) `npm test` เขียว (3) ไม่มีการใช้ API ที่ถูกถอดเหลือใน `desktop/`

## T3. build แบบ package, smoke ตัวที่ build, เปิดจาก Finder

**ทำไม:** โค้ดหา `src/` ในแอปที่ build แล้ว (`bridge-paths.mjs`) ยังไม่เคยรันจริง และ spike F14 พบว่า bridge ไม่ขึ้นเมื่อเปิดผ่าน LaunchServices (ยังไม่รู้สาเหตุ)

**ขั้นตอน**
1. `CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix desktop run pack` → `desktop/dist/mac*/Antigravity Bridge.app`
2. smoke กับตัวที่ build: ใช้คำสั่ง smoke เดิม แต่เรียก `"desktop/dist/<mac dir>/Antigravity Bridge.app/Contents/MacOS/Antigravity Bridge" --user-data-dir=...` แทน `electron .`
3. บอกเจ้าของก่อนแล้วให้เจ้าของดับเบิลคลิกแอปใน Finder (ขั้นนี้ใช้ `~/.config/antigravity` จริง และ token daemon จะ refresh ทุกโปรไฟล์) จากนั้นตรวจ tray กับ `curl -s http://127.0.0.1:8008/health`

**เสร็จเมื่อ:** (1) บรรทัด `SMOKE` ของตัวที่ build มี `"healthy":true`, chat 200 และ `entry` อยู่ใต้ `app.asar.unpacked` (2) เปิดจาก Finder แล้ว `/health` ตอบภายใน 30 วินาที ถ้าไม่ตอบ ให้แนบ `~/Library/Logs/Antigravity Bridge/bridge.log` และหาสาเหตุ

**ระวัง:** รายการ `files:`/`asarUnpack:` ใน `electron-builder.yml`; หลังทดสอบให้ลบโฟลเดอร์ log ที่ smoke สร้างไว้

## T4. Windows: spike, แก้ และ smoke

**ทำไม:** ทุกข้อของ Windows ยังเป็นสมมติฐาน (สเปก 6.1 S1–S6 และแคตตาล็อกหัวข้อ 10)

**ขั้นตอน** (บนเครื่อง Windows ที่ติดตั้ง agy และล็อกอินแบบปกติไว้แล้ว 1 ครั้ง)
1. `powershell -ExecutionPolicy Bypass -File .\docs\spike-windows.ps1 -IncludeThai` แล้ววาง `%TEMP%\agy-spike\agy-spike-report.txt` ลงหัวข้อ "Windows" ของ `spike-results.md` จากนั้นลบ `%TEMP%\agy-spike` (มีสำเนา token)
2. แก้ตามผล:
   - S1 (file mode) ใช้ไม่ได้ → ทำ T13
   - S2 (transcript ไม่อยู่ใต้ `USERPROFILE`) → แก้ path ที่ `readLatestAgyRunError()` อ่าน
   - S3 → ปรับ `WIN_EXTRA_ENV_KEYS`
   - S5 → ปรับ `defaultMaxCliArgBytes("win32")`
   - S6 (ภาษาไทยเพี้ยน) → decode ตาม code page
3. `npm test` บน Windows (ใช้คำสั่งแบบเดียวกับ T1) แล้วรัน smoke แบบ PowerShell (บน Windows `os.homedir()` อ่าน `USERPROFILE`):
   ```powershell
   $T = Join-Path $env:TEMP ("agb-smoke-" + [guid]::NewGuid()); New-Item -ItemType Directory $T | Out-Null
   Set-Content "$T\agy.cjs" 'process.stdout.write("OK\n")'
   $env:USERPROFILE = $T; $env:HOME = $T; $env:ANTIGRAVITY_DESKTOP_SMOKE = "1"; $env:ANTIGRAVITY_NO_AUTO_REFRESH = "1"
   $env:ANTIGRAVITY_BRIDGE_CMD = "`"$((Get-Command node).Source)`" `"$T\agy.cjs`" {prompt}"
   cd desktop; .\node_modules\.bin\electron.cmd . --user-data-dir="$T\userData"
   ```
4. บนบัญชี Windows ที่ชื่อมีภาษาไทยและช่องว่าง (สเปก E12): Add Profile แล้วดูว่าหน้าต่าง terminal เปิด และ agy เริ่มใน login HOME ที่ถูกต้อง

**เสร็จเมื่อ:** S1–S6 มีผลพร้อมหลักฐานใน spike-results.md; `npm test` เขียวบน Windows; smoke exit 0 บน Windows; มีบันทึกผล E12

## T5. ล็อกอิน Google จริงผ่านแอป (macOS และ Windows)

**ทำไม:** ขั้นตอนล็อกอินใน SSH mode (เมนู → URL → โค้ด) และจังหวะที่ไฟล์ token ปรากฏ ยังเห็นไม่ครบ (spike S8); ข้อความแนะนำในแอปเขียนจากส่วนที่เห็นแล้วเท่านั้น

**ขั้นตอน:** เจ้าของเปิดแอปแบบปกติ แล้ว Profiles → Add Profile (ชื่อใหม่เช่น `desktop-test`) และล็อกอินในเบราว์เซอร์. agy บันทึก: หน้าจอที่เห็นจริง (มี onboarding หลัง sign-in หรือไม่), ไฟล์ token ปรากฏตอนไหน (ต้องพิมพ์ `hi` ก่อนหรือไม่), แอปจับได้เองหรือไม่, อีเมลที่แสดง, ผล Probe (ใช้โควตา 1 ครั้ง). ถ้าหน้าจอจริงต่างจากที่เขียนไว้ ให้แก้ `WINDOWS_LINES`/`POSIX_LINES` ใน `desktop/profile-login.mjs` และข้อความใน modal ของ `desktop/ui/index.html`

**เสร็จเมื่อ:** แต่ละ OS มีแถวในหัวข้อ S8 ของ spike-results.md (เวอร์ชัน agy, สิ่งที่สังเกต) และโปรไฟล์ใหม่คุยผ่าน bridge ได้

## T6. ความทนทานของ bridge (`src/`: ไปถึง production เมื่อ deploy, ทำทีละข้อ)

- **6a** `/v1/profiles/check` เรียก `mark_exhausted()` ทุกครั้งที่ probe ล้ม. ให้แยกตามแบบ `executeCliWithFallback()`: โควตา → `mark_exhausted()`, อื่น ๆ → `mark_error()` (back-off สั้น). **เสร็จเมื่อ:** มี test ที่ agy ปลอมล้มด้วย `dial tcp: lookup ... no such host` แล้วโปรไฟล์ไม่เข้า cooldown ยาว
- **6b** token daemon รัน agy ให้ทุกโปรไฟล์ทุก 55 นาที ทั้งที่ copy-back ทำให้ token สดอยู่แล้ว. ให้ข้ามโปรไฟล์ที่ access token หมดอายุหลังเวลาปัจจุบันเกิน 15 นาที (ตั้งค่าผ่าน env ได้) และ log ว่าข้ามเพราะอะไร. **เสร็จเมื่อ:** มี test ว่า token สด → ไม่ spawn agy และ token หมดอายุ → refresh
- **6c** agy อัปเดตตัวเองโดยเขียนทับไฟล์ binary (spike F9). ถ้า spawn ล้มด้วย `ENOENT`/`ETXTBSY` ให้ลองใหม่ 1 ครั้งหลัง 1 วินาที. **เสร็จเมื่อ:** มี test ที่ template ชี้ไฟล์ซึ่งเพิ่งถูกสร้างหลังผ่านไป 500 ms แล้ว run สำเร็จ
- **6d** sandbox โตไม่หยุด (spike F11: 402 MB). ให้ลบ `brain/*` และ `conversations/*` ที่เก่ากว่า 7 วัน และ `log/cli-*.log` ที่เก่ากว่า 3 วัน ใต้ `.gemini/antigravity-cli` ของแต่ละ sandbox (ตั้งค่าผ่าน env ได้) ตอน start และทุก 24 ชั่วโมง ข้าม sandbox ที่ถูก lock อยู่. ใน desktop ให้ Doctor แสดงขนาดรวมและมีปุ่ม Clean. **เสร็จเมื่อ:** มี test ที่ใช้ไฟล์เก่า/ใหม่ปลอม (`fs.utimesSync`)
- **6e** `findPrimaryEnvFile()` เลือกไฟล์แรกที่ "มีอยู่" ขณะที่ `loadDotenv()` ใช้ไฟล์แรกที่ "กำหนด" `ANTIGRAVITY_API_KEYS`. เมื่อมีหลายไฟล์ key ใหม่จึงอาจไปอยู่ไฟล์ที่ถูกบัง. ให้เลือกไฟล์ที่กำหนด key อยู่ก่อน. **เสร็จเมื่อ:** มี test 2 ไฟล์ที่แสดงว่า create แล้ว restart ยังเห็น key ทั้งเก่าและใหม่
- **6f** client ที่ resolve `localhost` เป็น `::1` ต่อ bridge ไม่ได้ (สเปก 15.2). ให้ desktop ตั้ง env ใหม่ (เช่น `ANTIGRAVITY_LISTEN_IPV6=1`) ที่ทำให้ฟัง `::1` เพิ่มอีกตัว และเพิ่ม `[::1]:<port>` ใน Host allow-list. **เสร็จเมื่อ:** มี test ว่า request ไป `[::1]` สำเร็จ และค่าเริ่มต้นของ CLI ไม่เปลี่ยน

## T7. Doctor

สเปก 8.7, 12.2 และ P36 ให้เพิ่ม:
1. เตือนเมื่อพบ service ของ CLI edition ที่จะชนพอร์ต: macOS `launchctl list` มี `com.antigravity.bridge.node` (label จาก `setup_launchd_mac.sh`); Windows `schtasks /query /tn AntigravityBridgeNode` (ชื่อจาก `setup_service_windows.ps1`)
2. เตือนสีแดงเมื่อไฟล์ env ใดมี `ANTIGRAVITY_ALLOW_CLI_TOOLS=1`
3. ปุ่ม Export diagnostics: ไฟล์รายงานเดียวที่มีเวอร์ชัน (แอป, Electron, agy, OS), settings, `bridge_config.json`, log 500 บรรทัดสุดท้าย (ผ่าน `maskSecrets()`), `/health` แบบมี key, ชื่อโปรไฟล์ + อีเมล และผล Doctor. ห้ามมี token หรือ key

**เสร็จเมื่อ:** มี unit test ของการอ่านผลคำสั่ง/ไฟล์แต่ละแบบ และ test ที่ export จาก fixture ซึ่งมี key/token แล้วไม่พบค่าลับใดเลยในผล

## T8. First-run wizard

**ทำไม:** ตอนนี้มีแค่ checklist "Getting started" แต่สเปก 5.5 และ A2 ต้องการ wizard ตั้งแต่เปิดครั้งแรก

**ขั้นตอน:** เมื่อ `settings.onboarded !== true` ให้เปิด wizard เอง: agy (ตรวจ/ติดตั้ง) → บัญชีอย่างน้อย 1 บัญชี → URL + key (ปุ่มคัดลอก) + YAML ของ Hermes → เปิด/ปิด autostart → Finish (`saveSettings({ onboarded: true })`). ใช้ IPC ที่มีอยู่ ไม่เพิ่ม channel ใหม่ถ้าไม่จำเป็น

**เสร็จเมื่อ:** smoke ที่ใช้ userData ใหม่พบว่า element ของ wizard แสดงอยู่ (เพิ่มการตรวจนี้ใน `runSmoke()` ด้วย `executeJavaScript`); เมื่อ `onboarded: true` wizard ไม่แสดง; smoke ยัง exit 0

## T9. Installer

1. ไอคอน `desktop/build/icon.icns`, `icon.ico`, `icon.png` (512 px) และ tray icon จริง: macOS ใช้ template image (`trayTemplate.png` + `@2x`, สีดำบนพื้นโปร่ง) โหลดจากไฟล์แทน data URL
2. `desktop/build/installer.nsh` ตามร่างในสเปก 8.8 (uninstall ถามว่าจะลบข้อมูลโปรไฟล์ด้วยหรือไม่ ค่าเริ่มต้นคือเก็บไว้) และ `nsis.include`
3. การ sign: อ่านค่าจาก env/CI secrets เท่านั้น (สเปก 5.6); ใบรับรองเป็นเรื่องที่เจ้าของตัดสิน (D2)

**เสร็จเมื่อ:** `npm --prefix desktop run dist` ได้ DMG+ZIP (mac) และ NSIS exe (Windows) แบบ unsigned; เจ้าของติดตั้งและถอนการติดตั้งบนเครื่องสะอาดแล้วผ่านสเปก 5.5 ข้อ 1 และ E11

## T10. Auto-update

ย้าย `electron-updater` ไป `dependencies` (ใน devDependencies จะไม่ถูกบรรจุ). สร้าง `desktop/updater.mjs` ที่รับ autoUpdater และ supervisor แบบ inject: ตรวจทุก 6 ชั่วโมง, ดาวน์โหลดเบื้องหลัง, ติดตั้งเฉพาะเมื่อ `supervisor.inFlight() === 0`, ไม่มีการล็อกอินค้าง และผู้ใช้ยืนยันแล้ว (สเปก 5.7)

**เสร็จเมื่อ:** มี unit test ด้วย autoUpdater ปลอม ครอบคลุมทุกเงื่อนไขที่ต้อง "ไม่ติดตั้ง"; E10 จริงต้องใช้ build ที่ sign แล้ว (หลัง T9)

## T11. Release workflow

`.github/workflows/desktop-release.yml` ตามสเปก 8.9: รันเมื่อมี tag `v*`, `npm test` ต้องผ่านก่อน package, build แบบ unsigned เมื่อไม่มี secrets (`CSC_IDENTITY_AUTO_DISCOVERY=false`), อัปโหลด artifact

**เสร็จเมื่อ:** tag ทดสอบที่เจ้าของ push ได้ artifact แบบ unsigned ของ mac และ Windows

## T12. README / README.th

เพิ่มหัวข้อ "Desktop edition (preview)" ให้ตรงกับสถานะจริง: ทำอะไรได้แล้ว, วิธีรันจาก source, วิธีเชื่อม Hermes. แก้ตัวอย่าง Hermes จาก `custom_providers:` เป็น `providers:` (Hermes 0.21; ใส่หมายเหตุว่ารุ่นเก่าใช้ `custom_providers:`). ตาม `AGENTS.md` แถวใหม่ใน README อธิบายเฉพาะ Node.js edition

**เสร็จเมื่อ:** ทั้งสองภาษาตรงกัน และทุกคำสั่งที่เขียนในเอกสารถูกรันจริงแล้วอย่างน้อย 1 ครั้ง

## T13. keyring mode บน Windows (ทำเฉพาะเมื่อ S1 ของ T4 ล้ม)

ทดสอบ backend win32 ของ `src/core/keyring.mjs` บน Windows ตามสเปก 9.2: target ทดสอบ `gemini-bridge-test:antigravity`, round-trip ของ JSON และข้อความไทย, blob ขนาด 2,561 ไบต์ต้องล้ม (exit 4), ล้าง target ใน `t.after`. จากนั้นใช้ค่าเริ่มต้น `ANTIGRAVITY_AGY_TOKEN_MODE=keyring` บน win32 และทำ E3 (2 โปรไฟล์ต้องได้อีเมลถูกต้อง โดยรันทีละ run)

**เสร็จเมื่อ:** test ของ keyring เขียวบน Windows; E3 ผ่านพร้อมหลักฐาน (header `X-Antigravity-Active-Profile` + อีเมลใน banner)
