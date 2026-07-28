# Kite Code Agent 0.1.0 预生产稳定性加固实施计划

状态：active
优先级：P0
创建日期：2026-07-28
来源：[`2026-07-28-preproduction-stability-hardening-rfc.md`](../../design/2026-07-28-preproduction-stability-hardening-rfc.md)
依赖：ADR-0045、ADR-0046、ADR-0047、ADR-0048
当前工作分支：`featrue/0.1.0-stability`
审查时 HEAD：`a30faecc0220d77b4d2f5c4b8eb25d58adab7d4d`
发布候选分支：`release/0.1.0-preprod-hardening`；PR0 固定含本计划/ADR 的 Source SHA 后再创建

实施就绪结论：**ready-for-pr0**。PR0 可以开始；PR1～PR11 在 PR0 的基线、技术 Spike 和 runner gate 完成前不得合入。

## 一、目标与发布约束

本计划把已批准 RFC 拆为 PR0～PR11 十二个实施切片。当前代码保持 **NO-GO**；只有全部 Required gate、故障注入、Live 验证、回滚演练和至少 48 小时完整预生产观察完成后，才能提交 GO 评审。

整改期间冻结非稳定性功能开发，只接受：

- P0/P1 稳定性与安全修复；
- 测试、故障注入和可观测性；
- 必要的配置兼容、迁移和回滚支持；
- 文档、CI、部署与发布证据。

本计划不授权跳过审批、禁用文档门禁、使用 `--no-verify` 或以人工描述替代 CI 结果。

## 一点五、实施前置门禁

PR0 首先完成以下门禁，任一失败则计划状态改为 `blocked`，不能以实现过程中的临时方案绕过：

- [ ] 将本计划、RFC、ADR-0045～0048 纳入同一 Source SHA。
- [ ] 为 `release/0.1.0-preprod-hardening` 配置保护规则，并确认 PR 从当前稳定性分支合入该分支。
- [ ] Windows tree-kill Spike 证明能终止并检测 Bash 的受控子进程树；否则 Windows Shell 暂时改为 deny。
- [ ] DNS connect-time pinning Spike 证明 Bun 当前网络栈可以把已验证 IP 绑定到实际连接；否则预生产禁用 `web_fetch`，不得退回 hostname-only 检查。
- [ ] SQLite fault adapter 能确定性注入 busy、unique conflict、disk-full/IO failure 和 transaction interruption。
- [ ] Unit/TUI runner 在固定 deadline 内终止，能够输出 JUnit/JSON、测试数量和最后执行用例。
- [ ] 固定资源阈值、测试机规格和采样方法，不能在压力结果出来后反向调整。

### 初始配置基线

PR0 将以下 RFC 默认值固化到 schema 和测试 fixture；任何调整必须在 PR 描述中说明理由并重新评审资源门槛：

| 配置 | 默认值 |
| --- | ---: |
| `model_first_byte_ms` | 30,000 |
| `model_idle_ms` | 60,000 |
| `model_total_ms` | 600,000 |
| `shell_default_ms` | 600,000 |
| `shell_max_ms` | 1,800,000 |
| `mcp_call_ms` | 120,000 |
| `cancellation_grace_ms` | 3,000 |
| `model_projection_bytes` | 131,072 |
| `in_memory_stream_bytes` | 1,048,576 |
| `artifact_max_bytes` | 104,857,600 |
| `event_queue_max_events` | 2,048 |
| `event_queue_max_bytes` | 8,388,608 |
| `read_max_bytes` | 16,777,216 |
| `search_max_files` | 100,000 |
| `search_max_bytes` | 536,870,912 |
| `search_max_duration_ms` | 30,000 |
| `search_max_results` | 10,000 |

## 二、完成定义

- [ ] Linux/macOS sandbox 缺失或漂移时 fail closed。
- [ ] Windows 只允许受控非沙箱 Bash；`full` 模式禁用，未知 Shell 与 `cmd.exe` fallback 被拒绝。
- [ ] Model、Shell、MCP、Subagent、Web/File/Search 和 event transport 均有端到端资源预算。
- [ ] Shell timeout/cancel 清理完整受控进程树，旧 invocation 不污染新 run。
- [ ] stdout/stderr、MCP Result、Web response、文件读取、搜索遍历和本地 telemetry 内存有界。
- [ ] Durable event 不丢失；eventId、idempotencyKey、sequence、revision 职责分离。
- [ ] Event batch、thread sequence 和 Snapshot 在同一 SQLite transaction 提交。
- [ ] 受管文件修改 pre-image fail closed；Rewind journal 可在任意阶段崩溃后收敛。
- [ ] Project config 不能降低用户安全 ceiling。
- [ ] stdio MCP 不继承完整环境；Secret 只通过显式引用注入。
- [ ] 默认日志为 metadata-only，敏感正文不落盘。
- [ ] DNS SSRF、redirect rebinding、响应解压放大和 mutation TOCTOU 测试通过。
- [ ] 三平台 Required CI 可终止、可分片、结果完整并绑定同一 head SHA。
- [ ] SBOM、依赖审计、产物 provenance、Dashboard、告警和回滚 Runbook 完成。
- [ ] Model/MCP live、故障注入、压力测试和 48 小时 Soak 完成。
- [ ] `bun run check:docs-impact` 与 `bun run check:docs` 始终通过。

## 三、实施顺序

```text
PR0  基线、公共契约与故障夹具
 ├─ PR1  Execution boundary admission
 │   └─ PR2  Deadline 与进程树
 │       ├─ PR3  Bounded output/artifact
 │       └─ PR7  Invocation-scoped callbacks
 ├─ PR4  Event durability 与有界 transport
 │   └─ PR5  Event identity 与 Store migration
 │       └─ PR6  Durable pre-image 与 transactional Rewind
 ├─ PR8  Config provenance、Secret 与 logging
 └─ PR9  Network/File input resource boundaries
         ↓
PR10 Prompt injection regression（验证 PR1/7/8/9 的真实边界）
         ↓
PR11 Release CI、证据聚合、供应链与预生产 gate
```

任何前置 PR 未满足退出条件时，依赖 PR 可以开发但不得合入发布候选分支。编号表示依赖切片，不要求每个切片只能有一个物理 commit；每个 PR 仍必须只有一个稳定性主题。

## 三点五、变更与验证映射

| PR | 主要生产文件 | 新增/重点测试 | 必须同步的当前文档 |
| --- | --- | --- | --- |
| PR0 | `src/core/config/index.ts`、`src/core/runtime/failures.ts`、测试 runner/scripts | test discovery、runner timeout、Windows path、fault fixtures | `project-conventions.md`、`tui-e2e-standards.md` |
| PR1 | `src/core/sandbox/*`、`src/core/policies/*`、`src/core/tools/bash-path.ts`、CLI/TUI admission | `tests/sandbox*`、Windows Bash/Mode matrix | `authorization.md`、`shell-platform-compatibility.md` |
| PR2 | `src/core/tools/shell.ts`、sandbox executor、model invoke/provider、MCP、Subagent | deadline、process tree、cancel/new-run | `cancel-resume-cleanup.md`、`failure-classification.md` |
| PR3 | Shell capture、Tool projection、artifact persistence | high output、disk-full、slow consumer | `six-concept-runtime-architecture.md` |
| PR4 | `runtime/runner.ts`、events、Tool Controller、TUI consumer | queue/coalesce/durable ordering | `six-concept-runtime-architecture.md` |
| PR5 | `runtime/events.ts`、kernel、store、state | identity、sequence、migration、conflict | `six-concept-runtime-architecture.md`、ADR-0045 |
| PR6 | file-checkpoints、Store、file mutation gateway、Rewind UI | phase crash、path race、rollback | `cancel-resume-cleanup.md`、ADR-0046 |
| PR7 | model factory/invoke/provider、MCP invocation | concurrent retry/cancel isolation | `model-provider-boundary.md` |
| PR8 | config merge、MCP transport、session logger/writer | provenance、env isolation、log content | `workspace-trust.md`、`mcp-runtime-governance.md` |
| PR9 | web SSRF/extractor、file/search tools、mutation path checks | DNS rebinding、stream limits、TOCTOU | `file-reading-shared-boundary.md` |
| PR10 | security regression fixtures | repository/web/MCP/log/diff injection | `tool-gated-autonomy.md`、`authorization.md` |
| PR11 | `.github/workflows/*`、telemetry adapter、release scripts/docs | matrix, SBOM/provenance, soak harness | `real-model-test-boundary.md`、发布 Runbook |

新增测试文件可以按主题拆分，但必须由上述 Required job 明确发现；不得依赖默认 glob 偶然纳入。

## 四、PR0：基线、公共契约与故障夹具

### 范围

- 固定 Source branch、Commit SHA、Bun 版本、OS、Store schema、journal mode、配置摘要和 feature flags。
- 新增 invocation identity、结构化 failure code、确定性 clock/ID、资源预算 schema。
- 建立 process tree、bounded stream、SQLite fault、disk-full、slow consumer、DNS 和 crash fixture。
- 修复测试 runner 的平台路径归一化、suite/case timeout、heartbeat、结果归档和临时目录隔离。
- 完成 Windows tree-kill、DNS connect-time pinning 和 SQLite fault injection 三个 Spike，只保留可验证实现路线。

### 首批已知阻断

- Windows `tests/mcp-panel.test.tsx` 路径分隔符断言失败。
- `bun test` 与 `bun run test:tui:system` 必须在 runner deadline 内完整终止并产出结果。

### 验证

```text
bun install --frozen-lockfile
bun run typecheck
bun run check:core-boundary
bun run check:compaction-legacy
bun run check:docs-impact
bun run check:docs
bun run test
bun run test:tui:system
```

### 退出条件

- [ ] 基线报告绑定不可变 SHA。
- [ ] 所有 runner 可终止并报告 test/skip/fail 数量。
- [ ] 故障夹具不依赖开发者机器偶然状态。
- [ ] PR0 不改变生产行为。
- [ ] 三个技术 Spike 均形成 pass/fail 结论和 fallback 决策。

PR0 可以新增默认关闭的配置字段、接口和测试夹具，但不得切换生产调用路径。若某项 Spike 必须修改生产代码才能验证，应放入独立实验 fixture，不得夹带到 PR0 发布行为。

## 五、PR1：Execution boundary admission

实施状态：**completed（2026-07-29）**。已完成 invocation-scoped backend 探测、Unix
fail-closed、Windows Git Bash → vendored MSYS2 Bash 准入、WSL/PATH/cmd fallback 拒绝、
Windows `full` 禁用、无 sandbox 的 `auto` allowlist，以及状态栏、审批与 receipt 的
`Unsandboxed Bash` 投影。验证由 `tests/sandbox-runtime.test.ts`、
`tests/shell-exec.test.ts`、`tests/policies/mode-policy.test.ts`、
`tests/tui-layout.test.tsx` 和 `tests/tui-reducer.test.ts` 覆盖。

### 实现

- Linux/macOS 每次 Shell invocation 重新探测 sandbox backend 和能力。
- Windows 解析 Git Bash → vendored MSYS2 Bash，排除 WSL stub；禁止 `cmd.exe`/PowerShell fallback。
- Windows `accept_edits` 按风险审批，`auto` 仅有限 allowlist，`full` 禁止。
- 状态栏、审批和 receipt 持续显示 `Unsandboxed Bash`。
- 执行边界由 Core Policy 决定，App 只投影。

### 验证

- `sandbox-enabled-backend-missing`
- `sandbox-backend-disappears-after-start`
- `windows-git-bash-unsandboxed`
- `windows-vendored-bash-unsandboxed`
- `windows-wsl-stub-rejected`
- `windows-cmd-fallback-rejected`
- `windows-full-mode-rejected`

## 六、PR2：统一 Deadline 与进程树取消

### 实现

- 建立绝对 `deadlineAt`，first-byte/idle/local timeout/retry 共享剩余总预算。
- 外部 AbortSignal、Deadline 和 idle timer 保留首个取消原因。
- Linux/macOS 使用进程组 TERM → grace → KILL。
- Windows 使用受控 tree-kill adapter；无法确认清理时返回 `cancellation_cleanup_failed` 并 recovery-blocked。
- terminal receipt 只能在主进程、reader 和受控子进程全部收敛后产生。

### 验证

- 默认/最大 timeout、首字节/idle/total deadline；
- child/grandchild/background process；
- cancel 后立即新 run；
- MCP、Model、Shell 和 Subagent 取消互不串线。

## 七、PR3：有界输出与 Artifact

### 实现

- Shell/MCP 输出使用按字节计量的 head/tail capture。
- 模型 projection、内存、progress chunk、artifact、Session 和全局磁盘分别设硬上限。
- Artifact 使用可信 per-session 根、随机名称、owner-only 权限、流式 digest。
- 达到硬上限终止 invocation，不能只停止记录后继续执行。
- 启动清理无 live journal 引用的过期 artifact。

### 验证

- 1 GB 逻辑输出和 nightly 真实输出；
- stdout/stderr 组合预算；
- artifact disk-full/cleanup；
- 慢 consumer 下 RSS 与 event-loop lag。

## 八、PR4：Event durability 与有界 transport

### 实现

- 显式分类 `durable | ephemeral_coalescible | ephemeral_lossy`。
- Durable lane 按事件数和字节受限，满时 producer await。
- Ephemeral lane 每个 coalescing key 最多一个待投影值。
- Tool Controller 不再先积累全部 progress。
- Ephemeral event 不进入 reducer、Store 或 Snapshot。

### 验证

- progress coalescing；
- durable terminal ordering；
- consumer cancel；
- queue 满时无临时无界数组；
- model delta lease 失效后丢弃。

## 九、PR5：Event identity 与 RuntimeStore migration

### 实现

- 落实 ADR-0045。
- `eventId` 使用 occurrence identity；业务幂等单独使用 `idempotencyKey`。
- Store transaction 分配 thread-local sequence。
- 移除 `INSERT OR IGNORE`，唯一冲突回滚整个 batch。
- Event、sequence counter 和 Snapshot 同事务提交；失败时 Kernel state 不推进。
- Expand/verify/contract 迁移，保留历史 eventId，不擅自删除冲突记录。

### 验证

- 10,000 个相同 payload；
- duplicate eventId/sequence；
- concurrent writer；
- Snapshot 不推进；
- kill -9 与旧 Store migration；
- 未完成 migration marker 恢复。

## 十、PR6：Durable pre-image 与 Crash-consistent Rewind

### 实现

- 落实 ADR-0046。
- `write_file`、`edit_file` 和统一 gateway 下的 `apply_patch` 在写前提交 pre-image 与 mutation intent。
- pre-image 失败或配额不足时写工具 fail closed。
- Rewind journal 使用 `prepared → workspace_applying → workspace_applied → store_committed → cleaned`。
- 每一阶段支持启动恢复；路径重新执行 realpath、symlink、protected-path 和 workspace 检查。
- Shell/MCP/外部进程修改明确排除在 0.1.0 Rewind 保证外。

### 验证

- 每个 journal phase crash；
- readonly/disk-full/symlink swap/outside workspace；
- Store commit failure；
- 同一路径多次 mutation；
- 成功全回退、失败保持回退前或进入 recovery-blocked，不显示虚假成功。

## 十一、PR7：Invocation-scoped Model/MCP callbacks

### 实现

- 移除实例级 retry listener 等 invocation 可变状态。
- Retry observer、AbortSignal、deadline、stream callback 全部作为单次调用参数。
- MCP 调用绑定 invocationId、capability revision 和单次 Signal。

### 验证

- 两个并发模型调用 retry 不串线；
- cancel 一个调用不影响另一个；
-旧 invocation 的 late event 被拒绝；
- MCP disconnect 只终止当前调用。

## 十二、PR8：Config provenance、Secret 与 Logging hardening

### 实现

- 落实 ADR-0048。
- 安全字段采用 user/admin ceiling；project 只能收紧。
- `autoReview.failOpen` 在 0.1.0 移除或强制 false。
- Security config `.strict()`，未知字段和非法资源值启动失败。
- stdio MCP 使用最小环境 allowlist，Secret 只通过显式 credential/env-name reference。
- Session 日志默认 metadata-only；diagnostic 显式、短期、有风险提示。
- Scrub 发生在进入 writer/exporter 队列之前。

### 验证

- Project 不能关闭 sandbox、提升 mode、授予 full access；
- MCP 读不到未批准的 API key/cloud/CI token；
- metadata-only 文件不包含 prompt、reasoning、文件内容、命令和 secret；
-日志与 exporter 配额满时内存有界。

## 十三、PR9：Network/File 输入资源边界

### 实现

- Web Fetch 每跳执行 DNS A/AAAA 解析、IP policy 和 connect-time pinning。
- 拒绝 private/link-local/loopback/reserved/metadata 和混合公私网结果。
- 响应按压缩/解压字节流限额，HTML worker 共享 deadline。
- `read_file` 使用 stat/stream 预算，不因 line window 读取完整大文件。
- Search 限制文件数、总字节、耗时、结果数并返回结构化 truncated。
- Mutation gateway 防 realpath-check/write 间 symlink swap。

### 验证

- DNS rebinding、redirect rebinding、mapped IPv6、metadata endpoint；
- compression bomb、无 Content-Length 大响应；
-超大文件窗口读取；
- 100k 文件与深目录；
- target/parent symlink swap 与 file-id 漂移。

## 十四、PR10：间接提示注入回归

### 范围

- 恶意 README、代码注释、网页、MCP Result/Resource、测试日志、Git Diff。
- 断言 Runtime 事实而不是模型回复措辞。

### 退出条件

- [ ] Interaction mode 未变化。
- [ ] 未产生 authorization grant 或 approval。
- [ ] Capability、workspace、network 范围未扩大。
- [ ] 未发生未授权 Shell、文件或 MCP 副作用。
- [ ] 审批展示真实参数和 effective effects。

## 十五、PR11：Release CI 与证据 Gate

### 实现

- 三平台 Required matrix；Windows 验证受控非沙箱 Bash，Linux/macOS 验证 sandbox。
- Required jobs：quality、unit、runtime、tui-system、sandbox-admission、store-recovery、security-regression、secret-isolation、network-boundary、cross-platform-paths、build。
- Nightly/manual：model-live、mcp-live、high-output-stress、multi-session-soak、crash-recovery-matrix。
- 汇总 PR1～PR10 已增加的 Core telemetry，接入 OTLP；JSONL 作为 metadata-only 降级证据。
- 验证 PR3/PR6/PR8 已落实的 data-root 权限、ACL、配额、保留和 hard watermark。
- Actions 固定 commit SHA，生成 SBOM、依赖审计、签名/provenance。

### 退出条件

- [ ] Required Checks 绑定同一 PR head SHA。
- [ ] Dashboard、告警、Runbook 和回滚产物已版本化。
- [ ] Live runner 报告实际 provider/model/环境/SHA。
- [ ] 48 小时完整预生产无新增 P0/P1。

PR11 只负责发布 CI、证据聚合和部署 gate，不在最后一个 PR 首次实现跨模块资源治理。对应指标必须随 PR1～PR10 的行为一起实现；数据目录基础在 PR0 建立，artifact/Rewind/logging 的具体配额分别由 PR3、PR6、PR8 落地。

## 十五点五、Feature Flag、迁移与 Cutover

- `boundedExecutionV1`：PR2/PR3 默认关闭；本地 shadow 验证后在发布候选分支开启。新路径失败不能自动调用旧无界路径。
- `durableEventIdentityV2`：只控制新 Store 创建/cutover，不允许同一 thread 混写两种 envelope。完成 migration 后不可在原数据库上关闭。
- `transactionalRewindV1`：只对已具备新版 mutation receipt 的恢复点开启；旧恢复点保持只读诊断或明确不支持。
- Sandbox fail-closed、Windows 禁止 `cmd.exe` fallback、配置 security ceiling 和 MCP env isolation 属于安全修复，不允许用普通 feature flag 关闭。
- Store migration 前生成并验证完整备份；migration marker 未完成时只允许继续迁移或恢复备份。
- 每个 flag 的 owner、启用环境、观测指标、rollback 条件和删除日期记录在 PR 描述与 `docs/active/feature-flags.md`。

## 十六、文档与 ADR 同步

每个行为变更 PR 必须依据 `docs/documentation-map.json` 更新相应当前文档。至少包括：

- `docs/active/six-concept-runtime-architecture.md`
- `docs/active/cancel-resume-cleanup.md`
- `docs/active/authorization.md`
- `docs/active/shell-platform-compatibility.md`
- `docs/active/failure-classification.md`
- `docs/active/real-model-test-boundary.md`
- `docs/active/mcp-runtime-governance.md`
- `docs/active/workspace-trust.md`

在 stage、commit、push 或创建 PR 前，必须执行项目 Skill `document-before-commit`，并通过：

```text
bun run check:docs-impact
bun run check:docs
```

## 十七、最终 Go/No-Go 记录

```text
Release Candidate:
Commit SHA:
Environment:
RuntimeStore schema:
RuntimeState schema:
Sandbox/Windows Bash support matrix:
Completed gates:
Known residual risks:
Rollback version:
Decision: GO / NO-GO
Approvers:
```

任一 Required gate、故障注入、Live 边界、回滚演练或 48 小时 Soak 未完成，结论均为 NO-GO。
