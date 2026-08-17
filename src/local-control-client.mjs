import net from "node:net";

import { readLocalControlToken, resolveLocalControlPaths } from "./local-control.mjs";
import { PolicyError } from "./policy.mjs";

const MAX_RESPONSE_BYTES = 16 * 1024;

export async function sendLocalControlRequest(dataRoot, request, { timeoutMs = 10_000 } = {}) {
  const token = await readLocalControlToken(dataRoot);
  const { pipePath } = resolveLocalControlPaths(dataRoot);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let body = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      callback(value);
    };
    const timeout = setTimeout(
      () => finish(reject, new PolicyError("LOCAL_CONTROL_TIMEOUT", "本地桥接响应超时")),
      timeoutMs,
    );

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ ...request, token })}\n`, "utf8");
    });
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        finish(reject, new PolicyError("LOCAL_CONTROL_RESPONSE_TOO_LARGE", "本地桥接响应过大"));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (!response.ok) {
          finish(reject, new PolicyError(response.error ?? "LOCAL_CONTROL_ERROR", "本地桥接拒绝请求"));
          return;
        }
        finish(resolve, response);
      } catch {
        finish(reject, new PolicyError("INVALID_LOCAL_CONTROL_RESPONSE", "本地桥接响应格式无效"));
      }
    });
    socket.once("error", (error) => finish(reject, error));
  });
}
