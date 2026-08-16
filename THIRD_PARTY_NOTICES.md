# 第三方声明

## weixin-agent-sdk

- 项目：`wong2/weixin-agent-sdk`
- 锁定版本：`0.5.0`
- 许可证：MIT
- 上游仓库：https://github.com/wong2/weixin-agent-sdk

本仓库使用 pnpm 补丁移除入站触发的斜杠命令、自动回复、错误通知和打字状态发送。补丁不改变 `Bot.sendMessage()` 主动发送接口，但本项目仅通过本地受控出站控制器调用该接口。

上游软件按其 MIT 许可证“按原样”提供。完整许可证见上游发布包和仓库。
