import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Images and PDFs a client sends inline (OpenAI `image_url` / `file` parts with a base64 data URL,
 * Anthropic `image` / `document` blocks with a base64 source).
 *
 * agy takes text only: `--input-format stream-json` rejects any content block but "text" ("stream input
 * content block type \"image\" is not supported"), and an `@path` mention in a print-mode prompt is not
 * attached either. What does reach the model is agy's own `view_file` tool: it sends an image or a PDF
 * (scanned ones too) to Gemini/Claude as an inline media part. So the bridge decodes each attachment
 * into a private temporary directory, replaces the part with a text line naming the file, tells the
 * model to open exactly those files, and the executor lets view_file through for those paths only
 * (see AttachmentReadPolicy in core/executor.mjs). The directory is removed when the request ends.
 */

export const SUPPORTED_ATTACHMENT_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const MIME_ALIASES = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "application/x-pdf": "application/pdf" };

/** Most recent attachments forwarded per request (older ones become a text notice). */
export function maxAttachments() {
  const n = parseInt(process.env.ANTIGRAVITY_MAX_ATTACHMENTS || "10", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

export class AttachmentError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_ATTACHMENT";
  }
}

function normalizeMime(mime) {
  const m = String(mime || "").trim().toLowerCase();
  return MIME_ALIASES[m] || m;
}

/** The real type from the file's first bytes; a client's declared type is often wrong. */
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  const ascii = (a, b) => buf.subarray(a, b).toString("latin1");
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return null;
}

/** "data:<mime>;base64,<data>" -> { mime, base64 } | null (null for anything that is not a base64 data URL). */
export function parseDataUrl(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const header = value.slice(5, comma).split(";").map((s) => s.trim());
  if (!header.slice(1).some((s) => s.toLowerCase() === "base64")) return null;
  return { mime: header[0] || "", base64: value.slice(comma + 1) };
}

function decodeBase64(data, label) {
  const clean = String(data || "").replace(/\s+/g, "");
  if (!clean || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) {
    throw new AttachmentError(`${label}: the data is not valid base64`);
  }
  const buf = Buffer.from(clean, clean.includes("-") || clean.includes("_") ? "base64url" : "base64");
  if (buf.length === 0) throw new AttachmentError(`${label}: the data is empty`);
  return buf;
}

function safeFilename(name) {
  if (typeof name !== "string") return "";
  return path.basename(name).replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120);
}

/**
 * What one content part carries, or null when it is not an attachment part.
 * { kind: "inline", mime, base64, filename } | { kind: "url", url } | { kind: "text", text } | { kind: "unavailable", what }
 */
function describePart(part) {
  if (!part || typeof part !== "object") return null;
  const t = part.type;
  if (t === "image_url" || t === "input_image") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (typeof url !== "string" || !url) return { kind: "unavailable", what: "an image part without a URL" };
    const data = parseDataUrl(url);
    if (data) return { kind: "inline", mime: data.mime, base64: data.base64, filename: "" };
    return { kind: "url", url };
  }
  if (t === "file" || t === "input_file") {
    const f = t === "file" ? part.file || {} : part;
    const fileData = f.file_data;
    if (typeof fileData === "string" && fileData) {
      const data = parseDataUrl(fileData);
      if (data) return { kind: "inline", mime: data.mime, base64: data.base64, filename: f.filename };
      // Some clients send the bare base64 with only a filename; the type is sniffed from the bytes.
      return { kind: "inline", mime: "", base64: fileData, filename: f.filename };
    }
    if (typeof f.file_url === "string" && f.file_url) return { kind: "url", url: f.file_url };
    return { kind: "unavailable", what: `a file reference${f.file_id ? ` (file_id ${String(f.file_id).slice(0, 64)})` : ""} without inline data` };
  }
  if (t === "image" || t === "document") {
    const src = part.source || {};
    if (src.type === "base64") return { kind: "inline", mime: src.media_type, base64: src.data, filename: part.title };
    if (src.type === "url" && typeof src.url === "string") return { kind: "url", url: src.url };
    if (src.type === "text" && typeof src.data === "string") {
      return { kind: "text", text: `[Attached document${part.title ? ` "${safeFilename(part.title)}"` : ""}]\n${src.data}` };
    }
    return { kind: "unavailable", what: `an ${t} block with source type '${String(src.type || "none").slice(0, 32)}'` };
  }
  return null;
}

/**
 * Write every inline image/PDF in `messages` to a fresh private directory and return a copy of the
 * messages in which each attachment part is a text part naming its file. Nothing is written (and no
 * directory created) when there is no attachment. Throws AttachmentError for an attachment that cannot
 * be decoded or has an unsupported type, so the client gets a 400 instead of an answer that silently
 * ignored its file.
 *
 * Returns { messages, files: [{ path, mime, filename, bytes }], dir, cleanup }.
 */
export function materializeAttachments(messages, { baseDir = null, limit = maxAttachments() } = {}) {
  const result = { messages, files: [], dir: null, cleanup: () => {} };
  if (!Array.isArray(messages)) return result;

  // Pass 1: count the inline attachments so that only the most recent `limit` are forwarded.
  let total = 0;
  const countIn = (content) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const d = describePart(part);
      if (d?.kind === "inline") total++;
      if (part && typeof part === "object" && Array.isArray(part.content)) countIn(part.content);
    }
  };
  for (const m of messages) countIn(m?.content);

  // Pass 2: rewrite. URL-only and unavailable parts become readable text without writing anything.
  let dir = null;
  const byHash = new Map();
  let seen = 0;
  const ensureDir = () => {
    if (!dir) {
      dir = fs.mkdtempSync(path.join(baseDir || os.tmpdir(), "agy-attach-"));
      result.dir = dir;
      result.cleanup = () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort: a leftover temp dir is harmless
        }
      };
    }
    return dir;
  };

  const rewrite = (content) => {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map((part) => {
      let next = part;
      if (part && typeof part === "object" && Array.isArray(part.content)) {
        const inner = rewrite(part.content);
        if (inner !== part.content) next = { ...part, content: inner };
      }
      const d = describePart(part);
      if (!d) {
        if (next !== part) changed = true;
        return next;
      }
      changed = true;
      if (d.kind === "text") return { type: "text", text: d.text };
      if (d.kind === "url") {
        return { type: "text", text: `[Attachment at a remote URL, not downloaded by the bridge: ${String(d.url).slice(0, 500)}]` };
      }
      if (d.kind === "unavailable") return { type: "text", text: `[Attachment not forwarded: ${d.what}]` };

      seen++;
      if (seen <= total - limit) {
        return { type: "text", text: `[Earlier attachment omitted: the bridge forwards only the ${limit} most recent attachments]` };
      }
      const label = `Attachment ${seen}${d.filename ? ` ("${safeFilename(d.filename)}")` : ""}`;
      const buf = decodeBase64(d.base64, label);
      const mime = sniffMime(buf) || normalizeMime(d.mime);
      const ext = SUPPORTED_ATTACHMENT_TYPES[mime];
      if (!ext) {
        throw new AttachmentError(
          `${label}: unsupported type '${mime || "unknown"}'. Supported: ${Object.keys(SUPPORTED_ATTACHMENT_TYPES).join(", ")}`
        );
      }
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      let file = byHash.get(hash);
      if (!file) {
        const filePath = path.join(ensureDir(), `attachment-${result.files.length + 1}.${ext}`);
        fs.writeFileSync(filePath, buf, { mode: 0o600 });
        file = { path: filePath, mime, filename: safeFilename(d.filename), bytes: buf.length };
        byHash.set(hash, file);
        result.files.push(file);
      }
      const kind = mime === "application/pdf" ? "PDF" : "image";
      return { type: "text", text: `[Attached ${kind}${file.filename ? ` "${file.filename}"` : ""}: ${file.path}]` };
    });
    return changed ? out : content;
  };

  try {
    const rewritten = messages.map((m) => {
      if (!m || typeof m !== "object" || !Array.isArray(m.content)) return m;
      const content = rewrite(m.content);
      return content === m.content ? m : { ...m, content };
    });
    if (rewritten.some((m, i) => m !== messages[i])) result.messages = rewritten;
  } catch (err) {
    result.cleanup();
    throw err;
  }
  return result;
}

/** The prompt block that tells the model to open the attached files (appended after the conversation). */
export function attachmentInstructions(files) {
  if (!Array.isArray(files) || files.length === 0) return "";
  const lines = files.map(
    (f, i) => `${i + 1}. ${f.path} (${f.mime}${f.filename ? `, "${f.filename}"` : ""})`
  );
  return [
    "[Attachments]",
    `The conversation above includes ${files.length} attached file(s). The bridge saved them on disk only so that you can see them:`,
    ...lines,
    "Before you answer, open each of them with your view_file tool (AbsolutePath exactly as listed, one call per file). " +
      "This is the one tool use allowed here: do not open any other path and do not use any other tool. " +
      "Then answer the user from what you saw, without mentioning these file paths.",
  ].join("\n");
}
