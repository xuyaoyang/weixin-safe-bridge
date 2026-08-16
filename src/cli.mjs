import { loginToWeixin, startWeixinBridge } from "./weixin-runtime.mjs";

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
  console.log(`微信安全桥接已启动；inbox/outbox 根目录：${bridge.dataRoot}`);
  await bridge.wait();
} else {
  throw new Error("用法：node src/cli.mjs <login|run> [明确确认参数]");
}
