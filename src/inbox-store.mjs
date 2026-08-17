import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { AuditLog } from "./audit-log.mjs";
import { inspectOpaqueFile } from "./file-policy.mjs";
import { PolicyError, sha256, validateInboundText, validateSourceId } from "./policy.mjs";

function errorCode(error) {
  return error instanceof PolicyError ? error.code : "INTERNAL_STORAGE_ERROR";
}

export class InboxStore {
  constructor({ dataRoot, allowedAttachmentRoots, clock = () => new Date(), randomId = randomUUID }) {
    this.dataRoot = path.resolve(dataRoot);
    this.inboxRoot = path.join(this.dataRoot, "inbox");
    this.allowedAttachmentRoots = allowedAttachmentRoots.map((root) => path.resolve(root));
    this.clock = clock;
    this.randomId = randomId;
    this.audit = new AuditLog(path.join(this.dataRoot, "audit"), { clock });
  }

  async ingest(request) {
    let sourceRef = "sha256:invalid";
    try {
      ({ sourceRef } = validateSourceId(request?.conversationId));
      const receivedAt = this.clock().toISOString();
      const textResult = request?.text
        ? validateInboundText(request.text)
        : { text: "", byteLength: 0, sha256: sha256(Buffer.alloc(0)) };
      const mediaResult = request?.media
        ? await inspectOpaqueFile({
            filePath: request.media.filePath,
            fileName: request.media.fileName,
            claimedMime: request.media.mimeType,
            allowedRoots: this.allowedAttachmentRoots,
          })
        : undefined;

      if (!textResult.text && !mediaResult) {
        throw new PolicyError("EMPTY_INBOUND_MESSAGE", "入站消息没有文本或可接受附件");
      }

      const messageId = this.randomId();
      const day = receivedAt.slice(0, 10);
      const dayDirectory = path.join(this.inboxRoot, day);
      const finalDirectory = path.join(dayDirectory, messageId);
      const partialDirectory = path.join(dayDirectory, `.partial-${messageId}`);
      const storedAttachmentName = mediaResult
        ? `attachment${mediaResult.extension}`
        : undefined;
      await fs.mkdir(dayDirectory, { recursive: true, mode: 0o700 });
      await fs.mkdir(partialDirectory, { recursive: false, mode: 0o700 });

      const metadata = {
        schemaVersion: 2,
        messageId,
        receivedAt,
        sourceRef,
        status: "accepted",
        text: textResult.text
          ? {
              storedPath: "message.txt",
              byteLength: textResult.byteLength,
              sha256: textResult.sha256,
            }
          : undefined,
        media: mediaResult
          ? {
              storedPath: storedAttachmentName,
              safeOriginalName: mediaResult.safeOriginalName,
              byteLength: mediaResult.byteLength,
              mimeType: mediaResult.mimeType,
              transportMode: mediaResult.transportMode,
            }
          : undefined,
      };

      try {
        if (textResult.text) {
          await fs.writeFile(path.join(partialDirectory, "message.txt"), textResult.text, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        }
        if (mediaResult) {
          const storedPath = path.join(partialDirectory, storedAttachmentName);
          await fs.copyFile(mediaResult.realPath, storedPath, fsConstants.COPYFILE_EXCL);
          const copiedStats = await fs.stat(storedPath);
          if (!copiedStats.isFile() || copiedStats.size !== mediaResult.byteLength) {
            throw new PolicyError("FILE_CHANGED_DURING_COPY", "附件复制期间大小发生变化");
          }
          await fs.chmod(storedPath, 0o600);
        }
        await fs.writeFile(
          path.join(partialDirectory, "metadata.json"),
          `${JSON.stringify(metadata, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await fs.rename(partialDirectory, finalDirectory);
      } catch (error) {
        await fs.rm(partialDirectory, { recursive: true, force: true });
        throw error;
      }

      await this.audit.append({
        event: "INBOUND_ACCEPTED",
        messageId,
        sourceRef,
        hasText: Boolean(textResult.text),
        hasMedia: Boolean(mediaResult),
        textSha256: textResult.text ? textResult.sha256 : undefined,
        mediaBytes: mediaResult?.byteLength,
      });
      return { status: "accepted", messageId, directory: finalDirectory, metadata };
    } catch (error) {
      const code = errorCode(error);
      await this.audit.append({
        event: "INBOUND_REJECTED",
        sourceRef,
        reason: code,
      });
      return { status: "rejected", reason: code };
    }
  }
}
