import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_MAX_TEXT_BYTES = 16 * 1024;

const COMMAND_STYLE = /^(?:\s*(?:[/!>$&]|\.\\|\.\/|[a-z]:\\)|\s*(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|zsh|wsl|sudo)(?:\s|$))/iu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SOURCE_ID = /^[\p{L}\p{N}_.@:+-]{1,256}$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

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

export function normalizeTransportMime(value) {
  const mime = String(value ?? "application/octet-stream")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return MIME.test(mime) ? mime : "application/octet-stream";
}
