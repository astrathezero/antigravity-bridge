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

