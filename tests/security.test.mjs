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
