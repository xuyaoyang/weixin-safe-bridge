import { randomUUID } from "node:crypto";
import net from "node:net";

import {
  ensureLocalControlToken,
  localControlTokenMatches,
  resolveLocalControlPaths,
} from "./local-control.mjs";
import { PolicyError } from "./policy.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING = 16;

function errorCode(error) {
  return error instanceof PolicyError ? error.code : "LOCAL_CONTROL_ERROR";
}

function writeResponse(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`, "utf8");
}

export async function createLocalOutboundServer({
  dataRoot,
  prepareOutbound,
  sendOutbound,
  clock = () => Date.now(),
  randomId = randomUUID,
  approvalTtlMs = DEFAULT_APPROVAL_TTL_MS,
  maxPending = DEFAULT_MAX_PENDING,
}) {
  if (typeof prepareOutbound !== "function" || typeof sendOutbound !== "function") {
    throw new TypeError("本地出站服务需要 prepareOutbound 和 sendOutbound");
  }
  const expectedToken = await ensureLocalControlToken(dataRoot);
  const { pipePath } = resolveLocalControlPaths(dataRoot);
  const pending = new Map();

  function removeExpired() {
    const now = clock();
    for (const [approvalId, value] of pending) {
      if (value.expiresAtMs <= now) pending.delete(approvalId);
    }
  }

  async function handleRequest(request) {
    if (!localControlTokenMatches(expectedToken, request?.token)) {
      throw new PolicyError("LOCAL_CONTROL_UNAUTHORIZED", "本地控制请求未授权");
    }
    removeExpired();

    if (request.operation === "prepare-file") {
      if (pending.size >= maxPending) {
        throw new PolicyError("TOO_MANY_PENDING_SENDS", "待确认发送请求过多");
      }
      const prepared = await prepareOutbound({
        text: request.text,
        filePath: request.filePath,
        fileName: request.fileName,
      });
      if (!prepared.payload.media) {
        throw new PolicyError("OUTBOUND_FILE_REQUIRED", "本地文件发送请求缺少附件");
      }
      const approvalId = randomId();
      const expiresAtMs = clock() + approvalTtlMs;
      pending.set(approvalId, { prepared, expiresAtMs });
      return {
        ok: true,
        operation: "prepared",
        approvalId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        fileName: prepared.payload.media.fileName,
        byteLength: prepared.audit.mediaBytes,
        sha256: prepared.audit.mediaSha256,
      };
    }

    if (request.operation === "commit-file") {
      if (request.confirmRealSend !== true) {
        throw new PolicyError("REAL_SEND_CONFIRMATION_REQUIRED", "本地发送请求缺少明确确认");
      }
      const approvalId = String(request.approvalId ?? "");
      const value = pending.get(approvalId);
      if (!value) {
        throw new PolicyError("INVALID_OR_EXPIRED_APPROVAL", "发送批准不存在、已过期或已使用");
      }
      pending.delete(approvalId);
      await sendOutbound(value.prepared);
      return { ok: true, operation: "sent", approvalId };
    }

    if (request.operation === "cancel-file") {
      const approvalId = String(request.approvalId ?? "");
      const removed = pending.delete(approvalId);
      return { ok: true, operation: "cancelled", approvalId, removed };
    }

    throw new PolicyError("UNKNOWN_LOCAL_CONTROL_OPERATION", "未知的本地控制操作");
  }

  const server = net.createServer((socket) => {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.setEncoding("utf8");
    let body = "";
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        writeResponse(socket, { ok: false, error: "LOCAL_CONTROL_REQUEST_TOO_LARGE" });
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      try {
        const request = JSON.parse(body.slice(0, newline));
        writeResponse(socket, await handleRequest(request));
      } catch (error) {
        writeResponse(socket, { ok: false, error: errorCode(error) });
      }
    });
    socket.on("error", () => {});
  });
  server.maxConnections = 32;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return Object.freeze({
    pipePath,
    async close() {
      pending.clear();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });
}
