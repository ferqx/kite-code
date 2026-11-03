# Agent Note: 模型连接自动采用系统代理

Status: implemented

## Problem

Windows 普通开发窗口已开启系统代理，但模型连接只继承 HTTP(S) 环境变量。最新会话的首个 Codex Model 约21.6秒失败且没有正文；同地址无凭据直连约21.1秒报 ECONNREFUSED，经系统已登记的代理约0.3秒收到 HTTP 响应。网页工具已有系统代理发现，尚未接入模型连接。

## Decision

由 Service 在模型绑定时复用系统代理发现，显式环境仍交给 Bun；系统选择复制到该绑定，绕过名单决定具体请求是否直连。普通模型两协议、Codex 认证包装及提供商目录查询使用同一模型传输。系统发现失败和不支持设置明确失败，代理失败不自动直连重发；不更改进程环境、模型名、权限或工具／协议版本。

新 Run 仅保存网络选择摘要，恢复前变化拒绝；旧记录不补造历史选择。网页配置不控制模型，MCP 的独立网络准入不扩大。当前产品行为与实现归[模型手册](../../../../docs/handbook/features/models-and-configuration.md)和 [Service owner](../../../../apps/service/README.md)。

## Alternatives considered

- 继续要求每次启动手动设置 HTTPS_PROXY：可临时恢复连接，但无法满足已开启系统代理后正常启动的需求。
- 将系统代理写入 process.env：影响网页、扩展及其他并发请求，且当前 Bun 实测在启动后改变量未恢复相同连接，未采用。
- 代理失败后自动直连：改变用户选择的出口并增加一次请求，未采用。
- 只修 Codex 包装：遗漏普通提供商和显式模型目录查询，未采用。

## Consequences

复用现有 Windows/macOS 系统手动代理读取，不执行 PAC/WPAD或探测端口。显式环境的既有语义保持；新摘要不存原始环境或代理凭据，不改变数据库与协议版本。测试使用本地合成代理／模型，真实窗口资格与平台限制由 Service owner 的本轮证据维护。
