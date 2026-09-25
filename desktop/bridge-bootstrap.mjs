/**
 * Utility-process entry of the desktop edition: runs the unchanged bridge (src/index.mjs) and answers the
 * supervisor. Messages: {type:"shutdown"} -> end the agy runs, close the server, exit 0. Reports
 * {type:"children", pids} whenever the set of agy runs changes (the supervisor taskkills them on Windows
 * if the process has to be terminated).
 *
 * The channel is Electron's process.parentPort; under plain Node (child_process.fork, used by the tests)
 * it is the IPC channel, so the protocol is exercised without Electron.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir =
  process.env.ANTIGRAVITY_DESKTOP_BRIDGE_SRC || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const bridgeModule = (rel) => pathToFileURL(path.join(srcDir, rel)).href;

const channel = process.parentPort
  ? { send: (msg) => process.parentPort.postMessage(msg), onMessage: (fn) => process.parentPort.on("message", ({ data }) => fn(data)) }
  : process.send
    ? { send: (msg) => process.send(msg), onMessage: (fn) => process.on("message", fn) }
    : null;

process.title = "antigravity-bridge";
process.env.ANTIGRAVITY_DESKTOP = "1";

const { setDesktopHost } = await import(bridgeModule("core/host.mjs"));
const host = setDesktopHost({
  onChildrenChanged: (pids) => {
    try {
      channel?.send({ type: "children", pids });
    } catch {
      // Parent port closed
    }
  },
});

let stopping = false;
channel?.onMessage(async (data) => {
  if (data?.type !== "shutdown" || stopping) return;
  stopping = true;
  try {
    await host.shutdown({ graceMs: Number(data.graceMs) || 3000 });
  } catch {
    // Exit regardless
  }
  process.exit(0);
});

await import(bridgeModule("index.mjs"));
