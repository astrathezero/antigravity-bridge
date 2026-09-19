import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createBridgeServer } from "../src/server.mjs";
import { ProfileManager } from "../src/core/profile-manager.mjs";
import {
  verifyApiKey,
  isSafeProfileName,
  buildAllowedHosts,
  isAllowedHost,
  sanitizeHeaderValue,
} from "../src/core/security.mjs";
import { getProfileSandboxBasePath } from "../src/core/sandbox.mjs";

test("security: verifyApiKey ignores prototype properties and is exact", () => {
  const keys = { "sk-real-key-123456": "tester" };
  assert.equal(verifyApiKey("sk-real-key-123456", keys), "tester");
  for (const bad of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf", "", null, "sk-real-key-12345", "sk-real-key-1234567"]) {
    assert.equal(verifyApiKey(bad, keys), null, `should reject ${String(bad)}`);
  }
});

test("security: profile name validation blocks traversal and control chars", () => {
  for (const ok of [null, "", "default", "astra_1", "a.b-c"]) assert.equal(isSafeProfileName(ok), true, String(ok));
  for (const bad of ["..", ".", "../x", "a/b", "a\\b", "x\r\ny", " a", "-lead", ".hidden", "a".repeat(65), 42]) {
    assert.equal(isSafeProfileName(bad), false, String(bad));
  }
  assert.throws(() => getProfileSandboxBasePath("../../etc"));
});

test("security: host allow-list", () => {
  const a = buildAllowedHosts("127.0.0.1", "");
  assert.equal(isAllowedHost("127.0.0.1:8008", a), true);
  assert.equal(isAllowedHost("localhost", a), true);
  assert.equal(isAllowedHost("[::1]:8008", a), true);
  assert.equal(isAllowedHost("evil.example.com", a), false);
  assert.equal(isAllowedHost("", a), false);
  assert.equal(buildAllowedHosts("0.0.0.0", ""), null);
  const b = buildAllowedHosts("0.0.0.0", "bridge.lan, 10.0.0.5");
  assert.equal(isAllowedHost("bridge.lan:8008", b), true);
  assert.equal(isAllowedHost("other.lan", b), false);
  assert.equal(sanitizeHeaderValue("a\r\nX-Injected: 1"), "a  X-Injected: 1");
});

test("security: HTTP-level protections", async () => {
  const pm = new ProfileManager(["p1"]);
  const testPort = 8096;
  const { server } = createBridgeServer({
    port: testPort,
    host: "127.0.0.1",
    profileManager: pm,
    apiKeys: { "secret-test-token": "tester" },
  });
  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${testPort}`;
  try {
    // prototype-property bypass must fail
    for (const bad of ["toString", "__proto__", "constructor"]) {
      const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${bad}` } });
      assert.equal(r.status, 401, `bypass attempt with ${bad}`);
    }
    // query-string keys are no longer accepted
    const q = await fetch(`${base}/v1/models?api_key=secret-test-token`);
    assert.equal(q.status, 401);
    // valid key still works
    const okResp = await fetch(`${base}/v1/models`, { headers: { "x-api-key": "secret-test-token" } });
    assert.equal(okResp.status, 200);
    // unauthenticated /health is liveness-only
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    const hj = await h.json();
    assert.equal(hj.status, "ok");
    assert.equal(hj.profiles, undefined);
    assert.equal(hj.active_keys_count, undefined);
    // foreign Host header is rejected (DNS rebinding)
    // (fetch forbids overriding Host, so use raw http)
    const rbStatus = await new Promise((resolve, reject) => {
      const rq = http.request(
        { host: "127.0.0.1", port: testPort, path: "/health", method: "GET", headers: { Host: "evil.example.com" } },
        (rs) => { rs.resume(); rs.on("end", () => resolve(rs.statusCode)); }
      );
      rq.on("error", reject);
      rq.end();
    });
    assert.equal(rbStatus, 403);
    // CORS is off by default: no wildcard origin header, preflight refused
    assert.equal(okResp.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(`${base}/v1/models`, { method: "OPTIONS" });
    assert.equal(pre.status, 403);
    // unsafe profile names rejected on config + create-key validation
    const cfg = await fetch(`${base}/v1/profiles/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-test-token" },
      body: JSON.stringify({ profiles: ["../../etc"] }),
    });
    assert.equal(cfg.status, 400);
    assert.deepEqual(pm._profiles, ["p1"]);
    const kc = await fetch(`${base}/v1/keys/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-test-token" },
      body: JSON.stringify({ label: "x\nANTIGRAVITY_BRIDGE_CMD=evil" }),
    });
    assert.equal(kc.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- long-thinking / stream-json regression tests ---
import { AgyStreamParser } from "../src/core/executor.mjs";
import { calculateDynamicStallTimeout, DEFAULT_STALL_TIMEOUT } from "../src/config.mjs";

test("stall: threshold is lenient and independent of prompt size / model", () => {
  assert.ok(DEFAULT_STALL_TIMEOUT >= 600);
  const a = calculateDynamicStallTimeout(50, "gemini-3.8-flash");
  const b = calculateDynamicStallTimeout(80000, "gemini-3.8-flash-high");
  const c = calculateDynamicStallTimeout(100, "claude-opus-4-6-thinking");
  assert.equal(a, DEFAULT_STALL_TIMEOUT);
  assert.equal(b, a);
  assert.equal(c, a);
});

test("stream-json: parser yields deltas, final response and failure status", () => {
  const p = new AgyStreamParser();
  const items = [];
  items.push(...p.feed('{"event":"init","init":{"cwd":"/x"}}\n{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"17 × 23"}}\n{"event":"step_update","step_update":{"step_i'));
  items.push(...p.feed('ndex":1,"state":"DONE","step_type":"agent_response","text_delta":" = 391\\n"}}\n{"event":"result","result":{"status":"SUCCESS","response":"17 × 23 = 391\\n"}}\n'));
  items.push(...p.finish());
  assert.deepEqual(items.map((i) => i.kind), ["delta", "delta"]);
  assert.equal(p.finalText(), "17 × 23 = 391\n");
  assert.equal(p.isFailure(), false);

  const plain = new AgyStreamParser();
  const raw = plain.feed("plain text\n");
  assert.deepEqual(raw, [{ kind: "raw", text: "plain text\n" }]);
  assert.equal(plain.seenEvents, false);
  assert.equal(plain.finalText(), "plain text\n");

  const bad = new AgyStreamParser();
  bad.feed('{"event":"result","result":{"status":"ERROR","error":"Individual quota reached. Resets in 3h"}}\n');
  assert.equal(bad.isFailure(), true);
  assert.match(bad.errorText(), /quota reached/);
});

// --- API-mode tool guard / disconnect regression tests ---
import { apiModePreamble, API_MODE_PREAMBLE } from "../src/config.mjs";
import { formatMessagesToPrompt } from "../src/translators/openai.mjs";
import { executeCliCommand, executeCliWithFallback } from "../src/core/executor.mjs";

test("api-mode: prompt carries the no-tools preamble unless ANTIGRAVITY_ALLOW_CLI_TOOLS=1", () => {
  const prev = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  try {
    assert.equal(apiModePreamble(), API_MODE_PREAMBLE);
    const single = formatMessagesToPrompt([{ role: "user", content: "Hi" }]);
    assert.ok(single.startsWith("[Bridge Mode: API backend]"));
    assert.ok(single.endsWith("\n\nHi"));
    const multi = formatMessagesToPrompt([{ role: "system", content: "S" }, { role: "user", content: "U" }]);
    assert.ok(multi.startsWith("[Bridge Mode: API backend]"));
    assert.ok(multi.includes("[User]\nU"));
    process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = "1";
    assert.equal(apiModePreamble(), "");
    assert.equal(formatMessagesToPrompt([{ role: "user", content: "Hi" }]), "Hi");
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prev;
  }
});

test("stream-json: tool steps are recorded by the parser", () => {
  const p = new AgyStreamParser();
  const items = p.feed('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls /"}}}}\n');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tool");
  assert.match(items[0].text, /^run_command /);
  assert.equal(p.toolSteps.length, 1);
});

test("executor: a tool step kills the CLI and is not retried on other profiles", async () => {
  const prev = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const pm = new ProfileManager(["zz_t1", "zz_t2"]);
  pm.reset_all();
  const fsMod = await import("node:fs");
  fsMod.mkdirSync(`${process.cwd()}/tests/.tmp-sandbox`, { recursive: true });
  const helper = `${process.cwd()}/tests/.tmp-sandbox/tool-step.mjs`;
  fsMod.writeFileSync(
    helper,
    'process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"ACTIVE",step_type:"tool",tool_name:"run_command",tool_info:{name:"run_command",parameters:{CommandLine:"id"}}}})+"\\n");setTimeout(()=>{},30000);\n'
  );
  const tpl = `node ${helper} {prompt}`;
  const t0 = Date.now();
  await assert.rejects(
    executeCliWithFallback(tpl, "hi", { profileManager: pm, timeout: 20, totalTimeout: 40 }),
    /CLI tool execution blocked/
  );
  assert.ok(Date.now() - t0 < 10000, "blocked quickly instead of waiting for timeout");
  assert.equal(pm.is_in_cooldown("zz_t1"), false, "no cooldown for a blocked tool attempt");
  assert.equal(pm.state["zz_t2"]?.last_used || 0, 0, "second profile never tried");
  if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prev;
  if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
});

test("stream-json: tool items carry the tool name and full parameters", () => {
  const p = new AgyStreamParser();
  const longPath = "/tmp/" + "x".repeat(300) + "/transcript_full.jsonl";
  const items = p.feed(`{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"${longPath}"}}}}\n`);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "view_file");
  assert.equal(items[0].params.AbsolutePath, longPath, "params are not truncated like the summary text");
  assert.ok(items[0].text.length < longPath.length);
});

test("own-conversation read policy: matches only reads inside a conversation created by this run", async () => {
  const { OwnConversationReadPolicy } = await import("../src/core/executor.mjs");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const osMod = await import("node:os");
  const sandbox = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "agv-brain-"));
  const brain = pathMod.join(sandbox, ".gemini", "antigravity-cli", "brain");
  fsMod.mkdirSync(pathMod.join(brain, "old-conv", ".system_generated", "logs"), { recursive: true });
  const policy = new OwnConversationReadPolicy(sandbox, { enabled: true });
  // agy creates this run's conversation after the policy took its snapshot
  const newLogs = pathMod.join(brain, "new-conv", ".system_generated", "logs");
  fsMod.mkdirSync(newLogs, { recursive: true });
  const transcript = pathMod.join(newLogs, "transcript_full.jsonl");
  const oldTranscript = pathMod.join(brain, "old-conv", ".system_generated", "logs", "transcript_full.jsonl");

  assert.equal(policy.allows("view_content_chunk", { document_id: "d1", position: 2 }), false, "no chunk before a read");
  assert.equal(policy.allows("view_file", { AbsolutePath: transcript, StartLine: 0, EndLine: 200 }), true);
  assert.equal(policy.allows("view_content_chunk", { document_id: "d1", position: 2 }), true, "chunk pages through the allowed read");
  assert.equal(policy.allows("grep_search", { Query: "hello", SearchPath: pathMod.join(brain, "new-conv") }), true);
  assert.equal(policy.allows("view_file", { AbsolutePath: oldTranscript }), false, "another client's conversation");
  assert.equal(policy.allows("list_dir", { DirectoryPath: brain }), false, "listing all conversations");
  assert.equal(policy.allows("view_file", { AbsolutePath: "/etc/passwd" }), false);
  assert.equal(policy.allows("view_file", { AbsolutePath: pathMod.join(brain, "new-conv", "..", "old-conv", "x") }), false, "traversal");
  assert.equal(policy.allows("view_file", { AbsolutePath: "~/.gemini/antigravity-cli/brain/new-conv/x" }), false, "unresolved home");
  assert.equal(policy.allows("view_file", {}), false, "no path at all");
  assert.equal(policy.allows("run_command", { CommandLine: `cat ${transcript}` }), false, "never a command");
  assert.equal(policy.allows("write_to_file", { TargetFile: transcript }), false, "never a write");

  // Default is OFF: the step is recognised (for the hint) but not allowed.
  const prev = process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS;
  delete process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS;
  try {
    const off = new OwnConversationReadPolicy(sandbox);
    assert.equal(off.enabled, false);
    assert.equal(off.matches("view_file", { AbsolutePath: transcript }), false, "new-conv predates this policy");
    const laterTranscript = pathMod.join(brain, "later-conv", ".system_generated", "logs", "transcript_full.jsonl");
    fsMod.mkdirSync(pathMod.dirname(laterTranscript), { recursive: true });
    assert.equal(off.matches("view_file", { AbsolutePath: laterTranscript }), true, "recognised for the hint");
    assert.equal(off.allows("view_file", { AbsolutePath: laterTranscript }), false, "but not allowed while off");
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS; else process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS = prev;
  }
});

// agy stand-in: create this run's conversation log under $HOME (the sandbox), read it with
// view_file the way agy does for an oversized prompt, then answer in text.
const OWN_TRANSCRIPT_READ_SRC = [
  'const fs = require("node:fs"); const path = require("node:path");',
  'const logs = path.join(process.env.HOME, ".gemini", "antigravity-cli", "brain", "conv-" + process.pid, ".system_generated", "logs");',
  "fs.mkdirSync(logs, { recursive: true });",
  'const transcript = path.join(logs, "transcript_full.jsonl");',
  'fs.writeFileSync(transcript, "{}\\n");',
  'process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"ACTIVE",step_type:"tool",tool_name:"view_file",tool_info:{name:"view_file",parameters:{AbsolutePath:transcript,StartLine:0,EndLine:400}}}})+"\\n");',
  "setTimeout(() => {",
  '  process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:2,state:"ACTIVE",step_type:"agent_response",text_delta:"log answer"}})+"\\n");',
  '  process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"log answer"}})+"\\n");',
  "}, 400);",
  "",
].join("\n");

test("executor: agy reading its own conversation log is blocked by default (with a hint) and allowed by ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1", async () => {
  const prevTools = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const prevReads = process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS;
  delete process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS;
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const fsMod = await import("node:fs");
  fsMod.mkdirSync(`${process.cwd()}/tests/.tmp-sandbox`, { recursive: true });
  const helper = `${process.cwd()}/tests/.tmp-sandbox/own-transcript-read.cjs`;
  fsMod.writeFileSync(helper, OWN_TRANSCRIPT_READ_SRC);
  try {
    const pm = new ProfileManager(["zz_t5"]);
    pm.reset_all();
    const t0 = Date.now();
    await assert.rejects(
      executeCliWithFallback(`node ${helper} {prompt}`, "hi", { profileManager: pm, timeout: 20, totalTimeout: 40 }),
      /CLI tool execution blocked[\s\S]*ANTIGRAVITY_ALLOW_TRANSCRIPT_READS=1 allows only that read/
    );
    assert.ok(Date.now() - t0 < 10000, "blocked immediately, not after a timeout");

    process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS = "1";
    const res = await executeCliWithFallback(`node ${helper} {prompt}`, "hi", { profileManager: pm, timeout: 20, totalTimeout: 40 });
    assert.equal(res.outputText, "log answer");
    assert.equal(res.usedProfile, "zz_t5");

    // Only that read: a command in the same run is still killed.
    const cmdHelper = `${process.cwd()}/tests/.tmp-sandbox/own-transcript-then-cmd.cjs`;
    fsMod.writeFileSync(
      cmdHelper,
      OWN_TRANSCRIPT_READ_SRC.replace(
        "setTimeout(() => {",
        'process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:2,state:"ACTIVE",step_type:"tool",tool_name:"run_command",tool_info:{name:"run_command",parameters:{CommandLine:"id"}}}})+"\\n");\nsetTimeout(() => {'
      )
    );
    await assert.rejects(
      executeCliWithFallback(`node ${cmdHelper} {prompt}`, "hi", { profileManager: pm, timeout: 20, totalTimeout: 40 }),
      /CLI tool execution blocked[\s\S]*run_command/
    );
  } finally {
    if (prevTools === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prevTools;
    if (prevReads === undefined) delete process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS; else process.env.ANTIGRAVITY_ALLOW_TRANSCRIPT_READS = prevReads;
    if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
  }
});

test("executor: abort signal cancels the CLI", async () => {
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const ac = new AbortController();
  const t0 = Date.now();
  const p = executeCliCommand('node -e "setTimeout(()=>{},30000)" {prompt}', "hi", { profile: "zz_t3", timeout: 20, signal: ac.signal });
  setTimeout(() => ac.abort(), 500);
  await assert.rejects(p, /Client disconnected/);
  assert.ok(Date.now() - t0 < 5000);
  if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
});


test("executor: prompts above the argv limit go to agy over stdin as NDJSON", async () => {
  const { parseCmdTemplate } = await import("../src/core/executor.mjs");
  const big = "ทดสอบภาษาไทย ".repeat(20000); // ~600KB
  const tpl = '"/usr/local/bin/agy" --dangerously-skip-permissions --print-timeout 20m0s --output-format stream-json -p "{prompt}"';
  const { argv, stdinInput } = parseCmdTemplate(tpl, big);
  assert.deepEqual(argv.slice(-2), ["-p", ""]);
  const idx = argv.indexOf("--input-format");
  assert.ok(idx > 0 && argv[idx + 1] === "stream-json" && idx < argv.indexOf("-p"));
  const payload = JSON.parse(stdinInput);
  assert.equal(payload.event, "user");
  assert.equal(payload.message.role, "user");
  assert.equal(payload.message.content, big);
  // templates without stream-json output keep the old argv truncation
  const { argv: a2, stdinInput: s2 } = parseCmdTemplate('agy -p "{prompt}"', big);
  assert.equal(s2, null);
  assert.ok(Buffer.byteLength(a2[a2.length - 1], "utf-8") < 131072);
});

// Helper agy stand-in for the tool-block retry tests. First run: the prompt carries no notice ->
// start a tool and hang (the bridge kills it). Retry: the prompt carries the notice naming the
// offending tool -> answer in text like a well-behaved run.
const TOOL_STEP_THEN_TEXT_SRC = [
  'const p = process.argv.slice(2).join(" ");',
  'if (p.includes("[Bridge notice: previous attempt aborted]") && p.includes("run_command")) {',
  '  process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"text answer"}})+"\\n");',
  '  process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"text answer"}})+"\\n");',
  "} else {",
  '  process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"ACTIVE",step_type:"tool",tool_name:"run_command",tool_info:{name:"run_command",parameters:{CommandLine:"id"}}}})+"\\n");',
  "  setTimeout(()=>{},30000);",
  "}",
  "",
].join("\n");

test("executor: a blocked tool step is retried once on the same profile with a reinforced notice", async () => {
  const prev = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const prevRetries = process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
  delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const pm = new ProfileManager(["zz_t1", "zz_t2"]);
  pm.reset_all();
  const fsMod = await import("node:fs");
  fsMod.mkdirSync(`${process.cwd()}/tests/.tmp-sandbox`, { recursive: true });
  const helper = `${process.cwd()}/tests/.tmp-sandbox/tool-step-then-text.mjs`;
  fsMod.writeFileSync(helper, TOOL_STEP_THEN_TEXT_SRC);
  try {
    const t0 = Date.now();
    const res = await executeCliWithFallback(`node ${helper} {prompt}`, "hi", { profileManager: pm, timeout: 20, totalTimeout: 40 });
    assert.equal(res.outputText, "text answer");
    assert.equal(res.usedProfile, "zz_t1", "retry stays on the same profile");
    assert.ok(Date.now() - t0 < 15000, "retry happens right after the block, not after a timeout");
    assert.equal(pm.is_in_cooldown("zz_t1"), false, "no cooldown for a blocked tool attempt");
    assert.equal(pm.state["zz_t2"]?.last_used || 0, 0, "second profile never tried");
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prev;
    if (prevRetries === undefined) delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES; else process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES = prevRetries;
    if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
  }
});

test("executor: tool-block retry is skipped once text was streamed, and when ANTIGRAVITY_TOOL_BLOCK_RETRIES=0", async () => {
  const prev = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const prevRetries = process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
  delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const pm = new ProfileManager(["zz_t4"]);
  pm.reset_all();
  const fsMod = await import("node:fs");
  fsMod.mkdirSync(`${process.cwd()}/tests/.tmp-sandbox`, { recursive: true });
  const textThenTool = `${process.cwd()}/tests/.tmp-sandbox/text-then-tool-step.mjs`;
  fsMod.writeFileSync(
    textThenTool,
    [
      'process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"Let me check..."}})+"\\n");',
      'setTimeout(()=>{process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:2,state:"ACTIVE",step_type:"tool",tool_name:"run_command",tool_info:{name:"run_command",parameters:{CommandLine:"id"}}}})+"\\n");},300);',
      "setTimeout(()=>{},30000);",
      "",
    ].join("\n")
  );
  const helper = `${process.cwd()}/tests/.tmp-sandbox/tool-step-then-text.mjs`;
  fsMod.writeFileSync(helper, TOOL_STEP_THEN_TEXT_SRC);
  try {
    // Text already forwarded to the client: a retry would duplicate it, so the request fails instead.
    const kinds = [];
    await assert.rejects(
      executeCliWithFallback(`node ${textThenTool} {prompt}`, "hi", {
        profileManager: pm,
        timeout: 20,
        totalTimeout: 40,
        outputCallback: (_text, kind) => kinds.push(kind),
      }),
      /CLI tool execution blocked/
    );
    assert.ok(kinds.includes("delta"), "text was streamed before the tool step");

    // Retry disabled by configuration.
    process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES = "0";
    await assert.rejects(
      executeCliWithFallback(`node ${helper} {prompt}`, "hi", { profileManager: pm, timeout: 20, totalTimeout: 40 }),
      /CLI tool execution blocked/
    );
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prev;
    if (prevRetries === undefined) delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES; else process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES = prevRetries;
    if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
  }
});

// --- malformed-function-call salvage -------------------------------------------------------------

test("parser: agent_response text is grouped per step and a malformed-function-call run is salvageable", async () => {
  const { salvageClientToolCall } = await import("../src/core/executor.mjs");
  const call = '{"tool_calls":[{"name":"read_file","arguments":{"path":"/x"}}]}';
  const p = new AgyStreamParser();
  p.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: call.slice(0, 20) } }) + "\n");
  p.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: call.slice(20) } }) + "\n");
  p.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "second " } }) + "\n");
  p.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "reply" } }) + "\n");
  p.feed(JSON.stringify({ event: "result", result: { status: "ERROR", error: "Your previous response contained an improperly formatted function call\nPlease retry with a properly formatted function call\nRetries remaining: 3" } }) + "\n");
  assert.deepEqual(p.agentResponses(), [call, "second reply"]);
  assert.equal(p.isFailure(), true);
  assert.equal(salvageClientToolCall(p, ["terminal", "read_file"]), call, "first step that calls a client tool wins");
  assert.equal(salvageClientToolCall(p, ["terminal"]), null, "a call to a tool the client did not offer is not salvaged");
  assert.equal(salvageClientToolCall(p, null), null, "no client tools: nothing to salvage");
  assert.equal(salvageClientToolCall(p, []), null);

  // Any other agy failure is still a failure.
  const q = new AgyStreamParser();
  q.feed(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: call } }) + "\n");
  q.feed(JSON.stringify({ event: "result", result: { status: "ERROR", error: "API error (attempt 1): UNAVAILABLE (code 503)" } }) + "\n");
  assert.equal(salvageClientToolCall(q, ["read_file"]), null);
});

const MALFORMED_CALL_RUN_SRC = [
  'const call = JSON.stringify({tool_calls:[{name:"read_file",arguments:{path:"/etc/hostname"}}]});',
  'process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:1,state:"DONE",step_type:"agent_response",text_delta:call}})+"\\n");',
  'process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_index:3,state:"DONE",step_type:"agent_response",text_delta:"```json\\n"+call+"\\n```"}})+"\\n");',
  'process.stdout.write(JSON.stringify({event:"result",result:{status:"ERROR",error:"Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.\\nPlease retry with a properly formatted function call\\nRetries remaining: 3"}})+"\\n");',
  "",
].join("\n");

test("executor: a run agy ends with 'improperly formatted function call' is salvaged when the model already replied with a client-side tool call", async () => {
  const prev = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const fsMod = await import("node:fs");
  fsMod.mkdirSync(`${process.cwd()}/tests/.tmp-sandbox`, { recursive: true });
  const helper = `${process.cwd()}/tests/.tmp-sandbox/malformed-call-run.mjs`;
  fsMod.writeFileSync(helper, MALFORMED_CALL_RUN_SRC);
  try {
    const pm = new ProfileManager(["zz_s1", "zz_s2"]);
    pm.reset_all();
    const res = await executeCliWithFallback(`node ${helper} {prompt}`, "hi", {
      profileManager: pm,
      timeout: 20,
      totalTimeout: 40,
      clientToolNames: ["terminal", "read_file"],
    });
    assert.equal(res.outputText, '{"tool_calls":[{"name":"read_file","arguments":{"path":"/etc/hostname"}}]}');
    assert.equal(res.usedProfile, "zz_s1", "no failover to another profile");
    assert.equal(pm.state["zz_s2"]?.last_used || 0, 0, "second profile never tried");
    assert.equal(pm.is_in_cooldown("zz_s1"), false);

    // Without client tools the same run is the failure it always was.
    const pm2 = new ProfileManager(["zz_s3", "zz_s4"]);
    pm2.reset_all();
    await assert.rejects(
      executeCliWithFallback(`node ${helper} {prompt}`, "hi", { profileManager: pm2, timeout: 20, totalTimeout: 40 }),
      /improperly formatted function call/
    );
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prev;
    if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
  }
});

test("config: the tool-block retry notice names the client-side tools when the request has them", async () => {
  const { toolBlockRetryNotice, TOOL_BLOCK_RETRY_NOTICE_HEADER } = await import("../src/config.mjs");
  const plain = toolBlockRetryNotice('run_command {"CommandLine":"ls"}');
  assert.ok(plain.startsWith(TOOL_BLOCK_RETRY_NOTICE_HEADER));
  assert.ok(!plain.includes("client-side tools defined in this request"));
  const named = toolBlockRetryNotice('run_command {"CommandLine":"ls"}', ["terminal", "read_file", ""]);
  assert.ok(named.includes("The client-side tools defined in this request are: terminal, read_file."));
  assert.ok(named.includes('{"tool_calls":[{"name":"<tool>"'));
  assert.ok(named.includes("run_command"));
});

// --- blocked agy tool -> client tool --------------------------------------------------------------

const HERMES_LIKE_TOOLS = [
  { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", maximum: 2000 } }, required: ["path"] } },
  { name: "terminal", description: "run", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "write_file", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
];

test("translators: a blocked agy tool step maps onto the client's terminal / read_file tools", async () => {
  const { translateBlockedToolCall } = await import("../src/translators/tools.mjs");
  const t = (name, params, tools = HERMES_LIKE_TOOLS, opts) => translateBlockedToolCall({ name, params }, tools, opts);

  let r = t("run_command", { CommandLine: 'grep "Alert sent" /x.log | head -n 5', Cwd: "/sb/astraleno" }, HERMES_LIKE_TOOLS, { sandboxPrefixes: ["/sb"] });
  assert.equal(r.name, "terminal");
  assert.deepEqual(r.arguments, { command: 'grep "Alert sent" /x.log | head -n 5' }, "agy's own sandbox cwd is dropped");
  assert.equal(r.text, JSON.stringify({ tool_calls: [{ name: "terminal", arguments: r.arguments }] }));
  r = t("run_command", { CommandLine: "ls", Cwd: "/home/u/data" });
  assert.deepEqual(r.arguments, { command: "cd '/home/u/data' && ls" }, "a real cwd is honoured");
  r = t("view_file", { AbsolutePath: "/a.py", StartLine: 500, EndLine: 699 });
  assert.equal(r.name, "read_file");
  assert.deepEqual(r.arguments, { path: "/a.py", offset: 501, limit: 200 }, "0-based agy lines become 1-based offset + limit");
  r = t("view_file", { AbsolutePath: "/a.py", StartLine: 0, EndLine: 5000 });
  assert.equal(r.arguments.limit, 2000, "limit is clamped to the schema maximum");
  r = t("list_dir", { DirectoryPath: "/home/u/it's" });
  assert.deepEqual(r.arguments, { command: "ls -la '/home/u/it'\\''s'" });
  r = t("grep_search", { Query: "Alert sent", SearchPath: "/home/u", CaseInsensitive: true, IsRegex: false, Includes: ["*.log"] });
  assert.deepEqual(r.arguments, { command: "grep -rn -i -F --include='*.log' 'Alert sent' '/home/u'" });
  r = t("find_by_name", { SearchDirectory: "/home/u", Pattern: "*.py" });
  assert.deepEqual(r.arguments, { command: "find '/home/u' -name '*.py'" });

  // A tool the client has a cwd property for, and non-standard names.
  r = t("run_command", { CommandLine: "make", Cwd: "/proj" }, [{ name: "execute_shell", parameters: { properties: { cmd: { type: "string" }, workdir: { type: "string" } } } }]);
  assert.deepEqual(r, { name: "execute_shell", arguments: { cmd: "make", workdir: "/proj" }, text: r.text });

  // Nothing fits: browser steps, missing params, or no matching client tool.
  assert.equal(t("browser_subagent", { Task: "x" }), null);
  assert.equal(t("run_command", {}), null);
  assert.equal(t("run_command", { CommandLine: "ls" }, [{ name: "get_weather", parameters: { properties: { city: { type: "string" } } } }]), null);
  assert.equal(t("view_file", { AbsolutePath: "/a" }, [{ name: "terminal", parameters: { properties: { command: { type: "string" } } } }]), null);
  assert.equal(t("run_command", { CommandLine: "ls" }, []), null);
  assert.equal(t("run_command", { CommandLine: "ls" }, null), null);
});

test("executor: a blocked run_command step is answered as the client's terminal call, without a retry", async () => {
  const prev = process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const prevRetries = process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
  delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
  const prevTranslate = process.env.ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS;
  delete process.env.ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS;
  const prevBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  process.env.ANTIGRAVITY_SANDBOX_BASE = `${process.cwd()}/tests/.tmp-sandbox`;
  const fsMod = await import("node:fs");
  fsMod.mkdirSync(`${process.cwd()}/tests/.tmp-sandbox`, { recursive: true });
  const helper = `${process.cwd()}/tests/.tmp-sandbox/tool-step-then-text.mjs`;
  fsMod.writeFileSync(helper, TOOL_STEP_THEN_TEXT_SRC);
  try {
    const pm = new ProfileManager(["zz_x1", "zz_x2"]);
    pm.reset_all();
    const t0 = Date.now();
    const res = await executeCliWithFallback(`node ${helper} {prompt}`, "hi", {
      profileManager: pm,
      timeout: 20,
      totalTimeout: 40,
      clientTools: HERMES_LIKE_TOOLS,
    });
    assert.equal(res.outputText, '{"tool_calls":[{"name":"terminal","arguments":{"command":"id"}}]}');
    assert.equal(res.usedProfile, "zz_x1");
    assert.ok(Date.now() - t0 < 8000, "answered right after the block, no second run");
    assert.equal(pm.is_in_cooldown("zz_x1"), false);
    assert.equal(pm.state["zz_x2"]?.last_used || 0, 0, "second profile never tried");

    // Switched off: the old retry-with-notice path answers "text answer" on the second run.
    process.env.ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS = "0";
    const pm2 = new ProfileManager(["zz_x3"]);
    pm2.reset_all();
    const res2 = await executeCliWithFallback(`node ${helper} {prompt}`, "hi", { profileManager: pm2, timeout: 20, totalTimeout: 40, clientTools: HERMES_LIKE_TOOLS });
    assert.equal(res2.outputText, "text answer");
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS; else process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS = prev;
    if (prevRetries === undefined) delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES; else process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES = prevRetries;
    if (prevTranslate === undefined) delete process.env.ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS; else process.env.ANTIGRAVITY_TRANSLATE_BLOCKED_TOOLS = prevTranslate;
    if (prevBase === undefined) delete process.env.ANTIGRAVITY_SANDBOX_BASE; else process.env.ANTIGRAVITY_SANDBOX_BASE = prevBase;
  }
});
