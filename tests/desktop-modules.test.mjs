import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSettings, saveSettings, updateSettings, DEFAULT_SETTINGS } from "../desktop/settings.mjs";
import { findAgy, getInstallInstructions, openInstallTerminal } from "../desktop/agy-installer.mjs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { buildWindowsScript, buildPosixScript, shQuote, openTerminalScript } from "../desktop/terminal.mjs";
import { hermesSnippet } from "../desktop/hermes.mjs";
import { readApiKeys, parseDotenv } from "../desktop/keys.mjs";
import { startDesktopLogin, waitForDesktopLogin, addToRotation, removeFromRotation } from "../desktop/profile-login.mjs";
import { bridgeSrcDir } from "../desktop/bridge-paths.mjs";
import * as core from "../src/core/profile-login.mjs";
import { parseApiKeys } from "../src/auth.mjs";
import { MODEL_CONTEXT_LIMITS } from "../src/config.mjs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+

function makeTempDir(prefix = "agy-desktop-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("desktop settings: load and save lifecycle", (t) => {
  const tmpDir = makeTempDir();
  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // Default when empty
  const s1 = loadSettings(tmpDir);
  assert.equal(s1.port, DEFAULT_SETTINGS.port);
  assert.equal(s1.autostart, true);

  // Save new settings
  const s2 = saveSettings({ port: 9009, autostart: false, noProxy: true }, tmpDir);
  assert.equal(s2.port, 9009);
  assert.equal(s2.autostart, false);
  assert.equal(s2.noProxy, true);

  // Reload from disk
  const s3 = loadSettings(tmpDir);
  assert.equal(s3.port, 9009);
  assert.equal(s3.autostart, false);
  assert.equal(s3.noProxy, true);

  // Port boundary validation: 80 is below 1024 -> falls back to default 8008
  const s4 = saveSettings({ port: 80 }, tmpDir);
  assert.equal(s4.port, 8008);

  // Update settings partial
  const s5 = updateSettings({ language: "en" }, tmpDir);
  assert.equal(s5.language, "en");
  assert.equal(s5.port, 8008);
});

test("desktop agy-installer: Google's official installer URLs (with /cli/; without it they answer 404)", () => {
  const win = getInstallInstructions("win32");
  assert.equal(win.command, "irm https://antigravity.google/cli/install.ps1 | iex");
  assert.equal(win.shell, "powershell");
  for (const pf of ["darwin", "linux"]) {
    const unix = getInstallInstructions(pf);
    assert.equal(unix.command, "curl -fsSL https://antigravity.google/cli/install.sh | bash");
    assert.equal(unix.shell, "bash");
  }
});

test("desktop agy-installer: findAgy detection", () => {
  // Custom path that exists
  const custom = findAgy("/fake/custom/agy", {
    exists: (p) => p === "/fake/custom/agy",
  });
  assert.equal(custom, "/fake/custom/agy");

  // Win32 well-known path candidate
  const winFound = findAgy(null, {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", PATH: "" },
    exists: (p) => p.includes("AppData\\Local\\agy\\bin\\agy.exe"),
  });
  assert.ok(winFound);

  // Darwin candidate
  const macFound = findAgy(null, {
    platform: "darwin",
    homedir: "/Users/test",
    env: { PATH: "" },
    exists: (p) => p === "/opt/homebrew/bin/agy",
  });
  assert.equal(macFound, "/opt/homebrew/bin/agy");
});

/** A spawn() stand-in that records the call and reports a started process (or a failure). */
function fakeSpawn(calls, { fail = null } = {}) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (fail ? child.emit("error", Object.assign(new Error(fail), { code: "ENOENT" })) : child.emit("spawn")));
    return child;
  };
}

test("desktop terminal: Windows scripts are ASCII-only and get paths (a Thai user name) through the environment", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildWindowsScript(['echo C:\\Users\\สมชาย']), /ASCII-only/);

  const calls = [];
  const home = "C:\\Users\\สมชาย ใจดี\\.config\\antigravity\\.login\\work";
  const script = await openTerminalScript({
    platform: "win32",
    dir,
    name: "login-work",
    env: { HOME: home, USERPROFILE: home, AGB_AGY: "C:\\Users\\สมชาย ใจดี\\AppData\\Local\\agy\\bin\\agy.exe" },
    windowsLines: ['"%AGB_AGY%"'],
    spawnFn: fakeSpawn(calls),
  });
  const text = fs.readFileSync(script, "utf-8");
  assert.ok(!text.includes("สมชาย") && /^[\x00-\x7e]*$/.test(text), "no path text in the batch file");
  assert.equal(calls[0].file, "cmd.exe");
  assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(calls[0].args[3], `""${script}""`);
  assert.equal(calls[0].opts.env.USERPROFILE, home, "the value travels as UTF-16 in the environment");
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);

  // No wt.exe/cmd.exe to start: the promise rejects instead of an unhandled 'error' event later.
  await assert.rejects(openTerminalScript({ platform: "win32", dir, name: "x", windowsLines: ["echo x"], spawnFn: fakeSpawn([], { fail: "spawn cmd.exe ENOENT" }) }), /ENOENT/);
});

test("desktop terminal: macOS scripts export shell-quoted values and pass bash -n", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  const calls = [];
  const odd = "/Users/o'neil $HOME `x` \"q\"/.login/p";
  const script = await openTerminalScript({ platform: "darwin", dir, name: "login-p", env: { HOME: odd }, posixLines: ['cd "$HOME" || exit 1', 'printf "%s" "$HOME"'], spawnFn: fakeSpawn(calls) });
  assert.deepEqual([calls[0].file, ...calls[0].args], ["open", "-a", "Terminal", script]);
  if (process.platform !== "win32") {
    assert.equal(spawnSync("bash", ["-n", script]).status, 0);
    const out = spawnSync("bash", ["-c", `${buildPosixScript([], { HOME: odd })}\nprintf "%s" "$HOME"`], { encoding: "utf-8" });
    assert.equal(out.stdout, odd, "the value arrives unchanged, nothing expanded");
  }
});

test("desktop installer terminal: runs Google's installer, rejects cleanly when no terminal starts", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const cmd = await openInstallTerminal("win32", dir, { spawnFn: fakeSpawn(calls) });
  assert.ok(fs.readFileSync(cmd, "utf-8").includes('-Command "irm https://antigravity.google/cli/install.ps1 | iex"'));
  const sh = await openInstallTerminal("darwin", dir, { spawnFn: fakeSpawn(calls) });
  assert.ok(fs.readFileSync(sh, "utf-8").includes("curl -fsSL https://antigravity.google/cli/install.sh | bash"));
  await assert.rejects(openInstallTerminal("darwin", dir, { spawnFn: fakeSpawn([], { fail: "spawn open ENOENT" }) }), /ENOENT/);
});

test("desktop hermes: the snippet has Hermes 0.21's shape (api is the URL, models is a map)", () => {
  const yaml = hermesSnippet({ port: 8123, apiKey: "sk-agv-abc", contextLimits: MODEL_CONTEXT_LIMITS });
  assert.match(yaml, /^providers:\n  agy-bridge:\n    api: http:\/\/127\.0\.0\.1:8123\/v1\n    api_key: sk-agv-abc\n/m);
  assert.match(yaml, /^  provider: agy-bridge$/m);
  assert.match(yaml, /^      gemini-3\.1-pro-high:\n        context_length: 2000000$/m);
  assert.doesNotMatch(yaml, /base_url|api: "openai"|display_name|gemini-3\.8-pro/);
});

test("desktop keys: read like the bridge loads them (launch env first, then the first file that defines them)", (t) => {
  const home = makeTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = path.join(home, ".config", "antigravity");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "bridge.env"), '# keys\nANTIGRAVITY_API_KEYS="hermes:sk-agv-111,cli:sk-agv-222"\n');
  fs.writeFileSync(path.join(home, ".env"), "ANTIGRAVITY_API_KEYS=other:sk-agv-999\nAPI_KEY=single-key-1\n");
  assert.deepEqual(parseDotenv("A=1\nA=2\n# x\nB='q'"), { A: "1", B: "q" });
  assert.deepEqual(readApiKeys({ homedir: home, parseApiKeys }), { "sk-agv-111": "hermes", "sk-agv-222": "cli", "single-key-1": "default" });
  assert.deepEqual(readApiKeys({ homedir: home, parseApiKeys, launchEnv: { ANTIGRAVITY_API_KEYS: "env:sk-agv-000" } }), { "sk-agv-000": "env", "single-key-1": "default" });
});

test("desktop bridge-paths: a checkout uses ../src", () => {
  assert.equal(bridgeSrcDir({ resourcesPath: null }), path.resolve(HERE, "..", "src"));
});

test("desktop login: the token is collected once complete and stable, without waiting for agy to exit", async (t) => {
  const base = makeTempDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tmpDir = path.join(base, "tmp");
  const calls = [];
  const wrapped = { ...core, prepareLogin: (name, opts) => core.prepareLogin(name, { ...opts, baseDir: base }) };
  const handle = await startDesktopLogin("newp", { core: wrapped, agyPath: "/opt/agy", tmpDir, platform: "darwin", spawnFn: fakeSpawn(calls) });
  const script = fs.readFileSync(handle.script, "utf-8");
  assert.ok(script.includes(`export SSH_CONNECTION='127.0.0.1 0 127.0.0.1 22'`));
  assert.ok(script.includes(`export HOME=${shQuote(handle.ctx.loginHome)}`));

  const tokenFile = core.loginTokenFile(handle.ctx);
  setTimeout(() => {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: "2030-01-01T00:00:00Z" } }));
  }, 100);
  const fetchFn = async () => ({ ok: true, json: async () => ({ email: "new@example.com" }) });
  const result = await waitForDesktopLogin(handle, { core: wrapped, pollMs: 50, stableMs: 200, fetchFn });
  assert.equal(result.email, "new@example.com");
  assert.ok(fs.existsSync(path.join(base, "profiles", "newp", "oauth_creds.json")));
  assert.ok(!fs.existsSync(handle.script), "the sign-in script is removed");
});

test("desktop login: cancel, or agy leaving without a token, keeps an existing profile as it was", async (t) => {
  const base = makeTempDir();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "profiles", "work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "oauth_creds.json"), '{"access_token":"keep"}');
  const wrapped = { ...core, prepareLogin: (name, opts) => core.prepareLogin(name, { ...opts, baseDir: base }) };
  const start = () => startDesktopLogin("work", { core: wrapped, agyPath: "/opt/agy", tmpDir: path.join(base, "tmp"), platform: "darwin", spawnFn: fakeSpawn([]) });

  const cancelled = await start();
  setTimeout(() => (cancelled.cancelled = true), 100);
  await assert.rejects(waitForDesktopLogin(cancelled, { core: wrapped, pollMs: 20 }), /cancelled/);

  const exited = await start();
  fs.writeFileSync(exited.marker, "done");
  await assert.rejects(waitForDesktopLogin(exited, { core: wrapped, pollMs: 20 }), /without completing/);

  assert.equal(fs.readFileSync(path.join(dir, "oauth_creds.json"), "utf-8"), '{"access_token":"keep"}');
  assert.ok(!fs.existsSync(path.join(base, ".login", "work")));
});

test("desktop rotation: a first bridge_config.json keeps every profile the bridge was already rotating over", (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "bridge_config.json");
  assert.deepEqual(addToRotation("c", { configPath, available: ["a", "b", "c"] }), ["a", "b", "c"]);
  fs.writeFileSync(configPath, JSON.stringify({ profiles: ["a"], fallback_chains: { default: ["x"] } }));
  assert.deepEqual(addToRotation("c", { configPath, available: ["a", "b", "c"] }), ["a", "c"], "an explicit list is respected");
  assert.deepEqual(removeFromRotation("a", { configPath }), ["c"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf-8")).fallback_chains, { default: ["x"] }, "other settings kept");
});
