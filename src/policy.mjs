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
  ".docm",
  ".dotm",
  ".exe",
  ".hta",
  ".jar",
  ".js",
  ".jse",
  ".lnk",
  ".mjs",
  ".msi",
  ".potm",
  ".ppam",
  ".pptm",
  ".ps1",
  ".psd1",
  ".psm1",
  ".reg",
  ".scr",
  ".sldm",
  ".sh",
  ".sys",
  ".vbs",
  ".wsf",
  ".xlsm",
  ".xltm",
]);

const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["application/x-pdf", "application/pdf"],
  ["application/x-zip-compressed", "application/zip"],
  ["application/acad", "application/vnd.dwg"],
  ["application/dwg", "application/vnd.dwg"],
  ["application/x-acad", "application/vnd.dwg"],
  ["image/vnd.dwg", "application/vnd.dwg"],
  ["application/x-dxf", "application/dxf"],
  ["image/vnd.dxf", "application/dxf"],
  ["application/step", "model/step"],
  ["application/x-step", "model/step"],
  ["application/vnd.ms-pki.stl", "model/stl"],
  ["application/csv", "text/csv"],
  ["text/x-markdown", "text/markdown"],
]);

const TEXT_FILE_MIMES = new Map([
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".md", "text/markdown"],
  [".json", "application/json"],
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
  const hasPowerPointPath = buffer.includes(Buffer.from("ppt/"));
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
  if (hasContentTypes && hasPowerPointPath && extension === ".pptx") {
    return {
      extension: ".pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
  }
  throw new PolicyError("UNSUPPORTED_ZIP_CONTAINER", "只接受结构可识别的 DOCX/XLSX/PPTX，不接受通用 ZIP 容器");
}

function isDwg(buffer) {
  return buffer.length >= 64 && /^AC10\d{2}$/u.test(buffer.subarray(0, 6).toString("ascii"));
}

function isDxf(buffer) {
  if (buffer.subarray(0, 22).toString("latin1") === "AutoCAD Binary DXF\r\n\x1a\0") return true;
  const header = buffer.subarray(0, 256).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  return /^0\s+(?:SECTION|EOF)(?:\s|$)/u.test(header);
}

function isStepText(buffer) {
  if (!isProbablyUtf8Text(buffer)) return false;
  return buffer.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/u, "").trimStart().startsWith("ISO-10303-21;");
}

function isStl(buffer) {
  if (buffer.length >= 84) {
    const triangleCount = buffer.readUInt32LE(80);
    if (triangleCount <= Math.floor((buffer.length - 84) / 50) && 84 + triangleCount * 50 === buffer.length) {
      return true;
    }
  }
  if (!isProbablyUtf8Text(buffer)) return false;
  const text = buffer.toString("utf8");
  return /^\s*solid(?:\s|$)/u.test(text) && /\bfacet\s+normal\b/u.test(text) && /\bendsolid(?:\s|$)/u.test(text);
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
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  if (beginsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) || beginsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { extension: extension === ".tiff" ? ".tiff" : ".tif", mimeType: "image/tiff" };
  }
  if (beginsWith(buffer, [0x42, 0x4d])) {
    return { extension: ".bmp", mimeType: "image/bmp" };
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
  if (extension === ".dwg" && isDwg(buffer)) {
    return { extension: ".dwg", mimeType: "application/vnd.dwg" };
  }
  if (extension === ".dxf" && isDxf(buffer)) {
    return { extension: ".dxf", mimeType: "application/dxf" };
  }
  if ((extension === ".step" || extension === ".stp") && isStepText(buffer)) {
    return { extension, mimeType: "model/step" };
  }
  if (extension === ".ifc" && isStepText(buffer)) {
    return { extension: ".ifc", mimeType: "application/ifc" };
  }
  if (extension === ".stl" && isStl(buffer)) {
    return { extension: ".stl", mimeType: "model/stl" };
  }
  if (TEXT_FILE_MIMES.has(extension) && isProbablyUtf8Text(buffer)) {
    return { extension, mimeType: TEXT_FILE_MIMES.get(extension) };
  }
  throw new PolicyError(
    "UNSUPPORTED_FILE_TYPE",
    "文件内容不是允许的工程图、CAD 交换、PDF、Office、图片、音视频或 UTF-8 数据文件",
  );
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

export function validateDetectedExtension(filename, detectedExtension) {
  const extension = path.extname(filename).toLowerCase();
  const compatible = extension === detectedExtension || (extension === ".jpeg" && detectedExtension === ".jpg");
  if (!compatible) {
    throw new PolicyError(
      "FILE_EXTENSION_MISMATCH",
      `文件扩展名 ${extension || "(无)"} 与检测类型 ${detectedExtension} 不一致`,
    );
  }
  return extension;
}
