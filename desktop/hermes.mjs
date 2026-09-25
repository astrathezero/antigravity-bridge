/**
 * Hermes (0.21+) provider configuration for this bridge. The shape is the one Hermes 0.21.1 writes itself
 * (checked in a real ~/.hermes/config.yaml): the endpoint lives under `providers.<id>`, `api` is the base
 * URL (not an API type) and `models` maps each model id to { context_length }. The README's
 * `custom_providers:` is the pre-0.21 name.
 */
export const HERMES_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash-high",
  "gemini-3.1-pro-high",
  "claude-sonnet-4.6-thinking",
  "claude-opus-4.6-thinking",
  "antigravity",
];

export function hermesHome({ platform = process.platform, env = process.env, homedir }) {
  // Hermes Desktop keeps its runtime in %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere.
  if (platform === "win32" && env.LOCALAPPDATA) return `${env.LOCALAPPDATA}\\hermes`;
  return `${homedir}/.hermes`;
}

export function hermesSnippet({ port, apiKey, models = HERMES_MODELS, contextLimits = {}, providerId = "agy-bridge" }) {
  return [
    "# Antigravity Bridge (local) for Hermes 0.21+: merge into your Hermes profile's config.yaml",
    "model:",
    `  default: ${models[0]}`,
    `  provider: ${providerId}`,
    "providers:",
    `  ${providerId}:`,
    `    api: http://127.0.0.1:${port}/v1`,
    `    api_key: ${apiKey || "sk-agv-CREATE-A-KEY-FIRST"}`,
    "    name: Antigravity Bridge (local)",
    "    request_timeout_seconds: 1800   # agy answers take tens of seconds; keep this >= 300",
    "    models:",
    ...models.map((m) => `      ${m}:\n        context_length: ${contextLimits[m] || 1000000}`),
    "",
  ].join("\n");
}
