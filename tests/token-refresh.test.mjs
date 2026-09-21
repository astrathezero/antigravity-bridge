import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  refreshProfileToken,
  runTokenRefreshCycle,
  getTokenRefreshHome,
  findRefreshedToken,
} from "../src/core/token-daemon.mjs";

const SANDBOX_BASE = process.env.ANTIGRAVITY_SANDBOX_BASE;
const FAKE_HOME = path.join(path.dirname(SANDBOX_BASE), "fake-home");

// agy stand-in. It does what agy does for a refresh: read the token planted under HOME, take the
// refresh_token from it and write back a new access_token. FAKE_AGY_MODE picks the failure to
// reproduce; it records the HOME it was given, and stays alive well past the write so that an early
// exit has to kill it.
const FAKE_AGY_SRC = [
  'const fs = require("node:fs"); const path = require("node:path");',
  'const mode = process.env.FAKE_AGY_MODE || "ok";',
  'const delay = Number(process.env.FAKE_AGY_DELAY_MS || "300");',
  "const home = process.env.HOME;",
  'const tokenFile = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");',
  "let planted = null;",
  'try { planted = JSON.parse(fs.readFileSync(tokenFile, "utf-8")); } catch {}',
  'fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ home, pid: process.pid, mode, planted: planted && planted.token }) + "\\n");',
  'if (mode !== "never") {',
  "  setTimeout(() => {",
  '    const rt = mode === "wrong-account" ? "refresh-token-of-another-account" : (planted && planted.token && planted.token.refresh_token) || "";',
  '    const payload = { token: { access_token: "fresh-access-for-" + path.basename(home), refresh_token: rt, token_type: "Bearer", expiry: "2026-12-31T00:00:00Z" }, auth_method: "consumer" };',
  "    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });",
  "    fs.writeFileSync(tokenFile, JSON.stringify(payload));",
  "  }, delay);",
  "}",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

function setup(profiles, { mode = "ok", delayMs = 300 } = {}) {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(SANDBOX_BASE), ".token-refresh"), { recursive: true, force: true });
  const exe = path.join(path.dirname(SANDBOX_BASE), "fake-agy-refresh");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "#!/usr/bin/env node\n" + FAKE_AGY_SRC, { mode: 0o755 });
  const log = path.join(path.dirname(SANDBOX_BASE), "fake-agy-runs.jsonl");
  fs.writeFileSync(log, "");
  for (const p of profiles) {
    const dir = path.join(FAKE_HOME, ".config", "antigravity", "profiles", p);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "oauth_creds.json"),
      JSON.stringify({
        token: { access_token: `stale-access-${p}`, refresh_token: `refresh-token-${p}`, token_type: "Bearer", expiry: "2020-01-01T00:00:00Z" },
        auth_method: "consumer",
      })
    );
    fs.writeFileSync(path.join(dir, "google_accounts.json"), JSON.stringify({ active: `${p}@example.com` }));
  }
  return { exe, log, env: { HOME: FAKE_HOME, FAKE_AGY_MODE: mode, FAKE_AGY_DELAY_MS: String(delayMs), FAKE_AGY_LOG: log } };
}

function profileToken(p) {
  const f = path.join(FAKE_HOME, ".config", "antigravity", "profiles", p, "oauth_creds.json");
  const d = JSON.parse(fs.readFileSync(f, "utf-8"));
  return d.token;
}

function fakeRuns(log) {
  return fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Counts event-loop ticks while fn runs: 0 would mean the loop was blocked. */
async function countingTicks(fn) {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 20);
  try {
    const result = await fn();
    return { result, ticks };
  } finally {
    clearInterval(timer);
  }
}

test("token refresh: the run is isolated in its own HOME, the new token is stored, and agy is killed once it appears", async (t) => {
  if (os.platform() === "win32") return t.skip("POSIX HOME semantics");
  const { exe, log, env } = setup(["zz_tr2"], { delayMs: 300 });
  await withEnv(env, async () => {
    const t0 = Date.now();
    const { result, ticks } = await countingTicks(() => refreshProfileToken("zz_tr2", { agyExec: exe, timeoutMs: 15000, osType: "linux" }));
    const [ok, msg] = result;
    const elapsed = Date.now() - t0;
    assert.equal(ok, true, msg);
    assert.match(msg, /expires 2026-12-31/);
    assert.ok(ticks > 5, `event loop stayed free (${ticks} ticks)`);
    assert.ok(elapsed < 5000, `ended on the token, not on the timeout (${elapsed}ms)`);

    const runs = fakeRuns(log);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].home, getTokenRefreshHome("zz_tr2"), "agy ran in this profile's own refresh HOME");
    assert.notEqual(runs[0].home, FAKE_HOME, "never the real HOME shared by all profiles and both editions");
    assert.equal(runs[0].planted.refresh_token, "refresh-token-zz_tr2", "its own refresh token was planted");
    assert.equal(runs[0].planted.access_token, "", "with the access token cleared, so agy must exchange it");

    const after = profileToken("zz_tr2");
    assert.equal(after.access_token, `fresh-access-for-${path.basename(getTokenRefreshHome("zz_tr2"))}`);
    assert.equal(after.refresh_token, "refresh-token-zz_tr2", "the refresh token is untouched");
    assert.equal(after.expiry, "2026-12-31T00:00:00Z");

    // The stand-in holds itself open with an interval; the early exit must have killed it.
    await new Promise((r) => setTimeout(r, 200));
    let alive = true;
    try {
      process.kill(runs[0].pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(runs[0].pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    assert.equal(alive, false, "agy was killed once the token appeared");
  });
});

test("token refresh: a run that never produces a token times out and leaves the profile's token alone", async (t) => {
  if (os.platform() === "win32") return t.skip("POSIX HOME semantics");
  const { exe, env } = setup(["zz_tr3"], { mode: "never" });
  await withEnv(env, async () => {
    const t0 = Date.now();
    const { result, ticks } = await countingTicks(() => refreshProfileToken("zz_tr3", { agyExec: exe, timeoutMs: 1200, osType: "linux" }));
    const [ok, msg] = result;
    const elapsed = Date.now() - t0;
    assert.equal(ok, false);
    assert.match(msg, /no refreshed token within 1s/);
    assert.ok(elapsed >= 1200 && elapsed < 6000, `gave up at the ceiling (${elapsed}ms)`);
    assert.ok(ticks > 20, `event loop stayed free while waiting (${ticks} ticks)`);
    assert.equal(profileToken("zz_tr3").access_token, "stale-access-zz_tr3", "no foreign token was written in");
  });
});

test("token refresh: a token carrying another account's refresh token is never accepted", async (t) => {
  if (os.platform() === "win32") return t.skip("POSIX HOME semantics");
  const { exe, env } = setup(["zz_tr4"], { mode: "wrong-account", delayMs: 200 });
  await withEnv(env, async () => {
    const [ok, msg] = await refreshProfileToken("zz_tr4", { agyExec: exe, timeoutMs: 1200, osType: "linux" });
    assert.equal(ok, false, msg);
    assert.equal(profileToken("zz_tr4").access_token, "stale-access-zz_tr4", "the other account's token was rejected");
  });
  // The guard itself, directly.
  const home = getTokenRefreshHome("zz_tr4");
  assert.equal(findRefreshedToken(home, "refresh-token-zz_tr4"), null);
  const dir = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "a", refresh_token: "refresh-token-zz_tr4", expiry: "x" } }));
  assert.deepEqual(findRefreshedToken(home, "refresh-token-zz_tr4"), { accessToken: "a", refreshToken: "refresh-token-zz_tr4", expiry: "x" });
});

test("token refresh: a whole cycle refreshes every profile in its own HOME and keeps serving the event loop", async (t) => {
  if (os.platform() === "win32") return t.skip("POSIX HOME semantics");
  const profiles = ["zz_c1", "zz_c2", "zz_c3"];
  const { exe, log, env } = setup(profiles, { delayMs: 200 });
  await withEnv({ ...env, ANTIGRAVITY_BRIDGE_CMD: exe }, async () => {
    const { result: successCount, ticks } = await countingTicks(() => runTokenRefreshCycle(profiles, { timeoutMs: 8000, agyExec: exe, osType: "linux" }));
    assert.equal(successCount, 3);
    assert.ok(ticks > 15, `event loop stayed free for the whole cycle (${ticks} ticks)`);
    const homes = fakeRuns(log).map((r) => r.home);
    assert.equal(new Set(homes).size, 3, "one HOME per profile, never shared");
    for (const p of profiles) {
      assert.ok(homes.includes(getTokenRefreshHome(p)), `${p} ran in its own HOME`);
      assert.equal(profileToken(p).refresh_token, `refresh-token-${p}`);
      assert.match(profileToken(p).access_token, /^fresh-access-for-/);
    }
  });
});
