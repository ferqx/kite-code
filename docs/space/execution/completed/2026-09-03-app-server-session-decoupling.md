# App Server进程与Durable Session解耦完成记录

状态：completed（KASD-00～KASD-06，本机完整Gate与implementation head `af7c7596c2e1b7b4aa6eccb12375aca017b45222`三平台qualification通过）

日期：2026-09-03

方案：[`2026-09-02-app-server-session-decoupling.md`](../../plans/2026-09-02-app-server-session-decoupling.md)

ADR：[`ADR-0166`](../../../adr/0166-decouple-app-server-process-from-durable-session-authority.md)

## 最终结果

- 默认TUI/CLI分别启动同build、parent-owned的stdio App Server；它们不发现共享daemon，不监听HTTP，也不再有build drift或`tui:fresh`恢复路径。
- installed使用canonical `kite-session.sqlite`，source按canonical checkout隔离同schema Store。多个App Server可共享durable facts；同一Session的
  execution writer由Store中的`controllerGeneration`、lease、revision、cleanup与effect receipt共同fence，PID/build/socket不拥有Session authority。
- 显式`kite server start/status/stop`管理owner-only Unix socket或current-user Windows named pipe daemon；同一进程提供stable loopback Web与
  Browser read-only Agent API。普通client断开不停止daemon，status/stop absent不创建状态。
- release upgrade/rollback只切换immutable candidate pointer；不发现、停止、替换或升级运行中的App Server。
- 旧`kite service ensure/status/stop/restart`、`service run-single`、single-Service manager/client、Native lifecycle protocol、canonical
  `service.sock`、previous-build replacement、Service-owned Web与process harness均已删除。
- 最终过度设计复核删除了无production caller的旧Kite Home Store composition与第二套Session创建协调器；remote/LAN、Browser mutation、
  compatibility range、Storage daemon与upgrade watcher均延期且未保留脚手架。

## 本机验证

- `bun run test`：363个workspace files、98个integration files、63个isolated files通过。
- `bun run typecheck`：16个workspace通过。
- 42个隔离TUI PTY scenario files通过。
- runtime package、pre-release architecture、core boundary、docs-impact(all/staged)、docs、format与pre-commit Gate通过。
- macOS arm64 dirty candidate `9e5ebc21d6cf30a6f7f80c7d`通过build/verify，以及installed TUI、paired App Server、显式daemon/Web、
  MCP wrapper、upgrade、rollback与uninstall完整smoke；archive SHA-256为
  `f15d706e596f60292662b8fcf2938581d0c2545e11ebb26e505df407c32e7483`。

## GitHub-hosted qualification

[OSS Release Candidate run 33659494358](https://github.com/ferqx/kite-code/actions/runs/33659494358)绑定exact implementation head
`af7c7596c2e1b7b4aa6eccb12375aca017b45222`，结果如下：

| Runner | Job | 结果 | 覆盖 |
| --- | --- | --- | --- |
| macOS 15 arm64 | `candidate-macos-arm64` | success | contract、native build、verify、install/smoke、TUI PTY、artifact upload |
| Ubuntu 24.04 x64 | `candidate-linux-x64` | success | contract、native build、verify、install/smoke、TUI PTY、artifact upload |
| Windows 2025 x64 | `candidate-windows-x64` | success | pinned runner、endpoint/Session fencing、contract、native build、verify、install/smoke、TUI PTY、artifact upload |

Windows qualification期间真实发现并修复了cold Rust fixture串行编译超时、profile short/long canonical spelling与daemon endpoint identity漂移；
最终run没有跳过installed TUI或daemon smoke。

## 非目标

- 不交付remote/LAN、多租户、Browser mutation或后台Storage daemon。
- 不承诺跨protocol版本兼容区间；默认parent-child exact build，显式daemon exact protocol/capability。
- 不自动迁移、删除或fallback到旧`kite.sqlite`。
