import { TEST_STATE_DIR } from "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // import.meta.dirname needs Node 20.11+

// The desktop edition runs desktop/bridge-bootstrap.mjs in an Electron utility process. Under Node the
// same file talks over the fork() IPC channel, so its shutdown protocol is tested here without Electron.
const BOOTSTRAP = path.resolve(HERE, "..", "desktop", "bridge-bootstrap.mjs");

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

/** One request on its own connection (no keep-alive socket left to hold the test process open). */
function request(port, method, pathname, body = null) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, agent: false, headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", (err) => resolve(err));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function waitFor(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

test("desktop bootstrap: shutdown ends an agy run in flight (and its child) and exits 0", async (t) => {
  const pidFile = path.join(TEST_STATE_DIR, "bootstrap-agy.pids");
  const fake = path.join(TEST_STATE_DIR, "bootstrap-fake-agy.cjs");
  // An agy that never answers, with a child of its own: what a long request looks like at shutdown.
  fs.writeFileSync(
    fake,
    'const cp = require("node:child_process"); const fs = require("node:fs");' +
      'const g = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + g.pid); setInterval(() => {}, 1000);`
  );
  const port = await freePort();
  const child = fork(BOOTSTRAP, [], {
    env: {
      ...process.env,
      ANTIGRAVITY_PORT: String(port),
      ANTIGRAVITY_HOST: "127.0.0.1",
      ANTIGRAVITY_PROFILES: "zz_boot",
      ANTIGRAVITY_NO_AUTO_REFRESH: "1",
      ANTIGRAVITY_NO_PROXY: "1",
      ANTIGRAVITY_BRIDGE_CMD: `"${process.execPath}" "${fake}" {prompt}`,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const reported = [];
  child.on("message", (m) => m?.type === "children" && reported.push(m.pids));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(() => child.kill("SIGKILL"));

  const up = await waitFor(async () => (await request(port, "GET", "/health")) === 200);
  assert.ok(up, `bridge answered /health\n${output}`);

  const pending = request(port, "POST", "/v1/chat/completions", { model: "antigravity", messages: [{ role: "user", content: "hi" }] });
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf-8").includes(" ")), "agy started");
  const [agyPid, grandchild] = fs.readFileSync(pidFile, "utf-8").split(" ").map(Number);
  assert.ok(await waitFor(() => reported.some((pids) => pids.includes(agyPid))), "the supervisor is told which agy runs");

  const started = Date.now();
  child.send({ type: "shutdown", graceMs: 500 });
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 8000).unref())]);
  assert.equal(code, 0, `bootstrap exit (${Date.now() - started} ms)\n${output}`);
  assert.ok(await waitFor(() => !alive(agyPid) && !alive(grandchild), 5000), "no agy left behind");
  await pending;
});
