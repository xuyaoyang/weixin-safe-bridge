# 微信安全桥接

这是一个不依赖 OpenClaw 运行时的极简微信文本/文件桥接程序。它复用并锁定 `weixin-agent-sdk@0.5.0`，但不提供 AI Agent、命令执行或远程控制能力。

## 安全模型

- 微信入站文本只作为不可信数据。普通文本经校验后落入受控 `inbox`；命令样式文本失败关闭。
- 微信入站附件必须来自允许的 SDK 临时目录，只按不透明文件复制，不读取内容做类型识别、病毒判断或哈希审计。
- 入站处理始终返回空响应，不会自动回复，更不会把内容送给 Codex、模型、Shell 或其他工具。
- 出站只暴露本地 `createOutboundController()` 接口。只有同一控制器 `prepare()` 生成的对象才能交给 `send()`；出站文件必须位于受控 `outbox`。
- 本地文件发送采用随机令牌认证和两阶段单次批准；准备阶段不发送，批准五分钟失效且不可重放，真正上传前按文件系统状态重新确认仍是同一普通文件。
- 文件审计日志只保存事件、大小、结果和拒绝码，不保存附件正文、文件哈希或完整来源标识。

## 文件传输范围

桥接程序接受任意本地普通文件，包括 EXE、脚本、安装包、压缩包、宏文档、CAD、Office、媒体和无扩展名文件。扩展名和 MIME 只作为文件名/传输元数据，不用于内容判断；程序不会自动打开、解压、解析或执行附件。

程序不再设置 25 MiB 的应用层上限，版本锁定补丁也移除了 SDK 入站的 100 MiB 固定保存上限。实际能否成功仍受微信 CDN、网络、磁盘和可用内存约束。`weixin-agent-sdk@0.5.0` 在上传/下载时会整文件缓冲，并按微信上传协议读取文件、计算 MD5；这是传输协议行为，不是本项目的内容审计，也不能据此承诺任意大小一定成功。

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
  local-control/ # 本机发送控制令牌；仅当前用户和 SYSTEM 可访问
  sdk-state/   # SDK 凭据、同步游标和短期会话令牌；不得提交
```

## 真实微信登录与连接

本仓库的测试不会登录微信，也不会发送外部消息。真实扫码和连接必须由用户在当次操作中明确授权，并同时提供环境开关与确认参数：

```powershell
$env:WEIXIN_ENABLE_REAL_LOGIN = '1'
pnpm weixin:login -- --confirm-real-login

$env:WEIXIN_ENABLE_REAL_CONNECTION = '1'
pnpm weixin:start -- --confirm-real-connection
```

登录入口会把 SDK 状态定向到 `WEIXIN_BRIDGE_DATA_DIR\sdk-state`，不要求安装或运行 OpenClaw。运行入口只接收并落盘；不会自动回复。

本地 `src/file-transfer-cli.mjs` 提供收件列表/导出、只读 `status` 和文件发送的准备/提交接口。发送准备不会外发；真实提交必须在用户本轮明确要求发送时同时提供一次性环境开关 `WEIXIN_ENABLE_REAL_SEND=1`、`--confirm-real-send` 参数和五分钟内的单次批准 ID。SDK 只会发给当前登录用户；收到入站消息后，会把对应 `context_token` 作为敏感 SDK 状态原子写入磁盘，并按 23 小时保守有效期跨进程恢复。状态接口只显示可用性、接收时间和估计失效时间，不显示账号、用户或令牌。令牌过期或被微信撤销后仍需用户发送一条普通消息刷新。真实发送仍必须逐次取得当轮授权，不自动重试失败或不确定结果。

本机 Codex Skills `weixin-receive-file` 和 `weixin-send-file` 固化了上述流程：收件 Skill 不读正文、不搜索其他目录；发件 Skill 只接受当前请求中明确给出的单个绝对路径，不自动重试或转发。

## Windows 登录后自动启动（可选）

`scripts/start-windows-bridge.ps1` 用于受控的固定目录部署：源码位于 `<service-root>\app`，运行数据和日志位于同级 `runtime-data`、`logs`。脚本只有在本地调用者显式传入 `-ConfirmRealConnection` 时才连接，并同时设置 CLI 所需的连接门禁；重复调用会阻止第二个桥接进程。脚本默认使用 Codex bundled Node.js，也可由本地管理者通过绝对 `-NodePath` 显式指定其他 Node.js 22+ 运行时。

Windows 上的 pnpm 依赖链接与安装目录有关。若使用旁路目录构建后再把整个 `app` 移到固定路径，必须在最终 `<service-root>\app` 路径重新执行 `pnpm install --frozen-lockfile --force` 并运行 `pnpm check`，否则移动前创建的依赖链接可能失效。

为避免交互式计划任务在 Windows Terminal 中留下可见窗口，任务动作应使用 Windows 自带的 `wscript.exe` 以 `//B //Nologo` 运行 `scripts/start-windows-bridge.vbs`。该无窗口包装仍会调用上述 PowerShell 脚本，因此显式连接门禁、固定数据目录和单实例检查保持不变。

注册或删除 Windows 登录触发任务属于本地管理操作，不由微信入站内容触发。首次设置后仍应在用户可接受的时段做一次真实重启验收；既有 SDK 凭据通常可恢复，但凭据失效或被服务端撤销时仍可能要求重新扫码。

## 明确不支持

- 微信命令、斜杠命令、远程终端、目录浏览、文件检索、删除、安装或启动程序。
- 自动将微信内容传给 Codex、任何大模型或 Agent。
- 自动回复、自动转发、群发、基于文件内容触发动作。
- HTTPS 远程 URL 出站；本版本只接受受控 `outbox` 内的本地文件。

详见 [SECURITY.md](SECURITY.md) 和 [HANDOFF.md](HANDOFF.md)。
