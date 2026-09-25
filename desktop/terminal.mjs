/**
 * Open a visible terminal window that runs one script. The agy sign-in needs a real terminal (its TUI
 * waits for answers to terminal queries and for a window size), and so does Google's installer.
 *
 * Windows: an ASCII-only .cmd run by cmd.exe in a console of its own (cmd.exe is on every Windows;
 * wt.exe is not on Windows 10, and treats ";" in its command line as its own separator). Every path and
 * value reaches the script as an environment variable, never as text in the file: cmd.exe decodes a
 * batch file with the console code page, so a Thai user name written into it would become another path,
 * while a variable's value stays Unicode.
 * macOS: a .command file opened in Terminal.app. Terminal starts it with its own environment, so the
 * values are exported at the top of the script, shell-quoted.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildWindowsScript(lines) {
  const text = ["@echo off", ...lines].join("\r\n") + "\r\n";
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) {
    throw new Error("A Windows script must be ASCII-only; pass paths and values as environment variables");
  }
  return text;
}

export function buildPosixScript(lines, env = {}) {
  const exports = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Bad variable name: ${k}`);
    return `export ${k}=${shQuote(v)}`;
  });
  return ["#!/bin/bash", ...exports, ...lines].join("\n") + "\n";
}

function spawned(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Writes `<dir>/<name>.cmd|.command|.sh` and opens it in a new terminal window. Resolves once the
 * terminal process started; rejects (instead of throwing later from an 'error' event) when it could not.
 */
export async function openTerminalScript({
  platform = process.platform,
  dir,
  name,
  env = {},
  windowsLines,
  posixLines,
  spawnFn = spawn,
}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const script = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(script, buildWindowsScript(windowsLines));
    // A console app started detached from a GUI app gets a console window of its own. /s + the extra
    // quotes: cmd.exe strips exactly the outer pair, whatever characters the path contains.
    await spawned(
      spawnFn("cmd.exe", ["/d", "/s", "/c", `""${script}""`], {
        env: { ...process.env, ...env },
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        windowsVerbatimArguments: true,
      })
    );
    return script;
  }

  const script = path.join(dir, platform === "darwin" ? `${name}.command` : `${name}.sh`);
  fs.writeFileSync(script, buildPosixScript(posixLines, env), { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  if (platform === "darwin") {
    await spawned(spawnFn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" }));
  } else {
    await spawned(spawnFn("x-terminal-emulator", ["-e", script], { detached: true, stdio: "ignore" }));
  }
  return script;
}
