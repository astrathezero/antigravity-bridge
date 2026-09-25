import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildChildEnvironment,
  BASE_ALLOWED_ENV_KEYS,
  WIN_EXTRA_ENV_KEYS,
} from "../src/core/executor.mjs";
import { AGY_FILE_MODE_ENV } from "../src/config.mjs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+

test("executor-env: linux/darwin environment has base allowed keys and no win32 extras", () => {
  const baseEnv = {
    PATH: "/bin:/usr/bin",
    USER: "tester",
    SECRET_CUSTOM_VAR: "do-not-leak",
    APPDATA: "C:\\AppData",
    LOCALAPPDATA: "C:\\LocalAppData",
    ANTIGRAVITY_API_KEYS: "sk-agv-secret123",
    ANTIGRAVITY_API_KEY: "sk-agv-single456",
    ANTIGRAVITY_IMAGE_ROUTER_KEY: "sk-router789",
    ANTIGRAVITY_ALLOWED_HOSTS: "127.0.0.1",
    ANTIGRAVITY_CUSTOM_FLAG: "1",
  };

  const childEnv = buildChildEnvironment({
    platform: "darwin",
    baseEnv,
    sandboxDir: "/tmp/sandbox-1",
    profile: "prof1",
    tokenMode: "file",
  });

  // Base keys allowed
  assert.equal(childEnv.PATH, "/bin:/usr/bin");
  assert.equal(childEnv.USER, "tester");
  assert.equal(childEnv.HOME, "/tmp/sandbox-1");
  assert.equal(childEnv.USERPROFILE, "/tmp/sandbox-1");
  assert.equal(childEnv.XDG_CONFIG_HOME, "/tmp/sandbox-1/.config");
  assert.equal(childEnv.ANTIGRAVITY_PROFILE, "prof1");

  // File mode env injected
  assert.equal(childEnv.SSH_CONNECTION, AGY_FILE_MODE_ENV.SSH_CONNECTION);

  // Win extra NOT included on darwin
  assert.equal(childEnv.APPDATA, undefined);
  assert.equal(childEnv.LOCALAPPDATA, undefined);

  // Unrelated secret variables NOT included
  assert.equal(childEnv.SECRET_CUSTOM_VAR, undefined);

  // API keys and secret keys stripped (Section 4.12)
  assert.equal(childEnv.ANTIGRAVITY_API_KEYS, undefined);
  assert.equal(childEnv.ANTIGRAVITY_API_KEY, undefined);
  assert.equal(childEnv.ANTIGRAVITY_IMAGE_ROUTER_KEY, undefined);

  // Non-key ANTIGRAVITY_* flags preserved
  assert.equal(childEnv.ANTIGRAVITY_ALLOWED_HOSTS, "127.0.0.1");
  assert.equal(childEnv.ANTIGRAVITY_CUSTOM_FLAG, "1");
});

test("executor-env: win32 environment includes Windows extra variables", () => {
  const baseEnv = {
    PATH: "C:\\Windows\\System32",
    APPDATA: "C:\\Users\\User\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SYSTEMROOT: "C:\\Windows",
    USERNAME: "User",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\User",
    PROGRAMDATA: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files",
    windir: "C:\\Windows",
    NUMBER_OF_PROCESSORS: "8",
    PROCESSOR_ARCHITECTURE: "AMD64",
    ANTIGRAVITY_API_KEYS: "secret",
  };

  const childEnv = buildChildEnvironment({
    platform: "win32",
    baseEnv,
    sandboxDir: "C:\\Users\\User\\.config\\antigravity\\sandboxes\\p1",
    profile: "p1",
    tokenMode: "file",
  });

  assert.equal(childEnv.APPDATA, "C:\\Users\\User\\AppData\\Roaming");
  assert.equal(childEnv.LOCALAPPDATA, "C:\\Users\\User\\AppData\\Local");
  assert.equal(childEnv.COMSPEC, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(childEnv.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(childEnv.SYSTEMROOT, "C:\\Windows");
  assert.equal(childEnv.USERNAME, "User");
  assert.equal(childEnv.NUMBER_OF_PROCESSORS, "8");
  assert.equal(childEnv.PROCESSOR_ARCHITECTURE, "AMD64");

  // Secrets still stripped
  assert.equal(childEnv.ANTIGRAVITY_API_KEYS, undefined);
});

test("executor-env: win32 keeps variables whatever their spelling (Windows writes Path, SystemRoot, ComSpec)", () => {
  // The names as a real Windows environment spells them; the allow-list is upper-case.
  const baseEnv = {
    Path: "C:\\Windows\\system32;C:\\Users\\U\\AppData\\Local\\agy\\bin",
    SystemRoot: "C:\\WINDOWS",
    ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
    ProgramData: "C:\\ProgramData",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    Antigravity_Api_Keys: "secret",
    SomethingElse: "x",
  };
  const childEnv = buildChildEnvironment({ platform: "win32", baseEnv, sandboxDir: "C:\\sb", profile: "p1", tokenMode: "file" });
  assert.equal(childEnv.Path, baseEnv.Path);
  assert.equal(childEnv.SystemRoot, "C:\\WINDOWS");
  assert.equal(childEnv.ComSpec, baseEnv.ComSpec);
  assert.equal(childEnv.ProgramData, "C:\\ProgramData");
  assert.equal(childEnv.Antigravity_Api_Keys, undefined);
  assert.equal(childEnv.SomethingElse, undefined);

  // On POSIX names are case-sensitive: "Path" is not PATH.
  const posix = buildChildEnvironment({ platform: "linux", baseEnv: { Path: "/x", PATH: "/usr/bin" }, sandboxDir: "/sb" });
  assert.equal(posix.PATH, "/usr/bin");
  assert.equal(posix.Path, undefined);
});

test("executor-env: all spawn and spawnSync in src/ specify windowsHide: true", () => {
  function scanDir(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDir(full));
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        results.push(full);
      }
    }
    return results;
  }

  function findSpawnCalls(content) {
    const calls = [];
    const regex = /\b(spawn(?:Sync)?)\s*\(/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const start = match.index;
      let i = match.index + match[0].length;
      let depth = 1;
      while (i < content.length && depth > 0) {
        if (content[i] === "(") depth++;
        else if (content[i] === ")") depth--;
        i++;
      }
      calls.push(content.slice(start, i));
    }
    return calls;
  }

  const srcDir = path.resolve(HERE, "../src");
  const files = scanDir(srcDir);

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const calls = findSpawnCalls(content);
    for (const call of calls) {
      assert.ok(
        call.includes("windowsHide: true"),
        `Expected windowsHide: true in ${path.relative(srcDir, file)}:\n${call}`
      );
    }
  }
});
