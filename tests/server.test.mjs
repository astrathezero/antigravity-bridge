import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createBridgeServer } from "../src/server.mjs";
import { ProfileManager } from "../src/core/profile-manager.mjs";

test("server: /health and /v1/models endpoints", async () => {
  const pm = new ProfileManager(["test_profile"]);
  const testPort = 8099;
  const { server } = createBridgeServer({
    port: testPort,
    host: "127.0.0.1",
    profileManager: pm,
    apiKeys: {}, // Open mode
  });

  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  try {
    // 1. Test /health
    const healthResp = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.equal(healthResp.status, 200);
    const healthJson = await healthResp.json();
    assert.equal(healthJson.status, "ok");
    assert.equal(healthJson.service, "antigravity-bridge");
    assert.equal(healthJson.active_profile, "test_profile");

    // 2. Test /v1/models
    const modelsResp = await fetch(`http://127.0.0.1:${testPort}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const modelsJson = await modelsResp.json();
    assert.equal(modelsJson.object, "list");
    assert.ok(Array.isArray(modelsJson.data));
    assert.ok(modelsJson.data.some((m) => m.id === "gemini-3.8-flash"));
    assert.ok(modelsJson.data.some((m) => m.id === "claude-sonnet-4-6"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server: authentication validation", async () => {
  const pm = new ProfileManager(["test_profile"]);
  const testPort = 8098;
  const { server } = createBridgeServer({
    port: testPort,
    host: "127.0.0.1",
    profileManager: pm,
    apiKeys: { "secret-test-token": "tester" },
  });

  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  try {
    // 1. Health should work without auth
    const healthResp = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.equal(healthResp.status, 200);

    // 2. /v1/models without auth should return 401
    const unauthResp = await fetch(`http://127.0.0.1:${testPort}/v1/models`);
    assert.equal(unauthResp.status, 401);

    // 3. /v1/models with valid Bearer token should return 200
    const authResp = await fetch(`http://127.0.0.1:${testPort}/v1/models`, {
      headers: { Authorization: "Bearer secret-test-token" },
    });
    assert.equal(authResp.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server: /v1/profiles and /v1/profiles/config endpoints", async () => {
  const pm = new ProfileManager(["p1", "p2"]);
  pm.reset_all();
  const testPort = 8097;
  const { server } = createBridgeServer({
    port: testPort,
    host: "127.0.0.1",
    profileManager: pm,
    apiKeys: {},
    customCmd: 'node -e "console.log(\'OK\')"',
  });

  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  try {
    // 1. GET /v1/profiles
    const profResp = await fetch(`http://127.0.0.1:${testPort}/v1/profiles`);
    assert.equal(profResp.status, 200);
    const profJson = await profResp.json();
    assert.equal(profJson.object, "list");
    assert.ok(profJson.profiles.p1);
    assert.equal(profJson.profiles.p1.available, true);
    assert.equal(profJson.profiles.p1.estimated_quota_percent, 100);

    // 2. POST /v1/profiles/config
    const updateResp = await fetch(`http://127.0.0.1:${testPort}/v1/profiles/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profiles: ["p2", "p1"] }),
    });
    assert.equal(updateResp.status, 200);
    const updateJson = await updateResp.json();
    assert.equal(updateJson.status, "ok");
    assert.deepEqual(updateJson.active_profiles, ["p2", "p1"]);
    assert.deepEqual(pm._profiles, ["p2", "p1"]);

    // 3. POST /v1/profiles/check
    const checkResp = await fetch(`http://127.0.0.1:${testPort}/v1/profiles/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Health test" }),
    });
    assert.equal(checkResp.status, 200);
    const checkJson = await checkResp.json();
    assert.equal(checkJson.status, "ok");
    assert.ok(checkJson.results);
    assert.ok(checkJson.profiles);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("server: an EPIPE error on the connection socket is swallowed, not crashed on (matches the 13:41 production crash)", async () => {
  const pm = new ProfileManager(["epipe_profile"]);
  pm.reset_all();
  const testPort = 8090;
  const { server } = createBridgeServer({
    port: testPort,
    host: "127.0.0.1",
    profileManager: pm,
    apiKeys: {},
  });

  // Capture the server-side connection socket — the object that emitted the unhandled 'error' in prod.
  let serverSocket = null;
  server.on("connection", (sock) => {
    serverSocket = sock;
  });

  await new Promise((resolve) => server.listen(testPort, "127.0.0.1", resolve));

  try {
    const healthResp = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.equal(healthResp.status, 200);
    assert.ok(serverSocket, "captured the server-side socket");

    // The connection-level guard must have attached an error listener that outlives the request.
    assert.ok(serverSocket.listenerCount("error") > 0, "connection guard attached an error listener");

    // Re-create the exact prod failure: an async 'write EPIPE' on the socket. With no listener Node
    // treats it as unhandled and terminates the process; the guard must absorb it.
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write", errno: -32 });
    serverSocket.emit("error", epipe);

    // Any other socket error is also swallowed (a broken connection must not crash the server).
    serverSocket.emit("error", Object.assign(new Error("boom"), { code: "ESOMETHINGELSE" }));

    // Proof the process is still alive and serving.
    const after = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert.equal(after.status, 200);
    assert.equal((await after.json()).status, "ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A model reply that is a client-side tool call. Non-JSON stdout is passed through as the reply text.
const TOOL_CALL_REPLY_CMD =
  'node -e "console.log(JSON.stringify({tool_calls:[{name:\'get_time\',arguments:{zone:\'Asia/Bangkok\'}}]}))"';
const TEXT_REPLY_CMD = 'node -e "console.log(\'It is noon.\')"';

test("server: a tool-call reply carries neither the profile banner nor the raw tool_calls JSON (OpenAI and Anthropic); a text reply keeps the banner", async () => {
  const prevHide = process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS;
  delete process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS;
  const pm = new ProfileManager(["zz_sv1"]);
  pm.reset_all();
  const tools = [{ type: "function", function: { name: "get_time", description: "time", parameters: { type: "object", properties: { zone: { type: "string" } } } } }];
  const run = async (port, customCmd, body, pathname = "/v1/chat/completions") => {
    const { server } = createBridgeServer({ port, host: "127.0.0.1", profileManager: pm, customCmd, apiKeys: {} });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return await r.json();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
  try {
    const oai = await run(8121, TOOL_CALL_REPLY_CMD, { model: "antigravity", messages: [{ role: "user", content: "time?" }], tools });
    assert.ok(oai.choices, `unexpected reply: ${JSON.stringify(oai).slice(0, 400)}`);
    assert.equal(oai.choices[0].finish_reason, "tool_calls");
    assert.equal(oai.choices[0].message.tool_calls[0].function.name, "get_time");
    assert.equal(oai.choices[0].message.content, null, "no raw JSON and no banner in content");
    assert.ok(!JSON.stringify(oai).includes("Antigravity Profile"), "no banner anywhere in a tool-call reply");

    const anth = await run(8122, TOOL_CALL_REPLY_CMD, { model: "antigravity", max_tokens: 100, messages: [{ role: "user", content: "time?" }], tools: [{ name: "get_time", description: "time", input_schema: { type: "object", properties: { zone: { type: "string" } } } }] }, "/v1/messages");
    assert.equal(anth.stop_reason, "tool_use");
    assert.deepEqual(anth.content.map((c) => c.type), ["tool_use"], "only the tool_use block");
    assert.equal(anth.content[0].name, "get_time");

    const text = await run(8123, TEXT_REPLY_CMD, { model: "antigravity", messages: [{ role: "user", content: "time?" }], tools });
    assert.equal(text.choices[0].finish_reason, "stop");
    assert.ok(text.choices[0].message.content.startsWith("It is noon."));
    assert.ok(text.choices[0].message.content.includes("Antigravity Profile"), "a text reply still carries the banner");
  } finally {
    if (prevHide === undefined) delete process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS; else process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS = prevHide;
  }
});
