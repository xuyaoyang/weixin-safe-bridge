import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sdkEntry = fileURLToPath(import.meta.resolve("weixin-agent-sdk"));
const bundle = await fs.readFile(sdkEntry, "utf8");
const start = bundle.indexOf("async function processOneMessage");
const end = bundle.indexOf("//#endregion", start);

if (start < 0 || end < 0) {
  throw new Error("无法在已安装 SDK 中定位 processOneMessage；拒绝继续");
}

const inboundHandler = bundle.slice(start, end);
const forbidden = [
  "textBody.startsWith",
  "handleSlashCommand(",
  "sendWeixinErrorNotice(",
  "sendMessageWeixin(",
  "sendWeixinMediaFile(",
  "sendTyping(",
];

for (const token of forbidden) {
  if (inboundHandler.includes(token)) {
    throw new Error(`已安装 SDK 的入站处理仍包含禁止调用: ${token}`);
  }
}
if (!inboundHandler.includes("await deps.agent.chat(request)")) {
  throw new Error("已安装 SDK 没有调用受控 inbox Agent；拒绝继续");
}

console.log(`sdk_patch_verified=${sdkEntry}`);
