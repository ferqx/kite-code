---
name: code-simplification
version: 1.2.0
description: Simplify a code path, architecture, or repository by removing evidenced redundancy while preserving supported behavior and contracts. Use for requests to streamline, de-duplicate, or reduce overengineering in code; not for feature removal or performance work without a separate request.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
  properties:
    scope:
      type: string
      description: Path, module, flow, current diff, or repository to simplify; infer from the user request when omitted.
    mode:
      type: string
      enum: [review, apply]
      description: Review candidates only or implement the authorized simplification.
  required: []
output_schema:
  type: object
  properties:
    status:
      type: string
      enum: [complete, partial, blocked]
    summary:
      type: string
    changed_files:
      type: array
      items:
        type: string
    verification:
      type: array
      items:
        type: string
    remaining_unknowns:
      type: array
      items:
        type: string
  required: [status, summary, changed_files, verification, remaining_unknowns]
capabilities:
  require: [builtin:read_file, builtin:search_content, builtin:search_files, builtin:shell_execute, builtin:edit_file, builtin:write_file]
  deny: []
effects:
  filesystem: write
  network: none
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 1800000
  max_attempts: 1
verification:
  mode: best_effort
recovery:
  retry: never
---

# 代码精简

目标是让当前需求对应的代码更容易理解、修改和验证，而不是压缩行数。遵循用户指定范围和仓库规则；`review` 只读并给出有证据的候选，`apply` 在原任务授权内实施。未指定模式时，根据用户是否要求实际修改判断。评审当前 diff 时，可读取相邻代码和调用链，但只报告该 diff 引入或加重的问题。

请求覆盖整仓或多个 workspace 时，先读[全仓覆盖与验收](references/repository-wide.md)。逐模块候选和整仓完成判定不同；不得以少数已实施改动代替对请求范围的覆盖说明。

## 找到可安全精简的边界

1. 明确目标路径及其现有职责。读取所属模块文档、相关测试和实际调用点；涉及用户行为或跨包契约时，按仓库规则核对产品定义与双方 owner。先看现有改动，保护无关工作。
2. 写下必须保持的可观察事实：公开接口和数据格式、输出与错误、调用顺序和副作用，以及适用的权限、并发、事务、取消与恢复语义。对于并发或恢复路径，还要推演状态转换、事件交错、失败/重试及恢复后的不变量，记录测试难以覆盖的交错。只把已确认的需求当作约束；发现预期与实现冲突时，说明证据，不能将当前实现直接当作产品承诺。
3. 沿生产调用和配置入口找复杂度来源：只转发的层、重复判断、无消费者的抽象或状态、重复的 authority/注册表、无现行依据的兼容分支、过早通用化、可直接表达的间接调用、过深嵌套。对状态与协议先找负责 owner 和真实消费者；区分测试/文档引用与生产使用。搜索不到静态引用，不足以证明公开 API、动态注册或兼容入口可删。跨层或大型候选进一步按[候选证据与取舍](references/candidate-analysis.md)追踪完整效果路径和维护成本。

## 实施与核验

`review` 到候选与证据为止，不修改代码、测试或文档；以下改动步骤仅适用于 `apply`。

- 选择最小的自洽改动，优先移除没有当前用途的机制，或合并同一 owner 下的重复逻辑。核对实际消失的接口、状态、依赖、测试与文档，以及仍需保留的胶水；只移动复杂度不算精简。保留有明确正确性、安全、并发、恢复或平台理由的复杂度。避免为了复用引入更难理解的抽象，也避免把成本转嫁给调用方或用户。
- 把功能改变与纯精简分开判断；如果候选会删掉已支持行为、改变契约或扩大范围，核对是否已在用户授权目标内。未获授权时只给有证据的分析，不把它伪装成重构。不要以密集表达式、隐藏控制流或笼统工具函数换取较少行数。
- 对有风险的行为先取得基线：运行相关现有测试；关键契约缺覆盖时补充能观察行为的测试。按独立步骤修改，并复跑对应测试、类型/构建/边界检查。测试失败先定位本次差异，不以改断言掩盖行为变化。验证成本与风险相称，不为机械改写增加镜像测试。
- 最后检查 diff 和调用链，确认没有遗留转发层、失效注释、测试或文档引用；按仓库规则同步实际变化的 owner 文档。只有有度量证据时才声称性能改善。

交付时简述精简了什么、为什么该机制可去除、行为保持的证据、实际运行的验证及未验证边界。若证据不足，保留该机制并指出具体缺口；不把待定候选列成已完成成果。全仓请求还须区分已审查范围、已修改范围与未审查或未通过验证的范围；全局测试或门禁中断时不能宣称整仓验收通过。范围只完成一部分时返回 `partial`；只有缺少必要授权、输入或外部条件而无法继续时返回 `blocked`。

本方法所依据的社区与开源实践见[来源与取舍](references/principles.md)，需要核对某条原则的适用范围时再读。
