# ADR-0028：Runtime Action 门面与 Skill 生命周期服务

状态：accepted
日期：2026-07-26
补充：ADR-0002、ADR-0008、ADR-0043、ADR-0044
关联：`docs/space/plans/2026-07-26-tool-spec-registry-phase-3.md`、`docs/active/plan-mode-implementation.md`、`docs/active/tool-gated-autonomy.md`

## 背景

ToolSpec Registry 阶段 2 已把 Plan 三件与 Skill 三件接入 Registry，但接入仍是结构迁移：

- Plan specs 直接读取 `RuntimeState`、访问 `PlanArtifactStore` 并构造 Plan 生命周期事件；
- Skill specs 直接读取 frame/catalog、执行 activation 评估、关闭 frame 并构造 Verification 事件；
- Tool Controller 仍为 Skill disclosure、approval、fork adapter 和不同 runtime-action 结果重复编排专用分支。

这使 ToolSpec 同时承担模型工具适配与 Runtime 领域状态机职责。事件虽然已经结构化，却还没有稳定的领域命令门面。

## 决策

1. 新增统一的 `RuntimeActionEmission` 协议。Runtime Action 成功只返回模型投影与待提交的 `RuntimeEvent[]`；拒绝不产生领域事件。ToolSpec 的 `projectResult` 只做投影，不重新计算事件。
2. Plan 建立 Core 门面，封装 read/save/submit/progress 命令、Artifact I/O、并发版本检查与事件生成。Plan ToolSpec 只校验模型 Schema 并调用门面。
3. Skill 建立生命周期服务，封装 activation、reference boundary、inline/fork close、catalog drift invalidation 与 Verification 请求。Skill ToolSpec 只校验模型 Schema 并调用服务。
4. Tool Controller 保留跨领域治理：disclosure、Policy/approval、Runtime event 原子提交、Subagent adapter 和 tool lifecycle terminal event。它不得重新计算 Plan 或 Skill 领域结果。
5. 模型可见工具名、Schema、Tool Result 文本、RuntimeEvent discriminant、Artifact 格式和回放形状保持不变。本阶段不合并 Plan 三个模型工具，也不把 App/TUI 类型引入 Core。

## 后果

- Plan 与 Skill 生命周期可以脱离 Tool Controller/ToolSpec 做纯 Core 测试；
- specs 不再是 RuntimeState 的第二个 reducer；
- 阶段迁移可以逐工具进行，旧事件仍由现有 reducer 消费；
- 这是内部架构收口，除错误路径一致化外不主动改变用户可见行为。

## 回滚

各门面切片可独立 revert；事件和持久化形状未变，不需要 store migration。
