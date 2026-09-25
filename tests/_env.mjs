// Imported first by every test file: keeps the test-suite away from the real
// ~/.config/antigravity state (bridge_config.json, quota cache, sandboxes, profiles, bridge.env keys).
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agv-bridge-tests-"));
process.env.ANTIGRAVITY_BRIDGE_CONFIG ||= path.join(dir, "bridge_config.json");
process.env.ANTIGRAVITY_QUOTA_CACHE_FILE ||= path.join(dir, "quota_cache_node.json");
process.env.ANTIGRAVITY_SANDBOX_BASE ||= path.join(dir, "sandboxes");
// os.homedir() reads HOME (USERPROFILE on Windows) at call time: profile directories, the token
// copy-back after a run and the .env lookup all resolve under this directory, never the developer's.
export const TEST_HOME = path.join(dir, "home");
fs.mkdirSync(TEST_HOME, { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
export const TEST_STATE_DIR = dir;
