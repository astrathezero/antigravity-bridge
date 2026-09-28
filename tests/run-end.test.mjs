import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeCliCommand } from "../src/core/executor.mjs";

// A run is over once agy has printed its result event or its own process has exited. The bridge used
// to wait for the child's 'close' as well, which also waits for every process holding agy's stdout: a
// helper agy left running kept a finished answer waiting until the stall watchdog failed the run.

const SANDBOX_BASE = process.env.ANTIGRAVITY_SANDBOX_BASE;

// agy stand-in. ANTIGRAVITY_TEST_RUN_END_MODE:
//   normal          result, then exit
//   helper-group    result, start a helper in agy's process group that holds stdout for 30 s, exit
//   helper-detached the same, with the helper in a session of its own (out of reach of a group kill)
//   linger          result, then keep running without a word
//   linger-error    a quota result (status ERROR), then keep running
// Every pid is recorded in pids.marker in the run's HOME so the test can check what is left.
const FAKE_AGY_SRC = [
  'const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process");',
  'const mode = process.env.ANTIGRAVITY_TEST_RUN_END_MODE || "normal";',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'const pids = [process.pid];',
  'const record = () => fs.writeFileSync(path.join(process.env.HOME, "pids.marker"), pids.join(" "));',
  'out({ event: "init", conversation_id: "conv-" + process.pid });',
  'out({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "the answer" } });',
  'if (mode === "linger-error") {',
  '  out({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h2m1s." } });',
  "} else {",
  '  out({ event: "result", result: { status: "SUCCESS", response: "the answer" } });',
  "}",
  'if (mode === "helper-group" || mode === "helper-detached") {',
  '  const h = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"], detached: mode === "helper-detached" });',
  "  h.unref();",
  "  pids.push(h.pid);",
  "  record();",
  "  process.exit(0);",
  '} else if (mode === "linger" || mode === "linger-error") {',
  "  record();",
  "  setInterval(() => {}, 1000);",
  "} else {",
  "  record();",
  "  process.exit(0);",
  "}",
  "",
].join("\n");

function fakeAgyTemplate() {
  fs.mkdirSync(SANDBOX_BASE, { recursive: true });
  const helper = path.join(SANDBOX_BASE, "fake-agy-run-end.cjs");
  fs.writeFileSync(helper, FAKE_AGY_SRC);
  return `node ${helper} {prompt}`;
}

function recordedPids(profile) {
  const f = path.join(SANDBOX_BASE, profile, "pids.marker");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim().split(/\s+/).map(Number) : [];
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    // A zombie answers signal 0; when the runner is PID 1 without an init nobody reaps it.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

async function waitGone(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function run(t, profile, mode, graceMs = "300") {
  fs.rmSync(path.join(SANDBOX_BASE, profile), { recursive: true, force: true });
  const saved = { mode: process.env.ANTIGRAVITY_TEST_RUN_END_MODE, grace: process.env.ANTIGRAVITY_RUN_END_GRACE_MS };
  process.env.ANTIGRAVITY_TEST_RUN_END_MODE = mode;
  process.env.ANTIGRAVITY_RUN_END_GRACE_MS = graceMs;
  t.after(() => {
    for (const pid of recordedPids(profile)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    for (const [k, v] of [["ANTIGRAVITY_TEST_RUN_END_MODE", saved.mode], ["ANTIGRAVITY_RUN_END_GRACE_MS", saved.grace]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const t0 = Date.now();
  // A 30 s stall window and a 40 s timeout: the run must end long before either.
  const result = await executeCliCommand(fakeAgyTemplate(), "hi", { profile, timeout: 40, stallTimeout: 30 }).then(
    (text) => ({ text }),
    (error) => ({ error })
  );
  return { ...result, elapsed: Date.now() - t0 };
}

test("run end: an answer is returned although a helper agy left running still holds its output", async (t) => {
  for (const [profile, mode] of [["zz_re1", "helper-group"], ["zz_re2", "helper-detached"]]) {
    const r = await run(t, profile, mode);
    assert.equal(r.error, undefined, `${mode}: ${r.error?.message}`);
    assert.equal(r.text, "the answer", mode);
    assert.ok(r.elapsed < 5000, `${mode}: returned after ${r.elapsed} ms, not after the stall window`);
  }
  // The helper in agy's process group is ended with it; one in a session of its own is out of reach,
  // but no longer holds up the run.
  const [, groupHelper] = recordedPids("zz_re1");
  assert.ok(groupHelper, "the helper pid was recorded");
  assert.ok(await waitGone(groupHelper), "the helper in agy's process group is ended");
});

test("run end: agy that prints its result and does not exit is ended after the grace period", async (t) => {
  const r = await run(t, "zz_re3", "linger");
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.text, "the answer");
  assert.ok(r.elapsed < 5000, `returned after ${r.elapsed} ms`);
  const [agyPid] = recordedPids("zz_re3");
  assert.ok(await waitGone(agyPid), "the lingering agy process is ended");

  // A failed result is reported as the failure it is (here a quota error the fallback loop classifies),
  // not as a stall.
  const e = await run(t, "zz_re4", "linger-error");
  assert.ok(e.error, "a failed result rejects");
  assert.match(e.error.message, /status=ERROR\): RESOURCE_EXHAUSTED/);
  assert.ok(e.elapsed < 5000, `rejected after ${e.elapsed} ms`);
});

test("run end: a run that exits normally is not held for the grace period", async (t) => {
  const r = await run(t, "zz_re5", "normal", "10000");
  assert.equal(r.text, "the answer");
  assert.ok(r.elapsed < 5000, `returned after ${r.elapsed} ms, without waiting out a 10 s grace`);
});
