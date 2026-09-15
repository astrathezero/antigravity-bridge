import crypto from "node:crypto";

export function buildAnthropicResponse(
  outputText,
  model,
  parsedToolCalls = null,
  statusBanner = ""
) {
  const msgId = `msg_${crypto.randomBytes(12).toString("hex")}`;
  const content = [];
  let stopReason = "end_turn";

  if (parsedToolCalls && parsedToolCalls.length > 0) {
    if (outputText) {
      content.push({ type: "text", text: `${outputText}${statusBanner}` });
    }
    for (const tc of parsedToolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.arguments || {},
      });
    }
    stopReason = "tool_use";
  } else {
    content.push({
      type: "text",
      text: `${outputText}${statusBanner}`,
    });
  }

  return {
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(1, Math.floor(outputText.length / 4)),
      output_tokens: 50,
    },
  };
}

export function buildAnthropicStreamEvents(
  msgId,
  model,
  outputText,
  parsedToolCalls = null,
  statusBanner = ""
) {
  const events = [];

  events.push([
    "message_start",
    {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(1, Math.floor(outputText.length / 4)),
          output_tokens: 1,
        },
      },
    },
  ]);

  if (parsedToolCalls && parsedToolCalls.length > 0) {
    let blockIndex = 0;
    if (outputText) {
      events.push([
        "content_block_start",
        {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        },
      ]);
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: `${outputText}${statusBanner}` },
        },
      ]);
      events.push(["content_block_stop", { type: "content_block_stop", index: blockIndex }]);
      blockIndex++;
    }

    for (const tc of parsedToolCalls) {
      events.push([
        "content_block_start",
        {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
        },
      ]);
      const jsonStr = JSON.stringify(tc.arguments || {});
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: jsonStr },
        },
      ]);
      events.push(["content_block_stop", { type: "content_block_stop", index: blockIndex }]);
      blockIndex++;
    }

    events.push([
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 50 },
      },
    ]);
  } else {
    events.push([
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ]);
    events.push([
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${outputText}${statusBanner}` },
      },
    ]);
    events.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
    events.push([
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 50 },
      },
    ]);
  }

  events.push(["message_stop", { type: "message_stop" }]);
  return events;
}
