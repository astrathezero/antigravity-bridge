import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import {
  prepareLogin,
  collectLogin,
  cleanupLogin,
  runInteractiveLogin,
  loginTokenFile,
} from "../src/core/profile-login.mjs";
import { createKeyring } from "../src/core/keyring.mjs";

function makeTempDir(prefix = "agy-login-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** What agy leaves in the login HOME after a successful sign-in. */
function writeAgyLogin(ctx, { access = "fake-access-token-123", refresh = "fake-refresh-token-456", email = null } = {}) {
  const tokenFile = loginTokenFile(ctx);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(
    tokenFile,
    JSON.stringify({
      token: { access_token: access, refresh_token: refresh, token_type: "Bearer", expiry: "2026-12-31T23:59:59Z" },
      auth_method: "consumer",
      id_token: "id-token-789",
    })
  );
  if (email) fs.writeFileSync(path.join(ctx.loginHome, ".gemini", "google_accounts.json"), JSON.stringify({ active: email, old: [] }));
}

const userinfo = (email) => async (url) => {
  assert.ok(url.includes("userinfo"));
  return { ok: true, json: async () => ({ email }) };
};
const offline = async () => {
  throw new Error("getaddrinfo ENOTFOUND www.googleapis.com");
};

function seedProfile(baseDir, name, email, access = `access-of-${name}`) {
  const dir = path.join(baseDir, "profiles", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "oauth_creds.json"), JSON.stringify({ access_token: access, refresh_token: `refresh-of-${name}` }));
  fs.writeFileSync(path.join(dir, "google_accounts.json"), JSON.stringify({ active: email, old: [] }));
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  return dir;
}

function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf-8")]));
}

test("profile-login: file mode prepare and collect workflow", async (t) => {
  const baseDir = makeTempDir("agy-login-file-");
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  const ctx = await prepareLogin("prof1", { baseDir, mode: "file" });
  assert.equal(ctx.mode, "file");
  assert.equal(ctx.targetExisted, false);
  assert.ok(fs.existsSync(ctx.loginHome));
  assert.ok(!fs.existsSync(ctx.targetDir), "the profile is only created once the login succeeded");

  writeAgyLogin(ctx);
  const result = await collectLogin("prof1", { prepareCtx: ctx, fetchFn: userinfo("user1@example.com") });
  assert.equal(result.success, true);
  assert.equal(result.email, "user1@example.com");
  assert.equal(result.verified, true);

  const creds = JSON.parse(fs.readFileSync(path.join(ctx.targetDir, "oauth_creds.json"), "utf-8"));
  assert.equal(creds.access_token, "fake-access-token-123");
  assert.equal(creds.refresh_token, "fake-refresh-token-456");
  assert.equal(creds.token.expiry, "2026-12-31T23:59:59Z");
  assert.equal(creds.expiry_date, Date.parse("2026-12-31T23:59:59Z"));
  const accounts = JSON.parse(fs.readFileSync(path.join(ctx.targetDir, "google_accounts.json"), "utf-8"));
  assert.equal(accounts.active, "user1@example.com");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(ctx.targetDir, "oauth_creds.json")).mode & 0o777, 0o600);
  }
  assert.ok(!fs.existsSync(ctx.loginHome), "login HOME removed");
});

test("profile-login: an account another profile already has is rejected, and nothing is written or deleted", async (t) => {
  const baseDir = makeTempDir("agy-login-dup-");
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const existing = seedProfile(baseDir, "existing_prof", "shared@example.com");
  const before = snapshot(existing);

  const ctx = await prepareLogin("new_prof", { baseDir, mode: "file" });
  writeAgyLogin(ctx);
  await assert.rejects(
    collectLogin("new_prof", { prepareCtx: ctx, fetchFn: userinfo("Shared@Example.com") }),
    /already registered in profile 'existing_prof'/
  );
  await cleanupLogin(ctx, { keepTarget: false }); // what the CLI does on any error
  assert.deepEqual(snapshot(existing), before);
  assert.ok(!fs.existsSync(path.join(baseDir, "profiles", "new_prof")));
  assert.ok(!fs.existsSync(ctx.loginHome));
});

test("profile-login: re-login of an existing profile keeps it intact until the new login succeeds", async (t) => {
  const baseDir = makeTempDir("agy-login-relogin-");
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const dir = seedProfile(baseDir, "work", "old@example.com");
  const before = snapshot(dir);

  // 1. The user closes the terminal without signing in: the CLI cleans up with keepTarget: false.
  const cancelled = await prepareLogin("work", { baseDir, mode: "file" });
  assert.equal(cancelled.targetExisted, true);
  assert.deepEqual(snapshot(dir), before, "prepareLogin() does not touch the profile");
  await assert.rejects(collectLogin("work", { prepareCtx: cancelled, fetchFn: offline }), /No OAuth token found/);
  await cleanupLogin(cancelled, { keepTarget: false });
  assert.deepEqual(snapshot(dir), before, "a cancelled login leaves the profile as it was");

  // 2. A successful re-login into another account replaces the account files and keeps settings.json.
  const ctx = await prepareLogin("work", { baseDir, mode: "file" });
  writeAgyLogin(ctx, { access: "new-access" });
  const result = await collectLogin("work", { prepareCtx: ctx, fetchFn: userinfo("new@example.com") });
  assert.equal(result.email, "new@example.com");
  const after = snapshot(dir);
  assert.equal(JSON.parse(after["oauth_creds.json"]).access_token, "new-access");
  assert.equal(JSON.parse(after["google_accounts.json"]).active, "new@example.com");
  assert.equal(after["settings.json"], "{}");
});

test("profile-login: with Google's userinfo unreachable the account agy recorded is used (and checked for duplicates)", async (t) => {
  const baseDir = makeTempDir("agy-login-offline-");
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  seedProfile(baseDir, "a", "a@example.com");

  const dup = await prepareLogin("b", { baseDir, mode: "file" });
  writeAgyLogin(dup, { email: "a@example.com" });
  await assert.rejects(collectLogin("b", { prepareCtx: dup, fetchFn: offline }), /already registered in profile 'a'/);

  const ctx = await prepareLogin("b", { baseDir, mode: "file" });
  writeAgyLogin(ctx, { email: "b@example.com" });
  const result = await collectLogin("b", { prepareCtx: ctx, fetchFn: offline });
  assert.equal(result.email, "b@example.com");
  assert.equal(result.verified, false);

  // No e-mail at all: a previous account's e-mail files must not survive a re-login.
  const again = await prepareLogin("b", { baseDir, mode: "file" });
  writeAgyLogin(again, { access: "third" });
  const unknown = await collectLogin("b", { prepareCtx: again, fetchFn: offline });
  assert.equal(unknown.email, "unknown");
  assert.ok(!fs.existsSync(path.join(baseDir, "profiles", "b", "google_accounts.json")));
});

test("profile-login: agy is spawned by its resolved path, in the login HOME, with file mode and without the bridge's keys", async (t) => {
  const baseDir = makeTempDir("agy-login-spawn-");
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const ctx = await prepareLogin("p", { baseDir, mode: "file" });
  const agyPath = path.join(baseDir, "My Tools", process.platform === "win32" ? "agy.exe" : "agy");

  let seen = null;
  const spawnFn = (file, args, opts) => {
    seen = { file, args, env: opts.env };
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", 0, null));
    return child;
  };
  const saved = { cmd: process.env.ANTIGRAVITY_BRIDGE_CMD, keys: process.env.ANTIGRAVITY_API_KEYS };
  process.env.ANTIGRAVITY_BRIDGE_CMD = `"${agyPath}" --dangerously-skip-permissions -p "{prompt}"`;
  process.env.ANTIGRAVITY_API_KEYS = "hermes:sk-agv-secret";
  try {
    await runInteractiveLogin("p", { prepareCtx: ctx, spawnFn });
  } finally {
    for (const [k, v] of [["ANTIGRAVITY_BRIDGE_CMD", saved.cmd], ["ANTIGRAVITY_API_KEYS", saved.keys]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(seen.file, agyPath, "no literal quotes, spaces kept");
  assert.deepEqual(seen.args, []);
  assert.equal(seen.env.HOME, ctx.loginHome);
  assert.equal(seen.env.USERPROFILE, ctx.loginHome);
  assert.equal(seen.env.SSH_CONNECTION, "127.0.0.1 0 127.0.0.1 22");
  assert.equal(seen.env.ANTIGRAVITY_API_KEYS, undefined);
  await cleanupLogin(ctx);
});

test("profile-login: keyring mode backups and restorations", async (t) => {
  const baseDir = makeTempDir("agy-login-kr-base-");
  const homedir = makeTempDir("agy-login-kr-home-");
  t.after(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(homedir, { recursive: true, force: true });
  });

  const keyring = createKeyring({ storePath: path.join(baseDir, "keyring.json") });
  await keyring.setPassword("gemini", "antigravity", JSON.stringify({ token: { access_token: "old-host-token" } }));
  const geminiDir = path.join(homedir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, "oauth_creds.json"), JSON.stringify({ access_token: "old-file-creds" }));

  const ctx = await prepareLogin("prof_kr", { baseDir, homedir, mode: "keyring", keyring });
  assert.equal(ctx.mode, "keyring");
  assert.equal(await keyring.getPassword("gemini", "antigravity"), null, "the user's token is set aside");
  assert.ok(!fs.existsSync(path.join(geminiDir, "oauth_creds.json")));
  assert.ok(ctx.backups.length > 0);

  // Aborted before the login finished.
  await cleanupLogin(ctx, { keepTarget: false });
  assert.ok(fs.existsSync(path.join(geminiDir, "oauth_creds.json")));
  assert.ok((await keyring.getPassword("gemini", "antigravity")).includes("old-host-token"));
});
