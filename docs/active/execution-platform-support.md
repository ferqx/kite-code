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

当前 production-supported platform/backend 集合为空，D-04 已按“空支持集”关闭，不得生成
production artifact。候选组合不是支持声明：

| runner 候选 | backend 候选 | 当前结论 | 主要缺口 |
| --- | --- | --- | --- |
| macOS 15 | Seatbelt | `excluded` | Workspace 外及 protected path 读写仍开放；无完整 process-tree 上限、继承与入口组合证据 |
| Ubuntu 24.04 | bubblewrap | `excluded` | Workspace 外/protected path deny 未证明；无完整 process-tree 上限、继承与入口组合证据 |
| Windows Server 2025 | none | `excluded` | 没有 filesystem/network sandbox backend |

固定证据来自
[Platform Capability Probe run 30579701659](https://github.com/ferqx/kite-code/actions/runs/30579701659)，
绑定提交 `a4bdf22aa7c2a987734524c278c4750e7b9faa96`。macOS arm64、Ubuntu x64 与 Windows
x64 artifact 均为 `excluded`、`productionSupported=false`；三个 artifact 的 archive digest
固定在 support matrix。它们不包含 TUI/CLI composition evidence，也不能产生 production
资格。

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
即使某 runner 的技术项全部为 `enforced`，也必须由新的追加 ADR、新鲜证据与独立 release
gate 才能改变已关闭 D-04 的空支持集并产生 production support 声明。`backend=none` 不可能产生进程型
`supported`，只能在另行验证的无进程 fallback 条件下产生 `read_only_only`。

## Evidence 生命周期

探针 JSON 记录实际 OS release/version、architecture、Bun、backend、逐项 verdict、限制和
canonical digest。静态 support matrix 当前为 `accepted_empty_support_set`。任一 backend、
profile、composition root、runner image 或边界实现变化都需要新 evidence；只有新的追加 ADR
与独立 release gate 才能加入非空生产支持项。
