# ToolSpec Registry 阶段 3 完成记录

状态：completed
日期：2026-07-26
计划：[`2026-07-26-tool-spec-registry-phase-3.md`](../../plans/2026-07-26-tool-spec-registry-phase-3.md)
决策：ADR-0043、ADR-0044、ADR-0028

## 已完成

- 建立 `RuntimeActionEmission` 成功/拒绝边界，拒绝命令不携带领域事件；
- 建立 Plan Runtime 门面，统一 `read_plan`、`write_plan`、`update_plan` 的状态检查、
  Artifact I/O、版本冲突、review/replan、progress/completion 与 sibling cancellation；
- 建立 Skill 生命周期服务，统一 activation、active-frame task/revision 校验、reference
  boundary、inline/fork close、fork output schema 校验与 Verification 请求；
- Plan 与 Skill ToolSpec 收敛为 Schema、契约、effects、领域服务调用和结果投影；
- Controller 使用统一 helper 追加领域事件与生成 terminal Tool Result，并保留 disclosure、
  approval、fork adapter 和事件原子提交边界；
- conformance 测试禁止 Controller 重新构造 Plan/Skill 生命周期事件。

模型工具名、Schema、Tool Result 文本、RuntimeEvent discriminant、Plan Artifact 格式与
Runtime store 回放形状均保持不变。

## 验证

- `bun run typecheck`
- Plan/Artifact/Task lifecycle、Skill activation、Capability Search、Tool Controller、
  Tool definitions 与 Registry conformance 定向测试通过
- 真实本地 MCP/Skill E2E 通过
- `bun run test`：1769 pass、2 skip；其余 5 个失败与阶段 1/2 记录中的既有
  Windows TUI、project approval、ACL 与延迟取消失败集合一致
- `bun run check:core-boundary`
- `bun run check:docs`
- `bun run check:docs-impact`
- `git diff --check`
