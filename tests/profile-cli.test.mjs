import { TEST_HOME } from "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// `profile remove` tells a running bridge about the new rotation: aim it at a port nobody listens on,
// never at a live bridge (npm test runs on the production host next to the bridge on 8008).
const closedPort = await new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
process.env.ANTIGRAVITY_PORT = String(closedPort);
const { handleProfileCli } = await import("../src/cli/profile-cli.mjs");

const profilesDir = path.join(TEST_HOME, ".config", "antigravity", "profiles");

test("profile remove: refuses names that are not a single safe segment, and deletes nothing", async () => {
  const victim = path.join(TEST_HOME, "precious");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "keep.txt"), "x");
  fs.mkdirSync(profilesDir, { recursive: true });
  for (const bad of ["../../precious", "..", "a/b", ""]) {
    assert.equal(await handleProfileCli(["remove", bad]), 1, JSON.stringify(bad));
  }
  assert.ok(fs.existsSync(path.join(victim, "keep.txt")));
});

test("profile remove: deletes the profile, its sandboxes and its rotation entry", async () => {
  const dir = path.join(profilesDir, "zz_rm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "oauth_creds.json"), "{}");
  const sandboxBase = process.env.ANTIGRAVITY_SANDBOX_BASE;
  for (const d of [path.join(sandboxBase, "zz_rm", ".gemini"), path.join(sandboxBase, ".token-refresh", "zz_rm")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(process.env.ANTIGRAVITY_BRIDGE_CONFIG, JSON.stringify({ profiles: ["zz_keep", "zz_rm"] }));

  assert.equal(await handleProfileCli(["remove", "zz_rm"]), 0);
  assert.ok(!fs.existsSync(dir));
  assert.ok(!fs.existsSync(path.join(sandboxBase, "zz_rm")));
  assert.ok(!fs.existsSync(path.join(sandboxBase, ".token-refresh", "zz_rm")));
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.ANTIGRAVITY_BRIDGE_CONFIG, "utf-8")).profiles, ["zz_keep"]);
});
