import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AgyStreamParser,
  executeCliWithFallback,
  readLatestAgyRunError,
  agyRunTranscriptPath,
} from "../src/core/executor.mjs";
import { ProfileManager, isHardQuotaError } from "../src/core/profile-manager.mjs";

// Exactly what agy wrote to the run transcript on n8n.mrserm.com, 2026-09-20 16:48, for a profile
// whose quota was used up (agy then retried it 8 times over ~2.5 minutes).
const QUOTA_429 =
  "API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h2m1s.";
const BUSY_503 = "API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";

const SANDBOX_BASE = process.env.ANTIGRAVITY_SANDBOX_BASE;

// agy stand-in. It writes the run's transcript the way agy does (the prompt as a huge first line,
// then one ERROR_MESSAGE line per failed API call) and puts only bare error_message steps on stdout.
// The profile named by ANTIGRAVITY_TEST_FAILING_PROFILE keeps retrying every ANTIGRAVITY_TEST_RETRY_MS
// (4 attempts, then a result with status ERROR); every other profile answers "fine" at once.
// ANTIGRAVITY_TEST_FIRST_ERROR_TEXT gives attempt 1 a different error from the later attempts.
// ANTIGRAVITY_TEST_TRANSCRIPT_LAG_MS > 0 reproduces the production ordering the bridge defends against:
// the stdout step lands first (for attempt 1 even before the init event), the transcript line later.
// It also spawns a grandchild, records both pids in pids.marker, and leaves finished.marker when it
// reaches its natural end, so a test can tell "killed with its process group" from "ran out".
const FAKE_AGY_SRC = [
  'const fs = require("node:fs"); const path = require("node:path"); const cp = require("node:child_process");',
  'const conv = "conv-" + process.pid;',
  "const failing = path.basename(process.env.HOME) === process.env.ANTIGRAVITY_TEST_FAILING_PROFILE;",
  'const errText = process.env.ANTIGRAVITY_TEST_ERROR_TEXT || "";',
  "const firstErrText = process.env.ANTIGRAVITY_TEST_FIRST_ERROR_TEXT || errText;",
  'const retryMs = Number(process.env.ANTIGRAVITY_TEST_RETRY_MS || "8000");',
  'const lagMs = Number(process.env.ANTIGRAVITY_TEST_TRANSCRIPT_LAG_MS || "0");',
  'const logs = path.join(process.env.HOME, ".gemini", "antigravity-cli", "brain", conv, ".system_generated", "logs");',
  "fs.mkdirSync(logs, { recursive: true });",
  'const transcript = path.join(logs, "transcript.jsonl");',
  'const line = (o) => JSON.stringify(o) + "\\n";',
  "const out = (o) => process.stdout.write(line(o));",
  'fs.writeFileSync(transcript, line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "x".repeat(200000) }));',
  'const grandchild = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'fs.writeFileSync(path.join(logs, "pids.marker"), process.pid + " " + grandchild.pid);',
  'const finish = () => { fs.writeFileSync(path.join(logs, "finished.marker"), "1"); grandchild.kill("SIGKILL"); };',
  'const initEvent = { event: "init", conversation_id: conv, init: { cwd: process.env.HOME, tools: [] } };',
  "if (!failing) {",
  "  out(initEvent);",
  '  out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "fine" } });',
  '  out({ event: "result", result: { conversation_id: conv, status: "SUCCESS", response: "fine" } });',
  "  finish();",
  "} else {",
  "  let n = 0;",
  "  const attempt = () => {",
  "    n++;",
  '    const text = (n === 1 ? firstErrText : errText).replace("attempt 1", "attempt " + n);',
  '    const record = () => fs.appendFileSync(transcript, line({ step_index: n, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", error: text }));',
  '    const step = () => out({ event: "step_update", step_update: { conversation_id: conv, step_index: n, state: "DONE", step_type: "error_message", duration_seconds: 0 } });',
  "    if (lagMs > 0) {",
  "      step();",
  "      if (n === 1) out(initEvent);",
  "      setTimeout(record, lagMs);",
  "    } else {",
  "      if (n === 1) out(initEvent);",
  "      record();",
  "      step();",
  "    }",
  "    if (n >= 4) {",
  '      setTimeout(() => { out({ event: "result", result: { conversation_id: conv, status: "ERROR", response: "", error: text } }); finish(); }, lagMs);',
  "      return;",
  "    }",
  "    setTimeout(attempt, retryMs);",
  "  };",
  "  attempt();",
  "}",
  "",
].join("\n");

function fakeAgyTemplate() {
  fs.mkdirSync(SANDBOX_BASE, { recursive: true });
  const helper = path.join(SANDBOX_BASE, "fake-agy-quota.cjs");
  fs.writeFileSync(helper, FAKE_AGY_SRC);
  return `node ${helper} {prompt}`;
}

function freshProfiles(...profiles) {
  for (const p of profiles) fs.rmSync(path.join(SANDBOX_BASE, p), { recursive: true, force: true });
}

function runDirs(profile) {
  const dir = path.join(SANDBOX_BASE, profile, ".gemini", "antigravity-cli", "brain");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((conv) => path.join(dir, conv, ".system_generated", "logs"));
}

function runFinishedNaturally(profile) {
  return runDirs(profile).some((d) => fs.existsSync(path.join(d, "finished.marker")));
}

function runPids(profile) {
  return runDirs(profile).flatMap((d) => {
    const f = path.join(d, "pids.marker");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim().split(/\s+/).map(Number) : [];
  });
}

function transcriptAttempts(profile) {
  return runDirs(profile).flatMap((d) => {
    const f = path.join(d, "transcript.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf-8").split("\n").filter((l) => l.includes('"ERROR_MESSAGE"')).length;
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    // A zombie answers signal 0; when the runner is PID 1 without an init nobody reaps the orphaned grandchild.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Registered first in every test that expects a kill: whatever an earlier assertion does, nothing is left running. */
function killLeftovers(t, profile) {
  t.after(() => {
    for (const pid of runPids(profile)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  });
}

/** Captures [FALLBACK] / [QUOTA] lines while fn runs. */
async function captureWarnings(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => {
    lines.push(args.join(" "));
    orig(...args);
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return lines;
}

// SIGKILL is asynchronous and a killed child is briefly a zombie; poll a little.
async function assertProcessGroupGone(pids, what) {
  const deadline = Date.now() + 3000;
  let remaining = pids;
  while (Date.now() < deadline) {
    remaining = pids.filter(alive);
    if (remaining.length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone after all
    }
  }
  assert.fail(`${what}: pids still alive ${remaining.join(", ")} of ${pids.join(", ")}`);
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

const FAKE_ENV_OFF = {
  ANTIGRAVITY_QUOTA_FAST_FAIL: undefined,
  ANTIGRAVITY_PROFILE_SELECTION: "ordered",
  ANTIGRAVITY_PROFILE: undefined,
  ANTIGRAVITY_TEST_FIRST_ERROR_TEXT: undefined,
  ANTIGRAVITY_TEST_TRANSCRIPT_LAG_MS: undefined,
};

test("stream-json: error_message steps surface as api_error items and the conversation id is captured", () => {
  const p = new AgyStreamParser();
  const items = [];
  items.push(...p.feed('{"event":"init","conversation_id":"9787fbab-911a-451d-a4a5-8f30d0c76eaf","init":{"cwd":"/x","tools":[]}}\n'));
  items.push(...p.feed('{"event":"step_update","step_update":{"conversation_id":"9787fbab-911a-451d-a4a5-8f30d0c76eaf","step_index":0,"state":"DONE","step_type":"user_input"}}\n'));
  items.push(...p.feed('{"event":"step_update","step_update":{"conversation_id":"9787fbab-911a-451d-a4a5-8f30d0c76eaf","step_index":1,"state":"DONE","step_type":"error_message","duration_seconds":0}}\n'));
  items.push(...p.feed('{"event":"step_update","step_update":{"conversation_id":"9787fbab-911a-451d-a4a5-8f30d0c76eaf","step_index":2,"state":"DONE","step_type":"error_message","duration_seconds":0}}\n'));
  assert.equal(p.conversationId, "9787fbab-911a-451d-a4a5-8f30d0c76eaf");
  assert.deepEqual(items.filter((i) => i.kind === "api_error").map((i) => i.index), [1, 2]);
  assert.equal(p.errorSteps, 2);
  assert.equal(items.some((i) => i.kind === "raw" || i.kind === "delta"), false, "no text reaches the client");
  assert.equal(p.isFailure(), false, "not a failure until agy says so");
  // The id is also taken from a step event when it arrives before init.
  const q = new AgyStreamParser();
  q.feed('{"event":"step_update","step_update":{"conversation_id":"conv-early","step_index":1,"state":"DONE","step_type":"error_message"}}\n');
  assert.equal(q.conversationId, "conv-early");
});

test("quota: isHardQuotaError tells a used-up quota from errors a retry can get past", () => {
  assert.equal(isHardQuotaError(QUOTA_429), true);
  assert.equal(isHardQuotaError("CLI Execution Error (profile=astraleno, status=ERROR): " + QUOTA_429), true);
  assert.equal(isHardQuotaError("Rate limit exceeded. Resets in 74h 7m 25s."), true, "a named reset time is a hard quota");
  assert.equal(isHardQuotaError("You exceeded your current quota, please check your plan and billing details."), true);
  assert.equal(isHardQuotaError(BUSY_503), false, "a busy model is agy's retry to make");
  assert.equal(isHardQuotaError("HTTP 429 Too Many Requests"), false, "a per-minute limit without a reset time is left to agy");
  assert.equal(isHardQuotaError("The model is overloaded. Please try again later."), false);
  assert.equal(isHardQuotaError("Your previous response contained an improperly formatted function call\nRetries remaining: 3"), false);
  assert.equal(isHardQuotaError(""), false);
  assert.equal(isHardQuotaError(null), false);
});

test("executor: readLatestAgyRunError finds the newest error (and its step) at the end of a large transcript", async () => {
  const sandbox = path.join(SANDBOX_BASE, "zz_rl");
  const conv = "aaaaaaaa-1111-2222-3333-444444444444";
  const file = agyRunTranscriptPath(sandbox, conv);
  assert.equal(file, path.join(sandbox, ".gemini", "antigravity-cli", "brain", conv, ".system_generated", "logs", "transcript.jsonl"));
  assert.equal(await readLatestAgyRunError(sandbox, conv), null, "no transcript yet");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (o) => JSON.stringify(o) + "\n";
  fs.writeFileSync(file, line({ step_index: 0, type: "USER_INPUT", content: "ERROR_MESSAGE ".repeat(20000) }));
  assert.equal(await readLatestAgyRunError(sandbox, conv), null, "a prompt that mentions the word is not an error line");
  fs.appendFileSync(
    file,
    line({ step_index: 1, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", error: QUOTA_429 }) +
      line({ step_index: 2, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", error: QUOTA_429.replace("attempt 1", "attempt 2") })
  );
  assert.deepEqual(await readLatestAgyRunError(sandbox, conv), { error: QUOTA_429.replace("attempt 1", "attempt 2"), stepIndex: 2 });
  // A tail window that cuts into the prompt line still yields the newest whole error line.
  assert.deepEqual(await readLatestAgyRunError(sandbox, conv, { tailBytes: 600 }), { error: QUOTA_429.replace("attempt 1", "attempt 2"), stepIndex: 2 });
  for (const bad of [null, "", "../x", "a/b", "..", "x".repeat(200)]) {
    assert.equal(agyRunTranscriptPath(sandbox, bad), null, `rejects ${JSON.stringify(bad)}`);
    assert.equal(await readLatestAgyRunError(sandbox, bad), null);
  }
});

test("executor: a used-up quota ends the run within seconds (killing agy and its children), cools the profile down until the reset and moves on", async (t) => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_q1", "zz_q2");
  killLeftovers(t, "zz_q1");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_q1",
      ANTIGRAVITY_TEST_ERROR_TEXT: QUOTA_429,
      ANTIGRAVITY_TEST_RETRY_MS: "8000", // 4 attempts = 24 s if the bridge waited for agy
    },
    async () => {
      const pm = new ProfileManager(["zz_q1", "zz_q2"]);
      pm.reset_all();
      const t0 = Date.now();
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      const elapsed = Date.now() - t0;
      assert.equal(res.outputText, "fine");
      assert.equal(res.usedProfile, "zz_q2", "answered by the next profile");
      assert.ok(elapsed < 6000, `switched profile in ${elapsed}ms, not after agy's retries`);
      const pids = runPids("zz_q1");
      assert.equal(pids.length, 2, "fake agy recorded itself and its grandchild");
      await assertProcessGroupGone(pids, "exhausted profile's agy process group");
      assert.equal(runFinishedNaturally("zz_q1"), false);
      const now = Math.floor(Date.now() / 1000);
      assert.equal(pm.state.zz_q1.status, "EXHAUSTED");
      const cooldown = pm.state.zz_q1.exhausted_until - now;
      assert.ok(cooldown >= 3 * 3600 + 2 * 60 - 15 && cooldown <= 3 * 3600 + 2 * 60 + 5, `cooldown ${cooldown}s follows "Resets in 3h2m1s"`);
      assert.equal(pm.is_in_cooldown("zz_q1", "gemini-3.8-flash"), true);
      assert.ok(pm.state.zz_q1.last_used >= now - 10, "the failed attempt still counts for the LRU rotation");
      assert.equal(pm.is_in_cooldown("zz_q2", "gemini-3.8-flash"), false);
    }
  );
});

test("executor: the transcript line landing after the stdout step (and before init) is still caught within the same attempt", async (t) => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_q7", "zz_q8");
  killLeftovers(t, "zz_q7");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_q7",
      ANTIGRAVITY_TEST_ERROR_TEXT: QUOTA_429,
      ANTIGRAVITY_TEST_RETRY_MS: "8000",
      ANTIGRAVITY_TEST_TRANSCRIPT_LAG_MS: "300",
    },
    async () => {
      const pm = new ProfileManager(["zz_q7", "zz_q8"]);
      pm.reset_all();
      const t0 = Date.now();
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      const elapsed = Date.now() - t0;
      assert.equal(res.usedProfile, "zz_q8");
      assert.ok(elapsed < 6000, `caught on the re-read, ${elapsed}ms in (attempt 2 would be at 8 s)`);
      assert.deepEqual(transcriptAttempts("zz_q7"), [1], "killed during attempt 1");
      assert.equal(pm.state.zz_q7.status, "EXHAUSTED");
      await assertProcessGroupGone(runPids("zz_q7"), "lagging run's process group");
    }
  );
});

test("executor: a stale earlier error line does not hide a quota error whose line is still landing (503 then 429)", async (t) => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_q9", "zz_q10");
  killLeftovers(t, "zz_q9");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_q9",
      ANTIGRAVITY_TEST_FIRST_ERROR_TEXT: BUSY_503,
      ANTIGRAVITY_TEST_ERROR_TEXT: QUOTA_429,
      ANTIGRAVITY_TEST_RETRY_MS: "3000",
      ANTIGRAVITY_TEST_TRANSCRIPT_LAG_MS: "300",
    },
    async () => {
      const pm = new ProfileManager(["zz_q9", "zz_q10"]);
      pm.reset_all();
      const t0 = Date.now();
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      const elapsed = Date.now() - t0;
      assert.equal(res.usedProfile, "zz_q10");
      // attempt 1 (503) at 0 s is agy's to retry; attempt 2 (429) at 3 s must be caught on its own
      // re-read, not on attempt 3 at 6 s.
      assert.ok(elapsed >= 2900 && elapsed < 5900, `caught during attempt 2, ${elapsed}ms in (attempt 3 would be at 6 s)`);
      assert.deepEqual(transcriptAttempts("zz_q9"), [2], "killed during attempt 2");
      assert.equal(pm.state.zz_q9.status, "EXHAUSTED");
      assert.match(pm.state.zz_q9.last_reason, /attempt 2.*Individual quota reached/);
      await assertProcessGroupGone(runPids("zz_q9"), "503-then-429 run's process group");
    }
  );
});

test("executor: a busy model (503) is left to agy's own retry and the run is not killed", async () => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_q3", "zz_q4");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_q3",
      ANTIGRAVITY_TEST_ERROR_TEXT: BUSY_503,
      ANTIGRAVITY_TEST_RETRY_MS: "150",
    },
    async () => {
      const pm = new ProfileManager(["zz_q3", "zz_q4"]);
      pm.reset_all();
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      assert.equal(res.outputText, "fine");
      assert.equal(res.usedProfile, "zz_q4");
      assert.equal(runFinishedNaturally("zz_q3"), true, "agy was allowed to finish its retries");
      assert.deepEqual(transcriptAttempts("zz_q3"), [4]);
      assert.notEqual(pm.state.zz_q3.status, "EXHAUSTED", "a busy model is not a used-up quota");
    }
  );
});

test("executor: ANTIGRAVITY_QUOTA_FAST_FAIL=0 waits for agy as before (the profile is still cooled down at the end)", async () => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_q5", "zz_q6");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_QUOTA_FAST_FAIL: "0",
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_q5",
      ANTIGRAVITY_TEST_ERROR_TEXT: QUOTA_429,
      ANTIGRAVITY_TEST_RETRY_MS: "150",
    },
    async () => {
      const pm = new ProfileManager(["zz_q5", "zz_q6"]);
      pm.reset_all();
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      assert.equal(res.usedProfile, "zz_q6");
      assert.equal(runFinishedNaturally("zz_q5"), true, "not killed when the switch is off");
      assert.equal(pm.state.zz_q5.status, "EXHAUSTED");
    }
  );
});

test("profiles: idle profiles rotate least-recently-used by default; a pinned profile stays first; ordered mode keeps configuration order", async () => {
  await withEnv({ ANTIGRAVITY_PROFILE_SELECTION: undefined, ANTIGRAVITY_PROFILE: undefined }, async () => {
    const pm = new ProfileManager(["zz_l1", "zz_l2", "zz_l3", "zz_l4"]);
    pm.reset_all();
    const now = Math.floor(Date.now() / 1000);
    pm.state.zz_l1.last_used = now; // just used
    pm.state.zz_l3.last_used = now - 100; // used a while ago
    pm.state.zz_l4.last_used = now; // tie with zz_l1: configuration order decides
    // zz_l2 never used
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_l2", "zz_l3", "zz_l1", "zz_l4"]);
    assert.deepEqual(pm.get_ordered_profiles(null), ["zz_l2", "zz_l3", "zz_l1", "zz_l4"]);

    // Two attempts in the same second: the order of the attempts breaks the tie.
    pm.note_attempt("zz_l4");
    pm.note_attempt("zz_l1");
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash").slice(-2), ["zz_l4", "zz_l1"]);

    // An exhausted profile stays at the back whatever its age.
    pm.state.zz_l2.status = "EXHAUSTED";
    pm.state.zz_l2.exhausted_until = now + 3600;
    pm.state.zz_l2.family_cooldowns = { gemini: now + 3600, claude: now + 3600, "gpt-oss": now + 3600 };
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_l3", "zz_l4", "zz_l1", "zz_l2"]);

    // A busy profile is not idle: the next-oldest idle one comes first.
    pm.acquire_specific_profile("zz_l3");
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash").slice(0, 2), ["zz_l4", "zz_l1"]);
    pm.release_profile("zz_l3");

    // The pinned profile goes first even though it was just used.
    process.env.ANTIGRAVITY_PROFILE = "zz_l1";
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_l1", "zz_l3", "zz_l4", "zz_l2"]);
    delete process.env.ANTIGRAVITY_PROFILE;

    process.env.ANTIGRAVITY_PROFILE_SELECTION = "ordered";
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_l1", "zz_l3", "zz_l4", "zz_l2"]);
  });
});

test("profiles: a profile in mark_error's back-off is tried last for Gemini requests too, and is runnable again when it ends", async () => {
  await withEnv({ ANTIGRAVITY_PROFILE_SELECTION: "ordered" }, async () => {
    const pm = new ProfileManager(["zz_e1", "zz_e2"]);
    pm.reset_all();
    pm.mark_error("zz_e1", "CLI Execution Error (profile=zz_e1, exit=1): something broke");
    assert.equal(pm.state.zz_e1.status, "ERROR_COOLDOWN");
    assert.equal(pm.is_in_error_cooldown("zz_e1"), true);
    assert.equal(pm.is_executable("zz_e1", "gemini-3.8-flash"), false);
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_e2", "zz_e1"], "not handed out first on the next request");
    assert.equal(pm.acquire_profile(["zz_e1", "zz_e2"], 0, "gemini-3.8-flash"), "zz_e2");
    pm.release_profile("zz_e2");
    pm.state.zz_e1.exhausted_until = Math.floor(Date.now() / 1000) - 1; // back-off over
    assert.equal(pm.is_in_error_cooldown("zz_e1"), false);
    assert.equal(pm.is_executable("zz_e1", "gemini-3.8-flash"), true);
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_e1", "zz_e2"]);
    pm.mark_success("zz_e1", "gemini-3.8-flash");
    assert.equal(pm.state.zz_e1.status, "OK");
  });
});

test("executor: consecutive requests alternate between accounts under the default LRU rotation", async () => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_r1", "zz_r2");
  await withEnv({ ...FAKE_ENV_OFF, ANTIGRAVITY_PROFILE_SELECTION: undefined, ANTIGRAVITY_TEST_FAILING_PROFILE: "none" }, async () => {
    const pm = new ProfileManager(["zz_r1", "zz_r2"]);
    pm.reset_all();
    const used = [];
    for (let i = 0; i < 4; i++) {
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      used.push(res.usedProfile);
    }
    assert.deepEqual(used, ["zz_r1", "zz_r2", "zz_r1", "zz_r2"]);
    // A profile asked for by the request still wins.
    const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, preferredProfile: "zz_r2", timeout: 30, totalTimeout: 60 });
    assert.equal(res.usedProfile, "zz_r2");
  });
});

test("executor: a transcript line lagging beyond the re-read window is still judged (a hard quota line is decisive whatever its step)", async (t) => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_q11", "zz_q12");
  killLeftovers(t, "zz_q11");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_q11",
      ANTIGRAVITY_TEST_ERROR_TEXT: QUOTA_429,
      ANTIGRAVITY_TEST_RETRY_MS: "3000",
      ANTIGRAVITY_TEST_TRANSCRIPT_LAG_MS: "2600", // beyond the 5 x 400 ms re-reads
    },
    async () => {
      const pm = new ProfileManager(["zz_q11", "zz_q12"]);
      pm.reset_all();
      const t0 = Date.now();
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      const elapsed = Date.now() - t0;
      assert.equal(res.usedProfile, "zz_q12");
      // attempt 1's line lands at 2.6 s, after its own re-reads; attempt 2's step at 3 s must judge it.
      assert.ok(elapsed < 5900, `caught by attempt 2's check at the latest, ${elapsed}ms in (natural end would be 12 s+)`);
      assert.ok([1, 2].includes(transcriptAttempts("zz_q11")[0]), `killed during attempt 1 or 2, got ${transcriptAttempts("zz_q11")}`);
      assert.equal(runFinishedNaturally("zz_q11"), false);
      assert.equal(pm.state.zz_q11.status, "EXHAUSTED");
      await assertProcessGroupGone(runPids("zz_q11"), "lagging run's process group");
    }
  );
});

test("executor: the [FALLBACK] line counts the profiles the loop can still try, back-off ones apart", async (t) => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_c1", "zz_c2", "zz_c3", "zz_c4");
  killLeftovers(t, "zz_c1");
  await withEnv(
    {
      ...FAKE_ENV_OFF,
      ANTIGRAVITY_TEST_FAILING_PROFILE: "zz_c1",
      ANTIGRAVITY_TEST_ERROR_TEXT: QUOTA_429,
      ANTIGRAVITY_TEST_RETRY_MS: "8000",
    },
    async () => {
      const pm = new ProfileManager(["zz_c1", "zz_c2", "zz_c3", "zz_c4"]);
      pm.reset_all();
      const far = Math.floor(Date.now() / 1000) + 86400;
      // zz_c3: every model family used up, nothing the loop could run it with.
      pm.state.zz_c3.status = "EXHAUSTED";
      pm.state.zz_c3.exhausted_until = far;
      pm.state.zz_c3.family_cooldowns = { gemini: far, claude: far, "gpt-oss": far };
      // zz_c4: a short error back-off, a last resort only.
      pm.mark_error("zz_c4", "CLI Execution Error (profile=zz_c4, exit=1): boom");
      const lines = await captureWarnings(async () => {
        const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, modelName: null, timeout: 30, totalTimeout: 60 });
        assert.equal(res.usedProfile, "zz_c2");
      });
      const fallback = lines.find((l) => l.startsWith("[FALLBACK] Profile 'zz_c1'"));
      assert.ok(fallback, `no [FALLBACK] line in ${JSON.stringify(lines)}`);
      assert.ok(fallback.endsWith("; 1 profile(s) left (+1 in error back-off)"), fallback);
      assert.ok(lines.some((l) => l.startsWith("[QUOTA] profile=zz_c1")), "the [QUOTA] line names the profile");
    }
  );
});

test("executor: as a last resort a free profile in error back-off is tried before one whose sandbox is locked", async () => {
  const tpl = fakeAgyTemplate();
  freshProfiles("zz_k1", "zz_k2");
  const lockDir = path.join(SANDBOX_BASE, "zz_k1");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, ".sandbox.lock"), String(process.pid)); // held by a live process
  try {
    await withEnv({ ...FAKE_ENV_OFF, ANTIGRAVITY_TEST_FAILING_PROFILE: "none" }, async () => {
      const pm = new ProfileManager(["zz_k1", "zz_k2"]);
      pm.reset_all();
      pm.mark_error("zz_k2", "CLI Execution Error (profile=zz_k2, exit=1): boom");
      const res = await executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 30, totalTimeout: 60 });
      assert.equal(res.usedProfile, "zz_k2", "the back-off profile answered");
      assert.equal(pm.state.zz_k1.last_used || 0, 0, "the locked profile was never attempted");
      assert.equal(pm.state.zz_k2.status, "OK", "a success ends the back-off");
    });
  } finally {
    fs.rmSync(path.join(lockDir, ".sandbox.lock"), { force: true });
  }
});

test("profiles: the last-resort bucket rotates least-recently-used as well", async () => {
  await withEnv({ ANTIGRAVITY_PROFILE_SELECTION: undefined, ANTIGRAVITY_PROFILE: undefined }, async () => {
    const pm = new ProfileManager(["zz_x1", "zz_x2", "zz_x3"]);
    pm.reset_all();
    const now = Math.floor(Date.now() / 1000);
    for (const p of ["zz_x1", "zz_x2", "zz_x3"]) pm.mark_error(p, "boom");
    pm.state.zz_x1.last_used = now;
    pm.state.zz_x2.last_used = now - 50;
    pm.state.zz_x3.last_used = now - 100;
    assert.deepEqual(pm.get_ordered_profiles("gemini-3.8-flash"), ["zz_x3", "zz_x2", "zz_x1"]);
  });
});
