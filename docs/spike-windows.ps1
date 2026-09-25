# ==============================================================================
# Antigravity Bridge — Desktop edition Phase 0 spike for WINDOWS (S1, S2, S5, S6)
# ==============================================================================
# STATUS: written on macOS on 2026-09-24, NOT yet executed on Windows. Read it before running.
# It is READ-ONLY on Credential Manager (CredRead only) and never writes outside %TEMP%\agy-spike.
# It DOES copy your agy OAuth token into %TEMP%\agy-spike\home — delete that folder afterwards.
#
# Prerequisites: Windows 10/11, PowerShell 5.1+, agy installed (irm https://antigravity.google/cli/install.ps1 | iex)
#                and logged in once normally (run `agy`, sign in, type `hi`, then `/exit`).
# Run:  powershell -ExecutionPolicy Bypass -File .\docs\spike-windows.ps1 [-IncludeThai]
# Result: %TEMP%\agy-spike\agy-spike-report.txt  (paste into docs/spike-results.md, section "Windows")
#
# What it answers:
#   S1  does SSH_CONNECTION switch agy.exe to file-based token storage under USERPROFILE (= sandbox)?
#   S2  does agy write its brain/transcript under USERPROFILE (needed by the bridge's quota fast-fail)?
#   S5  where is the command-line length limit (expects 40k chars to fail, 24k to pass)?
#   S6  (optional, uses quota) does Thai text survive stdout round-trip?
# ==============================================================================
param(
  [string]$AgyPath = "",
  [switch]$IncludeThai
)
$ErrorActionPreference = "Stop"
$script:report = @()
function Say([string]$m) { Write-Host $m; $script:report += $m }

$spike = Join-Path $env:TEMP "agy-spike"
$sbHome = Join-Path $spike "home"
if (Test-Path $spike) { Remove-Item -Recurse -Force $spike }
New-Item -ItemType Directory -Force (Join-Path $sbHome ".gemini\antigravity-cli") | Out-Null
Say ("spike dir: " + $spike)
Say ("OS: " + [Environment]::OSVersion.VersionString + " PS " + $PSVersionTable.PSVersion + " user=" + $env:USERNAME)

# ---------- 1. locate agy.exe (same order the desktop app will use) ----------
if (-not $AgyPath) {
  $cands = @()
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe") }
  $cmd = Get-Command agy.exe -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  $AgyPath = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $AgyPath) { Say "[FAIL] agy.exe not found (expected %LOCALAPPDATA%\agy\bin\agy.exe). Install agy first."; exit 1 }
Say ("agy: " + $AgyPath)
try { Say ("agy version: " + ((& $AgyPath --version 2>&1) | Out-String).Trim()) } catch { Say ("agy --version failed: " + $_.Exception.Message) }

# ---------- 2. read the token agy stored in Credential Manager (READ ONLY) ----------
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class CredNativeRO {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize;
    public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, uint type, uint f, out IntPtr c);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr b);
}
"@
function Read-AgyCred {
  $p = [IntPtr]::Zero
  if (-not [CredNativeRO]::CredReadW("gemini:antigravity", 1, 0, [ref]$p)) { return $null }
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type][CredNativeRO+CREDENTIAL])
  $b = New-Object byte[] $c.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)
  [CredNativeRO]::CredFree($p)
  return [Text.Encoding]::UTF8.GetString($b)
}
$before = Read-AgyCred
if (-not $before) { Say "[FAIL] Credential Manager has no 'gemini:antigravity'. Run agy, sign in, type hi, /exit, then rerun."; exit 2 }
Say ("credential blob: " + [Text.Encoding]::UTF8.GetByteCount($before) + " bytes")
try {
  $j = $before | ConvertFrom-Json
  $tk = @(); if ($j.token) { $tk = $j.token.PSObject.Properties.Name }
  Say ("blob is JSON. top keys: " + ($j.PSObject.Properties.Name -join ",") + " | token keys: " + ($tk -join ","))
} catch {
  Say "[WARN] blob is NOT UTF-8 JSON — Windows format differs from macOS/Linux; first bytes (hex): "
  $bytes = [Text.Encoding]::UTF8.GetBytes($before); Say (($bytes[0..([Math]::Min(31,$bytes.Length-1))] | ForEach-Object { $_.ToString("x2") }) -join " ")
}

# ---------- 3. plant the token as a FILE in the sandbox HOME, exactly like the bridge does ----------
$tokFile = Join-Path $sbHome ".gemini\antigravity-cli\antigravity-oauth-token"
[IO.File]::WriteAllText($tokFile, $before, (New-Object Text.UTF8Encoding($false)))
$tokBefore = (Get-Item $tokFile).Length

# ---------- 4. S1/S2: run agy.exe with USERPROFILE/HOME = sandbox and SSH_CONNECTION set ----------
function Invoke-AgyInSandbox([string]$prompt, [string]$tag) {
  $saved = @{ USERPROFILE = $env:USERPROFILE; HOME = $env:HOME; SSH_CONNECTION = $env:SSH_CONNECTION }
  $env:USERPROFILE = $sbHome; $env:HOME = $sbHome; $env:SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 22"
  $out = Join-Path $spike "$tag.out"; $err = Join-Path $spike "$tag.err"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $p = Start-Process -FilePath $AgyPath -ArgumentList @("--dangerously-skip-permissions", "--print-timeout", "2m0s", "--output-format", "stream-json", "-p", ('"' + $prompt + '"')) -WorkingDirectory $sbHome -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $code = $p.ExitCode
  } catch { $code = "spawn-error: " + $_.Exception.Message }
  $sw.Stop()
  $env:USERPROFILE = $saved.USERPROFILE
  if ($saved.HOME) { $env:HOME = $saved.HOME } else { Remove-Item Env:HOME -ErrorAction SilentlyContinue }
  if ($saved.SSH_CONNECTION) { $env:SSH_CONNECTION = $saved.SSH_CONNECTION } else { Remove-Item Env:SSH_CONNECTION -ErrorAction SilentlyContinue }
  return @{ code = $code; secs = [int]$sw.Elapsed.TotalSeconds; out = $out; err = $err }
}

$r = Invoke-AgyInSandbox "Reply with exactly one word: OK" "s1"
Say ("S1 run: exit=" + $r.code + " time=" + $r.secs + "s")
$o = ""; if (Test-Path $r.out) { $o = Get-Content $r.out -Raw -Encoding UTF8 }
if ($o -match '"response":"OK') { Say "S1 [PASS] agy answered OK via stream-json" }
else {
  Say "S1 [FAIL] no OK in stdout"
  Say ("  stdout tail: " + (($o -split "`n") | Select-Object -Last 2) -join " | ")
  if (Test-Path $r.err) { Say ("  stderr: " + ((Get-Content $r.err -Raw -ErrorAction SilentlyContinue) | Out-String).Trim()) }
}
$logDir = Join-Path $sbHome ".gemini\antigravity-cli\log"
$fileMode = $false; $fallback = $false
if (Test-Path $logDir) {
  foreach ($l in Get-ChildItem $logDir -Filter "cli-*.log") {
    if (Select-String -Path $l.FullName -Pattern "Using file-based token storage" -Quiet) { $fileMode = $true }
    if (Select-String -Path $l.FullName -Pattern "falling back to file" -Quiet) { $fallback = $true }
  }
  Say ("S1 log line 'Using file-based token storage because SSH session detected': " + $(if ($fileMode) { "[PASS] found" } else { "[FAIL] not found" }) + $(if ($fallback) { " (also saw keyring->file fallback)" } else { "" }))
} else { Say ("S1 [FAIL] no log dir under sandbox: " + $logDir + " — agy did not honour USERPROFILE; look under " + $env:APPDATA + " / " + $env:USERPROFILE) }
$brain = Join-Path $sbHome ".gemini\antigravity-cli\brain"
Say ("S2 brain/transcript under sandbox USERPROFILE: " + $(if (Test-Path $brain) { "[PASS] " + $brain } else { "[FAIL] missing — quota fast-fail would not work; search for 'brain' under %APPDATA% and %USERPROFILE%" }))
$after = Read-AgyCred
Say ("S1 Credential Manager untouched by the run: " + $(if ($after -eq $before) { "[PASS]" } else { "[FAIL] blob changed — agy still wrote to Credential Manager" }))
Say ("S1 token file: " + $tokBefore + " -> " + (Get-Item $tokFile).Length + " bytes " + $(if ((Get-Item $tokFile).Length -ne $tokBefore) { "(rewritten by agy = refreshed in FILE)" } else { "(unchanged)" }))

# ---------- 5. S5: command-line length limit (no quota used) ----------
foreach ($n in @(24000, 31000, 40000)) {
  $arg = "x" * $n
  try {
    $pp = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "exit", "0", $arg) -NoNewWindow -Wait -PassThru
    Say ("S5 " + $n + "-char argv: started (exit " + $pp.ExitCode + ")")
  } catch { Say ("S5 " + $n + "-char argv: FAILED to start -> " + $_.Exception.Message) }
}
Say "S5 expectation: 24000 starts, 40000 fails (limit 32767 chars). The bridge must keep ANTIGRAVITY_MAX_CLI_ARG_BYTES about 24000 on Windows."

# ---------- 6. S6 (optional): Thai round trip through stdout ----------
if ($IncludeThai) {
  $rt = Invoke-AgyInSandbox "ตอบด้วยคำเดียวเท่านั้น: สวัสดี" "s6"
  $ot = ""; if (Test-Path $rt.out) { $ot = Get-Content $rt.out -Raw -Encoding UTF8 }
  Say ("S6 Thai round trip: exit=" + $rt.code + " " + $(if ($ot -match "สวัสดี") { "[PASS] Thai intact in stdout (UTF-8)" } else { "[FAIL] Thai missing or garbled: " + (($ot -split "`n") | Select-Object -Last 1) }))
}

# ---------- 7. environment snapshot (for the executor allow-list, S3) ----------
$present = @("APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERNAME", "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA") | ForEach-Object { $_ + "=" + [bool](Get-Item ("Env:" + $_) -ErrorAction SilentlyContinue) }
Say ("S3 env present in this shell: " + ($present -join " "))

$reportFile = Join-Path $spike "agy-spike-report.txt"
$script:report | Set-Content $reportFile -Encoding UTF8
Say ("report written: " + $reportFile)
Say ("CLEANUP: " + $spike + " contains a copy of your OAuth token. Delete it when done:  Remove-Item -Recurse -Force '" + $spike + "'")
