import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { detectLocalProxy } from "../src/config.mjs";

// Seen on the production host on 2026-09-28: every agy run of all 17 profiles failed within 0.3 s with
// "Eligibility check failed: Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\":
// Not Found". That is how agy (Go) reports an HTTP proxy that answered its CONNECT with 404: the bridge
// took whatever listened on one of the usual proxy ports for a proxy.

/** A local TCP server answering the first bytes it receives with reply(buffer) (null = say nothing). */
async function fakeService(t, reply) {
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", (buf) => {
      const out = reply(buf);
      if (out !== null) sock.write(out);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

const webApp = (t) => fakeService(t, () => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
const silent = (t) => fakeService(t, () => null);
const httpProxy = (t) =>
  fakeService(t, (buf) => (buf.toString("latin1").startsWith("CONNECT daily-cloudcode-pa.googleapis.com:443 ") ? "HTTP/1.1 200 Connection established\r\n\r\n" : "HTTP/1.1 400 Bad Request\r\n\r\n"));
const socksProxy = (t) => fakeService(t, (buf) => (buf[0] === 0x05 ? Buffer.from([0x05, 0x00]) : null));

const PROXY_VARS = ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ANTIGRAVITY_NO_PROXY", "DISABLE_PROXY", "NO_PROXY"];

/** Run with no proxy variables in the environment (the test machine may have its own), restoring them after. */
function clearProxyEnv(t) {
  const saved = Object.fromEntries(PROXY_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_VARS) delete process.env[k];
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

const opts = (httpPorts, socksPorts = []) => ({ httpPorts, socksPorts, answerTimeoutMs: 500 });

test("proxy: a local port that is not a proxy is skipped, and the real proxy behind it is used", async (t) => {
  clearProxyEnv(t);
  const [app, quiet, proxy, socks] = [await webApp(t), await silent(t), await httpProxy(t), await socksProxy(t)];

  // The production case: a web app on the first HTTP proxy port. Before, agy was sent to it.
  let { result, lines } = await captureLogs(() => detectLocalProxy(true, opts([app, quiet, proxy])));
  assert.equal(result, `http://127.0.0.1:${proxy}`);
  const line = lines.find((l) => l.startsWith("[PROXY]"));
  assert.ok(line, "the decision is logged");
  assert.match(line, new RegExp(`127\\.0\\.0\\.1:${app} answered CONNECT with "HTTP/1\\.1 404 Not Found"`));
  assert.match(line, new RegExp(`127\\.0\\.0\\.1:${quiet} accepted the connection but did not answer`));

  // With no HTTP proxy at all, a SOCKS5 proxy (WARP on 40000 in production) is found after the web app.
  ({ result } = await captureLogs(() => detectLocalProxy(true, opts([app], [socks]))));
  assert.equal(result, `socks5://127.0.0.1:${socks}`);

  // A web app on a SOCKS port is not a SOCKS proxy either; nothing usable means a direct connection.
  ({ result, lines } = await captureLogs(() => detectLocalProxy(true, opts([app], [app]))));
  assert.equal(result, null);
  assert.match(lines.join("\n"), /\[PROXY\] no local proxy found, agy connects directly/);
  assert.match(lines.join("\n"), /did not accept a SOCKS5 greeting/);
});

test("proxy: an explicit proxy variable wins, is logged once without credentials, and ANTIGRAVITY_NO_PROXY=1 turns detection off", async (t) => {
  clearProxyEnv(t);
  const app = await webApp(t);
  process.env.HTTPS_PROXY = "http://user:secret@127.0.0.1:3128";
  let { result, lines } = await captureLogs(() => detectLocalProxy(true, opts([app])));
  assert.equal(result, "http://user:secret@127.0.0.1:3128", "agy gets the variable exactly as configured");
  const logged = lines.filter((l) => l.startsWith("[PROXY]"));
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("secret"), `credentials are not logged: ${logged[0]}`);
  assert.match(logged[0], /HTTPS_PROXY in the bridge's environment/);
  ({ lines } = await captureLogs(() => detectLocalProxy(true, opts([app]))));
  assert.equal(lines.filter((l) => l.startsWith("[PROXY]")).length, 0, "an unchanged decision is not logged again");

  delete process.env.HTTPS_PROXY;
  process.env.ANTIGRAVITY_NO_PROXY = "1";
  ({ result, lines } = await captureLogs(() => detectLocalProxy(true, opts([app]))));
  assert.equal(result, null);
  assert.match(lines.join("\n"), /\[PROXY\] proxy auto-detection is off/);
});
