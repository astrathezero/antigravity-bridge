import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { macKeychainStore } from "./security.mjs";

export const KEYRING_TARGET = { service: "gemini", account: "antigravity" };
export const WINCRED_TARGET = "gemini:antigravity";

export function keyringBackend(platform = process.platform) {
  const forced = (process.env.ANTIGRAVITY_KEYRING_BACKEND || "").trim();
  if (forced.startsWith("file:")) return { kind: "file", path: forced.slice(5) };
  if (platform === "darwin") return { kind: "darwin" };
  if (platform === "win32") return { kind: "win32" };
  if (platform === "linux") return { kind: "linux" };
  return { kind: "none" };
}

// Windows: PowerShell + P/Invoke (native Windows Credential Manager without external dependencies)
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
  if (-not [CredNative]::CredReadW($target, 1, 0, [ref]$p)) { exit 2 }
  $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type][CredNative+CREDENTIAL])
  $b = New-Object byte[] $c.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize)
  [CredNative]::CredFree($p)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b)); exit 0
} elseif ($op -eq "write") {
  $bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
  if ($bytes.Length -gt 2560) { exit 4 }
  $c = New-Object CredNative+CREDENTIAL
  $c.Type = 1; $c.TargetName = $target; $c.UserName = "antigravity"; $c.Persist = 2
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
  const exe = process.env.ANTIGRAVITY_POWERSHELL || "powershell.exe";
  const encoded = Buffer.from(WINCRED_PS, "utf16le").toString("base64");
  const res = spawnSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded, op, target],
    { input: input ?? "", encoding: "utf-8", timeout: 15000, windowsHide: true }
  );
  return res;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function readToken(backend = keyringBackend()) {
  if (backend.kind === "file") {
    try {
      if (!fs.existsSync(backend.path)) return null;
      return JSON.parse(fs.readFileSync(backend.path, "utf-8"));
    } catch {
      return null;
    }
  }

  if (backend.kind === "win32") {
    const r = runWincred("read");
    return r.status === 0 && r.stdout ? safeParse(r.stdout) : null;
  }

  if (backend.kind === "darwin") {
    try {
      const res = spawnSync(
        "security",
        ["find-generic-password", "-s", KEYRING_TARGET.service, "-a", KEYRING_TARGET.account, "-w"],
        { encoding: "utf-8", windowsHide: true }
      );
      if (res.status === 0 && res.stdout) {
        const out = res.stdout.trim();
        if (out.startsWith("go-keyring-base64:")) {
          const rawB64 = out.slice("go-keyring-base64:".length);
          return safeParse(Buffer.from(rawB64, "base64").toString("utf-8"));
        }
        return safeParse(out);
      }
    } catch {
      return null;
    }
  }

  if (backend.kind === "linux") {
    try {
      const res = spawnSync(
        "secret-tool",
        ["lookup", "service", KEYRING_TARGET.service, "account", KEYRING_TARGET.account],
        { encoding: "utf-8", timeout: 2000, windowsHide: true }
      );
      if (res.status === 0 && res.stdout) {
        const out = res.stdout.trim();
        if (out.startsWith("go-keyring-base64:")) {
          const rawB64 = out.slice("go-keyring-base64:".length);
          return safeParse(Buffer.from(rawB64, "base64").toString("utf-8"));
        }
        return safeParse(out);
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function writeToken(tokenObj, backend = keyringBackend()) {
  const json = typeof tokenObj === "string" ? tokenObj : JSON.stringify(tokenObj);

  if (backend.kind === "file") {
    try {
      fs.writeFileSync(backend.path, json, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  if (backend.kind === "win32") {
    return runWincred("write", json).status === 0;
  }

  if (backend.kind === "darwin") {
    const b64Val = "go-keyring-base64:" + Buffer.from(json, "utf-8").toString("base64");
    return macKeychainStore(KEYRING_TARGET.service, KEYRING_TARGET.account, b64Val);
  }

  if (backend.kind === "linux") {
    const b64Val = "go-keyring-base64:" + Buffer.from(json, "utf-8").toString("base64");
    try {
      const res = spawnSync(
        "secret-tool",
        ["store", "--label=Antigravity", "service", KEYRING_TARGET.service, "account", KEYRING_TARGET.account],
        { input: b64Val, timeout: 2000, windowsHide: true }
      );
      return res.status === 0;
    } catch {
      return false;
    }
  }

  return false;
}

export function deleteToken(backend = keyringBackend()) {
  if (backend.kind === "file") {
    try {
      if (fs.existsSync(backend.path)) fs.unlinkSync(backend.path);
      return true;
    } catch {
      return false;
    }
  }

  if (backend.kind === "win32") {
    return runWincred("delete").status === 0;
  }

  if (backend.kind === "darwin") {
    try {
      const res = spawnSync(
        "security",
        ["delete-generic-password", "-s", KEYRING_TARGET.service, "-a", KEYRING_TARGET.account],
        { stdio: "ignore", windowsHide: true }
      );
      return res.status === 0;
    } catch {
      return false;
    }
  }

  if (backend.kind === "linux") {
    try {
      const res = spawnSync(
        "secret-tool",
        ["clear", "service", KEYRING_TARGET.service, "account", KEYRING_TARGET.account],
        { stdio: "ignore", timeout: 2000, windowsHide: true }
      );
      return res.status === 0;
    } catch {
      return false;
    }
  }

  return false;
}

export function createKeyring(options = {}) {
  const backend = options.storePath
    ? { kind: "file", path: options.storePath }
    : keyringBackend(options.platform);
  return {
    backend,
    async getPassword(_service, _account) {
      const tok = readToken(backend);
      return tok ? JSON.stringify(tok) : null;
    },
    async setPassword(_service, _account, value) {
      return writeToken(value, backend);
    },
    async deletePassword(_service, _account) {
      return deleteToken(backend);
    },
  };
}
