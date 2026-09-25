import { TEST_STATE_DIR } from "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fork } from "node:child_process";
import { BridgeSupervisor, maskSecrets } from "../desktop/bridge-supervisor.mjs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+

// The supervisor normally forks Electron utility processes; child_process.fork() with the same small
// surface (postMessage, stdout/stderr, exit, message, kill) runs the real bootstrap + bridge under Node.
const BOOTSTRAP = path.resolve(HERE, "..", "desktop", "bridge-bootstrap.mjs");
const nodeFork = (entry, args, opts) => {
  const child = fork(entry, args, { env: opts.env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.postMessage = (msg) => child.send(msg);
  return child;
};
const KEY = "sk-agv-supervisortest0001";

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

async function makeSupervisor(t, name) {
  const pidFile = path.join(TEST_STATE_DIR, `${name}.pids`);
  const fake = path.join(TEST_STATE_DIR, `${name}-agy.cjs`);
  fs.writeFileSync(fake, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const port = await freePort();
  const sup = new BridgeSupervisor({
    entry: BOOTSTRAP,
    cwd: path.join(TEST_STATE_DIR, `${name}-cwd`),
    port,
    fork: nodeFork,
    getApiKey: () => KEY,
    env: () => ({
      ...process.env,
      ANTIGRAVITY_PORT: String(port),
      ANTIGRAVITY_HOST: "127.0.0.1",
      ANTIGRAVITY_PROFILES: `zz_${name}`,
      ANTIGRAVITY_NO_AUTO_REFRESH: "1",
      ANTIGRAVITY_NO_PROXY: "1",
      ANTIGRAVITY_API_KEYS: `test:${KEY}`,
      ANTIGRAVITY_BRIDGE_CMD: `"${process.execPath}" "${fake}" {prompt}`,
    }),
  });
  t.after(async () => {
    await sup.stop({ force: true });
    clearInterval(sup.healthTimer);
  });
  return { sup, port, pidFile };
}

const healthy = (sup) => waitFor(async () => (await sup.pollHealth(), sup.state === "healthy"));

test("supervisor: restart leaves exactly one bridge, and the old one's exit does not touch the new one", async (t) => {
  const { sup } = await makeSupervisor(t, "sv_restart");
  await sup.start();
  assert.ok(await healthy(sup), sup.getRingLogs().join("\n"));
  const first = sup.child;

  const res = await sup.restart();
  assert.equal(res.restarted, true);
  assert.ok(await healthy(sup));
  const second = sup.child;
  assert.ok(second && second !== first, "a new process serves");
  assert.equal(alive(first.pid), false, "the old process is gone");
  await new Promise((r) => setTimeout(r, 500)); // any late event of the old process has fired by now
  assert.equal(sup.child, second, "still the new process");
  assert.equal(sup.state, "healthy");
});

test("supervisor: stop refuses while a request is in flight unless forced, and forced stop leaves no agy", async (t) => {
  const { sup, port, pidFile } = await makeSupervisor(t, "sv_busy");
  await sup.start();
  assert.ok(await healthy(sup));
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "antigravity", messages: [{ role: "user", content: "hi" }] }),
  }).catch(() => {});
  assert.ok(await waitFor(() => fs.existsSync(pidFile)), "agy started");
  const agyPid = Number(fs.readFileSync(pidFile, "utf-8"));

  const refused = await sup.stop();
  assert.deepEqual(refused, { stopped: false, busy: 1 });
  assert.equal(sup.state, "healthy", "still serving");

  const forced = await sup.stop({ force: true });
  assert.equal(forced.stopped, true);
  assert.equal(forced.clean, true, "exited on the shutdown message, without being terminated");
  assert.ok(await waitFor(() => !alive(agyPid), 5000), "agy was ended with the bridge");
  assert.equal(sup.state, "stopped");
});

test("supervisor: a bridge that dies is restarted after a short backoff", async (t) => {
  const { sup } = await makeSupervisor(t, "sv_crash");
  await sup.start();
  assert.ok(await healthy(sup));
  const first = sup.child;
  first.kill("SIGKILL");
  assert.ok(await waitFor(() => sup.child && sup.child !== first, 5000), "restarted");
  assert.ok(await healthy(sup));
  assert.equal(sup.restartAttempts, 1);
});

test("supervisor: log masking covers keys, tokens split across chunks, and JSON token fields", () => {
  const lines = [];
  const sup = new BridgeSupervisor({ knownSecrets: () => ["custom-key-12345678"] });
  sup.on("log", (l) => lines.push(l));
  const read = sup.lineReader("");
  read(Buffer.from('token {"access_token": "ya29.a0AfH6SMB'));
  read(Buffer.from('xyz", "refresh_token":"1//0gabcdefghijklmnopqrstuv"} key sk-agv-0123abcd custom-key-12345678 Bearer abcdefgh12345\n'));
  assert.equal(lines.length, 1, "one line, although it arrived in two chunks");
  assert.ok(!/ya29\.a0|1\/\/0g|0123abcd|custom-key|abcdefgh12345/.test(lines[0]), lines[0]);
  assert.equal(maskSecrets("nothing secret here"), "nothing secret here");
});
