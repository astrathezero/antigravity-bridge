import { TEST_STATE_DIR } from "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  setDesktopHost,
  registerChild,
  unregisterChild,
  getChildPids,
  registerServer,
  shutdown,
  isShuttingDown,
} from "../src/core/host.mjs";
import { executeCliCommand } from "../src/core/executor.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

/** An agy stand-in the way the executor starts one (detached on POSIX), with a grandchild of its own. */
async function spawnFakeAgyTree(name) {
  const pidFile = path.join(TEST_STATE_DIR, `${name}.pids`);
  const src =
    'const cp = require("node:child_process"); const fs = require("node:fs");' +
    'const g = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
    "fs.writeFileSync(process.argv[1], process.pid + ' ' + g.pid); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", src, pidFile], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf-8").includes(" ")));
  const [pid, grandchild] = fs.readFileSync(pidFile, "utf-8").split(" ").map(Number);
  return { child, pid, grandchild };
}

test("host: child registration and pid tracking", () => {
  const reported = [];
  setDesktopHost({ onChildrenChanged: (pids) => reported.push(pids) });
  const fakeProc1 = { pid: 10001 };
  const fakeProc2 = { pid: 10002 };

  registerChild(fakeProc1);
  registerChild(fakeProc2);
  assert.deepEqual(getChildPids().sort(), [10001, 10002]);

  unregisterChild(fakeProc1);
  assert.deepEqual(getChildPids(), [10002]);
  unregisterChild(fakeProc1); // idempotent: the executor and the close event both unregister
  unregisterChild(fakeProc2);
  assert.equal(getChildPids().length, 0);
  assert.deepEqual(reported.at(-1), [], "the host hears about every change");
});

test("host: shutdown kills agy trees first and does not wait for the requests they serve", async () => {
  const tree = await spawnFakeAgyTree("shutdown-tree");
  registerChild(tree.child);
  let shutdownHookRan = false;
  setDesktopHost({ onShutdown: () => (shutdownHookRan = true) });

  // A request that only ends when its agy run does (like a long chat completion).
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  registerServer(server);
  const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/v1/chat/completions" });
  req.on("error", () => {});
  await new Promise((r) => server.once("request", r)); // in flight, not an idle keep-alive socket

  const started = Date.now();
  await shutdown({ graceMs: 500 });
  const took = Date.now() - started;
  assert.ok(shutdownHookRan);
  assert.ok(took < 3000, `shutdown returned in ${took} ms instead of waiting for the request`);
  assert.ok(await waitFor(() => !alive(tree.pid) && !alive(tree.grandchild)), "agy and its child are gone");
  assert.equal(isShuttingDown(), true);
});

test("host: once shutting down, new agy runs are refused and a late spawn is killed at once", async () => {
  await assert.rejects(
    executeCliCommand(`"${process.execPath}" -e "setTimeout(() => {}, 30000)" {prompt}`, "hi", { profile: "zz_sd", timeout: 20 }),
    /shutting down/
  );
  const late = await spawnFakeAgyTree("late-tree");
  registerChild(late.child);
  assert.equal(getChildPids().length, 0);
  assert.ok(await waitFor(() => !alive(late.pid) && !alive(late.grandchild)));
});
