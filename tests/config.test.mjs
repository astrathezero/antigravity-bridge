import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PORT,
  parseTimeoutValue,
  extractModelAndTimeout,
  extractTimeoutFromPromptText,
  resolveModelFlags,
  isImageModel,
  getModelFamily,
  isBenignSocketError,
  defaultMaxCliArgBytes,
  keyringSerialized,
  detectCliCommand,
  agyTokenMode,
  AGY_FILE_MODE_ENV,
  splitCommandLine,
} from "../src/config.mjs";

test("config: DEFAULT_PORT is 8008 unless overridden by the environment", () => {
  // A machine-wide bridge.env / .env may set PORT or ANTIGRAVITY_PORT (e.g. the Python bridge's 8000).
  const expected = parseInt(process.env.PORT || process.env.ANTIGRAVITY_PORT || "8008", 10);
  assert.equal(DEFAULT_PORT, expected);
});

test("config: parseTimeoutValue formats", () => {
  assert.equal(parseTimeoutValue("30s"), 30);
  assert.equal(parseTimeoutValue("5m"), 300);
  assert.equal(parseTimeoutValue("2min"), 120);
  assert.equal(parseTimeoutValue("1h"), 3600);
  assert.equal(parseTimeoutValue("500ms"), 0.5);
  assert.equal(parseTimeoutValue(60), 60);
  assert.equal(parseTimeoutValue("invalid"), null);
  assert.equal(parseTimeoutValue(null), null);
});

test("config: extractModelAndTimeout", () => {
  const [m1, t1] = extractModelAndTimeout("claude-sonnet-4-6:30s");
  assert.equal(m1, "claude-sonnet-4-6");
  assert.equal(t1, 30);

  const [m2, t2] = extractModelAndTimeout("gemini-3.8-flash@timeout=5m");
  assert.equal(m2, "gemini-3.8-flash");
  assert.equal(t2, 300);

  const [m3, t3] = extractModelAndTimeout("gemini-3.7-flash");
  assert.equal(m3, "gemini-3.7-flash");
  assert.equal(t3, null);
});

test("config: extractTimeoutFromPromptText", () => {
  const text1 = "Please solve this <!-- timeout: 45s --> quickly";
  assert.equal(extractTimeoutFromPromptText(text1), 45);

  const text2 = "Process [timeout: 2m] task";
  assert.equal(extractTimeoutFromPromptText(text2), 120);

  assert.equal(extractTimeoutFromPromptText("Normal prompt"), null);
});

test("config: resolveModelFlags", () => {
  const flags1 = resolveModelFlags("gemini-3.8-flash");
  assert.deepEqual(flags1, ["--model", "gemini-3.8-flash", "--effort", "high"]);

  const flags2 = resolveModelFlags("gemini-3.8-flash-low");
  assert.deepEqual(flags2, ["--model", "gemini-3.8-flash", "--effort", "low"]);

  const flags3 = resolveModelFlags("claude-sonnet-4-6");
  assert.deepEqual(flags3, ["--model", "claude-sonnet-4-6"]);

  const flags4 = resolveModelFlags("gpt-oss-120b-medium");
  assert.deepEqual(flags4, ["--model", "gpt-oss-120b", "--effort", "medium"]);
});

test("config: isImageModel", () => {
  assert.equal(isImageModel("gemini-3.1-flash-image"), true);
  assert.equal(isImageModel("imagen-3"), true);
  assert.equal(isImageModel("nano-banana"), true);
  assert.equal(isImageModel("gemini-3.8-flash"), false);
  assert.equal(isImageModel("claude-sonnet-4-6"), false);
});

test("config: getModelFamily", () => {
  assert.equal(getModelFamily("gemini-3.8-flash"), "gemini");
  assert.equal(getModelFamily("claude-sonnet-4-6"), "claude");
  assert.equal(getModelFamily("claude-opus-4.6"), "claude");
  assert.equal(getModelFamily("gpt-oss-120b"), "gpt-oss");
  assert.equal(getModelFamily("other-model"), "other");
});

test("config: isBenignSocketError classifies client-disconnect codes only", () => {
  for (const code of ["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
    assert.equal(isBenignSocketError(Object.assign(new Error("x"), { code })), true, code);
  }
  for (const code of ["EACCES", "ENOENT", "ESOMETHINGELSE", undefined, ""]) {
    assert.equal(isBenignSocketError(Object.assign(new Error("x"), { code })), false, String(code));
  }
  assert.equal(isBenignSocketError(null), false);
  assert.equal(isBenignSocketError(undefined), false);
  assert.equal(isBenignSocketError(new Error("no code")), false);
});

test("config: defaultMaxCliArgBytes varies by platform", () => {
  assert.equal(defaultMaxCliArgBytes("win32"), 24000);
  assert.equal(defaultMaxCliArgBytes("linux"), 120000);
  assert.equal(defaultMaxCliArgBytes("darwin"), 120000);
});

test("config: agyTokenMode defaults to file mode", () => {
  const orig = process.env.ANTIGRAVITY_AGY_TOKEN_MODE;
  try {
    delete process.env.ANTIGRAVITY_AGY_TOKEN_MODE;
    assert.equal(agyTokenMode(), "file");
    assert.deepEqual(AGY_FILE_MODE_ENV, { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" });

    process.env.ANTIGRAVITY_AGY_TOKEN_MODE = "keyring";
    assert.equal(agyTokenMode(), "keyring");
  } finally {
    if (orig !== undefined) process.env.ANTIGRAVITY_AGY_TOKEN_MODE = orig;
    else delete process.env.ANTIGRAVITY_AGY_TOKEN_MODE;
  }
});

test("config: keyringSerialized only ever applies to keyring mode", () => {
  const orig = process.env.ANTIGRAVITY_KEYRING_SERIALIZE;
  try {
    delete process.env.ANTIGRAVITY_KEYRING_SERIALIZE;
    // File mode (the default): every profile has its own token file, so nothing is serialized, on any OS.
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.equal(keyringSerialized(platform, "file"), false, platform);
    }
    process.env.ANTIGRAVITY_KEYRING_SERIALIZE = "1";
    assert.equal(keyringSerialized("darwin", "file"), false, "the override cannot serialize file mode");

    // Keyring mode: one keyring entry per machine on macOS/Windows.
    delete process.env.ANTIGRAVITY_KEYRING_SERIALIZE;
    assert.equal(keyringSerialized("darwin", "keyring"), true);
    assert.equal(keyringSerialized("win32", "keyring"), true);
    assert.equal(keyringSerialized("linux", "keyring"), false);

    process.env.ANTIGRAVITY_KEYRING_SERIALIZE = "0";
    assert.equal(keyringSerialized("darwin", "keyring"), false);
    assert.equal(keyringSerialized("win32", "keyring"), false);

    process.env.ANTIGRAVITY_KEYRING_SERIALIZE = "1";
    assert.equal(keyringSerialized("linux", "keyring"), true);
  } finally {
    if (orig !== undefined) process.env.ANTIGRAVITY_KEYRING_SERIALIZE = orig;
    else delete process.env.ANTIGRAVITY_KEYRING_SERIALIZE;
  }
});

test("config: splitCommandLine keeps quoted paths (with spaces) as one argument", () => {
  assert.deepEqual(splitCommandLine('"C:\\Users\\A B\\agy.exe" --x -p "{prompt}"'), ["C:\\Users\\A B\\agy.exe", "--x", "-p", "{prompt}"]);
  assert.deepEqual(splitCommandLine("/usr/bin/agy -p hi"), ["/usr/bin/agy", "-p", "hi"]);
  assert.deepEqual(splitCommandLine(""), []);
});

test("config: detectCliCommand with platform and path injection", () => {
  // 1. Explicit envCmd override
  const cmd1 = detectCliCommand({ env: { ANTIGRAVITY_BRIDGE_CMD: "/custom/bin/agy -flag" } });
  assert.equal(cmd1.binary, "/custom/bin/agy");
  assert.equal(cmd1.template, "/custom/bin/agy -flag");

  // 2. Windows finding agy.exe in LOCALAPPDATA
  const cmdWin = detectCliCommand({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local", PATH: "" },
    exists: (p) => p === "C:\\Users\\User\\AppData\\Local\\agy\\bin\\agy.exe",
    homedir: "C:\\Users\\User",
  });
  assert.equal(cmdWin.binary, "C:\\Users\\User\\AppData\\Local\\agy\\bin\\agy.exe");
  assert.ok(cmdWin.template.includes("C:\\Users\\User\\AppData\\Local\\agy\\bin\\agy.exe"));

  // 3. macOS finding in /opt/homebrew/bin/agy
  const cmdMac = detectCliCommand({
    platform: "darwin",
    env: { PATH: "" },
    exists: (p) => p === "/opt/homebrew/bin/agy",
    homedir: "/Users/user",
  });
  assert.equal(cmdMac.binary, "/opt/homebrew/bin/agy");
  assert.ok(cmdMac.template.includes("/opt/homebrew/bin/agy"));

  // 4. A quoted ANTIGRAVITY_BRIDGE_CMD: the binary is the path without its quotes, spaces included.
  const cmdQuoted = detectCliCommand({ env: { ANTIGRAVITY_BRIDGE_CMD: '"/Applications/My Tools/agy" -p "{prompt}"' } });
  assert.equal(cmdQuoted.binary, "/Applications/My Tools/agy");

  // 5. A spawnable binary even for a GUI app whose PATH lacks ~/.local/bin (it was the bare word "agy").
  const cmdGui = detectCliCommand({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    exists: (p) => p === "/Users/user/.local/bin/agy",
    homedir: "/Users/user",
  });
  assert.equal(cmdGui.binary, "/Users/user/.local/bin/agy");
});

