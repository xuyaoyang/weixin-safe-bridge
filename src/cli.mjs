import { loginToWeixin, startWeixinBridge } from "./weixin-runtime.mjs";
import { createLocalOutboundServer } from "./local-outbound-server.mjs";

const [, , command, ...args] = process.argv;

function requireDoubleGate(envName, flag) {
  if (process.env[envName] !== "1" || !args.includes(flag)) {
    throw new Error(`真实操作被安全门禁阻止：需要 ${envName}=1 且参数 ${flag}`);
  }
}

if (command === "login") {
  requireDoubleGate("WEIXIN_ENABLE_REAL_LOGIN", "--confirm-real-login");
  await loginToWeixin();
} else if (command === "run") {
  requireDoubleGate("WEIXIN_ENABLE_REAL_CONNECTION", "--confirm-real-connection");
  const bridge = await startWeixinBridge();
  const localOutbound = process.env.WEIXIN_ENABLE_LOCAL_OUTBOUND === "1"
    ? await createLocalOutboundServer({
        dataRoot: bridge.dataRoot,
        prepareOutbound: bridge.prepareOutbound,
        sendOutbound: bridge.sendOutbound,
      })
    : undefined;
  console.log(`微信安全桥接已启动；inbox/outbox 根目录：${bridge.dataRoot}`);
  try {
    await bridge.wait();
  } finally {
    await localOutbound?.close();
  }
} else {
  throw new Error("用法：node src/cli.mjs <login|run> [明确确认参数]");
}
