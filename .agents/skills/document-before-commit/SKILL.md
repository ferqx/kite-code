---
name: document-before-commit
version: 2.2.0
description: Check and synchronize documentation when a change affects documented behavior or boundaries, or when preparing a Git delivery action.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
  properties:
    action:
      type: string
      enum: [design_complete, iteration_complete, stage, commit, push, pull_request]
  required: [action]
output_schema:
  type: object
  properties:
    status:
      type: string
      enum: [ready, blocked]
    documents_checked:
      type: array
      items:
        type: string
    documents_updated:
      type: array
      items:
        type: string
  required: [status, documents_checked, documents_updated]
capabilities:
  require: [builtin:read_file, builtin:shell_execute, builtin:edit_file, builtin:write_file]
  deny: []
effects:
  filesystem: write
  network: none
  external_state: none
approval:
  minimum: none
execution:
  timeout_ms: 300000
  max_attempts: 2
verification:
  mode: required
recovery:
  retry: never
---

# 文档同步与 Git 交付核对

触发时机和授权遵循[根 AGENTS](../../../AGENTS.md)；文档任务按[docs AGENTS](../../../docs/AGENTS.md)和[维护规则](../../../docs/development/documentation.md)定位。Skill 不扩大原任务授权；具体写入、Git 和外部动作由 Runtime policy 与原任务授权决定。

## design_complete

用于已确认且需保留为后续实施依据的设计。核对方案内容、状态及产品/技术入口；不要求尚未实现功能的运行测试通过。

## iteration_complete

分别核对产品与技术文档，归位已交付事实和必要证据。只更新实际变化；行为和边界不变时记录核对依据。需要选择验证或复用既有结果时，读 [references/validation.md](references/validation.md)。

## stage / commit / push / pull_request

这些 action 只在用户已授权对应 Git 动作时执行。读 [references/git-delivery.md](references/git-delivery.md) 确定实际 diff/range、保护无关改动并选择验证；不要把当前工作树、暂存区和已提交范围相互替代。

## 判定与交付

| 情况 | 判定和后续工作 |
| --- | --- |
| 本次引入的冲突、必要同步遗漏，或完成目标必须解决的问题 | 相关 action 返回 blocked，解决后复验 |
| 强制门禁本身失败，或无法证明当前交付安全 | 返回 blocked，说明失败范围与原因 |
| 与本次无关且不影响当前交付的既有问题 | 记录为 limitation，不自动扩大修复范围或阻断 action |
| 当前需求、源码和测试可解决的疑问 | 自行核实，不转交常规工程判断 |
| 证据无法解决且需用户决定的实质产品歧义 | 明确受阻部分并请求具体决定，其他独立工作继续 |

返回 ready 或 blocked，以及 documents_checked / documents_updated。集中说明 action、实际变化、产品与技术核对依据、相关验证和剩余问题；无需逐页填写“不适用”。ready 只覆盖本次 action 或阶段，部分交付不代表整个目标完成，文档 diff 不证明语义准确。

强制检查与授权不因证据复用或无关问题分类而削弱。不使用 --no-verify，不增加原任务以外的提交、推送或对外发送授权；过度设计检查按根规则触发。
