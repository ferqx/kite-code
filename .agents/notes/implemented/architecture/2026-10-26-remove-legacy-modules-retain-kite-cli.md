# Agent Note: 删除旧架构模块并保留 kite-cli 源码

Status: implemented

## Problem

正式入口、根 workspace 和默认测试已选择新八模块，仓库仍保留整套旧 Runtime、Service 和客户端实现。仅退役普通入口仍留下第二套源码、测试与发布闭包，不能满足用户要求的仓库边界。

## Decision

2026-10-26 用户明确要求：除新架构模块外，老架构只保留 `kite-cli`，其余全部删除。保留根八 workspace：`packages/ai`、`packages/agent`、`packages/client`、`packages/ui`、`apps/service`、`apps/cli`、`apps/desktop`、`apps/web`，以及 `apps/kite-cli` 的历史源码；删除其他旧 workspace 与仅服务它们的实现、测试和工具脚本。

`apps/kite-cli` 不进入根 workspace，不恢复构建或启动；其依赖闭包已删除，只供源码阅读与对照。当前模块和真实运行路径由[开发入口](../../../../docs/development/README.md)与[八 workspace 边界](../../../../docs/active/unified-agent-boundary.md)负责。已删除实现及旧证据按[固定 revision](https://github.com/ferqx/kite-code/tree/d5407cfe4319c5a84d530f63b1d0a0123218ad34)追溯。

历史链接最初误用了仅本地存在的 `c53f66367fcd19c8f460a30a18ff3e54b9364a6a`，GitHub API 实际返回该 ref 不存在。现固定至远端可读取的 `d5407cfe4319c5a84d530f63b1d0a0123218ad34`；148 个被引用文件或目录的 Git 对象与删除前本地版本逐项一致。旧文档只修正链接目标，原日期、决策、验证结论及实际测试代码版本记录保持。

清理时曾将 `native/windows-sandbox-runner` 按旧调用方的配套实现一并删除。用户指出该目录后，已纠正范围并逐字节恢复其 11 个受版本控制的文件。独立原生后端源码保留；当前新架构未接入它，不作为删除依据，也不恢复其旧 Runtime 或发布调用方。Windows 当前能力与限制仍归[Shell 沙箱边界](../../../../docs/active/windows-shell-sandbox.md)。

复核删除范围时，将独立的 Windows runner 构建器、通用发布/运维 metadata 与 evidence 工具、历史报告验证器、重复测试/采样原语，以及对应的 PTY、CI 和文档影响测试恢复。它们不因曾被旧调用方使用就属于旧 Runtime 模块。原 `scripts/release/canonical-json.ts` 和 `artifact-layout.ts` 是旧 Service 的 re-export；其通用实现已原样迁至这两个脚本路径，消除旧 workspace 依赖，没有恢复 Service。

保留的 TUI 生命周期测试仅运行 `apps/kite-cli` 中独立的展示 leaf，不取得旧 Runtime 依赖，也不冒称新 composer 的验证。旧 MCP/Skills E2E 完全依赖已删除的旧 Runtime 夹具，随旧闭包删除，避免动态调用缺失文件。当前根八 workspace、默认调度和正式产品入口保持；独立历史 evidence 工具不接回当前资格生产链。

## Alternatives considered

- 继续保留全部旧树并只拒绝普通入口：此前边界可防止误启动，但不满足本次用户明确删除要求。
- 将旧依赖留作 `kite-cli` 可运行闭包：会继续保留用户要求删除的旧模块，未采用。
- 同时删除 `kite-cli`：违背用户明确保留范围，未采用。

## Consequences

开发、构建和当前验证只围绕新架构，历史 `kite-cli` 不具有可运行库资格。文档中旧实现链接固定到删除前版本，旧设计理由与实际失败证据继续可追溯；保留的安全、取消、恢复、未知副作用、原数据保护和发布门禁不因代码删除而放宽。

本次删除不升级工具定义或协议，不重标旧数据，不恢复旧 writer，不触发工具重放，也不授予未取得的跨平台、资源或完整发布资格。实际验证由当前测试、类型和边界检查说明，历史成功不冒充本次执行结果。
