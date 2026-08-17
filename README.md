# 微信安全桥接

这是一个不依赖 OpenClaw 运行时的极简微信文本/文件桥接程序。它复用并锁定 `weixin-agent-sdk@0.5.0`，但不提供 AI Agent、命令执行或远程控制能力。

## 安全模型

- 微信入站文本只作为不可信数据。普通文本经校验后落入受控 `inbox`；命令样式文本失败关闭。
- 微信入站附件必须来自允许的 SDK 临时目录，经路径、大小、扩展名、声明 MIME 和内容特征联合校验后才复制。
- 入站处理始终返回空响应，不会自动回复，更不会把内容送给 Codex、模型、Shell 或其他工具。
- 出站只暴露本地 `createOutboundController()` 接口。只有同一控制器 `prepare()` 生成的对象才能交给 `send()`；出站文件必须位于受控 `outbox`。
- 审计日志只保存最小元数据、哈希、结果和拒绝码，不保存拒绝文本正文或完整来源标识。

## 为什么包含 SDK 补丁

上游 `weixin-agent-sdk@0.5.0` 的默认消息循环会优先处理 `/echo`、`/toggle-debug`、`/clear`，并可能根据 Agent 返回值或异常自动外发消息。项目内的版本锁定补丁移除了这些入站触发路径；主动发送 `Bot.sendMessage()` 仍只供本地受控出站接口使用。

安装后应确认补丁已经应用。测试会静态验证版本与补丁，CI 还会执行完整安装和测试。

## 本地验证

要求 Node.js 22 或更高版本、pnpm 11.19.0。依赖和测试工作区建议放在 `G:\CodexWork\微信连接`。

```powershell
pnpm install --frozen-lockfile
pnpm test
```

## 运行数据

默认运行数据位于 `%LOCALAPPDATA%\weixin-safe-bridge`。建议显式设置：

```powershell
$env:WEIXIN_BRIDGE_DATA_DIR = 'G:\CodexWork\微信连接\runtime-data'
```

目录结构：

```text
runtime-data/
  inbox/       # 已接受的入站文本、附件和 metadata.json
  outbox/      # 本地准备的可出站文件
  audit/       # JSONL 审计记录
  sdk-state/   # SDK 凭据和同步游标；不得提交
```

## 真实微信登录与连接

本仓库的测试不会登录微信，也不会发送外部消息。真实扫码和连接必须由用户在当次操作中明确授权，并同时提供环境开关与确认参数：

```powershell
$env:WEIXIN_ENABLE_REAL_LOGIN = '1'
pnpm weixin:login -- --confirm-real-login

$env:WEIXIN_ENABLE_REAL_CONNECTION = '1'
pnpm weixin:start -- --confirm-real-connection
```

登录入口会把 SDK 状态定向到 `WEIXIN_BRIDGE_DATA_DIR\sdk-state`，不要求安装或运行 OpenClaw。运行入口只接收并落盘；不会自动回复。真实主动发送尚未提供通用 CLI，必须由本地受控程序显式构造 `createOutboundController()` 并调用，且应在单独授权的真实联调中验证。

## Windows 登录后自动启动（可选）

`scripts/start-windows-bridge.ps1` 用于受控的固定目录部署：源码位于 `<service-root>\app`，运行数据和日志位于同级 `runtime-data`、`logs`。脚本只有在本地调用者显式传入 `-ConfirmRealConnection` 时才连接，并同时设置 CLI 所需的连接门禁；重复调用会阻止第二个桥接进程。脚本默认使用 Codex bundled Node.js，也可由本地管理者通过绝对 `-NodePath` 显式指定其他 Node.js 22+ 运行时。

注册或删除 Windows 登录触发任务属于本地管理操作，不由微信入站内容触发。首次设置后仍应在用户可接受的时段做一次真实重启验收；既有 SDK 凭据通常可恢复，但凭据失效或被服务端撤销时仍可能要求重新扫码。

## 明确不支持

- 微信命令、斜杠命令、远程终端、目录浏览、文件检索、删除、安装或启动程序。
- 自动将微信内容传给 Codex、任何大模型或 Agent。
- 自动回复、自动转发、群发、基于文件内容触发动作。
- HTTPS 远程 URL 出站；本版本只接受受控 `outbox` 内的本地文件。

详见 [SECURITY.md](SECURITY.md) 和 [HANDOFF.md](HANDOFF.md)。
