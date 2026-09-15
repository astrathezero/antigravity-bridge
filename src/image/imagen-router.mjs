import {
  DEFAULT_IMAGE_ROUTER_URL,
  DEFAULT_IMAGE_ROUTER_KEY,
} from "../config.mjs";

export async function generateImageViaRouter(
  prompt,
  modelName = "ag/gemini-3.1-flash-image",
  routerUrl = DEFAULT_IMAGE_ROUTER_URL,
  routerKey = DEFAULT_IMAGE_ROUTER_KEY,
  timeout = 60
) {
  let upstreamModel = modelName.startsWith("ag/") ? modelName : `ag/${modelName}`;
  if (upstreamModel !== "ag/gemini-3.1-flash-image") {
    upstreamModel = "ag/gemini-3.1-flash-image";
  }

  if (!routerUrl || !routerKey) {
    throw new Error(
      "Image router is not configured. Please set ANTIGRAVITY_IMAGE_ROUTER_URL and " +
      "ANTIGRAVITY_IMAGE_ROUTER_KEY in your environment or .env file."
    );
  }

  const baseUrl = routerUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${routerKey}`,
    "Content-Type": "application/json",
    "User-Agent": "AntigravityBridge-Node/2.0",
  };

  // 1. Try /images/generations
  try {
    const imgEndpoint = `${baseUrl}/images/generations`;
    const resp = await fetch(imgEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: upstreamModel,
        prompt,
        n: 1,
      }),
      signal: AbortSignal.timeout(timeout * 1000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const items = data.data || [];
      if (items.length > 0 && items[0].b64_json) {
        const b64 = items[0].b64_json;
        return [`\n![image](data:image/jpeg;base64,${b64})`, b64];
      }
    }
  } catch (err) {
    // Fallback to chat completions
  }

  // 2. Fallback to /chat/completions
  const chatEndpoint = `${baseUrl}/chat/completions`;
  const resp = await fetch(chatEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: upstreamModel,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (resp.ok) {
    const data = await resp.json();
    const choices = data.choices || [];
    if (choices.length > 0) {
      const content = choices[0]?.message?.content || "";
      const b64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
      const b64 = b64Match ? b64Match[1] : null;
      return [content, b64];
    }
  }

  throw new Error("Failed to retrieve generated image from router");
}
