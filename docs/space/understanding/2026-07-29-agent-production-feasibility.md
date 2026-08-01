# Agent 生产发布可行性论证

日期：2026-07-29
状态：understanding
范围：

- Agent Runtime、内置工具、MCP、Skills、Plan、上下文压缩、TUI 与恢复链路
- 安全与隐私、可观测性、发布工程和产品可用性
- 基线提交 `410b2c24717ab50f0cd7fe32d54942fa6fca9840`
- 合并增量复核 `a316a2df63e511f839d08aa72a20275afa8e3366`（2026-07-30）

读取时机：

- 决定是否进入内部试用、受限生产灰度或全量生产发布时。
- 调整生产 feature flag、MCP/Skills 放行范围或上下文压缩 rollout 时。
- 定义 Agent 生产 SLO、灰度门槛、回滚条件或发布验收计划时。

相关：

- `../../design/2026-07-29-agent-production-readiness-rfc.md`
- `../plans/2026-07-29-agent-production-readiness-roadmap.md`
- `../../active/six-concept-runtime-architecture.md`
- `../../active/tool-gated-autonomy.md`
- `../../active/mcp-runtime-governance.md`
- `../../active/verification-governance.md`
- `../../active/plan-artifact-lifecycle.md`
- `../../active/model-provider-boundary.md`
- `../../active/real-model-test-boundary.md`
- `../execution/completed/2026-07-22-context-compaction-production-rollout.md`

验证：

- `bun run typecheck`
- `bun run format:check`
- `bun run lint`
- `bun run check:core-boundary`
- `bun run check:compaction-legacy`
- `bun run check:docs`
- `bun run check:docs-impact`
- `bun run test`
- `bun run test:mock`
- `bun run test:e2e`
- `bun run test:tui:system`
- `bun run test:mcp:live`
- `bun run test:model:live`
- `bun audit`

## 结论

截至本记录基线，工程实现具备继续生产化的可行性，但**不具备全功能 GA 的放行证据**。

发布决策为：

- **全功能公开生产：No-Go。**
- **关闭高风险能力后的内部试用：Go。**
- **完成本文“受限灰度 P0”后的本地单用户、小流量白名单生产灰度：Conditional Go。**
- **Web、多租户共享服务、远程托管或无人值守 SaaS：本论证不覆盖，No-Go。**

这里的 No-Go 不表示架构需要推倒重来。Runtime 的状态机、审批、sandbox 接入点、工具消息
配对、checkpoint、MCP 治理和 Plan Artifact 已有较强基础；主要缺口是发布证据与默认启用
范围不一致，尤其包括：

1. 上下文压缩只验证结构和 token 缩减，没有验证关键事实、约束、失败、验证结果和下一步的语义保真。
2. Skills、Verification、MCP durable execution record/provider action 默认关闭，不能把实现存在等同于生产默认可用。
3. 会话日志记录正文、reasoning、工具参数和结果，但本机实测目录为 `0755`、文件为 `0644`，也没有明确的保留、轮转和 opt-out 策略。
4. Required CI 只运行 Ubuntu；真实模型压缩不在 Required CI 中；尚无全功能多平台、长时、负载和真实用户可用性证据。
5. 仓库没有正式版本 tag、变更日志、安全说明和可验证的发布/回滚制品流程，依赖审计本次也因 registry 返回 `404` 未完成。
6. 当前 sandbox 并非跨平台等价：macOS Seatbelt profile 明确允许全盘读写，依赖
   tool-policy 做授权；网络只有 `disabled/allow_all`，没有 host allowlist；后台/并发
   writer 也没有 worktree/branch 隔离。
7. 当前实现与证据尚未固化受支持部署拓扑、父子 Agent 累计资源预算、统一故障降级矩阵和
   具名事故责任链，不能直接外推为 hosted/multi-tenant 或无人值守服务。

因此，当前可以论证的是“核心工程路线可生产化”，不能论证“所有 Agent 功能已经稳定、可用且好用”。

## “可用”的判定口径

生产可用不能只用“测试通过”定义。本论证使用六个维度：

| 维度 | 必须回答的问题 |
| --- | --- |
| 功能正确性 | 正常输入下是否得到正确状态、工具结果和输出？ |
| 故障安全性 | 模型、工具、MCP、进程、终端或网络失败时，是否 fail closed、可恢复且不破坏状态？ |
| 语义正确性 | 压缩、Plan、Skill 和多轮执行是否保留关键约束，并真正完成用户目标？ |
| 安全与隐私 | 授权、sandbox、凭据、日志、第三方调用和本地数据是否满足最小权限？ |
| 可运营性 | 是否有指标、告警、SLO、灰度、kill switch、兼容矩阵和回滚？ |
| 产品可用性 | 目标用户是否能高成功率、低干预地完成代表性任务，并理解风险和恢复方式？ |

当前证据对“功能正确性”和部分“故障安全性”覆盖较强；对语义正确性、可运营性和产品可用性的覆盖不足。

## 证据等级

| 等级 | 证据类型 | 当前状态 |
| --- | --- | --- |
| L1 | 源码、类型、架构边界和静态门禁 | 较强 |
| L2 | 确定性 unit/contract 测试 | 较强 |
| L3 | 跨进程、PTY、恢复和本地 transport E2E | 较强，但主要是 Ubuntu/macOS 开发环境证据 |
| L4 | 真实 MCP、真实模型和真实故障注入 | 有少量证据；压缩出现失败反例 |
| L5 | 生产 canary、SLO、长时运行和真实用户任务 | 缺失 |

只有 L1-L3 不能证明生产中的第三方兼容性和语义质量；只有 L4 的单次成功也不能证明稳定性。GA 需要 L5。

## 基线验证结果

运行环境为 2026-07-29 的本地 macOS 工作区，Bun `1.3.14`，基线提交为
`410b2c24717ab50f0cd7fe32d54942fa6fca9840`。

| 验证 | 结果 | 解释 |
| --- | --- | --- |
| `bun run test` | `1959 pass`、`6 skip`、`0 fail`，124 个执行文件 | 确定性行为基线较强；同时出现 `MaxListenersExceededWarning` |
| `bun run test:mock` | `5 pass`、`0 fail` | Context compaction Runtime contract 通过 |
| `bun run test:e2e` | `7 pass`、`0 fail` | 本地跨进程 MCP/Skills E2E 通过 |
| `bun run test:tui:system` | 失败：`Sub-agent Read File Flow` 在 30 秒处超时 | 在此之前大量审批、输入、恢复、Plan、MCP、会话和压缩入口场景通过；孤立重跑同一文件仍为 `4 pass`、`1 fail`，required suite 非绿色 |
| `bun run test:mcp:live` | 成功 | 真实公网 LangChain Docs MCP 查询成功 |
| 质量门禁 | 全部退出码为 0 | typecheck、format、core boundary、compaction legacy 和文档门禁通过 |
| lint | 退出码为 0，但报告 `191 warnings`、`16 infos` | 当前 lint 是弱门禁，不能视为零问题 |
| `bun audit` | registry 请求返回 `404` | 本次无法形成供应链无已知漏洞结论 |
| `bun run test:model:live` | 失败：`Summary was truncated` | DeepSeek `deepseek-v4-flash` 在 direct summary 阶段失败 |

补充事实：

- 本地依赖目录初始缺少 lockfile 已声明的 `@inkjs/ui`，`bun install --frozen-lockfile` 补齐 5 个包后质量门禁通过。这是工作区安装状态问题，但说明发布验证必须从 clean install 开始。
- 默认 unit 的 6 个 skip 包括原生 keyring、Windows ACL 和 Windows/MSYS2 路径场景；相关行为不能用本次 macOS 本地结果代替多平台结论。
- 最近 30 天基线历史包含 227 个提交，变更速度很高。发布前需要冻结窗口和稳定分支，不能只在持续变化的开发分支上取一次快照。

## 2026-07-30 合并增量复核

复核对象为从初始论证基线到合并提交
`a316a2df63e511f839d08aa72a20275afa8e3366` 的增量，主要包含 effect-aware read
scheduling、shell sibling/approval/cancellation 调度、TUI turn/thought lifecycle、
`ask_user` canonical schema、Runtime schema v17 和新的默认测试 runner。

当前提交的增量验证结果：

| 验证 | 结果 | 解释 |
| --- | --- | --- |
| `bun run test` | 主 deterministic suite `1992 pass`、`6 skip`；5 个隔离文件合计 `26 pass`；`0 fail` | 新 runner 的原生环境执行通过；受管 sandbox 内最初因 PTY/process isolation `EPERM` 失败，不作为代码失败，但环境差异必须进入制品证据 |
| `bun run test:mock` | `5 pass`、`0 fail` | 压缩 Runtime mock contract 未回归 |
| `bun run test:tui:system` | 35 个 scenario 文件通过 | 原 Sub-agent Read File 30 秒超时本次未复现；仍出现 `MaxListenersExceededWarning`，且只有单次结果 |
| 静态与文档门禁 | typecheck、Core boundary、docs impact、docs 均通过 | 合并没有破坏当前架构与文档门禁 |
| live MCP / 真实模型 | 本轮未重跑 | 2026-07-29 的 live 结果只属于旧 artifact identity，不能为本提交或未来 release 放行 |

增量改变了实现细节和证据身份，没有推翻可行性结论、RFC 架构、Phase 顺序或 108 个 Task
DAG。它同时暴露出计划必须显式覆盖的新边界：

1. scheduler 的 read batch 代码上限 `4` 和 runner 的 shell overlap 不是 production
   `ResourceBudget`；必须新增父/子 Agent 共享的 tool/shell invocation 并发硬上限、有界
   permit wait 和原子 reservation，并由平台另行强制每次 shell 的 process-tree 上限。
2. parallel batch 中每个 network/MCP invocation 必须独立执行 boundary、egress permit、
   revision 与 receipt 检查，不能共享 sibling 的放行结果。
3. schema v17、system prompt/`ask_user` contract、tool effect 分类、Runtime 导出的 canonical
   scheduling policy snapshot 和默认测试 runner 必须进入 behavior/build digests；任一变化
   使旧 task/live evidence 失效。
4. Task 1C.6 继续保持 P0：timeout 风险从“本次可复现”收窄为“需 soak 证明已消失”，listener
   warning 仍未关闭。

## 能力放行矩阵

| 能力 | 已有保证 | 主要缺口 | 当前决策 |
| --- | --- | --- | --- |
| Runtime Kernel 与会话恢复 | 事件/效果/reducer 分层、取消恢复、checkpoint、跨会话场景和大量确定性测试 | 长时运行、kill -9、磁盘满、并发压力和跨版本恢复不足 | 受限灰度 |
| 内置文件、搜索、shell 工具 | Registry、policy、审批、sandbox 接入、读写和 shell 测试较完整 | macOS sandbox 允许 Workspace 外读写且网络只有全关/全开；`MaxListenersExceededWarning`；三平台全链路矩阵不足 | 修复执行边界后受限灰度 |
| Tool Search / progressive disclosure | 默认开启且有 catalog/binding 测试 | 大目录召回率、漏召回率、延迟和真实任务效果没有基准 | 受限灰度并采集指标 |
| MCP 发现与只读调用 | revisioned catalog、project approval、auth、local E2E 和公网 smoke | 第三方 server 兼容矩阵、SLO、限流、超时和错误预算不足 | 只读白名单灰度 |
| MCP 写操作 | 有 policy 和治理设计 | `mcpExecutionRecordV1`、`mcpProviderActionV1`、`verificationV1` 默认关闭 | 不放行 |
| Skills | fail-closed activation、workflow contract 和 local E2E 存在 | `skillActivationV2`、`skillWorkflowV1` 默认关闭；真实 workflow 和 UX 矩阵不足 | 不作为生产默认能力 |
| Plan | Artifact、版本、review、digest、持久化和恢复测试较完整，默认开启 | 进度和完成主要由模型报告；`verificationV1` 默认关闭 | 受限灰度，不宣称已验证完成 |
| Verification | 有分级验证、repair/waive/compensation 设计与测试 | 默认关闭，未形成生产默认完成门禁 | 不支撑 GA 完成语义 |
| 手动上下文压缩 | checkpoint、边界、tool 配对、回放、失败保持原状态等结构保证较强 | 无语义保真门禁；真实模型本次失败；单次大请求有输入/输出上限风险 | 仅内部 opt-in 实验 |
| 自动上下文压缩 | preflight、lease、stale result 丢弃和 fail-safe 路径存在 | 默认关闭；无真实 SLO、canary、语义质量和自动恢复证据 | 不放行 |
| TUI | PTY 系统场景广，覆盖错误恢复、审批、Plan、MCP、会话等 | 本次完整回归有 sub-agent read flow 超时；多平台真实终端、超长会话、性能和用户研究不足 | 修复超时后再受限灰度 |
| 可观测性 | session log 有结构化事件，compaction 有 debug reporter | 无默认生产指标导出、dashboard、告警和统一 trace；日志本身有隐私阻断项 | 未生产就绪 |

## 默认配置揭示的真实发布面

源码 `src/core/config/features.ts` 的默认值很重要：

- 默认开启：Plan lifecycle、Interaction Controller、Capability Catalog、MCP Runtime Binding、Tool Search、Context Compaction V2 和手动压缩入口。
- 默认关闭：Auto Review、Native Loop、Loop Mode、MCP Execution Record、MCP Provider Action、Skill Activation、Skill Workflow、Verification 和自动压缩。

这意味着：

1. 当前默认产品不应宣传 Skills 已可用，因为激活和 workflow 明确 fail closed。
2. MCP 工具可以被发现和绑定，但涉及外部副作用时，没有默认开启的 durable provider action、execution record 和 verification 共同兜底。
3. Plan 可管理计划状态，但不能把模型的“完成”自动等同于已通过外部验证。
4. 自动压缩默认关闭是正确的风险隔离；手动压缩默认开启仍需要在公开灰度前改为内部 opt-in，或先完成语义验收。

## 上下文压缩专项论证

### 已经可以信任的部分

当前实现的结构安全性比简单地删历史消息强：

- 原始 transcript 保持不可变，压缩通过 checkpoint 改变 context projection。
- 只在 complete turn 和合法 tool-call/tool-result 配对边界压缩；当前 live turn 可被保护。
- checkpoint 带 source revision、digest、covered message/turn 和 base checkpoint，可重放和增量替换。
- stale lease、状态漂移和无效 candidate 会被丢弃；失败或取消不会覆盖原始状态。
- summary 作为低权限历史内容注入，custom instruction 按不可信数据处理。
- 空摘要、length truncation、意外 tool call、narrative 超限和缩减不足会被拒绝。
- 自动压缩失败后不会在同一 turn 继续普通模型请求，避免基于不确定上下文继续执行。

这些机制能证明“checkpoint 不容易破坏 Runtime 结构”，不能证明“摘要保留了完成任务所需的语义”。

### 当前不能信任的部分

生产 compactor 是一次模型调用生成一份 Markdown narrative，当前验收只检查：

- 非空；
- finish reason 不是 length；
- 没有 tool call；
- 不超过 narrative 上限；
- checkpoint 边界和 lease 有效；
- candidate 至少减少固定数量的 token。

它没有检查：

- 用户目标和不可违反约束是否保留；
- 文件名、标识符、错误码、已完成/未完成状态是否保留；
- 工具失败、审批决定、测试结果和待验证项是否保留；
- Plan 当前步骤与下一步是否一致；
- 压缩后继续执行的任务成功率是否不劣于未压缩对照。

增量压缩以“旧 narrative + 新尾部”重新生成整个 narrative。一旦首轮遗漏关键事实，后续没有原始事实 ledger 可以修复；多轮重写还可能累积漂移。

当完整 safe history 超过显式 `maxSummaryInputTokens` 时，实现直接返回 `oversized_turn`，不会分块或只压缩安全前缀；不配置该上限时，又可能把超出真实 provider 窗口的请求交给 provider。Core 按设计不通过 HTTP 状态或错误字符串推断 context overflow，因此也不会自动修复这类失败。

### 真实模型反例

维护中的 live suite 在 2026-07-22 使用 DeepSeek `deepseek-v4-flash` 曾通过 direct 和 incremental 两个场景；2026-07-29 在同一 provider/model 的运行中，direct summary 因 `Summary was truncated` 失败。该 suite 设置：

- `maxSummaryTokens: 600`
- `maxNarrativeTokens: 800`
- 7 条高度重复的 synthetic user history
- 只断言 summary 非空、token 下降和 incremental summary 发生变化

这说明真实模型行为并不稳定到可以由一次历史成功放行，而且当前 live suite 即使通过，也没有证明语义保真。

另一次探索性检查把 narrative/output 预算放大后，direct 从估算 `16947` tokens 降至 `2509`，incremental 从 `4024` 降至 `2521`；但预埋的目标、约束、决策、文件、错误、验证结果、待办和下一步 opaque marker 都没有逐字保留。模型可能进行了语义改写，因此该结果**不能单独证明事实全部丢失**；它能明确证明当前“只检查 token 缩减”的 acceptance gate 无法发现这种风险。

### 压缩结论

- Runtime 结构安全：可进入内部 dogfood。
- 真实模型生成稳定性：未达到公开生产放行门槛。
- 语义保真：当前没有充分证据。
- 手动压缩：公开灰度前应默认关闭，只对内部白名单开放。
- 自动压缩：继续保持默认关闭，直到完成语义 benchmark、canary、指标、kill switch 和 provider/model 兼容矩阵。

## 安全与隐私阻断项

### 执行隔离

源码和测试显示：

- macOS `generateSandboxProfile()` 对 `/` 使用 `file-read*`、`file-write*`、
  `file-write-create` 和 `file-write-unlink` 全局 allow，Workspace 外读写依靠
  `checkDangerousPaths` 与 tool-policy，不是 OS sandbox 的技术边界；
- Linux bubblewrap 把系统路径只读绑定、Workspace 读写绑定，隔离语义更接近
  `workspace_write`，因此两个平台的 “sandbox available” 不能视为同一强度；
- `ShellNetworkMode` 当前只有 `disabled | allow_all`，不能按域名约束 dependency 下载或
  阻断允许网络后的任意外传；
- sandbox backend 不可用时 executor 会回退普通 shell；full mode 会被上层拒绝，但
  limited 的 `auto`/`accept_edits` 仍需要明确的 fail-closed profile；
- 代码库未发现生产 worktree/branch orchestration，当前 Sub-agent 原像恢复仍以共享
  Workspace 为基础。

所以“有 sandbox”不能直接推导“可以安全开放 auto”。受限灰度前必须把 filesystem
scope、network egress、protected paths、sandbox unavailable 和并发 writer 隔离作为
可验证的 permission profile；macOS 不能只依赖命令字符串扫描来声称
`workspace_write`。

### Provider 与远程 MCP 数据边界

源码和当前 active 文档没有形成版本化的 production Provider Data Policy，无法从 release
artifact 证明某条 model/MCP route 允许接收何种 Workspace 数据、region、retention、
training/content-use、DPA/consent 或策略变更后的资格失效。遥测不上传正文也不能回答这个
问题，因为模型请求和远程 MCP 调用本身可能包含 prompt、文件片段或工具结果。

因此外部灰度前必须：

1. 精确绑定 endpoint/operator route 与数据策略，而不是只按 model 名称放行；
2. 将 credential/secret/受保护路径从 model/MCP payload 独立阻断；
3. 区分模型 Provider、每个远程 MCP 和 secondary evaluator 三类接收方的授权；
4. 默认禁止真实用户正文进入 benchmark/人工 review，除非对用途、接收方和保留期单独
   opt-in；
5. 当 endpoint、region、retention/training 或条款变化时，使原 route evidence 失效。

这属于受限外部灰度前的隐私 P0，不应留给 GA 合规审查时再补。

### 本地日志

`SessionLogCollector` 在 Agent 运行时创建，日志会记录模型正文、reasoning、工具参数和摘要、用户交互、文件预览、Plan 及错误等内容。虽然已有 regex 脱敏和长度截断，但它只能覆盖已知 token 形态，不能保证源码、个人数据或业务秘密不被记录。

本机实测 `~/.kite-code/sessions`：

- 目录权限：`drwxr-xr-x`，即 `0755`
- `events.jsonl`、`errors.jsonl`、`summary.json`：`-rw-r--r--`，即 `0644`

在多用户机器上，同机其他用户可能读取这些日志。公开生产前至少需要：

1. 目录显式创建为 `0700`，文件显式创建为 `0600`，并修复已有目录/文件权限。
2. 定义默认保留期、单会话和总容量上限、轮转与删除策略。
3. 提供清晰的用户披露与 opt-out；企业环境应支持管理员策略。
4. 把正文记录与诊断指标分层，生产默认优先记录元数据而不是内容。
5. 增加敏感信息 corpus、文件内容、命令行参数、嵌套 JSON 和异常格式的脱敏测试。

该问题属于受限外部灰度前的 P0，而不是 GA 前再处理的 P1。

## Required CI 和发布工程缺口

Required CI 当前有 `quality`、`unit`、`compaction-contract`、`runtime-e2e` 和 `tui-system` 五个 Ubuntu job，基础分层合理，但仍缺少：

- macOS/Windows 的内置工具、shell、sandbox、TUI 和恢复 smoke；当前只有 native keyring 使用三平台 workflow。
- 真实模型压缩的定期矩阵与趋势结果。
- 依赖漏洞、license、SBOM 和制品 provenance 门禁。
- 覆盖率与关键模块变更覆盖门槛。
- 性能、内存、文件描述符/监听器、长时运行和故障注入。
- 正式版本 tag、changelog、release artifact、升级/降级和 rollback 演练。
- lint warning budget；当前 191 warnings 仍返回成功。

初始基线的 `MaxListenersExceededWarning` 指向 `useTerminalFocus` 相关 ReadStream data
listener。它可能只是测试 harness 生命周期问题，也可能代表真实长会话中的监听器泄漏；
当时的完整 PTY 回归还出现 sub-agent read flow 30 秒超时，孤立重跑可复现。新基线单次
完整 suite 未复现 timeout，但 listener warning 仍存在；在连续运行与资源斜率验证通过前
不能忽略。

## “好用”尚未被证明

PTY 和 E2E 能证明用户路径可被程序走通，不能证明目标用户觉得好用。当前缺少：

- 代表性任务集上的端到端成功率；
- 首次成功时间、总耗时、模型调用次数和成本；
- 工具审批次数、用户纠正次数、失败恢复率；
- Plan 是否减少返工；
- MCP/Skills 的发现成功率和误触发率；
- 压缩前后任务质量对照；
- 真实用户对可预测性、信任、错误解释和恢复体验的评价。

在宣称“好用”前，应至少以 10–20 名目标用户、覆盖仓库理解、修改、测试、MCP 查询、失败恢复、长对话和 Plan 审核的代表性任务做封闭试用。自动化通过率与用户任务成功率必须分别报告。

## 受限灰度 P0

完成以下事项前，不进入外部生产流量：

1. 修复 session log 权限，补齐保留/轮转/容量/opt-out 和敏感内容测试。
2. 将 limited permission profile 固化为真实 `workspace_write`、network off/host allowlist、
   protected paths 和 sandbox-unavailable fail closed；不能把 macOS 全盘读写 profile
   表述成 Workspace 隔离。
3. 为后台、定时、并发和委派 writer 建立 worktree/branch 或等价隔离，并提供 diff/review
   handoff。
4. 定位并消除 `MaxListenersExceededWarning` 与 sub-agent read flow 超时，增加长会话监听器/资源稳定性测试，并要求完整 PTY required suite 稳定变绿。
5. 建立可工作的 dependency audit、license/SBOM 和 clean install 验证。
6. 建立明确的版本、制品、配置迁移、回滚和 kill switch 流程。
7. 对公开灰度配置显式关闭 Skills、MCP 写操作、Verification 声称、手动/自动压缩；只为内部白名单逐项开启。
8. 在至少 macOS、Windows、Linux 上完成目标发布制品的启动、内置工具、sandbox、shell、会话恢复和 TUI smoke。
9. 建立最小生产指标：run/turn 成功率、工具/MCP 失败分类、模型重试、取消恢复、资源使用和未脱敏内容禁入遥测。
10. 将首发支持边界固定为本地单 OS 用户的 TUI 和用户在场的前台 Headless CLI；Web、
    多租户、远程托管、跨设备控制和服务端 credential custody 保持不可达或 unsupported。
11. 为父 Agent 与全部 Sub-agent 建立累计 time/turn/model/tool/token/concurrency/artifact
    硬预算、顶层 shell invocation 与 process-tree 独立上限、有界 permit wait/取消、
    descendant 清理和稳定 `budget_exhausted/resource_saturated` 终态。
12. 让 release manifest/evidence 绑定实际 agent contract、模型可见 tool schema、默认配置、
    Runtime 导出的 canonical scheduling policy、gate policy、build recipe、任务/压缩 suite
    和 route identity，digest mismatch 必须阻断。
13. 用同一 conformance suite 验证 sandbox、network、worktree、Provider、MCP、存储、预算、
    压缩、Verification、日志和管理员策略的 fail-closed/fallback 语义。
14. 指定 Release/Security/Platform/Capability/Evaluation/Incident owner 与 backup，完成事故
    检测、遏制、证据、通知、credential rotation、恢复和复盘 runbook 演练。
15. 为首批 production model/MCP route 建立数据分类、region、retention/training、
    DPA/consent、内容最小化和 policy 失效规则；远程 MCP 不能继承模型 Provider 的内容外发
    授权，真实用户正文默认不得用于 secondary evaluation。

## 全功能 GA P0

受限灰度通过后，全功能 GA 还需要：

1. **压缩语义门禁**：关键目标、硬约束、批准/拒绝、工具失败、验证结果、Plan 状态和下一步在 golden suite 中 `100%` 保留；压缩后任务完成率相对未压缩对照下降不超过 2 个百分点。
2. **真实模型矩阵**：每个受支持 provider/model 覆盖 direct、incremental、多次增量、tool pair、Plan、Skill、错误恢复、超输入、截断、空响应和 adversarial summary；建立成功率和错误预算，而不是记录单次通过。
3. **压缩运营闭环**：生产 exporter、dashboard、告警、按 provider/model 分桶、canary cohort、远程 kill switch 和自动回退；自动压缩仍应分阶段开启。
4. **MCP 写操作闭环**：durable execution record、provider action、required verification、幂等/补偿和恢复语义在生产配置中共同启用并验证。
5. **Skills 闭环**：activation/workflow 默认放行前完成恶意/冲突指令、依赖缺失、长 workflow、恢复和 UX 矩阵。
6. **Plan 完成语义**：区分“模型报告完成”和“验证完成”，required verification 失败时不能把任务呈现为成功。
7. **长时和故障测试**：进程中断、网络抖动、磁盘满、MCP 重启、模型部分流、并发会话和跨版本恢复。
8. **用户可用性门禁**：代表性任务完成率、纠正次数、恢复成功率、时延、成本和满意度达到预先定义的产品目标。

## 建议的分阶段发布

### 阶段 A：内部 dogfood

- 开启内置工具、Plan、Tool Search 和受控 MCP read。
- 使用有真实 filesystem/network 边界的 `accept_edits`/`auto`；full access 只在可信隔离环境。
- Skills、MCP write、Verification 完成声称和自动压缩保持关闭。
- 手动压缩只给内部白名单，并要求压缩后展示摘要、允许用户确认或清除。
- 每次失败形成分类记录，不以人工“感觉还行”替代指标。

### 阶段 B：受限生产灰度

- 仅允许本地单用户 TUI 或用户在场的前台 Headless CLI、白名单用户/仓库和只读 MCP server。
- 固定 artifact/agent contract/tool schema/config/provider route 组合，设置时间、并发、token、
  model/tool 调用、artifact 和有可靠计价来源时的成本上限。
- 使用小流量 cohort；任何数据泄露、状态损坏、越权执行、关键约束丢失立即 kill switch。
- 版本不自动扩面，每个 feature flag 独立评审。

### 阶段 C：能力 canary

- 依次放行手动压缩、Skills、MCP write、Verification、自动压缩，不并行全开。
- 每项都要有对照组、SLO、错误预算和独立回滚。
- 自动压缩最后放行，因为它会无提示改变后续所有模型调用的上下文。

### 阶段 D：GA

- 只有在 L5 生产证据稳定跨越一个明确观察窗口后，才移除白名单。
- 发布说明必须准确列出已支持、实验性、默认关闭和不保证的能力。

## 推荐 SLO 与验收指标

下面是下一阶段应采用的门槛建议，不是当前已经达到的结果：

| 领域 | 建议门槛 |
| --- | --- |
| Runtime 正确性 | required suites 零失败、零 Runtime warning；checkpoint/tool pair 损坏为 0 |
| 压缩结构 | invalid boundary、orphan tool result、stale checkpoint 被采纳为 0 |
| 压缩语义 | golden critical facts/constraints/verification `100%`；任务成功率下降不超过 2 个百分点 |
| 压缩生成 | 按 provider/model 建立不少于数百个样本的成功率；truncation/empty/oversized 单独分桶 |
| 工具安全 | 未授权写入、sandbox escape、审批绕过为 0 |
| MCP 写入 | 副作用调用 `100%` 有 execution record；required verification `100%` 执行或显式 waive |
| 恢复 | 可恢复失败后的下一轮成功率、平均恢复时间和状态一致性有持续趋势 |
| 资源稳定性 | 长时场景无 listener/FD/内存持续增长；定义 CPU、内存和日志容量上限 |
| 用户可用性 | 代表性任务成功率、纠正次数、审批负担、时延和成本达到产品预设目标 |

具体百分比和观察窗口应由产品风险等级、用户规模和 provider 成本共同确定，不能在没有 canary 基线时伪造。

## 最终判断

Agent 的核心架构不是当前生产化的主要障碍，真正的障碍是：

- 默认启用能力与实际验证闭环不一致；
- 压缩只有结构正确性，缺少语义正确性；
- 安全日志和发布运营存在明确 P0；
- filesystem/network/worktree 执行隔离尚未达到对外 `auto` 的边界；
- 部署拓扑、运行预算、行为证据绑定、统一降级和事故责任链尚未固化；
- 模型 Provider 与远程 MCP 的正常正文外发尚缺少版本化数据策略和接收方独立授权；
- “好用”尚无用户任务证据。

按本文关闭高风险能力、修复受限灰度 P0，并逐项建立 L4/L5 证据后，进入**本地单用户受限
生产**是可行的。若保持当前默认配置并把 MCP、Skills、Plan、压缩和 Verification 一并宣传
为稳定能力，或把该结论扩展到 Web/hosted/multi-tenant，则不可行。
