import path from "node:path";

import { createInboxOnlyAgent } from "./bridge-agent.mjs";
import { InboxStore } from "./inbox-store.mjs";
import { createOutboundController } from "./outbound-controller.mjs";
import { resolveDataRoot, resolveSdkInboundRoot } from "./runtime-config.mjs";

async function loadSdkAtControlledStateRoot(dataRoot) {
  process.env.OPENCLAW_STATE_DIR = path.join(dataRoot, "sdk-state");
  return import("weixin-agent-sdk");
}

export async function loginToWeixin({ dataRoot = resolveDataRoot(), log = console.log } = {}) {
  const sdk = await loadSdkAtControlledStateRoot(dataRoot);
  return sdk.login({ log });
}

export async function startWeixinBridge({ dataRoot = resolveDataRoot(), log = console.log } = {}) {
  const sdk = await loadSdkAtControlledStateRoot(dataRoot);
  const store = new InboxStore({
    dataRoot,
    allowedAttachmentRoots: [resolveSdkInboundRoot()],
  });
  const bot = sdk.start(createInboxOnlyAgent(store), { log });
  const outbound = createOutboundController({ dataRoot, transport: bot });
  return Object.freeze({
    dataRoot,
    outboxRoot: outbound.outboxRoot,
    prepareOutbound: outbound.prepare,
    sendOutbound: outbound.send,
    wait: () => bot.wait(),
  });
}
