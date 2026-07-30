# Production execution platform support

状态：active

读取时机：修改 sandbox backend、production execution admission、process-tree 限制、
network boundary、TUI/CLI composition root、Skill/local stdio MCP child 或平台发布矩阵时。

验证：`bun test tests/sandbox/platform-capability-probe.test.ts`、
`bun run scripts/release/platform-capability-probe.ts`，以及
`.github/workflows/platform-capability-probe.yml` 的声明平台原生 artifact。

相关：ADR-0054、ADR-0061、`release/platform-capabilities/support-matrix-v1.json`、
`docs/space/plans/2026-07-29-agent-production-execution-isolation.md`。

## 当前支持集合

当前 production-supported platform/backend 集合为空，D-04 保持 `open`，不得生成 production
artifact。候选组合不是支持声明：

| runner 候选 | backend 候选 | 当前结论 | 主要缺口 |
| --- | --- | --- | --- |
| macOS 15 | Seatbelt | `excluded` | Workspace 外及 protected path 读写仍开放；无完整 process-tree 上限、继承与入口组合证据 |
| Ubuntu 24.04 | bubblewrap | `excluded` | 原生证据未固定；无完整 process-tree 上限与入口组合证据 |
| Windows Server 2025 | none | `excluded` | 没有 filesystem/network sandbox backend |

本机 macOS arm64、Darwin 25.6.0、Bun 1.3.14 的探针只证明当前 Seatbelt backend 可以允许
Workspace 写并阻断 network；它同时证明 Workspace 外、`.git` 与 symlink escape 写没有被
现有 profile 阻断，因此结论仍是 `excluded`。本机证据不能代替另外两个原生 runner，也不能
代替 TUI/CLI composition evidence。

## 准入语义

矩阵当前显式选择 `selectedNetworkMode=off`。`supported` 要求 filesystem allow/deny、
network-off、完整 process-tree 硬数量上限与 kill 后
清理、shell/Skill/local stdio MCP inheritance，以及 TUI/foreground CLI 组合根全部为
`enforced`。无旁路 allowlist 可以是 `unsupported`，但该平台此时只能支持 network-off profile；
需要 allowlist 的 profile 仍不可准入；若未来选择 allowlist，evaluator 必须改为要求
`network.allowlist=enforced`。`read_only_only` 只接受单独通过 conformance 的无进程
Workspace-bound 只读工具、network-off 和两个入口组合证据；当前不存在该 fallback。

backend discovery、sandbox 命令成功、顶层 shell invocation permit、PID namespace、
`--die-with-parent`、child 自然退出或 proxy 环境变量都不是对应能力的 enforcement evidence。
探针无法执行或不能证明时按 `unavailable/unsupported` 处理，最终结论为 `excluded`。
`outcome` 只是技术能力分类；探针固定输出 `productionSupported=false`，不能自行完成治理签署。
即使某 runner 的技术项全部为 `enforced`，也必须由 accepted ADR、已关闭 D-04 与已固定矩阵的
独立 release gate 才能产生 production support 声明。`backend=none` 不可能产生进程型
`supported`，只能在另行验证的无进程 fallback 条件下产生 `read_only_only`。

## Evidence 生命周期

探针 JSON 记录实际 OS release/version、architecture、Bun、backend、逐项 verdict、限制和
canonical digest。Workflow artifact 运行并固定前，静态 support matrix 保持
`native_evidence_pending`。任一 backend、profile、composition root、runner image 或边界实现
变化都需要新 evidence；只有拟议 ADR accepted 且 D-04 关闭后，矩阵才能加入非空生产支持项。
