import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  keyringBackend,
  readToken,
  writeToken,
  deleteToken,
  KEYRING_TARGET,
  WINCRED_TARGET,
} from "../src/core/keyring.mjs";
import { injectOsKeyringToken, extractOsKeyringToken } from "../src/core/keyring-sync.mjs";

test("keyring: backend resolution by platform and override", () => {
  assert.equal(keyringBackend("darwin").kind, "darwin");
  assert.equal(keyringBackend("win32").kind, "win32");
  assert.equal(keyringBackend("linux").kind, "linux");
  assert.equal(keyringBackend("sunos").kind, "none");

  const orig = process.env.ANTIGRAVITY_KEYRING_BACKEND;
  try {
    process.env.ANTIGRAVITY_KEYRING_BACKEND = "file:/tmp/test-keyring.json";
    const b = keyringBackend("darwin");
    assert.equal(b.kind, "file");
    assert.equal(b.path, "/tmp/test-keyring.json");
  } finally {
    if (orig !== undefined) process.env.ANTIGRAVITY_KEYRING_BACKEND = orig;
    else delete process.env.ANTIGRAVITY_KEYRING_BACKEND;
  }
});

test("keyring: file backend write, read, and delete round-trip", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agv-keyring-test-"));
  const tmpFile = path.join(tmpDir, "keyring.json");
  const backend = { kind: "file", path: tmpFile };

  try {
    // 1. Initial read should be null
    assert.equal(readToken(backend), null);

    // 2. Write token
    const tokenObj = {
      token: {
        access_token: "ya29.test_access_token_12345",
        refresh_token: "1//04test_refresh_token_abcde",
        token_type: "Bearer",
        expiry: "2026-12-31T23:59:59Z",
      },
      auth_method: "consumer",
    };
    const ok = writeToken(tokenObj, backend);
    assert.equal(ok, true);
    assert.ok(fs.existsSync(tmpFile));

    // Check file permissions (on POSIX)
    if (process.platform !== "win32") {
      const stat = fs.statSync(tmpFile);
      assert.equal((stat.mode & 0o777), 0o600);
    }

    // 3. Read token back
    const readBack = readToken(backend);
    assert.deepEqual(readBack, tokenObj);

    // 4. Test keyring-sync delegation via env override
    const origEnv = process.env.ANTIGRAVITY_KEYRING_BACKEND;
    try {
      process.env.ANTIGRAVITY_KEYRING_BACKEND = `file:${tmpFile}`;
      const extracted = extractOsKeyringToken();
      assert.deepEqual(extracted, tokenObj);

      const updatedObj = { ...tokenObj, auth_method: "updated" };
      injectOsKeyringToken(JSON.stringify(updatedObj));
      assert.deepEqual(extractOsKeyringToken(), updatedObj);
    } finally {
      if (origEnv !== undefined) process.env.ANTIGRAVITY_KEYRING_BACKEND = origEnv;
      else delete process.env.ANTIGRAVITY_KEYRING_BACKEND;
    }

    // 5. Delete token
    const delOk = deleteToken(backend);
    assert.equal(delOk, true);
    assert.equal(fs.existsSync(tmpFile), false);
    assert.equal(readToken(backend), null);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
