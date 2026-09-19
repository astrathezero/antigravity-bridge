import "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTools, formatToolsToSystemPrompt, parseToolCallsFromResponse } from "../src/translators/tools.mjs";
import { formatMessagesToPrompt, buildOpenAIResponse } from "../src/translators/openai.mjs";
import { buildAnthropicResponse, buildAnthropicStreamEvents } from "../src/translators/anthropic.mjs";
import { compactToolOutput, sanitizePromptForCli } from "../src/translators/context-compactor.mjs";

test("translators: normalizeTools handles OpenAI and Anthropic format", () => {
  const oaiTools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ];

  const normalized = normalizeTools(oaiTools);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].name, "get_weather");
  assert.equal(normalized[0].description, "Get current weather");

  const anthropicTools = [
    {
      name: "search_db",
      description: "Search database",
      input_schema: { type: "object", properties: { q: { type: "string" } } },
    },
  ];
  const normalizedAnth = normalizeTools(anthropicTools);
  assert.equal(normalizedAnth.length, 1);
  assert.equal(normalizedAnth[0].name, "search_db");
});

test("translators: parseToolCallsFromResponse extracts code blocks and JSON", () => {
  const modelOutput = `Here is the data:
\`\`\`json
{
  "tool_calls": [
    {
      "name": "get_weather",
      "arguments": { "city": "Bangkok" }
    }
  ]
}
\`\`\`
Hope that helps!`;

  const [cleanText, toolCalls] = parseToolCallsFromResponse(modelOutput, ["get_weather"]);
  assert.equal(cleanText, "Here is the data:\nHope that helps!");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "get_weather");
  assert.deepEqual(toolCalls[0].arguments, { city: "Bangkok" });
});

test("translators: formatMessagesToPrompt formats conversation", () => {
  const msgs = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
  ];
  const prompt = formatMessagesToPrompt(msgs);
  assert.ok(prompt.includes("[System Instructions]\nYou are helpful."));
  assert.ok(prompt.includes("[User]\nHi"));
  assert.ok(prompt.includes("[Assistant]\nHello!"));
});

test("translators: buildOpenAIResponse creates valid schema", () => {
  const resp = buildOpenAIResponse("Hello world", "gemini-3.8-flash");
  assert.equal(resp.object, "chat.completion");
  assert.equal(resp.model, "gemini-3.8-flash");
  assert.equal(resp.choices[0].message.content, "Hello world");
  assert.equal(resp.choices[0].finish_reason, "stop");
});

test("translators: buildAnthropicResponse creates valid schema", () => {
  const resp = buildAnthropicResponse("Hello Claude", "claude-sonnet-4-6");
  assert.equal(resp.type, "message");
  assert.equal(resp.model, "claude-sonnet-4-6");
  assert.equal(resp.content[0].type, "text");
  assert.equal(resp.content[0].text, "Hello Claude");
  assert.equal(resp.stop_reason, "end_turn");
});

test("translators: compactToolOutput truncates long content", () => {
  const longText = "A".repeat(2000);
  const compacted = compactToolOutput(longText, 500);
  assert.ok(compacted.length < 1000);
  assert.ok(compacted.includes("[truncated"));
});

test("translators: sanitizePromptForCli boundary slicing", () => {
  const shortPrompt = "Short prompt text";
  assert.equal(sanitizePromptForCli(shortPrompt, 1000), shortPrompt);

  const longPrompt =
    "[System Instructions]\nInstruction 1\nInstruction 2\n\n" +
    "[User]\n" + "A".repeat(500) + "\n\n" +
    "[Assistant]\n" + "B".repeat(500) + "\n\n" +
    "[User]\nFinal question";
  const sanitized = sanitizePromptForCli(longPrompt, 400);
  assert.ok(sanitized.length <= 450);
  assert.ok(sanitized.includes("[Middle context truncated:"));
  assert.ok(sanitized.includes("[System Instructions]"));
  assert.ok(sanitized.includes("Final question"));
});

test("translators: tool_calls JSON with raw newlines and non-JSON escapes inside strings still parses", async () => {
  const { parseToolCallsFromResponse, repairJsonText } = await import("../src/translators/tools.mjs");
  // What gemini-3.8-flash wrote for a multi-line python command: real newlines inside the JSON string
  // and a regex \s escape. JSON.parse rejects both.
  const reply = [
    "{",
    '  "tool_calls": [',
    "    {",
    '      "name": "terminal",',
    '      "arguments": {',
    "        \"command\": \"python3 -c '",
    "import re",
    'print(re.findall(r\\"a\\s+b\\", \\"a  b\\"))',
    "'\"",
    "      }",
    "    }",
    "  ]",
    "}",
  ].join("\n");
  assert.throws(() => JSON.parse(reply));
  const [text, calls] = parseToolCallsFromResponse(reply, ["terminal", "read_file"]);
  assert.equal(text, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "terminal");
  assert.equal(calls[0].arguments.command, "python3 -c '\nimport re\nprint(re.findall(r\"a\\s+b\", \"a  b\"))\n'");

  // Valid JSON is returned unchanged; text that is not a tool call is still not one.
  const valid = '{"tool_calls":[{"name":"read_file","arguments":{"path":"/x\\n\\t"}}]}';
  assert.equal(repairJsonText(valid), valid);
  assert.deepEqual(parseToolCallsFromResponse("just prose with a\nnewline", ["terminal"]), ["just prose with a\nnewline", null]);
  assert.equal(repairJsonText('{"a":"tab\there"}'), '{"a":"tab\\there"}');
  assert.equal(repairJsonText('{"a":"C:\\Users\\x"}'), '{"a":"C:\\\\Users\\\\x"}', "non-escape backslashes become literal");
  assert.equal(repairJsonText('{"a":"\\u00e9 \\\\ \\""}'), '{"a":"\\u00e9 \\\\ \\""}', "real escapes are kept");
});
