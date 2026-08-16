import path from "node:path";

import { AuditLog } from "./audit-log.mjs";
import { inspectAllowedFile } from "./file-policy.mjs";
import { PolicyError, validateOutboundText } from "./policy.mjs";

export function createOutboundController({ dataRoot, transport }) {
  if (!transport || typeof transport.sendMessage !== "function") {
    throw new TypeError("transport.sendMessage 必须是函数");
  }
  const root = path.resolve(dataRoot);
  const outboxRoot = path.join(root, "outbox");
  const audit = new AuditLog(path.join(root, "audit"));
  const preparedByThisController = new WeakSet();

  return Object.freeze({
    outboxRoot,
    async prepare({ text, filePath, fileName } = {}) {
      const checkedText = validateOutboundText(text);
      const checkedFile = filePath
        ? await inspectAllowedFile({
            filePath,
            fileName,
            claimedMime: "application/octet-stream",
            allowedRoots: [outboxRoot],
          })
        : undefined;
      if (!checkedText && !checkedFile) {
        throw new PolicyError("EMPTY_OUTBOUND", "出站请求必须包含文本或受控文件");
      }
      const payload = Object.freeze({
        text: checkedText?.text,
        media: checkedFile
          ? Object.freeze({
              type: checkedFile.detectedMime.startsWith("image/") ? "image" : "file",
              url: path.resolve(filePath),
              fileName: checkedFile.safeOriginalName,
            })
          : undefined,
      });
      const prepared = Object.freeze({
        payload,
        audit: Object.freeze({
          textSha256: checkedText?.sha256,
          mediaSha256: checkedFile?.sha256,
          mediaBytes: checkedFile?.byteLength,
        }),
      });
      preparedByThisController.add(prepared);
      return prepared;
    },
    async send(prepared) {
      if (!prepared || typeof prepared !== "object" || !preparedByThisController.has(prepared)) {
        throw new PolicyError("UNPREPARED_OUTBOUND", "只能发送由同一控制器 prepare() 生成的对象");
      }
      await audit.append({ event: "OUTBOUND_ATTEMPT", ...prepared.audit });
      try {
        const payload = prepared.payload.media
          ? { ...(prepared.payload.text ? { text: prepared.payload.text } : {}), media: prepared.payload.media }
          : prepared.payload.text;
        await transport.sendMessage(payload);
        await audit.append({ event: "OUTBOUND_SENT", ...prepared.audit });
      } catch (error) {
        await audit.append({
          event: "OUTBOUND_FAILED",
          ...prepared.audit,
          reason: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }
    },
  });
}
