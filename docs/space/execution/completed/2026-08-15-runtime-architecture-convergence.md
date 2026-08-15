# Runtime 架构收敛完成记录

状态：completed
日期：2026-08-15
关联计划：[`2026-08-15-runtime-architecture-convergence.md`](../../plans/2026-08-15-runtime-architecture-convergence.md)
决策：ADR-0105、ADR-0106、ADR-0107、ADR-0108

## 结论

Runtime 架构收敛已按“删除重复权威、删除旧路径、切断错误依赖”完成。实现没有建设通用
Ports/Adapters、Runtime slice、第二个 release 组合根、ToolModule 或公共 Runtime V1 API；剩余依赖环
没有发现新的重复执行权威，满足计划停止条件，不继续做证据不足的目录或 reducer 拆分。

## 删除与单轨化结果

- RuntimeStore schema 4 与 Runtime schema 24 共同使用精确 format epoch；旧、缺失或损坏格式在 decode、
  reducer、scheduler 和 Tool dispatch 前 fail closed，源数据库不迁移、不搬移、不改写。
- 当前 event tail 先经过 discriminant/identity decoder 和 envelope 校验；`tool.execution_ready` 已删除，
  未知或退役事件不能推进审批。WAL-only 旧库预检、named snapshot rewind/fork 与嵌套 Subagent
  continuation 均在任何源写入或 dispatch 前完成完整性验证。
- Event decoder 只维护一份 required-field manifest；RuntimeStore 只保留严格事件读取，并删除 5 个无
  生产消费者的 Kernel snapshot/event façade。损坏事件不能再被解释为空历史。
- 删除 V2–V22 snapshot migration、historical tail/ToolOutcome decoder、schema migration fixture、legacy
  Plan/Subagent continuation/recovery、相关 effect、flag 与兼容分支。
- 删除 Protocol `AgentEvent`、`UserAction`、`UserInputProvider`，App 只在边缘维护本地 TUI action/view，
  Runtime 事实只剩 `RuntimeEvent`、`RuntimeUserAction`、`RuntimeActionProvider`。
- Protocol 不再导入 Core verification result；`protocol → core/app` 与 `core → app` 禁止边均为 0。
- 删除 `runApprovedTool`、Controller 的具体 ToolSpec dispatch、逐工具执行分支以及
  `ProjectedToolResult.display/runtimeEvents`。Builtin、Runtime action、coordination 和动态 MCP 均进入
  `invokeGovernedTool()`；`dispatchRegisteredTool()` 只在该实现内部调用。
- `ToolApprovalPayload` 只保留 Protocol 定义；普通 Tool、Task 与恢复后的 Task 共用唯一 terminal/digest
  mapper。Subagent continuation 的 recovery journal/reason identity 均为当前必填字段，不再缺省生成。
- Plan 只接受当前 PlanDocument V2；`write_plan` 固定为先 `save` Artifact、再用精确 identity `submit`，
  Plan progress/completion 只接受 active Task、identity 与 Runtime-derived evidence。首次 identity 对同一
  Task 稳定，Artifact 已发布但事件未提交的崩溃窗口可安全重试；发布同步目录项后才提交 Runtime 事实。
- active `TaskState.planning` 是 Planning 唯一持久权威；删除 RuntimeState compatibility mirror、同步写、
  镜像 invariant 与旧三参数 Plan Artifact locator。
- 删除 Plan 审批 action 中被忽略的兼容字段和 `tool.failed` 的旧字符串 fallback；当前失败只读取结构化
  `ClassifiedFailure`。

## 前后指标

| 指标 | 改动前 | 完成后 |
| --- | ---: | ---: |
| Core + Protocol TypeScript 文件 | 228 | 225 |
| 禁止依赖边 | 已知 `protocol → core` 违规 | 0 |
| Runtime event/action/provider 权威 | 双轨 | 各 1 套 |
| historical Runtime 在线 manifest | migration、decoder、recovery 并存 | 0 |
| ToolSpec Registry dispatch 路径 | Controller/Harness 双入口 | 1 |

SCC 与内部 import 边只在实施阶段做过一次性方向检查，不进入稳定门禁；审计修复又增加了当前格式
decoder 与完整性校验依赖，因此本记录不固化无法由仓库命令复现的旧扫描数字。剩余 SCC 没有具体重复
权威或错误依赖证据，因此没有创建 slice、selector、coordinator 或通用 Port 来追求形式上的零环。

## 防扩张审计

- `dispatchRegisteredTool()` 的生产调用仅存在于 `src/core/harness/tool-runner.ts`；边界检查会拒绝其他
  Core 文件新增直接 dispatch。
- `src/protocol/` 无 Core/App import，`src/core/` 无 App import。
- 没有新增 `src/core/ports/`、`RuntimeServices`、Runtime slice/reducer 框架、release consumer 或公开版本
  façade。
- 收尾审查删除了新 Event allowlist 重复事实源及既存残余 façade，没有用新的 selector hierarchy、schema
  平台或兼容 adapter 替代它们。既有 TUI Plan Mode 第二 writer 作为独立 correctness 问题留在本轮之外。
- 源码、测试与文档总 diff 为净删除；实际减少了权威、分支、入口和错误依赖，而不是以包装层换名。

## 验证

- `bun run typecheck`
- `bun run check:core-boundary`，并以 AST fixture 验证 alias/relative/multiline/dynamic import 与
  Registry dispatch/projection 旁路会失败
- `bun run check:docs-impact`
- `bun run check:docs`
- `bun run format:check`
- `bun run test`：主套件 3,413 pass、7 skip、0 fail，5 个 process-isolated 文件全部通过
- `git diff --check`

真实 Provider、native sandbox 与 release smoke 未运行；本次没有改变其边界，也没有打开正式发布或
候选制品范围。

## 交付边界

本记录只归档当前工作树的 Runtime 架构收敛实现；未创建提交、未 push、未创建 Pull Request。
