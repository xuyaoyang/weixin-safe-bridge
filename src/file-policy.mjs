import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_MAX_FILE_BYTES,
  PolicyError,
  assertPathWithinRoot,
  detectAllowedFile,
  sanitizeFilename,
  sha256,
  validateClaimedMime,
  validateDetectedExtension,
} from "./policy.mjs";

export async function inspectAllowedFile({
  filePath,
  fileName,
  claimedMime,
  allowedRoots,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
}) {
  if (typeof filePath !== "string" || filePath.includes("\0") || /^https?:\/\//iu.test(filePath)) {
    throw new PolicyError("INVALID_FILE_PATH", "文件路径为空、包含 NUL 或是远程 URL");
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new PolicyError("NO_ALLOWED_FILE_ROOT", "未配置允许的文件来源目录");
  }

  const resolvedAllowedRoots = allowedRoots.map((root) => path.resolve(root));
  const requestedPath = path.resolve(filePath);
  if (!resolvedAllowedRoots.some((root) => {
    try {
      assertPathWithinRoot(requestedPath, root);
      return true;
    } catch {
      return false;
    }
  })) {
    throw new PolicyError("FILE_PATH_OUTSIDE_ALLOWED_ROOT", "文件不在允许的来源目录内");
  }

  const linkStats = await fs.lstat(requestedPath);
  if (linkStats.isSymbolicLink()) {
    throw new PolicyError("SYMLINK_NOT_ALLOWED", "符号链接或目录联接不允许作为文件输入");
  }
  const realPath = await fs.realpath(requestedPath);
  const realAllowedRoots = await Promise.all(resolvedAllowedRoots.map((root) => fs.realpath(root)));
  if (!realAllowedRoots.some((root) => {
    try {
      assertPathWithinRoot(realPath, root);
      return true;
    } catch {
      return false;
    }
  })) {
    throw new PolicyError("REAL_PATH_OUTSIDE_ALLOWED_ROOT", "文件真实路径越出允许目录");
  }

  const handle = await fs.open(realPath, fsConstants.O_RDONLY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new PolicyError("NOT_A_REGULAR_FILE", "输入不是普通文件");
    if (stats.size <= 0 || stats.size > maxBytes) {
      throw new PolicyError("FILE_SIZE_REJECTED", `文件为空或超过 ${maxBytes} 字节限制`);
    }
    const buffer = await handle.readFile();
    if (buffer.length !== stats.size) {
      throw new PolicyError("FILE_CHANGED_DURING_READ", "文件读取期间大小发生变化");
    }

    const safeOriginalName = sanitizeFilename(fileName ?? path.basename(realPath));
    const detected = detectAllowedFile(buffer, safeOriginalName);
    validateDetectedExtension(safeOriginalName, detected.extension);
    const normalizedClaimedMime = validateClaimedMime(claimedMime, detected);
    return {
      buffer,
      byteLength: buffer.length,
      sha256: sha256(buffer),
      detectedMime: detected.mimeType,
      claimedMime: normalizedClaimedMime,
      extension: detected.extension,
      safeOriginalName,
      sourcePathRef: `sha256:${sha256(Buffer.from(realPath, "utf8"))}`,
    };
  } finally {
    await handle.close();
  }
}
