/**
 * BridgeSupervisor: runs the bridge (bridge-bootstrap.mjs) in an Electron utility process and keeps it
 * alive, the way systemd's Restart=always does on the server.
 *
 * - One bridge at a time: every handler checks that the process it belongs to is still the current one,
 *   so a process that is still exiting can never clear or replace its successor.
 * - Never stops or restarts a bridge with requests in flight unless told to (`force`): clients would
 *   get an error for every request cut (AGENTS.md, "Self-Hosting Danger").
 * - /health is polled with an API key, since without one the bridge only answers liveness.
 * - Crash loop guard: restarts back off 1-60 s and stop after 10 exits within 5 minutes.
 * - The log (file + 500-line ring for the UI) is split into whole lines and masked before it is kept.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const BACKOFF_S = [1, 2, 5, 10, 30, 60];
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 5;

export function maskSecrets(line, knownSecrets = []) {
  let out = String(line);
  for (const s of knownSecrets) if (s && s.length >= 8) out = out.split(s).join("***");
  return out
    .replace(/sk-agv-[A-Za-z0-9._-]+/g, "sk-agv-***")
    .replace(/ya29\.[0-9A-Za-z_.-]+/g, "ya29.***")
    .replace(/1\/\/[0-9A-Za-z_-]{20,}/g, "1//***")
    .replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+"/g, '$1***"')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1***");
}

export class BridgeSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.entry = options.entry;
    this.cwd = options.cwd;
    this.logFile = options.logFile;
    this.port = options.port || 8008;
    this.envFn = typeof options.env === "function" ? options.env : () => options.env || {};
    this.getApiKey = options.getApiKey || (() => null);
    this.knownSecrets = options.knownSecrets || (() => []);
    this.fork = options.fork || null; // (entry, args, opts) => child; defaults to Electron's utilityProcess

    this.child = null;
    this.state = "stopped"; // starting | healthy | degraded | unresponsive | stopped | crashloop | port-busy
    this.lastHealth = null;
    this.recentLogs = [];
    this.reportedChildPids = [];
    this.crashTimes = [];
    this.restartAttempts = 0;
    this.healthySince = 0;
    this.startedAt = 0;
    this.restartTimer = null;
    this.healthTimer = null;
    this.stopping = false;
    this.logStream = null;
    this.logBytes = 0;
  }

  getRingLogs() {
    return this.recentLogs.slice();
  }

  appendLog(text) {
    const masked = maskSecrets(text, this.knownSecrets()).trimEnd();
    if (!masked) return;
    const entry = `[${new Date().toISOString()}] ${masked}`;
    this.recentLogs.push(entry);
    if (this.recentLogs.length > 500) this.recentLogs.shift();
    this.emit("log", entry);
    this.writeLogFile(entry + "\n");
  }

  writeLogFile(text) {
    if (!this.logFile) return;
    try {
      if (!this.logStream) {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
        this.logBytes = fs.existsSync(this.logFile) ? fs.statSync(this.logFile).size : 0;
        this.logStream = fs.createWriteStream(this.logFile, { flags: "a", mode: 0o600 });
        this.logStream.on("error", () => {
          this.logFile = null; // disk full / no permission: keep the in-memory log only
          this.logStream = null;
        });
      }
      this.logStream.write(text);
      this.logBytes += Buffer.byteLength(text);
      if (this.logBytes > LOG_MAX_BYTES) this.rotateLog();
    } catch {
      // Ignore file log errors
    }
  }

  rotateLog() {
    const stream = this.logStream;
    this.logStream = null;
    this.logBytes = 0;
    stream?.end(() => {
      try {
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
          if (fs.existsSync(`${this.logFile}.${i}`)) fs.renameSync(`${this.logFile}.${i}`, `${this.logFile}.${i + 1}`);
        }
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      } catch {
        // Ignore rotation errors
      }
    });
  }

  /** stdout/stderr arrive in chunks that split lines (and tokens): keep the tail until its newline. */
  lineReader(prefix) {
    let pending = "";
    return (chunk) => {
      pending += chunk.toString("utf-8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      if (pending.length > 64 * 1024) {
        lines.push(pending);
        pending = "";
      }
      for (const line of lines) if (line) this.appendLog(prefix + line);
    };
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state, this.lastHealth);
  }

  checkPortAvailable(port = this.port) {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(port, "127.0.0.1");
    });
  }

  /** A request to the running bridge, with the API key. Resolves { status, json } or rejects. */
  async request(pathname, { method = "GET", body = null, timeoutMs = 5000 } = {}) {
    const headers = {};
    const key = this.getApiKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== null) headers["Content-Type"] = "application/json";
    const res = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Not JSON
    }
    return { status: res.status, json };
  }

  /** Requests in flight as of the last authenticated health check, or null when unknown. */
  inFlight() {
    const n = this.lastHealth?.concurrency?.active_in_flight;
    return typeof n === "number" ? n : null;
  }

  async start() {
    if (this.child || this.state === "starting") return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.setState("starting");
    this.appendLog(`[SUPERVISOR] Starting Antigravity Bridge on port ${this.port}...`);

    if (!(await this.checkPortAvailable(this.port))) {
      let other = false;
      try {
        other = (await this.request("/health", { timeoutMs: 2000 })).json?.service === "antigravity-bridge";
      } catch {
        // Not an HTTP service
      }
      const why = other
        ? `Another Antigravity Bridge (CLI, LaunchAgent or Scheduled Task) already answers on port ${this.port}. Stop it, or choose another port in Settings.`
        : `Port ${this.port} is used by another program. Choose another port in Settings.`;
      this.appendLog(`[SUPERVISOR] ${why}`);
      this.setState("port-busy");
      this.emit("fatal", why);
      return;
    }

    let child;
    try {
      if (this.cwd) fs.mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
      const fork = this.fork || (await import("electron")).utilityProcess.fork;
      child = fork(this.entry, [], {
        env: this.envFn(),
        cwd: this.cwd || undefined,
        stdio: "pipe",
        serviceName: "antigravity-bridge",
      });
    } catch (err) {
      this.appendLog(`[SUPERVISOR] Failed to launch the bridge process: ${err.message}`);
      this.setState("stopped");
      this.emit("fatal", `Failed to launch the bridge: ${err.message}`);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.reportedChildPids = [];
    child.stdout?.on("data", this.lineReader(""));
    child.stderr?.on("data", this.lineReader("[ERR] "));
    child.on("message", (msg) => {
      if (this.child === child && msg?.type === "children" && Array.isArray(msg.pids)) this.reportedChildPids = msg.pids;
    });
    child.on("exit", (code) => {
      this.appendLog(`[SUPERVISOR] Bridge process exited with code ${code}.`);
      child.exitCode = code ?? 0;
      child.emit("gone");
      if (this.child !== child) return; // an older process finishing its exit: not ours to act on
      this.child = null;
      this.lastHealth = null;
      if (this.stopping) this.setState("stopped");
      else this.handleCrash(code);
    });
    this.startHealthPolling();
  }

  startHealthPolling() {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => this.pollHealth(), 5000);
    setTimeout(() => this.pollHealth(), 700);
  }

  async pollHealth() {
    if (!this.child || this.stopping) return;
    try {
      const { status, json } = await this.request("/health", { timeoutMs: 3000 });
      if (status === 200 && json?.status === "ok") {
        this.lastHealth = json;
        const profiles = Object.values(json.profiles || {});
        const exhausted = profiles.length > 0 && profiles.every((p) => p && p.available === false);
        if (!this.healthySince) this.healthySince = Date.now();
        // A bridge that stayed up for a minute has recovered: the next crash starts the backoff afresh.
        if (Date.now() - this.healthySince > 60_000) this.restartAttempts = 0;
        this.setState(exhausted ? "degraded" : "healthy");
        this.emit("health", json);
        return;
      }
    } catch {
      // Unreachable
    }
    this.healthySince = 0;
    if (this.state === "healthy" || this.state === "degraded") this.setState("unresponsive");
    else if (this.state === "starting" && Date.now() - this.startedAt > 30_000) {
      this.appendLog("[SUPERVISOR] The bridge process runs but has not answered /health for 30 s.");
      this.setState("unresponsive");
    }
  }

  handleCrash(code) {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < 5 * 60_000).concat(now);
    if (this.crashTimes.length > 10) {
      clearInterval(this.healthTimer);
      this.appendLog("[SUPERVISOR] Crash loop (more than 10 exits in 5 minutes): not restarting. See the log above.");
      this.setState("crashloop");
      this.emit("fatal", "The bridge keeps crashing, so it was not restarted. Open the log for details.");
      return;
    }
    const delay = BACKOFF_S[Math.min(this.restartAttempts, BACKOFF_S.length - 1)];
    this.restartAttempts++;
    this.appendLog(`[SUPERVISOR] Bridge exited unexpectedly (code ${code}); restarting in ${delay}s (attempt ${this.restartAttempts}).`);
    this.setState("stopped");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.start();
    }, delay * 1000);
  }

  noteResume() {
    this.appendLog("[SUPERVISOR] System resumed from sleep; checking the bridge.");
    setTimeout(() => this.pollHealth(), 1000);
  }

  waitGone(child, ms) {
    if (child.exitCode !== undefined && child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      child.once("gone", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Stops the bridge. With requests in flight and no `force`, nothing is stopped and { stopped: false,
   * busy: n } is returned so the caller can ask the user first.
   */
  async stop({ force = false } = {}) {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.setState("stopped");
      return { stopped: true };
    }
    if (!force) {
      await this.pollHealth();
      const busy = this.inFlight();
      if (busy) return { stopped: false, busy };
    }

    this.stopping = true;
    clearInterval(this.healthTimer);
    this.appendLog("[SUPERVISOR] Stopping the bridge...");
    try {
      child.postMessage({ type: "shutdown", graceMs: 3000 });
    } catch {
      // Channel already closed
    }
    let gone = await this.waitGone(child, 8000);
    if (!gone) {
      this.appendLog("[SUPERVISOR] The bridge did not exit in time; terminating it.");
      try {
        child.kill();
      } catch {
        // Already gone
      }
      gone = await this.waitGone(child, 3000);
    }
    // TerminateProcess on Windows leaves agy (a separate process tree) running: end what was reported.
    if (process.platform === "win32") {
      for (const pid of this.reportedChildPids) {
        try {
          spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
        } catch {
          // Ignore
        }
      }
    }
    this.reportedChildPids = [];
    if (this.child === child) this.child = null;
    this.lastHealth = null;
    this.healthySince = 0;
    this.stopping = false;
    this.setState("stopped");
    return { stopped: true, clean: gone };
  }

  async restart({ force = false } = {}) {
    const res = await this.stop({ force });
    if (!res.stopped) return res;
    await this.start();
    return { restarted: true };
  }

  setPort(port) {
    this.port = port;
  }
}
