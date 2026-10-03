import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PORT,
  parseTimeoutValue,
  extractModelAndTimeout,
  extractTimeoutFromPromptText,
  resolveModelFlags,
  SUPPORTED_MODELS,
  DEFAULT_FALLBACK_CHAIN,
  isImageModel,
  getModelFamily,
  isBenignSocketError,
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

  const flags3 = resolveModelFlags("claude-sonnet-5-5-medium");
  assert.deepEqual(flags3, ["--model", "claude-sonnet-5-5", "--effort", "medium"]);

  const flags4 = resolveModelFlags("gpt-oss-120b-medium");
  assert.deepEqual(flags4, ["--model", "gpt-oss-120b", "--effort", "medium"]);
});

// `agy models` on agy 1.2.16 (2026-10-03). agy rejects any other --model/--effort pair before it
// calls the API ("not recognized", "requires --effort"); gpt-oss-120b alone was seen to answer too.
const AGY_MODELS = new Set([
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
  "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
  "gemini-3.1-pro-high", "gemini-3.1-pro-low",
  "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high",
  "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium", "gpt-oss-120b",
]);

function agySelection(flags) {
  const model = flags[flags.indexOf("--model") + 1];
  const i = flags.indexOf("--effort");
  return i === -1 ? model : `${model}-${flags[i + 1]}`;
}

test("config: every listed model id and the default fallback chain reach agy as a model it offers", () => {
  const ids = [...Object.keys(SUPPORTED_MODELS).filter((m) => !SUPPORTED_MODELS[m][0].startsWith("ag/")), ...DEFAULT_FALLBACK_CHAIN];
  for (const id of ids) {
    assert.ok(AGY_MODELS.has(agySelection(resolveModelFlags(id))), `${id} -> ${resolveModelFlags(id).join(" ")}`);
  }
  assert.ok(Object.keys(SUPPORTED_MODELS).includes("claude-opus-5-5-high"));
  assert.ok(Object.keys(SUPPORTED_MODELS).includes("claude-sonnet-5-5-low"));
});

test("config: Claude 5.5 spellings and the retired 4.6 / gemini-3.5 ids resolve to what agy offers now", () => {
  const cases = {
    "claude-opus-5-5": "claude-opus-5-5-high",
    "claude-opus-5.5": "claude-opus-5-5-high",
    "claude-opus-5.5-low": "claude-opus-5-5-low",
    "claude-sonnet-5.5-thinking": "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium:5m": "claude-sonnet-5-5-medium",
    "claude-opus-4-6-thinking": "claude-opus-5-5-high",
    "claude-opus-4.6": "claude-opus-5-5-high",
    "claude-sonnet-4-6": "claude-sonnet-5-5-high",
    "claude-sonnet-4.6-thinking": "claude-sonnet-5-5-high",
    "gemini-3.6-flash": "gemini-3.6-flash-high",
    "gemini-3.5-flash": "gemini-3.6-flash-high",
    "gemini-3.5-flash-low": "gemini-3.6-flash-low",
  };
  for (const [id, want] of Object.entries(cases)) {
    assert.equal(agySelection(resolveModelFlags(id)), want, id);
  }
  for (const retired of ["claude-opus-4-6-thinking", "claude-sonnet-4.6", "gemini-3.5-flash"]) {
    assert.equal(Object.keys(SUPPORTED_MODELS).includes(retired), false, `${retired} is not advertised in /v1/models`);
  }
});

test("config: a retired Claude id is spawned as Claude 5.5, not passed to agy verbatim", async () => {
  const { parseCmdTemplate } = await import("../src/core/executor.mjs");
  const { argv } = parseCmdTemplate('agy --output-format stream-json -p "{prompt}"', "hi", "claude-opus-4-6-thinking");
  assert.deepEqual(argv.slice(0, 5), ["agy", "--model", "claude-opus-5-5", "--effort", "high"]);
  assert.ok(!argv.some((a) => a.includes("4-6") || a.includes("4.6")));
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

test("config: isBenignSocketError classifies client-disconnect codes only", () => {
  for (const code of ["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
    assert.equal(isBenignSocketError(Object.assign(new Error("x"), { code })), true, code);
  }
  for (const code of ["EACCES", "ENOENT", "ESOMETHINGELSE", undefined, ""]) {
    assert.equal(isBenignSocketError(Object.assign(new Error("x"), { code })), false, String(code));
  }
  assert.equal(isBenignSocketError(null), false);
  assert.equal(isBenignSocketError(undefined), false);
  assert.equal(isBenignSocketError(new Error("no code")), false);
});
