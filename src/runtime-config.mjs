import os from "node:os";
import path from "node:path";

export function resolveDataRoot(env = process.env) {
  const configured = env.WEIXIN_BRIDGE_DATA_DIR?.trim();
  return path.resolve(configured || path.join(env.LOCALAPPDATA || os.homedir(), "weixin-safe-bridge"));
}

export function resolveSdkInboundRoot() {
  return path.join(os.tmpdir(), "weixin-agent", "media", "inbound");
}
