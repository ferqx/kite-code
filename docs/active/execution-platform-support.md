# Production execution platform support

状态：active

读取时机：修改 sandbox backend、production execution admission、process-tree 限制、
network boundary、TUI/CLI composition root、Skill/local stdio MCP child 或平台发布矩阵时。

验证：`bun test tests/sandbox/platform-capability-probe.test.ts tests/sandbox/execution-boundary.test.ts
tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts`、
`bun run scripts/release/platform-capability-probe.ts`，以及
`.github/workflows/platform-capability-probe.yml` 的声明平台原生 artifact。

相关：ADR-0054、ADR-0061、`release/platform-capabilities/support-matrix-v1.json`、
`docs/space/plans/2026-07-29-agent-production-execution-isolation.md`。

## 当前支持集合

当前 production-supported platform/backend 集合为空，D-04 已按“空支持集”关闭，不得生成
production artifact。候选组合不是支持声明：

| runner 候选 | backend 候选 | 当前结论 | 主要缺口 |
| --- | --- | --- | --- |
| macOS 15 | Seatbelt | `excluded` | 本地 filesystem profile 已加固，但缺少新 release-pinned native artifact、完整 process-tree 上限、Skill/MCP 继承与入口组合证据 |
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

当前 macOS 本机增量 probe 已能证明 Workspace read/write、Workspace read-only、Workspace 外
read/write、protected Git/Agent config/credential/shell profile、symlink escape、network-off 和
shell descendant filesystem inheritance；executor 还使用逐 invocation、`0700`、结束清理且不
共享的 runtime temp，返回前请求终止已跟踪 process group；未确认退出时 fail closed 并保留 runtime，
确认后才以不跟随 symlink 的物理清理恢复 hostile mode/BSD immutable flag，删除不能确认时也
fail closed。profile 还拒绝读取未列为 runtime
dependency 的 `/private/etc/hosts`。这些只是
未固定的开发 evidence。Seatbelt 没有实现并
证明每次 Shell invocation 的硬 process-tree 数量上限，forked Skill/local stdio MCP 与两个
production composition entrypoint 也尚未形成 native evidence，因此 outcome 仍必须是
`excluded`、`productionSupported=false`。

Task 1B.4 的进程内网络控制器已能对 `web_fetch` 逐 invocation/hop 执行精确 host allowlist、
DNS 实际地址检查、manual redirect 复查、endpoint revision 与 pinned socket，并在 dispatch 前
持久化 allow/deny receipt。该控制器不依赖 proxy environment，但也不能约束任意 descendant。
因此所有候选平台在 sealed boundary 下仍把 Shell/Skill 网络收紧为 off，并在 Task 1B.8 前关闭
全部 MCP transport entrypoint 和 `tool_search` Provider readiness；没有 child-bypass native
conformance，也没有平台因此进入支持集。

Linux bubblewrap 的开发边界现已把 canonical Workspace 按 `workspace_write` 或 `read_only`
分别投影为 rw/ro bind，并把逐 invocation runtime 显式 rw bind；runtime 清理在只暴露该 runtime
和只读系统工具的独立 mount namespace 内执行，避免 nested symlink 把宿主清理重定向到
Workspace 或其他宿主路径。Ubuntu workflow 会运行真实 executor 与 hostile cleanup 测试，
验证 Workspace 写、read-only 拒绝、Workspace 外读取拒绝，以及多层 `000` 目录和 external
symlink 下的 runtime 清理。protected path、seccomp strength、硬 process-tree 上限和完整
child/入口继承仍未证明，因此 Linux 结论继续是 `excluded`。

## ExecutionBoundaryV1 schema 与 composition gate

Task 1B.1 已在 Core 冻结 `ExecutionBoundaryV1`：filesystem 只允许
`read_only | workspace_write | full_access`，network 只允许 `off | allowlist`，local/private
network 固定为 `false`，process-tree 上限必须是有限正整数。Workspace root 在解析时使用真实
路径 canonicalize，并与 Workspace Trust 共用 `canonicalWorkspaceKey()`；allowlist 只接受精确
DNS host、统一小写/排序/去重，不接受 URL、IP literal 或空的 allowlist 模式。

边界组合只能收紧：filesystem scope 取更小权限、allowlist 取交集（空交集变成 network off）、
protected policy 取 deny、process-tree limit 取更小值、sandbox required 取逻辑或、unavailable
fallback 取 fail。不同 canonical Workspace 的边界禁止组合。

production composition gate 不接受单一 `sandboxAvailable`，也不接受调用方传入 raw
`supported | read_only_only`。它只读取
`release/platform-capabilities/approved-execution-qualifications-v1.json`，校验固定 revision/digest，
再按实际 OS release/version、architecture、Bun、backend、network mode 和 TUI/foreground CLI
入口精确解析 qualification。probe 与 resolver 共用 canonical environment identity producer，且
每个可批准 qualification 必须同时包含两个入口的 composition evidence。qualification 内逐维固定 filesystem、network、完整 process tree、
child inheritance 和 verified in-process read-only strength。flag/artifact 缺失、Workspace 不匹配、
`full_access`、环境无匹配 qualification 或任一必需维度 `unsupported` 时 capability surface 全部
关闭；同一环境 admission key 重复也按歧义拒绝，不能由 registry 文件顺序选择首项。

`read_only_only` 还要求 digest 校验通过的非空 tool catalog；每个 tool contract 明确禁止 network、
process、write 和 workspace 外路径，只允许 Workspace read。准入 surface 保留 catalog
revision/digest、descriptor revision 与 effect contract，供后续 tool disclosure/execution 对照，
不能只按相同 tool ID 放行。当前 builtin disclosure 与 runner 已执行该匹配，并拒绝外部路径及
动态 MCP；该 surface 的 shell、writer、Skill child 和 local stdio MCP 始终关闭。

对未来非空的原生 `supported` qualification，surface 各能力轴同样独立执行：例如
`filesystemScope=read_only` 可以保留受 native sandbox 约束的 process/Shell，但模型披露和
Runner 都必须按 descriptor effects 拒绝进程内 writer；`network=off` 拒绝进程内网络工具，
任意 production surface 都拒绝进程内文件工具的 Workspace 外路径。审批不能提升这些 ceiling。

`loadProductionAgentConfig()` 是 2A composition root 必须使用的 Core 配置准入入口，并在返回
任何可供 Runtime/进程使用的配置前完成 sealed gate；它不改变当前开发 TUI/CLI。当前静态
support matrix 与批准 qualification registry 都是空支持集，1B.1 schema 或技术评估 fixture
不能自行提升为 release approval。未来改变 registry 必须绑定新的固定 evidence/manifest，不能
从用户、项目、CLI 或普通 App 调用参数构造。

production loader 按 boundary 的 canonical Workspace 读取 project config，并将 user、project、
CLI/App 的 rollout 与 sandbox restriction 按 deny-wins 组合。`sandbox.enabled=false` 或
`--no-sandbox` 等价 restriction 必须在 composition 阶段拒绝，不能获得 shell/process surface；
成功的 production config 固定 `sandbox.enabled=true`，后续入口必须直接消费该 sealed config。

## Evidence 生命周期

探针 JSON 记录实际 OS release/version、architecture、Bun、backend、逐项 verdict、限制和
canonical digest。静态 support matrix 当前为 `accepted_empty_support_set`。任一 backend、
profile、composition root、runner image 或边界实现变化都需要新 evidence；只有新的追加 ADR
与独立 release gate 才能加入非空生产支持项。
