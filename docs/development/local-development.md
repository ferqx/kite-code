# 本地开发与验证

仓库使用 Bun；CI 与正式 qualification 固定 Bun 1.4.0。先 `bun install`，再根据目标选择入口。

| 目标 | 命令 | 说明 |
| --- | --- | --- |
| TUI | `bun run tui` | 源码直接启动配套 App Server，不预构建 Web |
| Web 完整环境 | `bun run server` | 构建资源、启动显式 daemon、打印地址 |
| Web 资源热开发 | `bun run --cwd apps/kite-web dev` | 仅 Vite，不替代后端启动 |
| CLI | `bun run agent run --workspace . --task "任务"` | 信任与配置仍须满足 |
| 默认测试 | `bun run test` | 使用仓库测试 runner |
| TUI 系统测试 | `bun run test:tui:system` | PTY 场景，按修改选择定向场景 |
| 类型检查 | `bun run typecheck` | 根与 workspace |
| 文档 | `bun run check:docs`、`bun run check:docs-impact` | 结构阻断，影响提示需语义核对 |
| 首发证据 | `bun run check:plan-evidence` | 独立历史证据消费者 |

本地与 installed profile 不同；不要在诊断时把另一 checkout 的数据当成当前环境。显式服务测试使用隔离 profile/endpoint，结束后按所属 harness 清理。

先运行所属 workspace 的相关测试。跨包协议、持久化、授权或恢复变化再扩大到对应边界和 qualification；不能用 Web build 通过替代 TUI PTY，也不能用 fixture 通过宣称原生平台支持。

测试分层与真实模型调用约束见[测试入口](../../tests/README.md)。只修改文档不默认启动真实 Provider、发送外部请求或运行所有平台测试。

## Web 启动失败链的已知差异

[`ensure-web`](../../scripts/development/ensure-web.ts) 按 build→start→discover 调用子进程，但非零仅设置父进程 exitCode，没有立即停止后续步骤，因此可能在失败后打印已有 daemon 地址。后续需补 build/start 失败时不继续调用的回归，产品限制见[服务生命周期](../handbook/server/lifecycle.md)。
