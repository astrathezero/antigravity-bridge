// Imported first by every test file: keeps the test-suite away from the real
// ~/.config/antigravity state (bridge_config.json, quota cache, sandboxes).
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agv-bridge-tests-"));
process.env.ANTIGRAVITY_BRIDGE_CONFIG ||= path.join(dir, "bridge_config.json");
process.env.ANTIGRAVITY_QUOTA_CACHE_FILE ||= path.join(dir, "quota_cache_node.json");
process.env.ANTIGRAVITY_SANDBOX_BASE ||= path.join(dir, "sandboxes");
export const TEST_STATE_DIR = dir;
