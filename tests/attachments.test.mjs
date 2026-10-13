import { TEST_STATE_DIR } from "./_env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridgeServer } from "../src/server.mjs";
import { ProfileManager } from "../src/core/profile-manager.mjs";
import { AttachmentReadPolicy } from "../src/core/executor.mjs";
import { resolveFooter } from "../src/config.mjs";
import {
  materializeAttachments,
  attachmentInstructions,
  AttachmentError,
  sniffMime,
} from "../src/translators/attachments.mjs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
const PDF = Buffer.from("%PDF-1.4\nfake pdf body\n%%EOF\n");
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString("base64")}`;

function attachDirsIn(base) {
  return fs.readdirSync(base).filter((d) => d.startsWith("agy-attach-"));
}

test("attachments: an OpenAI image_url data URL becomes a private file and a text line naming it", () => {
  const base = fs.mkdtempSync(path.join(TEST_STATE_DIR, "att-"));
  const messages = [
    { role: "system", content: "be brief" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        // declared jpeg, really a PNG: the bytes decide the type and the extension
        { type: "image_url", image_url: { url: dataUrl("image/jpeg", PNG), detail: "high" } },
      ],
    },
  ];
  const att = materializeAttachments(messages, { baseDir: base });
  try {
    assert.equal(att.files.length, 1);
    const f = att.files[0];
    assert.equal(f.mime, "image/png");
    assert.ok(f.path.endsWith(".png"));
    assert.deepEqual(fs.readFileSync(f.path), PNG);
    assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(att.dir).mode & 0o777, 0o700);
    const parts = att.messages[1].content;
    assert.deepEqual(parts[0], { type: "text", text: "what is this?" });
    assert.equal(parts[1].type, "text");
    assert.ok(parts[1].text.includes(f.path) && parts[1].text.startsWith("[Attached image"));
    assert.ok(!JSON.stringify(att.messages).includes(PNG.toString("base64")), "no base64 left in the prompt");
    assert.equal(messages[1].content[1].type, "image_url", "the caller's messages are not mutated");
    const block = attachmentInstructions(att.files);
    assert.ok(block.startsWith("[Attachments]") && block.includes(`1. ${f.path} (image/png)`) && block.includes("view_file"));
  } finally {
    att.cleanup();
  }
  assert.equal(fs.existsSync(att.dir), false, "cleanup removes the directory");
});

test("attachments: Anthropic image/document blocks, an image inside a tool_result, and a resent identical image", () => {
  const base = fs.mkdtempSync(path.join(TEST_STATE_DIR, "att-"));
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
        { type: "document", title: "invoice.pdf", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } },
        { type: "document", source: { type: "text", media_type: "text/plain", data: "plain doc body" } },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "screenshot taken" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
          ],
        },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
      ],
    },
  ];
  const att = materializeAttachments(messages, { baseDir: base });
  try {
    assert.deepEqual(att.files.map((f) => f.mime), ["image/jpeg", "application/pdf", "image/png"], "the resent jpeg is written once");
    assert.equal(att.files[1].filename, "invoice.pdf");
    assert.ok(att.files[1].path.endsWith(".pdf"));
    const first = att.messages[0].content;
    assert.ok(first[1].text.startsWith('[Attached PDF "invoice.pdf"'));
    assert.ok(first[2].text.includes("plain doc body"), "a text document is inlined as text");
    const tr = att.messages[2].content[0];
    assert.equal(tr.type, "tool_result");
    assert.equal(tr.content[1].type, "text");
    assert.ok(tr.content[1].text.includes(att.files[2].path), "the tool_result image is rewritten too");
    assert.ok(att.messages[2].content[1].text.includes(att.files[0].path), "the resent image points at the first file");
  } finally {
    att.cleanup();
  }
});

test("attachments: remote URLs and plain messages write nothing; bad data is a 400-type error with nothing left behind", () => {
  const base = fs.mkdtempSync(path.join(TEST_STATE_DIR, "att-"));
  const plain = [{ role: "user", content: "hi" }];
  const p = materializeAttachments(plain, { baseDir: base });
  assert.equal(p.messages, plain);
  assert.equal(p.dir, null);

  const url = materializeAttachments([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }], { baseDir: base });
  assert.equal(url.files.length, 0);
  assert.ok(url.messages[0].content[0].text.includes("not downloaded") && url.messages[0].content[0].text.includes("https://example.com/a.png"));
  assert.deepEqual(attachDirsIn(base), []);

  assert.throws(
    () => materializeAttachments([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,@@not-base64@@" } }] }], { baseDir: base }),
    (e) => e instanceof AttachmentError && /not valid base64/.test(e.message)
  );
  assert.throws(
    () =>
      materializeAttachments(
        [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } },
              { type: "image_url", image_url: { url: dataUrl("image/bmp", Buffer.from("BM not supported")) } },
            ],
          },
        ],
        { baseDir: base }
      ),
    (e) => e instanceof AttachmentError && /unsupported type 'image\/bmp'/.test(e.message)
  );
  assert.deepEqual(attachDirsIn(base), [], "the file written before the failure is removed");
});

test("attachments: only the most recent N are forwarded", () => {
  const base = fs.mkdtempSync(path.join(TEST_STATE_DIR, "att-"));
  const img = (buf) => ({ type: "image_url", image_url: { url: dataUrl("image/png", buf) } });
  const messages = [
    { role: "user", content: [img(Buffer.concat([PNG, Buffer.from("1")]))] },
    { role: "user", content: [img(Buffer.concat([PNG, Buffer.from("2")])), img(Buffer.concat([PNG, Buffer.from("3")]))] },
  ];
  const att = materializeAttachments(messages, { baseDir: base, limit: 2 });
  try {
    assert.equal(att.files.length, 2);
    assert.ok(att.messages[0].content[0].text.startsWith("[Earlier attachment omitted"));
    assert.ok(fs.readFileSync(att.files[1].path).toString().endsWith("3"));
  } finally {
    att.cleanup();
  }
});

test("attachments: sniffMime recognises the supported formats", () => {
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(JPEG), "image/jpeg");
  assert.equal(sniffMime(PDF), "application/pdf");
  assert.equal(sniffMime(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffMime(Buffer.from("\0\0\0\x18ftypheic\0\0")), "image/heic");
  assert.equal(sniffMime(Buffer.from("hello")), null);
});

test("executor: AttachmentReadPolicy lets view_file through for the request's attachment files only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-attach-"));
  const file = path.join(dir, "attachment-1.png");
  fs.writeFileSync(file, PNG);
  try {
    const policy = new AttachmentReadPolicy([file]);
    assert.equal(policy.allows("view_content_chunk", { document_id: "x" }), false, "no chunk paging before a file was opened");
    assert.equal(policy.allows("view_file", { AbsolutePath: "/etc/passwd" }), false);
    assert.equal(policy.allows("view_file", { AbsolutePath: path.join(dir, "attachment-2.png") }), false, "a sibling that is not an attachment");
    assert.equal(policy.allows("run_command", { CommandLine: `cat ${file}` }), false);
    assert.equal(policy.allows("list_dir", { DirectoryPath: dir }), false);
    // agy printed the un-normalised tmpdir form in production-like runs (".../T//agy-attach-x/...")
    assert.equal(policy.allows("view_file", { AbsolutePath: file.replace("agy-attach-", "/agy-attach-") }), true);
    assert.equal(policy.allows("view_file", { AbsolutePath: fs.realpathSync(file) }), true, "the realpath form (/private/var on macOS)");
    assert.equal(policy.allows("view_content_chunk", { document_id: "x", position: 1 }), true);
    assert.equal(new AttachmentReadPolicy([]).allows("view_file", { AbsolutePath: file }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: resolveFooter (operator switch, header, body field, endpoint default)", () => {
  const prevHide = process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS;
  delete process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS;
  try {
    assert.equal(resolveFooter({}), true);
    assert.equal(resolveFooter({ endpointDefault: false }), false);
    assert.equal(resolveFooter({ header: "off" }), false);
    assert.equal(resolveFooter({ header: "0", bodyValue: true }), false, "the header wins over the body");
    assert.equal(resolveFooter({ header: "on", endpointDefault: false }), true);
    assert.equal(resolveFooter({ bodyValue: false }), false);
    assert.equal(resolveFooter({ bodyValue: true, endpointDefault: false }), true);
    assert.equal(resolveFooter({ header: "garbage" }), true, "an unknown header value leaves the default");
    process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS = "1";
    assert.equal(resolveFooter({ header: "on", bodyValue: true }), false, "the operator's switch wins");
  } finally {
    if (prevHide === undefined) delete process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS; else process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS = prevHide;
  }
});

// agy stand-in: opens every file listed under [Attachments] with view_file the way agy does, then answers
// with what it read from each one (type marker + size), so the test sees the bytes reached "the model".
// ANTIGRAVITY_TEST_VIEW_OTHER=1 makes it open a path that is not an attachment instead.
const FAKE_AGY_VIEW_SRC = [
  'const fs = require("node:fs");',
  "const prompt = process.argv[process.argv.length - 1];",
  "const paths = [...prompt.matchAll(/^\\d+\\. (\\/\\S+) \\(/gm)].map((m) => m[1]);",
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'if (process.env.ANTIGRAVITY_TEST_VIEW_OTHER === "1") paths.unshift("/etc/hosts");',
  "let i = 1;",
  'for (const p of paths) out({ event: "step_update", step_update: { step_index: i++, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: p } } } });',
  'const seen = paths.map((p) => { const b = fs.readFileSync(p); return b.subarray(1, 4).toString("latin1") + ":" + b.length; }).join(",");',
  "setTimeout(() => {",
  '  const reply = "saw " + (seen || "nothing");',
  '  out({ event: "step_update", step_update: { step_index: i, state: "DONE", step_type: "agent_response", text_delta: reply } });',
  '  out({ event: "result", result: { status: "SUCCESS", response: reply } });',
  "}, 200);",
  "",
].join("\n");

test("server: /v1/vision endpoints forward images and PDFs to agy's view_file, with no footer unless asked; payloads over 20 MB are accepted", async () => {
  const prevHide = process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS;
  delete process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS;
  delete process.env.ANTIGRAVITY_ALLOW_CLI_TOOLS;
  const helper = path.join(TEST_STATE_DIR, "fake-agy-view.cjs");
  fs.writeFileSync(helper, FAKE_AGY_VIEW_SRC);
  const pm = new ProfileManager(["zz_att1"]);
  pm.reset_all();
  const port = 8141;
  const { server } = createBridgeServer({ port, host: "127.0.0.1", profileManager: pm, customCmd: `node ${helper} {prompt}`, apiKeys: {} });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const post = async (pathname, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const before = new Set(attachDirsIn(os.tmpdir()));
  try {
    // OpenAI shape, vision endpoint: the image reaches agy, no footer by default.
    const oai = await post("/v1/vision/chat/completions", {
      model: "antigravity",
      messages: [{ role: "user", content: [{ type: "text", text: "what is it?" }, { type: "image_url", image_url: { url: dataUrl("image/png", PNG) } }] }],
    });
    assert.equal(oai.status, 200, JSON.stringify(oai.json).slice(0, 400));
    assert.equal(oai.json.choices[0].message.content, `saw PNG:${PNG.length}`);

    // The footer comes back on request (header), and stays on by default on the plain endpoint unless turned off.
    const on = await post(
      "/v1/vision/chat/completions",
      { model: "antigravity", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl("image/png", PNG) } }] }] },
      { "X-Antigravity-Footer": "on" }
    );
    assert.ok(on.json.choices[0].message.content.includes("Antigravity Profile"));
    const plain = await post("/v1/chat/completions", { model: "antigravity", messages: [{ role: "user", content: "hi" }] });
    assert.ok(plain.json.choices[0].message.content.includes("Antigravity Profile"), "existing endpoints keep the footer");
    const plainOff = await post("/v1/chat/completions", { model: "antigravity", antigravity_footer: false, messages: [{ role: "user", content: "hi" }] });
    assert.equal(plainOff.json.choices[0].message.content, "saw nothing");

    // Anthropic shape: an image and a PDF.
    const anth = await post("/v1/vision/messages", {
      model: "antigravity",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") } },
            { type: "text", text: "compare" },
          ],
        },
      ],
    });
    assert.equal(anth.status, 200, JSON.stringify(anth.json).slice(0, 400));
    assert.deepEqual(anth.json.content.map((c) => c.type), ["text"]);
    assert.equal(anth.json.content[0].text, `saw \xd8\xff\xe0:${JPEG.length},PDF:${PDF.length}`);

    // A 21 MB image (28 MB of JSON) is accepted.
    const big = Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024, 7)]);
    const bigResp = await post("/v1/vision/chat/completions", {
      model: "antigravity",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl("image/png", big) } }] }],
    });
    assert.equal(bigResp.status, 200, JSON.stringify(bigResp.json).slice(0, 400));
    assert.equal(bigResp.json.choices[0].message.content, `saw PNG:${big.length}`);

    // An unsupported type is refused up front.
    const bad = await post("/v1/vision/chat/completions", {
      model: "antigravity",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl("image/bmp", Buffer.from("BM....")) } }] }],
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /unsupported type/);

    // view_file on anything else is still blocked.
    process.env.ANTIGRAVITY_TEST_VIEW_OTHER = "1";
    process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES = "0";
    const other = await post("/v1/vision/chat/completions", {
      model: "antigravity",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl("image/png", PNG) } }] }],
    });
    assert.equal(other.status, 500);
    assert.match(other.json.error.message, /blocked[\s\S]*\/etc\/hosts/);
  } finally {
    delete process.env.ANTIGRAVITY_TEST_VIEW_OTHER;
    delete process.env.ANTIGRAVITY_TOOL_BLOCK_RETRIES;
    await new Promise((resolve) => server.close(resolve));
    if (prevHide === undefined) delete process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS; else process.env.ANTIGRAVITY_HIDE_PROFILE_STATUS = prevHide;
  }
  const leftover = attachDirsIn(os.tmpdir()).filter((d) => !before.has(d));
  assert.deepEqual(leftover, [], "every request's attachment directory is removed");
});
