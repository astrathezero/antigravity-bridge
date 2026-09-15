import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isQuotaOrRateLimitError,
  parseQuotaResetSeconds,
  formatCooldownDuration,
} from "../src/core/profile-manager.mjs";

test("quota: isQuotaOrRateLimitError patterns", () => {
  assert.equal(
    isQuotaOrRateLimitError("RESOURCE_EXHAUSTED: You have reached your individual quota limit."),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("Rate limit exceeded. Resets in 74h 7m 25s."),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("HTTP 429 Too Many Requests"),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("The model is overloaded. Please try again later."),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("Capacity error: temporary resource exhaustion"),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("503 Service Unavailable: backend overloaded"),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("Daily quota limit reached for this project"),
    true
  );
  assert.equal(
    isQuotaOrRateLimitError("SyntaxError: Unexpected token"),
    false
  );
});

test("quota: parseQuotaResetSeconds formats", () => {
  // 74h 7m 25s = 74*3600 + 7*60 + 25 = 266400 + 420 + 25 = 266845
  const sec1 = parseQuotaResetSeconds("Resets in 74h7m25s.");
  assert.equal(sec1, 266845);

  // 1d 2h = 86400 + 7200 = 93600
  const sec2 = parseQuotaResetSeconds("Resets in 1d 2h");
  assert.equal(sec2, 93600);

  // Retry after 60s
  const sec3 = parseQuotaResetSeconds("Retry after 60s");
  assert.equal(sec3, 60);

  // Try again in 15m
  const sec4 = parseQuotaResetSeconds("Try again in 15m");
  assert.equal(sec4, 900);

  // wait: 2h
  const sec5 = parseQuotaResetSeconds("wait: 2h");
  assert.equal(sec5, 7200);

  assert.equal(parseQuotaResetSeconds("No timer here"), null);
});

test("quota: formatCooldownDuration", () => {
  assert.equal(formatCooldownDuration(266845), "3d 2h 7m 25s");
  assert.equal(formatCooldownDuration(3600), "1h");
  assert.equal(formatCooldownDuration(45), "45s");
  assert.equal(formatCooldownDuration(0), "ready");
  assert.equal(formatCooldownDuration(-10), "ready");
});

test("quota: ProfileManager banner and quota percent", async () => {
  const { ProfileManager } = await import("../src/core/profile-manager.mjs");
  const pm = new ProfileManager(["test_p1", "test_p2"]);
  assert.equal(pm.get_estimated_quota_percent("test_p1"), 100);

  const banner = pm.build_profile_quota_banner("test_p1");
  assert.ok(banner.includes("Antigravity Profile:"));
  assert.ok(banner.includes("test_p1"));
  assert.ok(banner.includes("Quota Pool:"));
  assert.ok(banner.includes("Ready (Gemini)"));
  assert.ok(banner.startsWith("\n---"));

  // Simulate cooldown on test_p2
  pm.state["test_p2"].family_cooldowns = {
    gemini: Math.floor(Date.now() / 1000) + 3600,
    claude: 0,
    "gpt-oss": 0,
  };
  const bannerWithFallback = pm.build_profile_quota_banner("test_p1");
  assert.ok(bannerWithFallback.includes("in Cooldown (Model Fallback)"));
  assert.ok(bannerWithFallback.includes("Model Fallback Active:"));

  // Check status summary metrics
  const summary = pm.get_status_summary();
  assert.equal(summary["test_p1"].available, true);
  assert.equal(summary["test_p1"].concurrency_status, "IDLE");
  assert.equal(summary["test_p2"].sonnet_fallback_candidate, true);
});

