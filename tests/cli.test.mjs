import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loginProfile, removeProfileDir, checkProfileToken, agyBinaryFromTemplate } from "../src/cli/profile-tools.mjs";

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");

/** A throwaway HOME (both HOME and USERPROFILE, so os.homedir() follows on every OS). */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agv-cli-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));

test("cli: login stores the token agy wrote plus the verified email, and puts ~/.gemini back", async () => {
  await withHome(async (home) => {
    const gemini = path.join(home, ".gemini");
    fs.mkdirSync(gemini, { recursive: true });
    fs.writeFileSync(path.join(gemini, "oauth_creds.json"), '{"access_token":"the-machine-login"}');
    const profileDir = path.join(home, ".config", "antigravity", "profiles", "zz_new");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "oauth_creds.json"), '{"access_token":"stale"}');

    let sawMachineLogin = null;
    const res = await loginProfile("zz_new", {
      runAgy: (name) => {
        assert.equal(name, "zz_new");
        // agy must not find the machine's own login, or it skips the browser OAuth.
        sawMachineLogin = fs.existsSync(path.join(gemini, "oauth_creds.json"));
        fs.writeFileSync(
          path.join(gemini, "oauth_creds.json"),
          JSON.stringify({ access_token: "ya29.new", refresh_token: "1//refresh", expiry: "2026-10-01T00:00:00Z" })
        );
        return 0;
      },
      extractKeyring: () => null,
      lookupEmail: async (tok) => (tok === "ya29.new" ? "new@example.com" : null),
      log: () => {},
    });

    assert.equal(sawMachineLogin, false);
    assert.deepEqual(res, { ok: true, email: "new@example.com", targetDir: profileDir });
    const creds = readJson(path.join(profileDir, "oauth_creds.json"));
    assert.equal(creds.access_token, "ya29.new");
    assert.equal(creds.token.refresh_token, "1//refresh");
    assert.equal(creds.token.expiry, "2026-10-01T00:00:00Z");
    assert.equal(readJson(path.join(profileDir, "antigravity-oauth-token")).token.access_token, "ya29.new");
    assert.equal(readJson(path.join(profileDir, "google_accounts.json")).active, "new@example.com");
    assert.equal(readJson(path.join(gemini, "oauth_creds.json")).access_token, "the-machine-login", "restored");
    assert.deepEqual(fs.readdirSync(gemini).filter((f) => f.endsWith(".bak")), []);
  });
});

test("cli: a login agy did not complete reports failure and still restores ~/.gemini", async () => {
  await withHome(async (home) => {
    const gemini = path.join(home, ".gemini");
    fs.mkdirSync(gemini, { recursive: true });
    fs.writeFileSync(path.join(gemini, "google_accounts.json"), '{"active":"machine@example.com"}');
    const res = await loginProfile("zz_quit", {
      runAgy: () => 1,
      extractKeyring: () => null,
      lookupEmail: async () => assert.fail("no token, no lookup"),
      log: () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(readJson(path.join(gemini, "google_accounts.json")).active, "machine@example.com");
  });
});

test("cli: login and remove refuse profile names that could leave the profiles directory", async () => {
  await withHome(async () => {
    await assert.rejects(loginProfile("../escape", { runAgy: () => 0, log: () => {} }), /Invalid profile name/);
    assert.throws(() => removeProfileDir("../.."), /Invalid profile name/);
    assert.throws(() => removeProfileDir(""), /profile name/);
  });
});

test("cli: doctor tells a live token, an expired one with a refresh token, and a broken one apart", async () => {
  await withHome(async (home) => {
    const base = path.join(home, ".config", "antigravity", "profiles");
    const write = (p, data) => {
      fs.mkdirSync(path.join(base, p), { recursive: true });
      fs.writeFileSync(path.join(base, p, "oauth_creds.json"), JSON.stringify(data));
    };
    write("zz_live", { access_token: "live" });
    write("zz_old", { access_token: "old", refresh_token: "r" });
    write("zz_dead", { token: { access_token: "old" } });
    write("zz_empty", {});
    const lookup = async (tok) => (tok === "live" ? { status: 200, email: "live@example.com" } : { status: 401, email: null });

    assert.match((await checkProfileToken("zz_live", lookup)).line, /ACTIVE & VALID.*live@example\.com/);
    assert.equal((await checkProfileToken("zz_old", lookup)).level, "warn");
    assert.match((await checkProfileToken("zz_dead", lookup)).line, /expired \(401\) and refresh_token is missing/);
    assert.match((await checkProfileToken("zz_empty", lookup)).line, /tokens are empty/);
    assert.match((await checkProfileToken("zz_none", lookup)).line, /oauth_creds\.json missing/);
  });
});

test("cli: the agy binary is taken from the detected command template", () => {
  assert.equal(agyBinaryFromTemplate('"/home/u/.local/bin/agy" --dangerously-skip-permissions -p "{prompt}"'), "/home/u/.local/bin/agy");
  assert.equal(agyBinaryFromTemplate('agy -p "{prompt}"'), "agy");
});

/** Runs `node src/index.mjs ...args` in its own HOME and working directory. */
function runCli(args, { home, env = {} }) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    // Unset, not empty: a variable that is already set (even to "") wins over the .env file.
    for (const k of ["ANTIGRAVITY_API_KEYS", "ANTIGRAVITY_API_KEY", "ANTIGRAVITY_PORT", "PORT"]) delete childEnv[k];
    const child = spawn(process.execPath, [INDEX, ...args], { cwd: home, env: childEnv });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("cli: key add / test / revoke work without Python, and bad labels never reach .env", async () => {
  await withHome(async (home) => {
    const server = http.createServer((req, res) => {
      const ok = req.headers.authorization === "Bearer sk-agv-good-key-123";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { data: [{ id: "m1" }, { id: "m2" }] } : { error: "unauthorized" }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = String(server.address().port);
    try {
      let r = await runCli(["key", "add", "agent-one", "sk-agv-good-key-123"], { home });
      assert.equal(r.code, 0, r.out);
      assert.match(fs.readFileSync(path.join(home, ".env"), "utf-8"), /ANTIGRAVITY_API_KEYS="agent-one:sk-agv-good-key-123"/);

      r = await runCli(["key", "add", "bad:label", "sk-agv-other-key-456"], { home });
      assert.equal(r.code, 1);
      assert.doesNotMatch(fs.readFileSync(path.join(home, ".env"), "utf-8"), /bad/);

      r = await runCli(["key", "test", "sk-agv-good-key-123", "--port", port], { home });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /accepted.*2 models/);
      r = await runCli(["key", "test", "sk-agv-wrong-key-789", "--port", port], { home });
      assert.equal(r.code, 1);
      assert.match(r.out, /401/);

      r = await runCli(["manage-keys"], { home });
      assert.match(r.out, /agent-one/, "the manage_keys.py shortcut lists the keys");

      r = await runCli(["key", "revoke", "agent-one"], { home });
      assert.equal(r.code, 0, r.out);
      r = await runCli(["key", "revoke", "agent-one"], { home });
      assert.equal(r.code, 1, "nothing left to revoke");
    } finally {
      server.close();
    }
  });
});

test("cli: the Python CLI's shortcuts work without the profile prefix; unknown commands fail", async () => {
  await withHome(async (home) => {
    const dir = path.join(home, ".config", "antigravity", "profiles", "zz_gone");
    fs.mkdirSync(dir, { recursive: true });
    const env = { ANTIGRAVITY_BRIDGE_CONFIG: path.join(home, "bridge_config.json"), ANTIGRAVITY_QUOTA_CACHE_FILE: path.join(home, "qc.json") };

    let r = await runCli(["profiles"], { home, env });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /zz_gone/);

    r = await runCli(["remove", "zz_gone"], { home, env });
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.existsSync(dir), false);

    r = await runCli(["profile", "no-such-command"], { home, env });
    assert.equal(r.code, 1);
    assert.match(r.out, /Unknown profile command/);

    r = await runCli(["profile", "copy", "zz_gone", "-oProxyCommand=evil"], { home, env });
    assert.equal(r.code, 1);
    assert.match(r.out, /Invalid remote/);
  });
});
