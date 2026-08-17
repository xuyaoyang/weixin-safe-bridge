import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { PolicyError, assertPathWithinRoot, sanitizeFilename } from "./policy.mjs";

const RECEIPT_REF = /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/u;

async function directoryNames(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function listInboxReceipts(dataRoot, { limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new PolicyError("INVALID_INBOX_LIMIT", "收件列表数量必须在 1 到 50 之间");
  }
  const inboxRoot = path.join(path.resolve(dataRoot), "inbox");
  const days = (await directoryNames(inboxRoot)).filter((name) => /^\d{4}-\d{2}-\d{2}$/u.test(name)).sort().reverse();
  const receipts = [];
  for (const day of days) {
    const dayRoot = path.join(inboxRoot, day);
    const messages = (await directoryNames(dayRoot)).filter((name) => /^[0-9a-f-]{36}$/u.test(name));
    const dayReceipts = [];
    for (const messageId of messages) {
      const metadataPath = path.join(dayRoot, messageId, "metadata.json");
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
        if (metadata.status !== "accepted" || metadata.messageId !== messageId) continue;
        dayReceipts.push({
          receiptRef: `${day}/${messageId}`,
          receivedAt: metadata.receivedAt,
          hasText: Boolean(metadata.text),
          media: metadata.media
            ? {
                fileName: metadata.media.safeOriginalName,
                byteLength: metadata.media.byteLength,
                mimeType: metadata.media.mimeType ?? metadata.media.detectedMime ?? "application/octet-stream",
                transportMode: metadata.media.transportMode ?? "legacy-validated",
              }
            : undefined,
        });
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    dayReceipts.sort((left, right) => String(right.receivedAt).localeCompare(String(left.receivedAt)));
    receipts.push(...dayReceipts);
    if (receipts.length >= limit) return receipts.slice(0, limit);
  }
  return receipts;
}

export async function exportInboxAttachment(dataRoot, receiptRef, destinationDirectory) {
  if (typeof receiptRef !== "string" || !RECEIPT_REF.test(receiptRef)) {
    throw new PolicyError("INVALID_RECEIPT_REF", "收件引用格式无效");
  }
  if (typeof destinationDirectory !== "string" || destinationDirectory.includes("\0")) {
    throw new PolicyError("INVALID_EXPORT_DESTINATION", "导出目标目录无效");
  }
  const inboxRoot = path.join(path.resolve(dataRoot), "inbox");
  const messageRoot = assertPathWithinRoot(path.join(inboxRoot, ...receiptRef.split("/")), inboxRoot);
  const metadata = JSON.parse(await fs.readFile(path.join(messageRoot, "metadata.json"), "utf8"));
  if (metadata.status !== "accepted" || !metadata.media?.storedPath) {
    throw new PolicyError("RECEIPT_HAS_NO_ATTACHMENT", "该收件记录没有可导出的附件");
  }
  const sourcePath = assertPathWithinRoot(path.join(messageRoot, metadata.media.storedPath), messageRoot);
  const sourceStats = await fs.lstat(sourcePath);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new PolicyError("INVALID_INBOX_ATTACHMENT", "收件附件不是普通文件");
  }
  const destinationStats = await fs.stat(destinationDirectory);
  if (!destinationStats.isDirectory()) {
    throw new PolicyError("EXPORT_DESTINATION_NOT_DIRECTORY", "导出目标必须是已存在目录");
  }
  if (sourceStats.size !== metadata.media.byteLength) {
    throw new PolicyError("INBOX_ATTACHMENT_SIZE_CHANGED", "收件附件大小与收据不一致");
  }
  const fileName = sanitizeFilename(metadata.media.safeOriginalName);
  const destinationPath = path.join(path.resolve(destinationDirectory), fileName);
  await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  await fs.chmod(destinationPath, 0o600);
  const copiedStats = await fs.stat(destinationPath);
  if (!copiedStats.isFile() || copiedStats.size !== sourceStats.size) {
    await fs.rm(destinationPath, { force: true });
    throw new PolicyError("INBOX_EXPORT_COPY_INCOMPLETE", "附件导出复制不完整");
  }
  return {
    receiptRef,
    destinationPath,
    fileName,
    byteLength: copiedStats.size,
    mimeType: metadata.media.mimeType ?? metadata.media.detectedMime ?? "application/octet-stream",
    transportMode: metadata.media.transportMode ?? "legacy-validated",
  };
}
