/**
 * What a shutdown needs to reach: the HTTP server and the agy runs in flight. agy runs detached (its own
 * process group), so nothing ends it when the bridge exits unless it is killed here; under systemd the
 * cgroup does that, but a desktop app, LaunchAgent or Scheduled Task would leave it running on (and
 * spending quota). The desktop edition's utility process registers callbacks with setDesktopHost().
 */
import { killProcessTree } from "./executor.mjs";

const runningChildren = new Set();
let registeredServer = null;
let activeDesktopHost = null;
let shuttingDown = false;

export function registerServer(server) {
  registeredServer = server;
}

export function registerChild(child) {
  if (!child || !child.pid) return;
  if (shuttingDown) {
    // Spawned after the shutdown began (a fallback attempt racing it): end it right away.
    try {
      killProcessTree(child, true);
    } catch {
      // ignore
    }
    return;
  }
  runningChildren.add(child);
  notifyChildren();
  if (typeof child.once === "function") {
    child.once("close", () => unregisterChild(child));
  }
}

export function unregisterChild(child) {
  if (!child || !runningChildren.delete(child)) return;
  notifyChildren();
}

export function getChildPids() {
  return Array.from(runningChildren).map((c) => c.pid).filter(Boolean);
}

export function isShuttingDown() {
  return shuttingDown;
}

/** Refuse new agy runs from now on and kill every run still in flight (whole process tree). */
export function beginShutdown() {
  shuttingDown = true;
  for (const child of runningChildren) {
    try {
      killProcessTree(child, true);
    } catch {
      // ignore
    }
  }
  runningChildren.clear();
  notifyChildren();
}

/**
 * Stop serving. The agy runs are killed first: their requests then fail at once instead of holding
 * server.close() open for as long as the run takes (up to the profile timeout). Connections still open
 * after `graceMs` are dropped.
 */
export async function shutdown({ graceMs = 3000 } = {}) {
  if (activeDesktopHost?.onShutdown) {
    try {
      await activeDesktopHost.onShutdown();
    } catch {
      // ignore
    }
  }
  beginShutdown();
  const server = registeredServer;
  if (!server) return;
  const closeIdle = () => {
    try {
      server.closeIdleConnections?.();
    } catch {
      // older Node
    }
  };
  closeIdle();
  // A keep-alive client's socket turns idle once its (now failed) request is answered: keep closing
  // those so the server closes as soon as the answers are out, not only when the grace period ends.
  const sweeper = setInterval(closeIdle, 100);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        // older Node
      }
      resolve();
    }, graceMs);
    timer.unref?.();
    try {
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  clearInterval(sweeper);
}

export function setDesktopHost(options = {}) {
  activeDesktopHost = {
    onChildrenChanged: typeof options.onChildrenChanged === "function" ? options.onChildrenChanged : null,
    onShutdown: typeof options.onShutdown === "function" ? options.onShutdown : null,
    shutdown,
  };
  return activeDesktopHost;
}

export function getDesktopHost() {
  return activeDesktopHost;
}

function notifyChildren() {
  if (!activeDesktopHost?.onChildrenChanged) return;
  try {
    activeDesktopHost.onChildrenChanged(getChildPids());
  } catch {
    // ignore
  }
}
