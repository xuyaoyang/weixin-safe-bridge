import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

export const DEFAULT_MAX_TEXT_BYTES = 16 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".dll",
  ".exe",
  ".hta",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".mjs",
  ".msi",
  ".ps1",
  ".psd1",
  ".psm1",
  ".reg",
  ".scr",
  ".sh",
  ".sys",
  ".vbs",
  ".wsf",
]);

const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["application/x-pdf", "application/pdf"],
  ["application/x-zip-compressed", "application/zip"],
]);

const COMMAND_STYLE = /^(?:\s*(?:[/!>$&]|\.\\|\.\/|[a-z]:\\)|\s*(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|zsh|wsl|sudo)(?:\s|$))/iu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SOURCE_ID = /^[\p{L}\p{N}_.@:+-]{1,256}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateSourceId(value) {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    throw new PolicyError("INVALID_SOURCE", "来源标识为空、过长或包含不允许的字符");
  }
  return {
    sourceRef: `sha256:${sha256(Buffer.from(value, "utf8"))}`,
  };
}

export function validateInboundText(value, { maxBytes = DEFAULT_MAX_TEXT_BYTES } = {}) {
  if (typeof value !== "string") {
    throw new PolicyError("INVALID_TEXT", "文本必须是字符串");
  }
  const normalized = value.normalize("NFC");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes > maxBytes) {
    throw new PolicyError("TEXT_TOO_LARGE", `文本超过 ${maxBytes} 字节限制`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new PolicyError("TEXT_CONTROL_CHARACTER", "文本包含不允许的控制字符");
  }
  if (COMMAND_STYLE.test(normalized)) {
    throw new PolicyError("COMMAND_STYLE_TEXT", "命令样式入站文本被安全策略拒绝");
  }
  return {
    text: normalized,
    byteLength: bytes,
    sha256: sha256(Buffer.from(normalized, "utf8")),
  };
}

export function validateOutboundText(value, { maxBytes = DEFAULT_MAX_TEXT_BYTES } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PolicyError("INVALID_OUTBOUND_TEXT", "出站文本必须是字符串");
  }
  const normalized = value.normalize("NFC");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0 || bytes > maxBytes) {
    throw new PolicyError("INVALID_OUTBOUND_TEXT_SIZE", "出站文本为空或超过大小限制");
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new PolicyError("OUTBOUND_CONTROL_CHARACTER", "出站文本包含不允许的控制字符");
  }
  return {
    text: normalized,
    byteLength: bytes,
    sha256: sha256(Buffer.from(normalized, "utf8")),
  };
}

export function sanitizeFilename(value, fallback = "attachment") {
  const raw =
    typeof value === "string"
      ? path.posix.basename(value.normalize("NFKC").replaceAll("\\", "/"))
      : fallback;
  let safe = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/u, "")
    .replace(/^\.+/u, "")
    .slice(0, 120);
  if (!safe || WINDOWS_RESERVED_NAME.test(safe)) safe = fallback;
  return safe;
}

export function assertPathWithinRoot(candidate, root, code = "PATH_OUTSIDE_ROOT") {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }
  throw new PolicyError(code, "路径不在允许的受控目录内");
}

function normalizedMime(value) {
  const mime = String(value ?? "application/octet-stream")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return MIME_ALIASES.get(mime) ?? mime;
}

function beginsWith(buffer, bytes) {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}

function isProbablyUtf8Text(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function zipDocumentKind(buffer, extension) {
  const hasWordPath = buffer.includes(Buffer.from("word/"));
  const hasExcelPath = buffer.includes(Buffer.from("xl/"));
  const hasContentTypes = buffer.includes(Buffer.from("[Content_Types].xml"));
  if (hasContentTypes && hasWordPath && extension === ".docx") {
    return {
      extension: ".docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  if (hasContentTypes && hasExcelPath && extension === ".xlsx") {
    return {
      extension: ".xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  throw new PolicyError("UNSUPPORTED_ZIP_CONTAINER", "只接受结构可识别的 DOCX/XLSX，不接受通用 ZIP 容器");
}

export function detectAllowedFile(buffer, filename = "attachment") {
  const extension = path.extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new PolicyError("BLOCKED_FILE_EXTENSION", `禁止的文件扩展名: ${extension}`);
  }
  if (beginsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { extension: ".pdf", mimeType: "application/pdf" };
  }
  if (beginsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (beginsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (beginsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return zipDocumentKind(buffer, extension);
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return { extension: ".wav", mimeType: "audio/wav" };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return { extension: ".mp4", mimeType: "video/mp4" };
  }
  if (extension === ".txt" && isProbablyUtf8Text(buffer)) {
    return { extension: ".txt", mimeType: "text/plain" };
  }
  throw new PolicyError("UNSUPPORTED_FILE_TYPE", "文件内容不是允许的 PDF、图片、DOCX/XLSX、WAV、MP4 或 UTF-8 文本");
}

export function validateClaimedMime(claimed, detected) {
  const mime = normalizedMime(claimed);
  if (mime === "application/octet-stream") return mime;
  if (mime.endsWith("/*") && detected.mimeType.startsWith(mime.slice(0, -1))) return mime;
  if (mime !== detected.mimeType) {
    throw new PolicyError("MIME_MISMATCH", `声明类型 ${mime} 与检测类型 ${detected.mimeType} 不一致`);
  }
  return mime;
}
