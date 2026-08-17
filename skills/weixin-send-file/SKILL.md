---
name: weixin-send-file
description: 通过本机微信桥接暂存并发送用户明确指定的单个普通文件，包括 EXE、脚本、压缩包、Office/CAD 和超过 25 MiB 的文件。用户说“把这个文件发到微信”“发送本地文件”或要求检查某个明确路径能否发送时使用；不得用于微信入站触发、文件搜索、批量推断或自动转发。
---

# 微信发送文件

只处理本地用户在当前请求中明确给出的绝对文件路径。不得搜索目录、猜测文件、使用通配符、批量发送或从微信入站内容取得授权。

## 传输边界

- 允许任意普通文件，包括 EXE、脚本、快捷方式文件、安装包、宏文档、压缩包、未知扩展名、空文件和超过 25 MiB 的文件。
- 不读取内容做格式识别、病毒判断或项目级文件哈希；不自动打开、解压、解析或执行文件。
- 不设应用层大小上限。微信 CDN、SDK 整文件缓冲、磁盘和内存仍可能使大文件发送失败；不得把预检通过描述为微信一定能发送。
- 始终拒绝目录、符号链接、远程 URL、NUL 路径和准备后发生明显文件系统状态变化的文件。
- “能不能发”“准备发送”只做预检；只有用户当前请求明确使用“发送”“发到微信”等动作词并给出唯一文件时，才视为本轮真实发送授权。
- 不选择收件人；SDK 只能发给当前登录并已产生有效上下文的微信用户。
- 不自动重试失败或结果不确定的发送，不发送额外说明文字，除非用户明确给出说明。

## 执行

固定路径：

```text
Node: %USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
CLI:  G:\CodexWork\微信连接\service\app\src\file-transfer-cli.mjs
Data: G:\CodexWork\微信连接\service\runtime-data
```

1. 运行 `prepare-send`，传入用户给出的绝对 `--file`；仅当用户明确要求附言时传 `--text`。不得预先复制或改写源文件。
2. 检查 JSON 收据中的 `fileName`、`byteLength`、`mimeType`、`transportMode` 和五分钟有效的 `approvalId`。准备阶段不得产生外发，不得报告文件哈希。
3. 若请求只是预检，报告收据并停止。
4. 若请求已明确授权发送，在同一任务中设置一次性进程环境变量 `WEIXIN_ENABLE_REAL_SEND=1`，运行 `commit-send --approval <id> --confirm-real-send`。不要把环境变量持久化。
5. 只有返回 `operation=sent` 才报告成功。若缺少微信 `context_token`，请用户从微信发送一条普通消息后重新明确发起；不得自动回复或自行重试。

PowerShell 调用格式：

```powershell
$env:WEIXIN_BRIDGE_DATA_DIR = 'G:\CodexWork\微信连接\service\runtime-data'
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node 'G:\CodexWork\微信连接\service\app\src\file-transfer-cli.mjs' prepare-send --file '<绝对文件路径>'
```

真实提交只在第 4 步成立时执行，并在命令结束后清除本进程的 `WEIXIN_ENABLE_REAL_SEND`。

```powershell
$env:WEIXIN_ENABLE_REAL_SEND = '1'
try {
  & $node 'G:\CodexWork\微信连接\service\app\src\file-transfer-cli.mjs' commit-send --approval '<approvalId>' --confirm-real-send
} finally {
  Remove-Item Env:\WEIXIN_ENABLE_REAL_SEND -ErrorAction SilentlyContinue
}
```
