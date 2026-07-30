# Agent 生产化 Phase 1B：执行隔离与变更边界计划

状态：active
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)
设计依据：RFC §7、§9.4、§18

Task 1B.0 已完成：三平台原生 probe 均为 `excluded`、`productionSupported=false`，
ADR-0061 已接受，D-04 以空支持集关闭。Task 1B.1 已基于
`1063e879933f3e1b0cf8c0958363c999bb2696ab` 激活；1B.2–1B.4 继续等待 1B.1，其余 Task 按
依赖保持未绑定。规范记录见
[decision register](2026-07-29-agent-production-decision-register.md)。

## 目标

把 `workspace_write`、network allowlist、protected path 和 writer worktree 从产品文案变成
跨入口可验证的技术边界，使 `accept_edits`/`auto` 不再依赖审批或命令字符串扫描来代替
隔离。

## 非目标

- 不支持 `full_access` GA；
- 不支持 Web、hosted 或 multi-tenant runner；
- 不允许远程 rollout 提升权限；
- 不以 Agent shell 操作 `.git` 来创建 worktree；
- 不承诺外部 MCP 服务端在本地 sandbox 内；
- 不将 worktree 当作外部副作用回滚机制。

## 当前基线

- macOS Seatbelt profile 对 `/` 允许全盘文件读写；
- Linux bubblewrap 更接近 Workspace bind isolation，但平台强度不等价；
- `ShellNetworkMode` 只有 `disabled | allow_all`；
- sandbox backend 不可用时 executor 回退裸 `shellTool`；
- protected path 主要依赖 `checkDangerousPaths()` 字符串检查；
- 后台/并发 writer 没有生产 worktree/branch controller。

## 主要改动范围

- `src/core/sandbox/`
- `src/core/types.ts`
- `src/core/policies/`
- `src/core/tools/process-tree.ts`
- `src/core/harness/tool-runner.ts`
- `src/core/controllers/tool-controller.ts`
- App composition root
- 新增 typed Workspace/Worktree Controller
- sandbox/network/worktree conformance tests
- 三平台 artifact smoke

## 共享 schema ownership

本计划是 `ExecutionBoundaryV1` 的首个实现计划，Platform 与 Security & Privacy 共同审批，
Platform 是规范 producer。它只投影 2A `ReleaseProfileV1` 的 process-tree limit，并拥有平台
enforcement；不得复制 2A 的预算默认值/composition 或 1C 的 reservation、waiter 和终态语义。

## 实施步骤

### 任务执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 1B.0 | `T:0:0.1`、`T:0:0.2`、`D-04:CLOSED`、`D-08:CLOSED`、`D-09:CLOSED` | `docs/adr/` 隔离 ADR、`scripts/release/platform-capability-probe.ts`、filesystem/network/process-tree support matrix、`tests/sandbox/platform-capability-probe.test.ts` | `bun test tests/sandbox/platform-capability-probe.test.ts`；每个声明支持组合运行 native deny/allow/process probe | 仅调查/ADR；不可行平台明确 verified in-process read-only 或排除 |
| 1B.1 | 1B.0、`T:0:0.3` | `src/core/sandbox/types.ts`、`src/core/config/execution-boundary.ts`、`src/core/types.ts`、`tests/sandbox/execution-boundary.test.ts` | `bun test tests/sandbox/execution-boundary.test.ts` | `executionBoundaryV1=false` 时 production 禁止进程型/写能力；不得用审批恢复 |
| 1B.2 | 1B.0、1B.1 | `src/core/sandbox/profile.ts`、`executor.ts`、`shell-wrapper.ts`、macOS process-tree limit 与真实 sandbox tests | `bun test tests/sandbox.test.ts tests/sandbox-runtime.test.ts tests/sandbox/process-tree-limit.test.ts`；macOS native smoke | production 不回退裸 shell；失败关闭 macOS process/write capability |
| 1B.3 | 1B.0、1B.1 | `src/core/sandbox/bwrap.ts`、Windows backend/projection、platform/process-tree tests | `bun test tests/sandbox/platform-backends.test.ts tests/sandbox/process-tree-limit.test.ts`；声明支持平台 native smoke | unsupported 不伪装 sandbox；仅 verified in-process read-only 或平台排除 |
| 1B.4 | 1B.0、1B.1 | `src/core/sandbox/network-policy.ts`、`network-enforcer.ts`、`executor.ts`、`process-tree.ts`、DNS/redirect/concurrent-call tests | `bun test tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts`；child bypass native smoke | `networkBoundaryV1=false`；production 回滚为 network=off |
| 1B.5 | 1B.1–1B.4 | shared protected-path policy、registry/harness integration tests | `bun test tests/policies/protected-path.test.ts` | 跟随 `executionBoundaryV1`；production 缺 gate 时拒绝写 |
| 1B.6 | 1B.1、1B.5、`D-09:CLOSED` | `src/app/workspace/worktree-controller.ts`、`change-handoff.ts`、真实 Git repo E2E | `bun test tests/workspace/worktree-controller.test.ts` | `worktreeControllerV1=false`；后台/并发 writer 随之关闭 |
| 1B.7 | 1B.1、1B.4–1B.6 | `src/app/release/execution-status.ts`、CLI/TUI composition/status、`tests/sandbox/status-projection.test.ts`、TUI scenario | `bun test tests/sandbox/status-projection.test.ts tests/tui-system/scenarios/sandbox-mode.test.ts` | 状态 UI 可回退，但 production admission 不可绕过 |
| 1B.8 | 1B.1、1B.4、1B.5、`T:1A:1A.6` | `src/core/mcp/supervisor.ts`、`manager.ts`、`runtime-provider.ts`、`src/app/tui/hooks/useMcpController.ts`、transport boundary/concurrency tests | `bun test tests/mcp-supervisor.test.ts tests/mcp-manager.test.ts tests/mcp-transport-boundary.test.ts tests/mcp-transport-boundary-concurrency.test.ts` | conformance 前 limited 排除 local stdio MCP；HTTP MCP enforcement 不可回退为环境代理 |
| 1B.9 | 1B.2–1B.8、`T:2A:2A.0` | `scripts/release/execution-boundary-smoke.ts`、platform/adversarial/parallel-batch matrix、artifact workflows；唯一产生 `MS:1B-DONE` | `bun run release:smoke`；声明支持组合 native conformance | 任一 bypass 关闭对应 platform/capability |

### Task 1B.0：平台 backend 可行性与支持矩阵

在实现 schema 或 backend 前完成 bounded spike，并由 ADR 固定：

- 首发声明支持的 OS/version/backend 与 `read_only/workspace_write/network off/allowlist`
  能力矩阵；
- macOS Seatbelt、Linux bubblewrap/network namespace、Windows 候选 backend 的真实探针；
- shell、Skill、local stdio MCP child/descendant 是否继承边界；
- 每个平台是否能对单个 shell invocation 的完整 process tree 强制数量上限，并在 kill 后
  确认无残留 descendant；只能报告 `enforced` 或 `unsupported`，不能用顶层 invocation
  计数替代；
- 每个平台结论只能是 `supported`、`read_only_only` 或 `excluded`；
- allowlist backend 不可行时允许 `network=off`，但不得以 proxy environment 变量作为无旁路
  技术边界；
- 产出 ADR、support matrix 和 native probe evidence；Task 1B.1–1B.4 不能边实现边选择
  backend。

### Task 1B.1：冻结执行边界 schema

定义：

```typescript
type FilesystemScope = 'read_only' | 'workspace_write' | 'full_access';
type NetworkMode = 'off' | 'allowlist';

interface ExecutionBoundaryV1 {
  filesystemScope: FilesystemScope;
  workspaceRoot: string;
  networkMode: NetworkMode;
  networkAllowlist: string[];
  allowLocalAndPrivateNetwork: false;
  protectedPathPolicy: 'deny' | 'prompt';
  maxProcessTreeSizePerShellInvocation: number;
  sandboxRequired: boolean;
  sandboxUnavailable: 'fail' | 'verified_in_process_read_only';
}
```

规则：

- canonical Workspace identity 与 Workspace Trust 共用；
- protected path denylist 取并集；
- allowlist 取交集；
- App 可以把边界注入 Core，Core 不导入 TUI 类型；
- backend 声明其实际强度，不使用单一 `sandboxAvailable: boolean` 掩盖差异。
- `maxProcessTreeSizePerShellInvocation` 来自 effective Release Profile，只能收紧；它限制
  shell、pipeline 与 descendants 的完整 process tree，不限制顶层 shell invocation 数。
  后者由 1C 的 `maxConcurrentShellInvocations` permit 管理；
- `verified_in_process_read_only` 不是审批降级：它只暴露 conformance allowlist 中不创建
  process、不能访问 Workspace 外路径的进程内只读工具，强制 network off；
- flag 关闭、backend 缺失或 fallback 未通过 conformance 时，production run 在 composition
  root 阶段拒绝 shell、writer、Skill child 和 local stdio MCP，不能先启动后提示审批。

涉及文件：

- `src/core/sandbox/types.ts`
- `src/core/config/execution-boundary.ts`
- `src/core/types.ts`
- schema/property tests

### Task 1B.2：macOS workspace_write 技术隔离

改造 Seatbelt profile：

- 默认禁止全盘写；
- Workspace realpath 和受控 runtime temp 目录只读/读写按 scope 放行；
- 系统运行依赖只读；
- `.git`、credential、shell profile、Agent/MCP 配置按 protected policy 拒绝；
- symlink、`..`、case normalization 和 mount alias 在 profile 构造前 canonicalize；
- Workspace 外路径即使命令字符串未命中也由 OS policy 拒绝。

涉及文件：

- `src/core/sandbox/profile.ts`
- `src/core/sandbox/executor.ts`
- `src/core/sandbox/shell-wrapper.ts`
- `tests/sandbox.test.ts`
- `tests/sandbox-runtime.test.ts`

验证：

- 允许 Workspace 普通文件读写；
- 拒绝 Workspace 外 read/write/create/unlink；
- 拒绝 protected path；
- symlink 指向 Workspace 外被拒；
- tool、shell 和 Skill 子进程继承同一边界；
- 超过 process-tree 上限时完整 tree 被平台强制终止，产生稳定
  `process_limit_exceeded`，无 orphan descendant；
- 测试直接检查真实 `sandbox-exec` 行为，不只 snapshot profile 文本。

无法在目标 macOS 版本实现真实 `workspace_write` 时，该平台的 `auto` 保持 off，不得降低门槛。

### Task 1B.3：Linux/Windows 边界对齐

Linux：

- 校验 bubblewrap 只读系统 bind、Workspace rw bind 和 network namespace；
- seccomp 缺失时报告实际强度，不伪装完整；
- runtime temp 和必要 socket 显式 allow。
- 使用 cgroup/pids controller 或已接受的等价 backend 强制 process-tree 上限；不可用时
  该平台 production shell unsupported。

Windows：

- 只实现 Task 1B.0 已接受的 backend outcome；
- 没有等价技术隔离时 limited profile 只允许 verified in-process Workspace-bound read-only
  工具，关闭 shell/Skill child/stdio MCP/writer，或暂不列为支持平台；
- 若 Job Object/已接受 backend 不能强制 process-tree 上限，同样关闭 production shell；
- 不能把路径字符串检查表述为 sandbox。

验证：

- 每个平台输出稳定 backend/capability projection；
- release evidence 分 platform/backend；
- Linux 结果不替代 Windows/macOS。

### Task 1B.4：network off/allowlist 执行层

实现策略使用 Task 1B.0 ADR 已选择的透明代理、namespace firewall 或平台等价机制，并且
必须满足：

- DNS 解析后检查实际 IP；
- 每次 redirect 重新检查；
- 拒绝 loopback、link-local、private、metadata endpoint；
- 拒绝 IP literal/编码绕过和 DNS rebinding；
- shell/Skill/MCP child 与 descendants 无代理旁路；
- 同一 turn 的并发 `web_fetch`、shell、remote MCP inventory/resource/tool call 必须逐
  invocation 执行 DNS、redirect、endpoint revision 与 network admission；不能复用同 batch
  中首个 sibling 的 allow 结果；
- 一个 sibling 的 denial/controller failure 不得放行、重写或取消其他 sibling 已持久化的
  独立边界决定；
- 只按 host 执行时不宣传 URL path 隔离；
- 无法执行 allowlist 时自动收紧为 `off`，不能回退 `allow_all`。

涉及文件：

- `src/core/sandbox/executor.ts`
- `src/core/sandbox/bwrap.ts`
- 新增 network policy/enforcer 模块
- `src/core/tools/process-tree.ts`
- local DNS/redirect/proxy fixture tests

验证至少包含：

- allowlisted public host 成功；
- 非 allowlisted host 失败；
- allowlisted host redirect 到 private IP 失败；
- DNS 首次 public、后续 private 失败；
- child process 清除 proxy env 后仍不能旁路；
- 4-way 并发 read/network batch 中每个 destination 独立判定，private/redirect/rebinding
  sibling 收到零请求且 public sibling 的 receipt 不被串用；
- network controller crash 后任务得到 typed unavailable。

### Task 1B.5：protected path 统一求值

将 protected path 从 shell 字符串防线升级为工具、shell、Skill、MCP local process 共用的
结构化策略：

- canonical path + operation；
- `.git`、Agent 配置、MCP 配置、credential、shell profile 和 Workspace 外路径；
- read 与 write 分开；
- deny 优先于 allow；
- typed Git/worktree controller 使用独立 App 授权，不向模型 shell 放开 `.git`；
- `checkDangerousPaths()` 只保留 defense-in-depth，不是权威 gate。

涉及文件：

- `src/core/policies/`
- `src/core/harness/tool-runner.ts`
- `src/core/tools/registry/`
- `src/core/sandbox/shell-wrapper.ts`
- Policy conformance tests

### Task 1B.6：typed worktree/branch controller

新增 App-owned controller：

- 输入 baseline repo、commit、task/run/writer identity；
- 只允许规范 repo 根目录和安全命名；
- 创建独立 worktree 与 branch；
- 输出 opaque worktree identity 给 Runtime；
- 支持 diff/status/changed-files handoff；
- 清理只处理 controller 创建且 identity 匹配的 worktree；
- dirty、conflict、branch collision、磁盘满和 Git 失败全部 fail closed；
- 不自动 push、merge 或删除用户 branch。

运行规则：

- 前台 TUI 单 writer 可由用户选择当前 checkout；
- 用户在场的前台 Headless CLI 必须给出 diff/review handoff；
- 后台、定时、并发和委派 writer 强制独立 worktree；
- 创建失败不回退共享 checkout；
- 共享 checkout 中 Sub-agent 只允许只读。

建议落点：

- `src/app/workspace/worktree-controller.ts`
- `src/app/workspace/change-handoff.ts`
- TUI/CLI composition root
- `tests/workspace/worktree-controller.test.ts`
- 真实临时 Git repo E2E

### Task 1B.7：入口与状态展示

TUI/CLI 展示：

- backend 和实际 filesystem scope；
- network `off/allowlist`；
- protected path policy；
- 当前是否 controller worktree；
- capability 被关闭原因；
- sandbox unavailable fallback。

模型不接收完整安全 profile，只接收执行所需的有效 Tool surface。CLI 越界 override 在创建
Runtime/MCP/Skill 前失败。

### Task 1B.8：MCP transport 执行边界集成

把 MCP lifecycle 纳入同一个 Workspace/run boundary：

- `McpSupervisor`/`McpManager` 创建 transport 时必须接收 canonical Workspace identity、
  `ExecutionBoundaryV1` revision 和 run/profile identity；
- local stdio server 由 sandbox executor 启动，继承 filesystem/network/process-tree；
- 旧 transport 的 Workspace、policy 或 revision 不匹配时先关闭再重建，不能跨 Workspace/run
  复用；
- remote HTTP transport 的 DNS、redirect、private destination 和 endpoint revision 进入
  network enforcer；环境 proxy 变量不是权威边界；
- remote server 端执行仍标记为 unsandboxed remote effect，并继续经过 1A.6 egress permit；
- 并发 local/remote MCP 调用分别绑定 Workspace/run boundary revision、endpoint/tool
  revision、network decision 和 invocation receipt；transport pool 不得把一次 admission
  缓存成 sibling 的通行证；
- 本任务 conformance 通过前，首个 limited profile 排除 local stdio MCP；没有强制 endpoint
  enforcement 的 remote HTTP MCP 同样不进入 allowlist。

涉及文件：

- `src/core/mcp/supervisor.ts`
- `src/core/mcp/manager.ts`
- `src/core/mcp/runtime-provider.ts`
- `src/app/tui/hooks/useMcpController.ts`
- `tests/mcp-transport-boundary.test.ts`
- `tests/mcp-supervisor.test.ts`
- `tests/mcp-manager.test.ts`

### Task 1B.9：三平台和 adversarial conformance

建立版本化矩阵：

- platform/backend；
- TUI/Headless CLI；
- builtin shell/文件工具；
- Skill child；
- local stdio MCP child；
- symlink/path traversal；
- DNS/redirect/child bypass；
- parallel read/network/MCP batch 的逐调用隔离、permit/revision 串用和部分失败；
- process-tree 超限、完整清理和 orphan detection；
- sandbox missing；
- worktree collision/cleanup。

目标 workflow 使用实际分发制品，不只从源码运行。

所有声明支持的组合通过、未支持组合显式排除且 active/book/ADR/map 收敛后，本任务唯一产生
`MS:1B-DONE`。

## 验收条件

- [ ] macOS/Linux 支持声明与真实隔离强度一致；
- [ ] 写入支持平台实现真实 `workspace_write`；
- [ ] allowlist 无 DNS/redirect/child bypass；
- [ ] protected path 在所有本地执行路径统一生效；
- [ ] sandbox/network controller 不可用时 fail closed；
- [ ] 后台/并发/委派 writer 强制 worktree；
- [ ] worktree 创建失败不触碰共享 checkout；
- [ ] TUI/CLI 显示实际边界；
- [ ] 三平台 artifact conformance 有明确通过/不支持结果；
- [ ] local stdio/remote HTTP MCP transport 使用同一有效 boundary revision；
- [ ] production shell 平台强制 process-tree 上限，不能执行的平台明确 unsupported；
- [ ] active/book/ADR/map 与实现同步。

## 回滚

- 可把 network 从 allowlist 收紧为 off；
- 可把 write profile 收紧为 verified in-process read-only，同时关闭所有进程型能力；
- 可关闭 background/concurrent writer；
- 可把 canary cohort 置 0；
- 不允许回滚为 sandbox 缺失时裸 shell；
- 不允许回滚为后台 writer 共享 checkout；
- controller 清理失败时保留 worktree并提示人工处理，不执行广泛递归删除。

## 风险

| 风险 | 控制 |
| --- | --- |
| macOS profile 阻断必要系统文件 | 最小只读系统 allowlist + artifact smoke |
| proxy 被子进程绕过 | OS/network namespace 强制 + descendant conformance |
| DNS rebinding | 每次解析/redirect 校验实际 IP |
| worktree 清理误删用户数据 | opaque identity、规范根目录、只清理 controller-owned |
| Windows 无可用 backend | 缩小支持矩阵，不降低安全定义 |
| protected path 与 Git controller 冲突 | 模型工具 gate 与 App typed controller 分权 |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-execution-isolation.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

- 三平台 backend 支持矩阵；
- 真实文件/network adversarial 报告；
- process-tree limit 与 orphan cleanup native 报告；
- worktree 并发/失败/cleanup E2E；
- TUI/CLI 状态截图或 snapshot；
- limited profile 的 effective boundary；
- 不支持平台或入口的明确产品文案。
