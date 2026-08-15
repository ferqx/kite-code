# Runtime 架构收敛计划

状态：archived

日期：2026-08-15

优先级：P0

依赖：当前 Runtime Kernel、ToolSpec Registry、`docs/active/six-concept-runtime-architecture.md`、`docs/active/layer-boundary-enforcement.md`

并行约束：`2026-08-15-tui-i18n-zh-en.md` 完成前，不修改 TUI 展示协议、`handleEvent.ts` 或 `types.ts`；不与其他正在修改相同 ownership set 的任务并行。

已确认决策：项目尚未发布正式版，不兼容任何历史 Runtime 持久格式；旧数据不主动删除，但不提供读取、迁移或恢复承诺。

## 1. 审核结论

本计划只做“删除重复权威、删除旧路径、切断错误依赖”。不建设新的内部平台，不以目录重排、接口包装或概念换名作为成果。

原方案中以下内容不再是必做目标：

- 不预设 `core/domain → core/application → core/ports → app/adapters` 全量改造；
- 不新建通用 `src/core/ports/` 体系或 `RuntimeServices` 服务袋；
- 不预设六个 Runtime slice、六套 reducer、selector 和跨 slice coordinator；
- 不为现有 ToolSpec 再创建 `ToolModule` 或 definition/policy/handler/projection 四套包装；
- 不建设第二个 release-candidate Runtime 组合根；
- 不在正式发布前新增 `RuntimeEventV1`、`RuntimeActionV1` 等公共兼容承诺；
- 不把依赖分析扩展成长期维护的架构分析平台。

第一轮是确定执行范围；第二轮只有在第一轮指标证明仍有重复执行路径时才能启动。Runtime reducer 拆分和具体依赖 seam 提取均为证据触发项，不得预先承诺。

## 2. 收敛目标

完成后的最小结构是：

```text
app/cli ─┐
         ├─→ core/runtime ─→ protocol
app/tui ─┘       │
                 ├── 一个 RuntimeState
                 ├── 一个 reducer 入口
                 ├── 一个 Runtime event/action/provider API
                 └── 一个 ToolSpec Registry 与 invocation pipeline
```

这里的“一”指唯一权威和唯一路径，不要求所有实现位于一个文件。

必须达到：

1. `src/protocol/` 只包含中立、JSON-safe、确需跨边界共享的数据，不依赖 Core 或 App；
2. `src/core/` 不依赖 App/TUI 类型；
3. Runtime Kernel 继续是唯一持久状态转换和事务提交权威；
4. Runtime event、action、provider 各只有一个当前内部协议；
5. 工具只有一条解析、事实提取、Policy、审批、执行和结果归一链；
6. 当前 Runtime 只接受精确 format epoch，不执行历史 migration、decoder 或 recovery；
7. 每个架构 PR 都删除明确的旧权威、旧入口、旧分支或错误依赖。

## 3. 当前证据

实施前复核以下事实，并将精确 symbol/file manifest 作为删除清单：

| 观察 | 当前事实 |
| --- | --- |
| 物理层违规 | `src/protocol/verification.ts` 导入 `src/core/capabilities/result.ts` |
| Core 依赖 | Core 一级模块与 protocol 存在大强连通分量 |
| 双轨协议 | `AgentEvent` / `RuntimeEvent`、`UserAction` / `RuntimeUserAction`、`UserInputProvider` / `RuntimeActionProvider` |
| 历史兼容 | V2–V22 migration、historical tail/ToolOutcome decoder、legacy Plan/Subagent recovery 仍在在线路径 |
| Tool 双路径 | ToolSpec 已拥有 schema/effects/execute/projection，但 Controller/Harness 仍保留重叠 dispatch 路径 |
| ToolSpec 过宽 | Tool execution context 持有过多 Runtime/Skill/MCP/Sandbox 依赖，projection 混入 display/runtime event |
| 组合逻辑 | `runRuntimeAgent()` 仍创建部分具体依赖，但仓库已经存在若干窄接口和 release composition root |
| 无消费者路径 | production loader 等入口只有测试消费者或没有产品消费者 |

SCC、fan-out 和生产代码量只用于阶段前后比较，不设长期阈值，不作为独立产品或稳定公共格式。

## 4. 不变量与非目标

### 4.1 必须保持

1. Runtime Event 是可恢复事实，只有 reducer 可以形成新的持久 RuntimeState。
2. Scheduler 只根据持久事实决定 Effect，外部实现不能获得调度权威。
3. 副作用先持久化 intent，再 dispatch；未知结果只能 reconciliation。
4. Policy、approval、sandbox 和 execution boundary 继续 fail closed。
5. Tool terminal event 与 transcript ToolMessage 保持一一对应。
6. Required Verification 不能被 final、flag 或模型声明绕过。
7. 当前 epoch 的 restore、fork、rewind、取消、并发和顺序语义保持不变。
8. 旧 epoch 失败时零 dispatch、零 store 写入、源文件不变。

### 4.2 明确不做

- 不新增工具、Provider、Skill、MCP route、Web 产品或后台 Agent；
- 不改变 TUI 交互、用户命令、默认授权模式或安全边界；
- 不整体搬迁 `core/model`、`core/mcp`、`core/sandbox` 或 Runtime store；
- 不为已有窄接口再包装同义 Port；
- 不创建新的 release 产品路径来证明架构完整；
- 不把内部 Runtime event 全部提升为 Protocol 或公共 API；
- 不为了“领域纯度”强制所有字段经 selector 访问；
- 不主动移动、改写或删除旧会话、数据库与 Artifact；
- 不进行无法按删除清单独立验证的 big-bang rewrite。

## 5. 反扩张门禁

每个架构 PR 在开始前声明 before/after 指标和删除清单。合并时必须满足：

1. 禁止 abstraction-only PR；新增抽象必须在同一 PR 替代并删除至少一个旧抽象、旧入口或具体创建点。
2. 新增入口必须在同一 PR 删除旧入口；不得在合并点保留双实现、双写或无期限 shim。
3. 本 PR 声明的核心指标至少一项严格下降，其他受控指标不得恶化。
4. forbidden dependency edge、最大 SCC 节点数和临时例外数量不得增加。
5. 新增 interface、factory 或公共 export 时，对应总数不得净增加，除非 ADR 明确说明不可避免且同时删除更大的重复权威。
6. 除必要的错误处理外，非测试生产代码不得无解释净增长；出现净增长时必须证明执行路径、分支或依赖边减少。
7. migration flag 与旧路径在所属 PR 同时删除，不得留到统一收尾。
8. 临时 allowlist 必须绑定本计划内的删除项；能够先修复的违规不得进入 allowlist。
9. 文档、测试和检查脚本不计作架构收敛成果，必须伴随源码权威或路径的实际减少。

阶段报告至少记录：

| 指标 | 约束 |
| --- | --- |
| Runtime event/action/provider 权威数量 | 第一轮结束时分别为 1 |
| legacy Runtime manifest | 每个删除 PR 严格下降，第一轮结束时为 0 |
| 每个已迁移工具的 invocation path | 必须为 1 |
| Controller/Harness 逐工具分支 | Tool PR 中严格下降 |
| forbidden dependency edge | 不增加，计划结束时为 0 |
| 最大 SCC 节点数 | 不增加；是否继续拆分由剩余真实环决定 |
| interface/factory/public export | 不得因架构包装净增加 |

## 6. 执行顺序

### 第一轮：删除历史与双轨协议

第一轮完成后必须停止并人工复核。它本身应当形成可保留的完整结果。

#### AC-00：最小决策与硬边界

- 依赖：无；
- 修改范围：ADR、现有 `check:core-boundary`、对应 tests 和 active 边界文档；
- 产出：记录“预发布无历史兼容”和最小依赖方向；检查 `protocol → core/app`、`core → app` 与本轮声明的禁止入口；生成一次性基线报告；
- 删除：无效边界例外、与当前规则冲突的文档表述；
- 禁止：创建完整 import graph 产品、稳定 JSON API、fan-out CI 阈值、预设 domain/application/ports 矩阵；
- 验收：新增禁止依赖的 fixture 会失败，当前债务有精确删除项，文档门禁通过。

#### AC-01：Format epoch fail-closed

- 依赖：AC-00；
- 修改范围：Runtime format 标识、store open/restore 边界和定向 tests；
- 产出：当前数据带精确 format epoch；缺失、错误或损坏 epoch 在任何 event decode、reducer、scheduler、tool 或 adapter 调用前失败；
- 删除：仅依赖 schemaVersion 判断可恢复性的旧入口；
- 禁止：quarantine 目录、自动搬移、importer/exporter、恢复 UI；
- 验收：覆盖“schemaVersion 相同但 epoch 缺失/错误”fixture，证明零 dispatch、零写入且源文件哈希不变。

#### AC-02：历史 decoder 与 migration 删除

- 依赖：AC-01；
- 修改范围：snapshot migration、historical tail reducer、ToolOutcome decoder 及对应 fixtures/tests；
- 产出：当前 epoch 只有当前 decode/reduce 路径；
- 删除：V2–V22 migration、historical tail、historical ToolOutcome 在线 decoder 和只服务这些路径的类型/flag；
- 禁止：用 `legacy` 关键字批量删除与 Runtime 格式无关的安全隔离或 Git 语义；
- 验收：删除 manifest 严格下降，当前 epoch create/restore/fork/rewind 通过，旧 epoch 不进入 decode。

#### AC-03：Legacy Plan/Subagent recovery 删除

- 依赖：AC-02；
- 修改范围：Scheduler、effects、Plan/Subagent compatibility 状态与 tests；
- 产出：Plan/Subagent 只保留当前调度和审批路径；
- 删除：legacy Plan recovery、legacy Subagent approval/continuation、兼容字段、effect 和对应 migration flag；
- 禁止：保留“暂无调用”的兼容分支；
- 验收：legacy Runtime manifest 为 0，当前 Plan/Subagent live、restore、approval、cancel 行为通过。

#### AC-04：Runtime 协议单轨化

- 依赖：AC-03；TUI i18n 已完成或明确避开冲突文件；
- 修改范围：Runtime event/action/provider、Protocol leaf DTO、CLI/TUI 边缘转换、Session Logger 和根 export；
- 产出：App 直接消费唯一的 Core Runtime API；Protocol 只保留中立 DTO；
- 删除：AgentEvent logger path、UserAction、UserInputProvider、createCliProvider 和对应转换/死 export；
- 禁止：把整个 RuntimeEvent union 搬进 Protocol、添加 `V1` 公共命名、重新设计 durable/live 两套协议、改变 TUI 文案；
- 验收：event/action/provider 权威分别为 1；`protocol → core/app` 为 0；live/restore、CLI/TUI lifecycle 和 session logging 通过。

### M1 强制暂停

AC-04 合并后停止实现并提交报告：

- 前后禁止依赖、SCC 和公共权威数量；
- 删除的 schema、decoder、recovery、协议和 flag 清单；
- format epoch 错误的零副作用证据；
- 当前 epoch 的 live/restore/replay、CLI/TUI 和安全验证；
- 是否仍存在 Tool 双路径，以及每条路径的具体调用证据。

没有维护者明确确认，不启动第二轮。

### 第二轮：Tool 单路径，条件启动

第二轮只解决 M1 报告证明仍存在的 Tool 重复路径，不建设新的 Tool 架构。

#### AC-05：缩窄现有 ToolSpec 并验证最小样本

- 依赖：M1 明确继续；若改变 ADR-0028/ADR-0043 的既有结论，先新增范围最小的 superseding ADR；
- 修改范围：现有 ToolSpec、ToolExecutionContext、ProjectedToolResult、一个 read 工具、一个 effectful 工具及其 Controller/Harness 分支；
- 产出：ToolSpec 继续是唯一注册事实源；context 只保留执行必需依赖；工具只提供结构化 effect facts，不拥有授权决策；application 负责 outcome → event，App 负责 display；
- 删除：样本工具的重复 schema/policy/dispatch/projection、逐工具 Controller/Harness 分支和不再需要的 display/runtime event 字段；
- 禁止：新增 ToolModule、四 facet 接口或文件模板、将动态 MCP 定义为新的 ToolKind；
- 验收：两个样本工具各只有一条 invocation path；审批、protected path、sandbox、preimage、模型结果与展示行为保持；生产接口和分支净减少。

#### AC-06：按工具家族完成单路径迁移

- 依赖：AC-05 指标确实改善；
- 修改范围：只读、写入/shell、interrupt/Plan、coordination/MCP 按 ownership set 分开提交；
- 产出：所有实际工具来源进入同一 invocation lifecycle，动态 MCP 只作为 binding/source 差异；
- 删除：`runApprovedTool()`、旧 request/result adapter、剩余逐工具双路由以及随迁移失效的 flag；
- 禁止：一个 PR 同时跨越多个 ownership set；不得打开默认关闭的 capability；不得为未发现双路由的工具制造迁移；
- 验收：每个已迁移工具的 parse、effect facts、Policy、approval、dispatch、projection 路径为 1；Tool/Policy/Sandbox/MCP/Skill/Subagent/Verification tests 通过。

### M2 重新测量与停止条件

AC-06 完成后重新生成依赖报告：

- 若目标错误依赖已归零、Tool 路径唯一且剩余 SCC 没有明确重复权威，计划直接进入收尾；
- 若仍有具体 `core → SDK/driver/app` 依赖，只在原模块旁复用或提取最窄接口，一个违规一个 PR；
- 若仍有明确跨领域循环，只按“一个真实依赖环一个 PR”提取纯处理函数或最小 seam；
- 不改变 RuntimeState 持久形状，不建立 slice 框架；
- 保留唯一 `reduceRuntimeState()` 入口；按 event family 拆纯处理函数即可；
- selector 只为至少两个消费者共享且封装真实不变量的查询创建；
- Scheduler 可以读 RuntimeState，但不得写状态或复制 reducer 决策。

证据触发 PR 同样受第 5 节约束。若无法声明会被删除的依赖边、循环或重复权威，则不得创建该 PR。

## 7. 收尾

收尾不设置“架构抽象建设”PR。每个实现 PR 同步更新相关 active 文档和删除所属 migration flag；最后只允许：

1. 修正遗漏的当前事实文档和计划状态；
2. 删除已确认无消费者且不属于 release tooling 的 loader/export/script；
3. 保存前后依赖、删除清单和验证证据；
4. 执行文档门禁并将本计划移入 completed。

不得为无消费者 production loader 新建入口。Release 产品化、公开兼容政策和候选制品组合根由正式发布计划单独决定。

## 8. 验证矩阵

每个 PR 至少运行：

```bash
bun run typecheck
bun run check:core-boundary
bun run check:docs-impact
bun run check:docs
bun run test
```

| 变更范围 | 必须验证 |
| --- | --- |
| Format epoch | 当前 epoch 正常恢复；错误 epoch 零 dispatch、零写入、源文件不变 |
| 历史清理 | 当前 schema/replay/fork/rewind；被删 symbol 和在线路径不可达 |
| Runtime 协议 | live/restore、Session Logger、CLI、TUI lifecycle |
| Tool pipeline | Registry、Controller、Runner、Policy、Sandbox、MCP、Skill、Subagent、Verification |
| 依赖 seam | 定向 contract test、禁止依赖 fixture、前后 dependency/SCC 报告 |
| 文档 | docs impact、docs、相关 active 文档一致性 |

真实 Provider、native 平台和 fault/soak 仅在对应边界变化或候选资格阶段运行，不混入无关内部清理 PR。

## 9. 完成定义

以下条件全部满足才能标记 completed：

1. `protocol → core/app` 和 `core → app` 禁止依赖为 0；
2. Runtime event/action/provider 权威分别为 1；
3. 在线 legacy migration、decoder、Plan/Subagent recovery manifest 为 0；
4. 当前 Runtime 只接受精确 format epoch，错误格式不会触发任何外部副作用或写入；
5. 每个实际工具只有一条受治理 invocation path，Controller/Harness 不再维护逐工具双路由；
6. Kernel、单一 RuntimeState 和单一 reducer 入口保持唯一事务权威；
7. 没有为了本计划新增通用 Ports/Adapters、slice 框架、release 组合根或公共版本承诺；
8. 没有跨 PR 存活的 shim、双实现或 migration flag；
9. active 文档与源码、测试和边界门禁一致；
10. Required、文档及所有受影响范围的定向验证通过；
11. 完成报告证明架构权威、执行路径、旧分支或错误依赖发生了净减少。

任何实现如果不能指出“删除了什么”以及“哪个核心指标下降”，都不属于本架构收敛计划。

完成记录：[`2026-08-15-runtime-architecture-convergence.md`](../execution/completed/2026-08-15-runtime-architecture-convergence.md)
