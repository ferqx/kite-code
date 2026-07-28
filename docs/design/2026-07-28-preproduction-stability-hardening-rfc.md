# Kite Code Agent 0.1.0 预生产稳定性加固 RFC

状态：approved（已转实施计划）
日期：2026-07-28
目标分支：`featrue/0.1.0` 的发布候选分支
依赖：ADR-0001（Runtime Kernel）、ADR-0042（文件工具语义与 Rewind）
关联：`docs/active/six-concept-runtime-architecture.md`、`docs/active/cancel-resume-cleanup.md`、`docs/active/authorization.md`、`docs/active/shell-platform-compatibility.md`、`docs/active/real-model-test-boundary.md`

> 本文是未来设计提案，不描述当前行为。批准后必须先转化为 `docs/space/plans/` 下的可验证实施计划；架构决策落地前必须新增 ADR，不能改写 ADR-0042 的历史结论。

## RFC 评审信息

评审状态：已通过
进入评审：2026-07-28
批准日期：2026-07-28
评审结论：accepted
评审人：Codex 初审、项目所有者确认
决策人：项目所有者（本线程确认）

实施计划：[`2026-07-28-preproduction-stability-hardening.md`](../space/plans/2026-07-28-preproduction-stability-hardening.md)
决策记录：ADR-0045、ADR-0046、ADR-0047、ADR-0048

### 评审范围

本轮评审只决定设计和预生产门禁是否可接受，不授权修改生产行为、创建发布分支或开始十二个实施 PR。评审通过后的下一步是：

1. 为 Event identity/commit protocol 和 Crash-consistent Rewind 分别创建 proposed ADR。
2. 将 RFC 拆为 `docs/space/plans/` 下的 PR0～PR11 实施计划。
3. 固定 Source SHA、支持矩阵、资源阈值和 Required Checks。
4. 逐 PR 实施、验证并同步更新相关 `docs/active/`。

### 必须形成结论的决策

| 决策 | RFC 建议 | 当前状态 |
| --- | --- | --- |
| Windows Shell 边界 | 允许受控非沙箱 Bash；`full` 禁止 | 用户已确认 |
| Linux/macOS sandbox | backend 缺失或漂移时 fail closed | accepted（ADR-0047） |
| Rewind 保证范围 | 仅覆盖统一 mutation gateway 的受管文件修改 | accepted（ADR-0046） |
| Event identity | occurrence ID 与业务 idempotency 分离 | accepted（ADR-0045） |
| Store 提交协议 | event batch、sequence、Snapshot 同一事务 | accepted（ADR-0045） |
| 配置安全 ceiling | project 只能收紧安全设置，不能提升权限 | accepted（ADR-0048） |
| MCP secret 边界 | stdio 最小环境 allowlist，secret 显式引用 | accepted（ADR-0048） |
| 本地日志 | 默认 metadata-only，diagnostic 显式短期启用 | accepted（ADR-0048） |
| 网络边界 | DNS/IP pinning、逐跳 SSRF、流式响应上限 | accepted |
| 交付范围 | PR0～PR11 共十二个切片 | accepted |
| 发布结论 | 全部门禁完成前维持 NO-GO | accepted |

### 批准条件

- 上表所有“待评审”项都有明确的 accepted、rejected 或 revision-required 结论。
- rejected 项同时记录替代方案，不能只删除门禁。
- reviewer 确认十二个切片的依赖无循环，且每个切片有独立失败复现与回滚边界。
- Windows 非沙箱 Bash 的风险提示、审批和 CI 声明不会被描述为 sandbox。
- 新 ADR、实施计划、active 文档和发布证据的生命周期责任明确。
- 评审记录填写结论、决策人、日期和 residual risks。

### 评审记录

| 日期 | 评审人 | 结论 | 意见/要求 |
| --- | --- | --- | --- |
| 2026-07-28 | Codex 初审 | revision-complete | 已完成源码核验、横向预生产审计、Windows 边界调整和 RFC 最终一致性检查；等待项目决策人评审 |
| 2026-07-28 | 项目所有者 | accepted | 转入 `docs/space/plans/` 实施，并新增 ADR-0045～0048 |

## 1. 结论

预生产整改方案指出的主要风险与当前代码相符，应判定当前版本 **NO-GO**，并冻结非稳定性功能开发。整改应保留“安全边界、资源边界、一致性、发布证据”四条主线。原九个 PR 不足以覆盖横向审计发现的配置、secret、网络、数据目录与发布证据问题；本 RFC 将其扩展为 PR0～PR11 共十二个可评审切片。

本 RFC 将工作收敛为四个架构工作流：

1. **执行边界**：沙箱准入、Deadline、进程树终止和有界输出共享一次 invocation 的生命周期。
2. **事件边界**：Durability 分类、有界流队列、唯一事件身份和 Event/Snapshot 原子提交共享一个提交协议。
3. **恢复边界**：文件 pre-image、工作区恢复日志和 Runtime 截断组成可恢复的 Rewind 协议。
4. **发布边界**：跨平台 CI、故障注入、Soak、指标与不可变 SHA 共同形成放行证据。

原方案的九个主题保留，并增加公共基础、配置/secret、网络/输入资源和最终供应链门禁；依赖顺序调整为：

```text
基础设施：配置 schema + failure code + invocation identity + 测试夹具
  ├─ 执行：Sandbox admission → Deadline/process tree → bounded output
  ├─ 事件：Durability → bounded transport → event identity/store migration
  └─ 恢复：durable pre-image → rewind journal → transactional recovery
最后：并发隔离 → 安全回归 → CI/观测/预生产
```

## 2. 现状核验与方案 Review

### 2.1 已由源码确认的问题

| 风险 | 当前证据 | 结论 |
| --- | --- | --- |
| Sandbox 缺失时裸执行 | `createSandboxExecutor()` 在 backend 为 `none` 时返回 `shellTool` | P0，方案判断成立 |
| Sandbox 状态只在创建时探测 | executor 创建时选择 backend，执行前不重新验证 | P1，需运行时探针 |
| Shell 无默认硬超时 | `shellTool` 与 sandbox executor 只在 `input.timeoutMs` 存在时创建 timer | P0，方案判断成立 |
| 只终止直接子进程 | timeout 调用 `proc.kill()`，没有统一的进程组/Job Object 协议 | P0，方案判断成立 |
| stdout/stderr 无界 | `readWithProgress()` 把完整文本累加到字符串 | P0，方案判断成立 |
| Runtime 流队列无界 | `executeEffectWithStreaming()` 使用无上限 `pending: RuntimeEvent[]` | P0，方案判断成立 |
| Tool progress 无界积累 | Tool Controller 先 `progress.push()`，完成后再整体追加 | P0，方案判断成立 |
| Event ID 混同内容幂等 | Kernel 对 `JSON.stringify(event)` 做 SHA-256 | P0，合法重复事件会被折叠 |
| Store 静默忽略冲突 | metadata 写入使用 `INSERT OR IGNORE`，未检查 affected rows | P0，Snapshot 可在事件未写入时推进 |
| Event 去重窗口有界 | State 只保留最近 4096 个 `appliedEventIds` | P1，不能作为持久唯一性依据 |
| pre-image 是 best-effort | recorder 捕获并吞掉 Store 异常 | P0，与可逆性承诺不相容 |
| Rewind 允许分裂结果 | 文件逐个恢复，失败后仍截断 Runtime，并只显示失败列表 | P0，方案判断成立 |
| 模型重试监听器共享 | Model Controller 调用实例级 `setRetryListener()` 并在 finally 清空 | P1，并发调用可能串线 |
| Required CI 仅 Ubuntu | `.github/workflows/required.yml` 的 required jobs 均运行在 Ubuntu | P1，跨平台证据不足 |

### 2.2 原方案需要修正的部分

1. **Windows 采用显式的平台例外，而不是实现本地沙箱。** 当前 backend 只有 Seatbelt、Bubblewrap 和 `none`，Windows 正常落入 `none`。0.1.0 不实现 Windows sandbox backend，但允许 Windows 在无沙箱时运行受控 Bash。这个例外必须是配置 schema 和 Policy 中可见的正式状态，不能继续表现为 backend 探测失败后静默返回裸 `shellTool`。

   Windows 非沙箱 Bash 仍必须经过 Capability、Policy、Approval、Deadline、进程树取消、输出上限、危险路径检查和审计边界。只能使用经过解析和校验的 Git for Windows Bash 或 vendored MSYS2 Bash；找不到 Bash 时拒绝执行，不得回退 `cmd.exe`、PowerShell 或任意 PATH 命中的 shell。

2. **Rewind 无法依赖一个跨 SQLite 与文件系统的真正 ACID 事务。** “备份文件后再截断 Store”仍有 kill -9 窗口。设计必须引入持久化 Rewind journal 和启动恢复，而不是只依赖内存中的 try/catch 回滚。

3. **`ephemeral_terminal` 命名不清。** `tool.finished`、`tool.failed`、`run.completed` 都是可恢复事实，应为 durable。即时流只有 `ephemeral_coalescible` 与 `ephemeral_lossy` 两类即可。

4. **事件 `sequence` 与 `revision` 不能重复承担同一职责。** `sequence` 表示 thread 内持久事件位置；`revision` 表示 reducer 后 State revision。二者当前可保持 1:1，但 schema 和验证必须分别表达，不能依赖 SQLite 全局 row id 推断 thread sequence。

5. **输出 artifact 策略需要补齐安全边界。** 除 `0600` 外，还要定义可信根目录、文件名生成、配额、敏感内容不进入日志、Session/崩溃后的清理、模型是否可读取 artifact。达到硬上限时默认终止命令，比“停止记录但继续执行”更可验证。

6. **Deadline 需要一个端到端预算。** first-byte、idle 和单次调用 timeout 不能各自重置总预算；重试、MCP 重连和 cancellation grace 都必须从 invocation deadline 派生。

7. **Live gate 不能用测试脚本存在代替覆盖充分。** 当前真实模型边界只维护显式 opt-in runner，且文档说明默认测试不代表真实 Provider。发布报告必须记录实际 provider、model、命令、时间、环境与 SHA；没有运行只能标为未验证。

8. **阶段工期不是发布承诺。** 原方案的 10～12 个开发日不包含 48～72 小时观察，而且 Windows 进程树、Store migration 和 crash-consistent Rewind 都有显著不确定性。Epic 应使用 gate 驱动，不以日期自动放行。

### 2.3 横向预生产审计新增问题

除原方案覆盖的执行、事件和 Rewind 风险外，2026-07-28 的仓库横向审计确认以下问题也必须进入预生产整改：

| 风险 | 当前证据 | 优先级 | 本轮处置 |
| --- | --- | --- | --- |
| 项目配置可降低用户安全边界 | `mergeConfigs()` 允许 project 覆盖 `interactionMode`、`sandbox`、`autoReview` 和 feature flags | P0 | 建立配置 provenance 与安全 ceiling |
| stdio MCP 继承完整环境 | transport 使用 `{ ...process.env, ...config.env }` | P0 | 默认最小环境 allowlist，secret 显式引用 |
| Session 日志记录敏感正文 | recorder 保存模型 text/reason/final、工具 args、命令、失败 stdout/stderr；开发模式默认开启 error log | P0 | 默认 metadata-only、写前结构化脱敏、受控诊断开关 |
| Web Fetch 存在 DNS SSRF/重绑定窗口 | `checkUrl()` 只检查 URL hostname 字面值，不解析并固定远端 IP | P0 | DNS resolution + IP policy + connect-time pinning |
| Web Fetch 响应上限发生在完整读取之后 | `resp.text()` 后才检查 5 MB | P1 | 流式读取并在字节上限处取消 |
| `read_file` 即使只请求部分行也先读完整文件 | `readTextContent()` 使用 `readFileSync(target)` | P1 | stat/stream 上限、显式大文件路径 |
| 文件校验与写入存在 TOCTOU | realpath 检查后再按 path 执行 `writeFileSync`，中间可发生 symlink swap | P0 | mutation gateway 使用 handle/原子替换并重复验证 |
| 搜索遍历没有统一文件数/总字节/时间预算 | `walkFiles()` 可遍历整个大工作区 | P1 | invocation 扫描预算与部分结果 |
| 本地 Runtime/日志/artifact 权限与配额不统一 | 多处直接创建目录、SQLite 和 JSONL，缺少共同数据目录策略 | P1 | owner-only/ACL、配额、保留和清理协议 |
| Required 测试入口当前不稳定 | Windows MCP panel 路径断言失败；完整 unit/TUI runner 在 120 秒内未收敛 | P0（发布证据） | 先修测试可终止性、平台归一化与分片 |
| 供应链证据不足 | Actions 使用移动 tag，缺少 SBOM、依赖审计和构建 provenance gate | P1 | 固定 action SHA、SBOM、审计和签名/provenance |

以上风险不是对原九个 PR 的无限扩张。它们按“安全配置与秘密、网络与输入资源、发布证据”三个新增工作流收敛，并在 §7 中作为独立 PR 切片。

## 3. 目标与非目标

### 3.1 目标

- Linux/macOS 配置要求 sandbox 时，任何 backend 缺失、失效或能力漂移都拒绝执行；Windows 只按显式 `windows_unsandboxed_bash` 边界准入。
- Model、Shell、MCP、事件流和 artifact 都有默认值、硬上限和结构化失败。
- 同一 invocation 的取消在返回 terminal receipt 前完成资源回收；旧 invocation 不能污染新 run。
- durable event 不丢失、不静默去重，Snapshot 只在全部预期事件成功写入后推进。
- Rewind 对外只呈现两种可恢复结果：完整完成，或恢复到 Rewind 前状态；进程崩溃后可继续收敛。
- 发布结论绑定不可变 Commit SHA、配置摘要和可追溯 CI/预生产证据。
- 对外准确声明 Rewind 覆盖范围，不把未受管 Shell/MCP 副作用包装成可回退保证。
- 项目内容不能通过配置、MCP 子进程环境、日志或网络解析旁路扩大用户级安全边界。
- 所有本地持久数据和输入型工具都具有统一权限、配额和生命周期。

### 3.2 非目标

- 不承诺任意 OS、任意 Shell 都具备同等级沙箱。
- 不在本轮引入分布式多写 RuntimeStore；单 thread 保持单 writer lease。
- 不把所有 UI 增量变为 durable event。
- 不把 artifact 当作长期文件存储或用户备份。
- 不以提示词替代 Policy、Approval、Sandbox 或路径检查。
- 不在 0.1.0 承诺回退任意 Shell、MCP 或外部进程产生的文件副作用；只有经过受管文件 mutation gateway 且成功持久化 pre-image 的修改进入 Rewind 保证。

## 4. 总体不变量

### 4.1 执行不变量

```text
Capability admitted
  AND Policy allowed
  AND Approval satisfied
  AND Required isolation available
  AND Invocation budget available
    → execution may start
```

任一条件缺失都产生结构化 terminal failure；不能降级到权限更大的执行方式。

每个 invocation 必须有稳定的：

```typescript
interface InvocationContext {
  invocationId: string;
  threadId: string;
  turnId: string;
  effectId: string;
  toolCallId?: string;
  deadlineAt: string;
  abortSignal: AbortSignal;
  sandboxRequirement:
    | 'required'
    | 'windows_unsandboxed_bash'
    | 'disabled_by_user'
    | 'unsafe_explicit';
}
```

### 4.2 持久化不变量

- `eventId` 标识一次发生，默认由 UUIDv7/ULID 生成，不能由 payload 推导。
- `idempotencyKey` 只用于明确声明可幂等的业务调用。
- `(thread_id, event_id)` 和 `(thread_id, sequence)` 都唯一。
- 一个提交批次中，`inserted event count === expected event count`。
- Event batch、Snapshot、thread sequence 分配在同一 SQLite transaction 内完成。
- transaction 失败时 Kernel 内存 State 不推进，Session 进入明确的 recovery-blocked 状态。
- ephemeral event 不进入 reducer、event log 或 Snapshot。

### 4.3 Rewind 不变量

- 文件写入前的 pre-image 持久化失败时，写工具不得执行。
- 历史数据库中的路径只是输入，恢复时必须重新做 realpath、workspace、symlink 与 protected-path 检查。
- Rewind journal 的阶段转换必须先持久化，再执行对应文件系统动作。
- 启动发现未完成 journal 时，Session 在恢复完成前不可运行新 effect。
- Runtime 截断完成但 cleanup 未完成时，启动恢复只能继续 cleanup；不得再次反向应用工作区。
- Rewind 恢复计划只接受受管 mutation receipt 中的路径；缺失 receipt、无法重放验证或来源不明的工作区变化不进入“可原子回退”声明。

## 5. 详细设计

### 5.1 Sandbox admission

配置：

```yaml
sandbox:
  enabled: true
  fallbackPolicy: deny # deny | explicit_unsafe_fallback
  windowsUnsandboxedBash: allow # allow | deny
```

`windowsUnsandboxedBash: allow` 是 Windows 的显式平台策略，默认值为 `allow`；它不等同于通用 `explicit_unsafe_fallback`，也不能在 Linux/macOS 生效。`enabled: false` 与 `explicit_unsafe_fallback` 仍必须来自显式用户/配置授权，并产生可审计的 `sandbox.unsafely_enabled` 事实；二者不能由 backend 探测结果自动触发。

0.1.0 平台决策：

| 平台 | 默认 backend | 默认 Shell 行为 | Required 验证 |
| --- | --- | --- | --- |
| macOS | Seatbelt | 探针通过后准入 | sandbox 执行、探针失效拒绝、进程组清理 |
| Linux | Bubblewrap | 探针通过后准入 | sandbox 执行、探针失效拒绝、进程组清理 |
| Windows | none | 允许受控的非沙箱 Bash | Bash 解析、无 `cmd.exe` fallback、审批、Deadline、输出上限、子进程清理、持续风险提示 |

Windows Job Object sandbox backend 不属于本 RFC 的 0.1.0 交付范围。Windows CI 只能声明“受控的非沙箱 Bash”已验证，不得声明 sandbox isolation 已验证。

Linux/macOS 执行前按 invocation 重新解析 backend：

1. backend 类型仍符合启动时 capability；
2. backend executable/profile 可访问；
3. 自检探针在短 Deadline 内通过；
4. Policy 要求的网络/文件边界可由该 backend 表达。

探针失败返回 `sandbox_unavailable` 或 `sandbox_capability_mismatch`，不调用 `shellTool`。App 只投影状态，不自行决定降级；Core 不依赖 TUI 类型。

Windows 执行前按 invocation 重新解析 Bash：

1. 优先使用由 Git executable 位置推导出的 Git for Windows Bash；
2. 其次使用校验过的 vendored MSYS2 Bash；
3. 排除 `%SystemRoot%\System32\bash.exe` 等 WSL stub；
4. 记录解析后的 shell kind 和 executable digest；
5. 找不到合格 Bash时返回 `windows_bash_unavailable`。

Windows 状态栏、每次 Shell 审批和执行回执必须持续显示 `Unsandboxed Bash`。审计事件记录 `sandboxBackend: none`、`executionBoundary: windows_unsandboxed_bash` 和解析后的 shell kind，但不记录用户环境变量。

Windows Interaction Mode 准入：

| Mode | 非沙箱 Bash |
| --- | --- |
| `accept_edits` | 允许；按既有风险分类进入人工审批，不能因命令被分类为只读而隐藏非沙箱状态 |
| `auto` | 允许有限 allowlist；任何写入、未知网络或无法可靠分类的命令仍需人工审批 |
| `full` | 禁止；`full` 仍要求真正可用的 sandbox，不因 Windows 平台例外而放宽 |

`windows_unsandboxed_bash` 只解决 Windows 可用性，不授予 authorization，也不把 approval 变成 sandbox。项目配置不能借此启用 `full`。

### 5.2 Deadline 与进程树

统一配置：

```yaml
runtime:
  deadlines:
    model_first_byte_ms: 30000
    model_idle_ms: 60000
    model_total_ms: 600000
    shell_default_ms: 600000
    shell_max_ms: 1800000
    mcp_call_ms: 120000
    cancellation_grace_ms: 3000
```

配置载入时验证 `default <= max`，所有值必须为有限正整数。一次 invocation 建立绝对 `deadlineAt`，子操作使用 `min(局部上限, 剩余总预算)`。外部 AbortSignal、总 Deadline、idle timer 组合为单一取消源，并保留首个触发原因。

Shell 平台适配：

- Linux/macOS：新进程组；先 TERM，grace 后 KILL 整个进程组。
- Windows：使用受控 process-tree adapter 跟踪 Bash 主进程并在 timeout/cancel 时执行树终止；可使用 Windows 原生 tree-kill 能力，但不把它表述为 sandbox。清理无法确认时返回 `cancellation_cleanup_failed`，Session 进入 recovery-blocked，不能立即启动下一 run。
- terminal receipt 只能在主进程退出、stdout/stderr reader 结束、子进程树清理完成后产生。

失败代码至少包括：

```text
model_first_byte_timeout
model_stream_idle_timeout
model_total_deadline
shell_deadline
mcp_deadline
cancellation_cleanup_failed
```

### 5.3 有界输出与 artifact

`readWithProgress()` 改为增量捕获器，不返回完整无界字符串：

```typescript
interface BoundedStreamCapture {
  head: string;
  tail: string;
  totalBytes: number;
  capturedBytes: number;
  truncated: boolean;
  artifact?: {
    artifactId: string;
    relativePath: string;
    bytes: number;
    digest: string;
  };
}
```

规则：

- 内存预算按字节而不是 JS 字符数计量，stdout/stderr 共用 invocation 总预算。
- head/tail、模型投影、progress chunk 和 artifact 分别有硬上限。
- artifact 位于 Runtime 管理的 per-session 隔离根目录，使用随机文件名和 owner-only 权限。
- artifact 写入计算流式 digest；超过 session 或 artifact 硬上限时终止命令并返回 `tool_output_limit_exceeded`。
- 正常关闭清理当前 Session artifact；启动时清理无 live journal 引用的过期 artifact。
- 日志只记录 artifactId、大小和 digest，不记录完整内容。

### 5.4 Event durability 与背压

事件分类由 Core 的显式映射维护：

```typescript
type EventDurability = 'durable' | 'ephemeral_coalescible' | 'ephemeral_lossy';
```

| 类别 | 示例 | 行为 |
| --- | --- | --- |
| durable | `tool.started`、`tool.finished`、`tool.failed`、approval、`run.completed` | reducer + transaction + delivery，不可丢 |
| ephemeral_coalescible | `tool.progress`、状态采样 | 按 key 合并，允许覆盖旧值 |
| ephemeral_lossy | `model.text_delta`、`model.reasoning_delta` | lease 有效时尽力投影，不恢复 |

Runner transport 使用双通道：

- durable lane：容量受限；满时 producer await，形成背压；
- ephemeral lane：按 `event type + invocationId + stream` coalesce，超过字节上限丢弃旧增量；
- 调度优先保证 durable terminal event 最终可入队；
- consumer 退出或取消时，producer 收到 AbortSignal，不允许后台继续积累。

两个 lane 共享 invocation cancellation，但不共享容量。durable lane 的容量由事件数和序列化字节数共同约束；达到上限时暂停对应 producer，不能把 durable event spill 到临时数组。ephemeral lane 每个 coalescing key 最多保留一个待投影值，替换时累计 `coalesced` 指标。terminal durable event 不能越过同 invocation 已接受的 durable predecessor；队列调度只能提高消费优先级，不能改变 sequence。

Tool Controller 不再把 progress 收集到完成后的数组；provider adapter 直接向受限 sink 发布。模型 delta 与 tool progress 均不能进入 RuntimeStore。

### 5.5 唯一 Event identity 与 Store migration

Envelope：

```typescript
interface RuntimeEventEnvelope {
  eventId: string;
  idempotencyKey?: string;
  threadId: string;
  sequence: number;
  revision: number;
  occurredAt: string;
  causationId?: string;
  payload: RuntimeEvent;
}
```

Store 在 transaction 内读取/更新 thread-local `next_sequence`。普通提交由 Kernel 提供 eventId，Store 分配或验证连续 sequence，并使用普通 `INSERT`。任何唯一约束冲突都使整个 transaction 失败。

迁移采用 expand/verify/contract：

1. 新增 nullable `sequence` 与 `idempotency_key`，保留旧 row id 和 eventId。
2. 按每个 thread 的 SQLite row id 顺序回填 sequence。
3. 校验无空洞、无重复、Snapshot event position 可映射。
4. 建立唯一索引并更新 Store schema version。
5. 首次加载旧 Snapshot 后按新版 metadata 写新 Snapshot；不重算历史 eventId。

若历史数据本身存在重复 `(thread_id, event_id)`，迁移不能擅自删除事件；Session 标记 recovery-blocked，并提供离线诊断/导出工具。

### 5.6 Crash-consistent Rewind

Rewind 使用持久 journal：

```typescript
type RewindPhase =
  | 'prepared'
  | 'workspace_applying'
  | 'workspace_applied'
  | 'store_committed'
  | 'cleaned';
```

协议：

1. 读取恢复点并生成完整计划。
2. 对每个目标重新做路径与 symlink 检查。
3. 在 workspace 同文件系统的受控目录准备 replacement 与 backup，记录 digest。
4. fsync 文件、目录和 `prepared` journal。
5. 标记 `workspace_applying`，逐项原子替换；每项进度可恢复。
6. 校验全部 digest，标记 `workspace_applied`。
7. SQLite transaction 截断 event/snapshot/pre-image，并标记 `store_committed`。
8. 删除 backup/staging，fsync 目录，标记 `cleaned`。

崩溃恢复规则：

- `prepared`：删除 staging，不改变工作区。
- `workspace_applying` / `workspace_applied`：从 backup 恢复 Rewind 前工作区。
- `store_committed`：继续 cleanup，不撤销已经提交的 Rewind。
- 任一步骤无法收敛：Session recovery-blocked，禁止新 run，并展示可操作诊断。

这项决策替代 ADR-0042 当前的 best-effort Rewind 语义，实施前必须新增 ADR；`docs/active/cancel-resume-cleanup.md` 同步更新。

#### 5.6.1 Rewind 保证范围

0.1.0 的原子 Rewind 只覆盖以下入口：

```text
write_file
edit_file
apply_patch（仅其所有目标都经过统一 mutation gateway 时）
```

三者必须在写入前经过同一个 gateway：

```text
resolve canonical target
→ validate workspace/protected/symlink boundary
→ persist pre-image and mutation intent
→ execute mutation
→ persist mutation receipt
```

Shell、MCP、Subagent 内部进程和用户在 Agent 运行期间直接产生的文件变化默认不在 Rewind 保证内。若未来要纳入，必须先使其通过相同 mutation intent/receipt 边界，或设计工作区级快照 backend。TUI 和文档必须使用“回退受管文件修改”，不得表述为“恢复整个工作区到任意历史时刻”。

同一 thread、同一路径在一个恢复点区间内只需要保留最早 pre-image；后续 mutation 仍各自产生 receipt。pre-image 大小计入 Session 存储配额；超过配额时写工具 fail closed，不能静默放弃可逆性。

### 5.7 Model/MCP 并发隔离

模型 retry observer、stream callbacks、AbortSignal 和 deadline 全部作为单次 `invoke()` 参数传入。共享模型对象必须是无 invocation 可变状态的 provider adapter。

MCP 调用同样绑定 invocationId、expected capability revision 和单次 AbortSignal。超时只结束当前调用；Manager 连接是否重启由 control plane 决定，不能直接终止整个 Session。

### 5.8 提示注入防御

统一系统规则可以作为纵深防御，但验收以运行时强制边界为准：

- 非可信仓库、网页、日志、MCP Result/Resource 不能改变 interaction mode。
- 不能创建 authorization grant、approval decision 或 capability binding。
- 不能扩大 workspace/网络范围。
- approval UI 使用已解析的真实参数与 effective effect，不使用模型生成的摘要替代。
- 测试断言“副作用未发生”和“审计事实存在”，不能只断言模型回复文本。

### 5.9 配置 provenance 与安全 ceiling

配置合并不能继续使用“project 对所有字段无条件覆盖 user”的单一规则。每个字段声明 provenance 和 merge policy：

```typescript
type ConfigProvenance = 'default' | 'user' | 'project' | 'cli' | 'admin';
type MergePolicy = 'project_override' | 'user_ceiling' | 'explicit_only';
```

安全敏感字段采用 `user_ceiling` 或 `explicit_only`：

| 字段 | 合并规则 |
| --- | --- |
| `sandbox.*` | project 只能收紧，不能禁用 Linux/macOS sandbox，也不能开启通用 unsafe fallback |
| `windowsUnsandboxedBash` | user/CLI 决定；project 可从 allow 收紧为 deny |
| `interactionMode` | project 不能从 `accept_edits` 提升为 `auto/full` |
| `autoReview.failOpen` | 0.1.0 移除或强制 false；project 不得开启 |
| authorization/full access | 只来自当前用户交互或显式 CLI，不从 project config 恢复 |
| experimental feature flags | project 只能开启 allowlist 中不扩大权限的 flag |
| provider/model/theme/compaction | 可按字段定义保留 project override |

配置解析对安全对象使用 `.strict()`；未知安全字段、非法 timeout、NaN/Infinity、越界资源值直接启动失败，不能静默丢弃。Runtime 启动日志记录配置摘要和 provenance，不记录 API key、header、env value 或完整路径内容。

Workspace trust 表示用户允许读取项目配置和能力声明，不等于允许项目提升 interaction mode、关闭 sandbox 或导出用户环境。

### 5.10 Secret、MCP 子进程与本地日志边界

stdio MCP 默认环境从“继承全部 `process.env`”改为最小 allowlist：

```text
PATH（经规范化）
SystemRoot/ComSpec（Windows 启动必需）
HOME/USERPROFILE（仅确有运行需要）
TMP/TEMP
LANG/LC_*
KITE_CODE_PROJECT_DIR
```

API key、OAuth token、云凭据、CI token、代理认证和任意其他环境变量默认不继承。MCP 所需 secret 必须通过 credential reference 或 project approval 中逐项可见的 env-name 引用注入；审批只显示变量名和来源，不显示值。子进程回执记录 env key allowlist digest。

本地日志默认 `metadata_only`：

```yaml
telemetry:
  localContent: metadata_only # off | metadata_only | diagnostic
  retentionDays: 7
  maxSessionBytes: 52428800
```

`metadata_only` 禁止保存：

- 模型 prompt、reasoning、final 正文；
- `write_file` content、Shell command 全文、Tool Result 全文；
- 用户问题和 MCP payload 全文；
- 环境变量值、header、URL query、credential reference material。

记录长度、类型、digest、failure code 和 allowlist 后的有限字段。`diagnostic` 必须由用户显式开启、显示持续风险提示、设置短生命周期，并仍执行结构化字段级 scrubber。Regex 只能作为第二层补救，不能作为主要脱敏机制。

SessionLogWriter、telemetry exporter 和 artifact writer 都使用有界队列。磁盘失败或配额耗尽时丢弃辅助 telemetry 并记录本地 drop counter，但不得积累无界内存；Runtime durable event 走独立边界。

### 5.11 网络解析与 Web Fetch 资源边界

Web Fetch 在每个请求和 redirect hop 执行：

1. 规范化 URL，拒绝 userinfo 和非 HTTP(S)。
2. 解析 A/AAAA 全部地址。
3. 任一候选命中 loopback、private、link-local、multicast、reserved、metadata range 时拒绝。
4. 连接时固定到已验证地址，并保持原 Host/SNI；不能验证连接目标时 fail closed。
5. redirect 后重新执行完整解析，不复用旧决定。
6. 限制 DNS 结果数、解析时间、redirect 次数和总 invocation deadline。

仅在 fetch 前检查字符串 hostname 不能防止 DNS rebinding。测试必须包含私网 DNS、IPv4-mapped IPv6、十六/整数 IPv4、redirect rebinding、多个 A/AAAA 中混入私网地址和云 metadata 别名。

响应正文按字节流读取，超过 `web_fetch_max_bytes` 立即取消 body；不得先执行 `resp.text()` 再检查长度。压缩响应同时限制 compressed bytes、decompressed bytes 和 compression ratio。HTML 解析/Readability worker 也必须共享剩余 deadline 和输出上限。

HTTP MCP endpoint 属于显式配置能力，不自动复用 Web Fetch 的公网限制，但必须有独立的 endpoint policy：project 来源的 loopback/private endpoint 在审批中明确标注网络范围，redirect 和 OAuth endpoint 仍逐跳验证。

### 5.12 文件读取、搜索与 mutation TOCTOU

输入型文件工具共享 invocation 预算：

```yaml
runtime:
  file_io:
    read_max_bytes: 16777216
    search_max_files: 100000
    search_max_bytes: 536870912
    search_max_duration_ms: 30000
    search_max_results: 10000
```

`read_file` 的 line `offset/limit` 不能掩盖完整文件读取。默认先 stat 并拒绝超限文件；需要读取大文件时使用有界流式窗口，不把全文保存在 `rawContent`。search 达到任一预算时返回 `truncated: true`、已扫描计数和稳定 continuation 信息，而不是继续后台遍历。

文件写入 gateway 在最终写入时重新验证目录和目标身份。优先在同目录创建 owner-only temporary、fsync、检查目标未发生不允许的 identity 变化，再原子 replace；避免“realpath 检查后按同一路径裸写”的 symlink swap。平台无法提供可靠 handle-relative 操作时，执行前后重复 lstat/realpath/file-id 校验，检测漂移即失败并进入恢复路径。

### 5.13 本地数据目录、配额与保留

RuntimeStore、Rewind backup、artifact、Session 日志、计划和 capability artifact 使用统一 data-root policy：

- Unix 新建文件 `0600`、目录 `0700`；Windows 应用当前用户 ACL，禁止宽泛继承。
- 所有路径由 Runtime 生成并限制在对应可信根；threadId/frontend 等先编码，不直接拼接为任意路径。
- 每 Session、每数据类别和全局都有 byte/file-count 配额。
- 启动时只清理拥有有效格式标记且不被 live journal 引用的过期对象。
- 清理失败有指标和告警，不阻塞已有 Session 恢复；磁盘达到 hard watermark 时拒绝新的有状态 run。
- 数据保留策略区分 durable recovery data 与 diagnostic telemetry，不能因清理日志误删恢复事实。

RuntimeStore 和 Rewind journal 包含用户内容，0.1.0 至少保证 OS 权限隔离和备份生命周期；是否提供应用层加密作为独立 ADR 评估，不在未设计密钥管理时宣称“静态加密”。

### 5.14 测试可终止性与发布供应链

所有测试 runner 自身必须有：

- suite 和 case 两级 timeout；
- 每个子进程的 process-tree cleanup；
- 每 60 秒 heartbeat 或当前 case 标识；
- JUnit/JSON 结果和失败 artifact；
- 独立临时目录、RuntimeStore、端口和环境；
- 平台路径归一化，不硬编码 `/` 或 `\`；
- shard 后仍可证明全部测试被发现且恰好执行一次。

Required CI 禁止把 runner timeout 视为普通 flaky retry；未产出完整结果即失败。预生产基线必须记录 test count、skip count、duration 和残留进程。

供应链 gate：

- GitHub Actions 固定到审核过的 commit SHA；
- `bun install --frozen-lockfile` 后生成依赖清单/SBOM；
- 对 runtime dependency 执行已配置严重度门槛的漏洞审计，并对不可修复项记录 waiver/expiry；
- 构建产物包含 Commit SHA、lockfile digest、Bun 版本和配置 schema；
- RC 生成签名或 provenance，发布只接受 Required head SHA 对应的产物；
- postinstall 和 native dependency（如 keyring）纳入三平台 smoke 与来源校验。

## 6. 配置、兼容与 Feature Flag

建议新增一组总开关只用于迁移期：

```yaml
features:
  boundedExecutionV1: false
  durableEventIdentityV2: false
  transactionalRewindV1: false
```

安全规则：

- 发布构建中 `sandbox.fallbackPolicy=deny` 不由 feature flag 关闭。
- 发布构建允许 Windows 的 `windowsUnsandboxedBash: allow`；它是受支持的平台边界，不受通用 fallbackPolicy 控制。
- Event schema 和 Rewind journal 一旦写入新版数据，回滚程序必须能识别并拒绝不兼容写入。
- flag 只控制新路径准入，不允许在新路径失败时自动调用旧的不安全路径。
- `explicit_unsafe_fallback` 必须有持续 UI 状态、每次 invocation 审计和发布环境禁用策略。

## 7. 实施切片

| PR | 内容 | 前置 | 必须交付 |
| --- | --- | --- | --- |
| 0 | 基线、公共契约与测试夹具 | 固定 SHA | 基线报告、invocation identity、failure code、配置 schema、资源采样、故障夹具、Store migration harness |
| 1 | Execution boundary admission | PR0 | Linux/macOS sandbox fail-closed、Windows 受控非沙箱 Bash |
| 2 | Invocation Deadline/进程树 | PR1 | 默认/最大 timeout、树清理 |
| 3 | Bounded output/artifact | PR2 | 内存与磁盘配额、清理 |
| 4 | Event durability/有界 transport | PR0 | 双通道背压、慢消费者 |
| 5 | Event identity/Store migration | PR4 | schema migration、冲突回滚 |
| 6 | Durable pre-image/transactional Rewind | PR5 | 新 ADR、journal、crash recovery |
| 7 | Invocation-scoped model/MCP callbacks | PR2 | 并发隔离测试 |
| 8 | Config provenance、secret 与 logging hardening | PR0 | user ceiling、MCP env allowlist、metadata-only logging |
| 9 | Network/file input resource boundaries | PR2、PR3 | DNS SSRF、流式 fetch/read、搜索预算、mutation TOCTOU |
| 10 | Prompt injection regression | PR1、PR7、PR8、PR9 | 真实副作用断言 |
| 11 | CI、观测、数据目录与供应链 gate | PR1–PR10 | 三平台 required、runner 可终止性、配额、SBOM/provenance、nightly/soak |

PR4 必须先把 ephemeral event 从持久化边界中显式分离，PR5 才能安全定义 sequence。PR5 必须先提供可靠的 Runtime transaction，PR6 才能把 Rewind journal 与 Store commit 对齐。PR8 应在任何外部 MCP/遥测预生产验证前完成；PR9 必须在开放 Web Fetch 和大工作区测试前完成；PR10 用前述已落地边界验证间接提示注入不能产生真实副作用。

PR0 不改变生产行为。它只建立后续 PR 共享的类型、默认关闭配置、确定性时钟/ID、受控流、进程夹具、SQLite fault adapter 和资源采样协议。任何基础契约如果本身改变当前行为，必须从 PR0 拆出并进入对应主题 PR。

## 8. 测试与验证

### 8.1 确定性测试

- Sandbox backend 缺失、启动后消失、能力不匹配。
- Shell 默认 timeout、最大值 clamp、子/孙进程清理、取消后立即新 run。
- 1 GB 逻辑输出源、慢消费者、artifact 满、磁盘满。
- 10,000 个相同 payload 事件仍获得不同 eventId 和连续 sequence。
- 人工唯一冲突、SQLite busy/disk-full、事务中断时 Snapshot 不推进。
- Rewind 在每个 journal phase 注入异常和进程终止。
- 两个并发模型/MCP invocation 的 callback、取消、retry 不串线。
- 间接提示注入不能改变任何授权和副作用事实。
- 项目配置不能关闭用户 sandbox、提升 interaction mode 或开启 fail-open。
- stdio MCP 子进程无法读取未显式允许的 API key、云凭据和 CI token。
- metadata-only 日志中不存在 prompt、reasoning、文件内容、Shell command 或 secret。
- DNS rebinding、混合公私网解析、metadata endpoint 和 redirect hop 全部 fail closed。
- 超大 Web/File/Search 输入在读取阶段保持 RSS 有界并返回结构化截断/失败。
- symlink swap、目标 file-id 漂移和 parent directory 替换不能导致越界写入。

### 8.2 跨平台 CI

Required workflow 覆盖 Ubuntu、macOS、Windows。Windows Shell 套件必须在真实 Git Bash 或仓库 vendored Bash 上验证受控非沙箱执行，并明确断言：

- sandbox backend 为 `none` 且 execution boundary 为 `windows_unsandboxed_bash`；
- UI、审批和回执持续显示非沙箱风险；
- WSL stub、未知 Bash 和 `cmd.exe` fallback 被拒绝；
- Deadline、输出上限和取消仍然生效；
- 测试报告只声明 Bash 兼容与运行边界，不声明文件系统或网络隔离。

Required：

```text
quality
unit
runtime
tui-system
sandbox-admission
store-recovery
security-regression
secret-isolation
network-boundary
cross-platform-paths
build
```

Nightly/手动：

```text
model-live
mcp-live
high-output-stress
multi-session-soak
crash-recovery-matrix
```

Live runner 不进入默认 `bun test` 发现；报告必须绑定 SHA。没有密钥或网络时 job 应明确标记 not-run，不得伪装成功。

### 8.3 预生产 Gate

原方案的零容忍项保留：

```text
未授权文件修改 = 0
重复副作用执行 = 0
残留子进程 = 0
Event/Snapshot 不一致 = 0
Rewind 分裂状态 = 0
Durable event 丢失 = 0
不可恢复 Session 卡死 = 0
```

资源和时延门槛必须在 PR0 基线后固化，不能在看到结果后反向调整。`RSS 基线 + 150 MB` 只作为初始候选；应同时指定测试机、Bun 版本、并发、输出速率、artifact 配置与采样方法。

#### 8.3.1 可复现测量协议

每份压力/Soak 报告必须包含：

```text
Commit SHA、dirty state
OS/内核、CPU、内存、磁盘类型与可用空间
Bun/Node compatibility 版本
Runtime/Store schema version
配置与 feature flag digest
并发 Session 数、每 Session invocation 数
输入/输出总字节、生成速率、consumer 速率
RSS 与 event-loop lag 采样间隔
测试开始/结束时间和原始结果 artifact digest
```

统一测量定义：

- RSS 使用同一平台采样器，每 1 秒采样；报告 peak、P95 和稳态末值。
- 取消响应从 cancellation request 被 Runtime 接受到 invocation terminal receipt 持久化完成计时。
- 工具完成率的分母只包含已准入且实际开始执行的工具；用户拒绝、policy denied 和 unsupported 不计入。
- 模型瞬时故障恢复率只统计预先列入 transient taxonomy 且至少发生一次重试的请求。
- event-loop lag 使用固定 100ms probe；“长时间阻塞”定义为单次 lag 大于 1 秒或 1 分钟窗口 P99 大于 250ms。
- SQLite 增长同时报告 durable event 数、数据库 bytes/event 和 progress 数；不得只报告文件绝对大小。
- 1 GB 场景在普通 CI 使用逻辑流/稀疏 fixture 验证边界，在 nightly 使用真实字节流验证 OS pipe、磁盘和 RSS。

## 9. 可观测性与脱敏

指标采用有界 label cardinality。`threadId`、eventId、toolCallId 等高基数字段进入结构化 trace/log，不作为 Metrics label。

Core 定义与供应商无关的同步记录接口，默认实现为 no-op，不直接依赖 TUI 或具体 OTLP/Prometheus SDK：

```typescript
interface RuntimeTelemetry {
  increment(name: RuntimeCounter, value?: number, labels?: RuntimeMetricLabels): void;
  observe(name: RuntimeHistogram, value: number, labels?: RuntimeMetricLabels): void;
  gauge(name: RuntimeGauge, value: number, labels?: RuntimeMetricLabels): void;
  emit(record: RuntimeTraceRecord): void;
}
```

允许的 metric labels 固定为低基数字段：

```text
platform
sandboxBackend
interactionMode
providerKind
toolKind
failureKind
outcome
```

App/部署层负责把接口接到 OTLP 或其他 backend。0.1.0 预生产选择 **OTLP 作为部署出口，结构化 JSONL 作为本地/降级证据**；backend 不可用不能阻塞 Runtime，也不能导致内存积压。Exporter 使用有界队列，满时丢 telemetry 并增加本地 `telemetry_dropped_total`，不得影响 durable Runtime event。

Histogram bucket 在 PR0 固化，并在 RC 期间保持不变。Dashboard 查询、告警阈值和 exporter 配置作为版本化部署 artifact 与 Commit SHA 一起归档。

核心关联字段：

```text
commitSha, threadId, turnId, effectId, invocationId,
eventId, eventSequence, toolCallId, modelRequestId, sandboxBackend
```

日志禁止包含 API/OAuth/MCP credential、完整环境变量、用户文件全文和未脱敏 Tool Result。输出截断和 artifact 创建只记录字节数、digest、failure code 与 artifactId。

脱敏必须发生在进入 telemetry/exporter 队列之前；不能依赖远端 collector 二次处理。对 command、path、model prompt 和 Tool Result 默认只记录类型、字节数与 digest，只有明确 allowlist 的诊断字段可记录有限文本。

## 10. 迁移与回滚

发布前生成旧 Store 副本并在三平台执行 forward migration、crash injection、恢复与只读降级演练。

迁移程序必须记录 `migration_started`/`migration_completed` marker 和源 schema version。发现未完成迁移时只允许继续同版本迁移或从完整备份恢复；不得用旧 binary 打开后继续写。备份完成后先验证可打开、checksum 和可恢复 Snapshot，再开始 schema mutation。

回滚分两类：

- **代码回滚**：仅在旧版本能识别新版 Store header 并 fail closed 时允许；不得让旧版本继续写新版数据库。
- **数据回滚**：使用迁移前备份恢复整个 RuntimeStore；不能逐表拼接。工作区 Rewind journal 若未 `cleaned`，必须先由对应版本 recovery 完成。

发布产物记录：

```text
Release Candidate
Commit SHA
Bun version
RuntimeStore schema version
RuntimeState schema version
Sandbox support matrix
Feature flags/config digest
Rollback artifact/version
```

## 11. 文档与架构决策影响

实施时至少需要：

1. 新增 ADR：Event identity、sequence 与 Event/Snapshot commit protocol。
2. 新增 ADR：Crash-consistent Rewind，明确替代 ADR-0042 的 best-effort 结论。
3. 更新 `docs/active/six-concept-runtime-architecture.md` 的 Runtime 持久化边界。
4. 更新 `docs/active/cancel-resume-cleanup.md` 的取消和 Rewind 语义。
5. 更新 `docs/active/authorization.md` 的 sandbox admission 与 unsafe 审计。
6. 更新 `docs/active/shell-platform-compatibility.md` 的进程树和平台支持矩阵。
7. 更新 `docs/active/failure-classification.md` 的 Deadline、Sandbox、Store、Rewind failure code。
8. 更新 `docs/active/real-model-test-boundary.md` 与 CI/发布证据说明。
9. 若映射范围不准确，同步修正 `docs/documentation-map.json`。

## 12. Go/No-Go

当前结论：**NO-GO**。

满足以下条件后才可提交 GO 评审：

- 所有 P0 不变量有“旧实现失败、新实现通过”的确定性回归测试。
- 三平台 Required Checks 对同一 RC head SHA 全绿；Windows 以受控非沙箱 Bash 支持矩阵验收，Linux/macOS 以 sandbox fail-closed 矩阵验收。
- Store migration 与 Rewind journal 完成 crash recovery matrix。
- 高输出、慢消费者、多 Session、取消与进程树测试达到预先固定的资源门槛。
- 实际运行 Model/MCP live runner，并记录边界；未覆盖项列为 residual risk。
- 至少 48 小时完整预生产阶段无新增 P0/P1，告警与回滚演练完成。
- `bun run check:docs-impact`、`bun run check:docs` 及所有相关验证通过。
- 配置 provenance、MCP 环境隔离、metadata-only 日志、DNS SSRF 和本地数据权限 gate 全部通过。

最终记录格式：

```text
Release Candidate:
Commit SHA:
Environment:
Completed gates:
Known residual risks:
Rollback version:
Decision: GO / NO-GO
Approvers:
```
