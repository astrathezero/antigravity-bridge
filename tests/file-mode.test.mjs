import { TEST_HOME, TEST_STATE_DIR } from "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeCliCommand } from "../src/core/executor.mjs";

// agy stand-in. It records when it ran and the access token the bridge planted in its HOME (the
// sandbox), then, like agy after refreshing an expired token, rewrites that token file. How it rewrites
// is picked per profile through ANTIGRAVITY_TEST_FM_MODE (only ANTIGRAVITY_* reaches agy's environment).
const FAKE_AGY_SRC = [
  'const fs = require("node:fs"); const path = require("node:path");',
  "const profile = process.env.ANTIGRAVITY_PROFILE;",
  'const modes = JSON.parse(process.env.ANTIGRAVITY_TEST_FM_MODE || "{}");',
  'const mode = modes[profile] || "none";',
  'const file = path.join(process.env.HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token");',
  'const planted = JSON.parse(fs.readFileSync(file, "utf-8"));',
  "const start = Date.now();",
  "setTimeout(() => {",
  "  const t = planted.token;",
  '  if (mode === "refresh") Object.assign(t, { access_token: "NEW-" + profile, expiry: "2030-01-01T00:00:00.123456789Z" });',
  '  if (mode === "other") Object.assign(t, { access_token: "FOREIGN", refresh_token: "someone-else", expiry: "2030-01-01T00:00:00Z" });',
  '  if (mode === "older") Object.assign(t, { access_token: "STALE-" + profile, expiry: "2020-01-01T00:00:00Z" });',
  '  if (mode !== "none") fs.writeFileSync(file, JSON.stringify({ ...planted, token: t, id_token: "ID-" + profile }));',
  "  fs.appendFileSync(process.env.ANTIGRAVITY_TEST_FM_LOG, JSON.stringify({ profile, start, end: Date.now(), planted: planted.token.access_token, ssh: process.env.SSH_CONNECTION || null }) + \"\\n\");",
  '  process.stdout.write("ok\\n");',
  "}, Number(process.env.ANTIGRAVITY_TEST_FM_DELAY_MS || \"50\"));",
].join("\n");

const FAKE = path.join(TEST_STATE_DIR, "fake-agy-file-mode.cjs");
fs.writeFileSync(FAKE, FAKE_AGY_SRC);
const TEMPLATE = `"${process.execPath}" "${FAKE}" {prompt}`;
const LOG = path.join(TEST_STATE_DIR, "fake-agy-file-mode.log");

function profileDir(p) {
  return path.join(TEST_HOME, ".config", "antigravity", "profiles", p);
}

function seedProfile(p) {
  const dir = profileDir(p);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const token = { access_token: `OLD-${p}`, refresh_token: `R-${p}`, token_type: "Bearer", expiry: "2026-01-01T00:00:00Z" };
  fs.writeFileSync(path.join(dir, "oauth_creds.json"), JSON.stringify({ ...token, expiry_date: Date.parse(token.expiry), token, auth_method: "consumer" }));
  return dir;
}

function readCreds(p) {
  return JSON.parse(fs.readFileSync(path.join(profileDir(p), "oauth_creds.json"), "utf-8"));
}

function runs() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const BASE_ENV = {
  ANTIGRAVITY_TEST_FM_LOG: LOG,
  ANTIGRAVITY_NO_PROXY: "1",
  ANTIGRAVITY_AGY_TOKEN_MODE: undefined,
  ANTIGRAVITY_KEYRING_SERIALIZE: undefined,
};

test("file mode: agy gets SSH_CONNECTION, and runs of two profiles overlap (no machine-wide mutex on macOS/Windows)", async () => {
  fs.rmSync(LOG, { force: true });
  seedProfile("zz_fm_a");
  seedProfile("zz_fm_b");
  await withEnv({ ...BASE_ENV, ANTIGRAVITY_TEST_FM_DELAY_MS: "700" }, () =>
    Promise.all([
      executeCliCommand(TEMPLATE, "hi", { profile: "zz_fm_a", timeout: 30 }),
      executeCliCommand(TEMPLATE, "hi", { profile: "zz_fm_b", timeout: 30 }),
    ])
  );
  const [a, b] = ["zz_fm_a", "zz_fm_b"].map((p) => runs().find((r) => r.profile === p));
  assert.ok(a && b, "both runs happened");
  assert.equal(a.ssh, "127.0.0.1 0 127.0.0.1 22", "file mode is signalled to agy");
  assert.ok(a.start < b.end && b.start < a.end, `runs overlap (a ${a.start}-${a.end}, b ${b.start}-${b.end})`);
});

test("file mode: the token agy refreshed during a run is kept in the profile and planted in the next run", async () => {
  fs.rmSync(LOG, { force: true });
  seedProfile("zz_fm_keep");
  await withEnv({ ...BASE_ENV, ANTIGRAVITY_TEST_FM_MODE: JSON.stringify({ zz_fm_keep: "refresh" }) }, () =>
    executeCliCommand(TEMPLATE, "hi", { profile: "zz_fm_keep", timeout: 30 })
  );
  const creds = readCreds("zz_fm_keep");
  assert.equal(creds.access_token, "NEW-zz_fm_keep");
  assert.equal(creds.token.access_token, "NEW-zz_fm_keep");
  assert.equal(creds.token.expiry, "2030-01-01T00:00:00.123456789Z");
  assert.equal(creds.expiry_date, Date.parse("2030-01-01T00:00:00.123Z"));
  assert.equal(creds.refresh_token, "R-zz_fm_keep", "the refresh token is the profile's own");
  const tokenFile = JSON.parse(fs.readFileSync(path.join(profileDir("zz_fm_keep"), "antigravity-oauth-token"), "utf-8"));
  assert.equal(tokenFile.token.access_token, "NEW-zz_fm_keep");
  assert.equal(tokenFile.id_token, "ID-zz_fm_keep");

  // Next run: the sandbox is planted with the kept token, and a run that leaves it alone rewrites nothing.
  const stamp = fs.statSync(path.join(profileDir("zz_fm_keep"), "oauth_creds.json")).mtimeMs;
  await withEnv({ ...BASE_ENV, ANTIGRAVITY_TEST_FM_MODE: "{}" }, () =>
    executeCliCommand(TEMPLATE, "hi", { profile: "zz_fm_keep", timeout: 30 })
  );
  assert.equal(runs().at(-1).planted, "NEW-zz_fm_keep", "the next run starts from the refreshed token");
  assert.equal(fs.statSync(path.join(profileDir("zz_fm_keep"), "oauth_creds.json")).mtimeMs, stamp, "profile untouched");
});

test("file mode: a token with another account's refresh_token, or an older expiry, never replaces the profile's", async () => {
  seedProfile("zz_fm_other");
  seedProfile("zz_fm_older");
  const before = { other: readCreds("zz_fm_other"), older: readCreds("zz_fm_older") };
  await withEnv({ ...BASE_ENV, ANTIGRAVITY_TEST_FM_MODE: JSON.stringify({ zz_fm_other: "other", zz_fm_older: "older" }) }, () =>
    Promise.all([
      executeCliCommand(TEMPLATE, "hi", { profile: "zz_fm_other", timeout: 30 }),
      executeCliCommand(TEMPLATE, "hi", { profile: "zz_fm_older", timeout: 30 }),
    ])
  );
  assert.deepEqual(readCreds("zz_fm_other"), before.other);
  assert.deepEqual(readCreds("zz_fm_older"), before.older);
});

test("keyring mode (macOS/Windows default, forced here on any OS) still runs one agy at a time", async () => {
  fs.rmSync(LOG, { force: true });
  seedProfile("zz_kr_a");
  seedProfile("zz_kr_b");
  await withEnv(
    {
      ...BASE_ENV,
      ANTIGRAVITY_AGY_TOKEN_MODE: "keyring",
      ANTIGRAVITY_KEYRING_SERIALIZE: "1",
      // Never the real Keychain / Credential Manager / Secret Service.
      ANTIGRAVITY_KEYRING_BACKEND: `file:${path.join(TEST_STATE_DIR, "keyring.json")}`,
      ANTIGRAVITY_TEST_FM_DELAY_MS: "300",
    },
    () =>
      Promise.all([
        executeCliCommand(TEMPLATE, "hi", { profile: "zz_kr_a", timeout: 30 }),
        executeCliCommand(TEMPLATE, "hi", { profile: "zz_kr_b", timeout: 30 }),
      ])
  );
  const [a, b] = ["zz_kr_a", "zz_kr_b"].map((p) => runs().find((r) => r.profile === p));
  assert.ok(a && b, "both runs happened");
  assert.equal(a.ssh, null, "keyring mode does not signal file mode");
  assert.ok(a.end <= b.start || b.end <= a.start, "keyring-mode runs never overlap");
});
