import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PORT,
  parseTimeoutValue,
  extractModelAndTimeout,
  extractTimeoutFromPromptText,
  resolveModelFlags,
  isImageModel,
  getModelFamily,
} from "../src/config.mjs";

test("config: DEFAULT_PORT is 8008 unless overridden by the environment", () => {
  // A machine-wide bridge.env / .env may set PORT or ANTIGRAVITY_PORT (e.g. the Python bridge's 8000).
  const expected = parseInt(process.env.PORT || process.env.ANTIGRAVITY_PORT || "8008", 10);
  assert.equal(DEFAULT_PORT, expected);
});

test("config: parseTimeoutValue formats", () => {
  assert.equal(parseTimeoutValue("30s"), 30);
  assert.equal(parseTimeoutValue("5m"), 300);
  assert.equal(parseTimeoutValue("2min"), 120);
  assert.equal(parseTimeoutValue("1h"), 3600);
  assert.equal(parseTimeoutValue("500ms"), 0.5);
  assert.equal(parseTimeoutValue(60), 60);
  assert.equal(parseTimeoutValue("invalid"), null);
  assert.equal(parseTimeoutValue(null), null);
});

test("config: extractModelAndTimeout", () => {
  const [m1, t1] = extractModelAndTimeout("claude-sonnet-4-6:30s");
  assert.equal(m1, "claude-sonnet-4-6");
  assert.equal(t1, 30);

  const [m2, t2] = extractModelAndTimeout("gemini-3.8-flash@timeout=5m");
  assert.equal(m2, "gemini-3.8-flash");
  assert.equal(t2, 300);

  const [m3, t3] = extractModelAndTimeout("gemini-3.7-flash");
  assert.equal(m3, "gemini-3.7-flash");
  assert.equal(t3, null);
});

test("config: extractTimeoutFromPromptText", () => {
  const text1 = "Please solve this <!-- timeout: 45s --> quickly";
  assert.equal(extractTimeoutFromPromptText(text1), 45);

  const text2 = "Process [timeout: 2m] task";
  assert.equal(extractTimeoutFromPromptText(text2), 120);

  assert.equal(extractTimeoutFromPromptText("Normal prompt"), null);
});

test("config: resolveModelFlags", () => {
  const flags1 = resolveModelFlags("gemini-3.8-flash");
  assert.deepEqual(flags1, ["--model", "gemini-3.8-flash", "--effort", "high"]);

  const flags2 = resolveModelFlags("gemini-3.8-flash-low");
  assert.deepEqual(flags2, ["--model", "gemini-3.8-flash", "--effort", "low"]);

  const flags3 = resolveModelFlags("claude-sonnet-4-6");
  assert.deepEqual(flags3, ["--model", "claude-sonnet-4-6"]);

  const flags4 = resolveModelFlags("gpt-oss-120b-medium");
  assert.deepEqual(flags4, ["--model", "gpt-oss-120b", "--effort", "medium"]);
});

test("config: isImageModel", () => {
  assert.equal(isImageModel("gemini-3.1-flash-image"), true);
  assert.equal(isImageModel("imagen-3"), true);
  assert.equal(isImageModel("nano-banana"), true);
  assert.equal(isImageModel("gemini-3.8-flash"), false);
  assert.equal(isImageModel("claude-sonnet-4-6"), false);
});

test("config: getModelFamily", () => {
  assert.equal(getModelFamily("gemini-3.8-flash"), "gemini");
  assert.equal(getModelFamily("claude-sonnet-4-6"), "claude");
  assert.equal(getModelFamily("claude-opus-4.6"), "claude");
  assert.equal(getModelFamily("gpt-oss-120b"), "gpt-oss");
  assert.equal(getModelFamily("other-model"), "other");
});
