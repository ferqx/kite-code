---
name: document-before-commit
version: 2.1.0
description: Synchronize product, technical, and related documentation at design or iteration completion and before staging, committing, pushing, or opening a pull request.
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
  minimum: user
execution:
  timeout_ms: 300000
  max_attempts: 2
verification:
  mode: required
recovery:
  retry: never
---

# 产品与技术文档同步

触发时机和授权遵循[根 AGENTS](../../../AGENTS.md)；文档任务按[docs AGENTS](../../../docs/AGENTS.md)进入[维护规则](../../../docs/development/documentation.md)。同一任务已读且未变化的规则无需机械重读。检查当前 diff、相关产品预期与实现，确定本次客户端、模块和验证范围；映射候选不是整批必读清单。

## design_complete

用于已确认且需保留为后续实施依据的设计。按维护规则的“当前事实与设计状态”核对方案内容及产品、技术入口链接。普通小修复不强制产生方案或标记。检查设计和链接，不要求尚未实现功能的运行测试通过；此 action 不要求再次确认已经授权的设计。

## iteration_complete

分别核对产品与技术文档，按维护规则归位已交付事实和必要证据，处理部分交付、完成或取消后的设计入口。只更新实际变化，行为不变时说明依据。

执行 check:docs、all 作用域 check:docs-impact 和实际相关验证。TypeScript 变化运行 typecheck；发布证据或其检查器变化运行 check:plan-evidence；技术边界变化运行相关边界检查。按下方条件复用仍有效的结果。

## stage / commit / push / pull_request

检查 staged、unstaged、untracked 和唯一 Git owner，保护无关改动。stage 用 all；commit 用 staged；push 与 pull_request 按已提交变更的实际范围核对，不能用空暂存区替代，CI 用 range。执行 check:docs、check:core-boundary 与相关测试；TypeScript 和发布证据按上述条件扩大验证。

push 前核实实际 remote、目标 ref、待推送 head 与远端 tip；PR 核实目标分支与 head，不猜默认分支。检查器 range 使用 `base...HEAD`（merge-base 差异）：PR 用目标分支作 base；普通 fast-forward push 用已核实的远端 tip 作 base。新远端分支需确定本次交付基线；非 fast-forward、推送非 HEAD 或多个 ref 时，先按实际 commit 集合逐一核对，不能直接套用当前 HEAD 的 range 并宣称覆盖。基线或目标无法核实时阻塞该 Git action，不扩大 Git 授权。

进入新提交边界重新核对该边界；完整工作树结果不能证明暂存区包含必要同步，staged 结果也不能证明已提交的 push/PR 范围。其他相关验证可以按下方条件复用。同一 authority 的并发工作遵循根规则。

## 读取与验证复用

复用前说明已有结果检查了什么，以及为何仍适用于当前状态；以下条件必须同时成立：

- 相关文件、依赖、配置和生成输入没有影响结果的变化。
- 原验证范围覆盖当前断言，结果可在本次任务中追溯。
- 没有新失败、未解决风险或环境变化使结果失效。

证据不明确时重新验证受影响范围。已通过且仍有效的检查不重复手动执行；新修改、失败或风险才扩大或补充验证。现有 hook 和 CI 独立运行，不增加跳过参数、持久验证缓存或同步台账。

## 判定与交付

| 情况 | 判定和后续工作 |
| --- | --- |
| 本次引入的冲突、必要同步遗漏，或完成目标必须解决的问题 | 相关 action 返回 blocked，解决后复验 |
| 本次强制检查失败，包括无关既有问题导致的失败 | 返回 blocked，说明失败范围与原因，不声称检查通过或绕过门禁 |
| 与本次无关且不影响强制门禁的既有问题 | 记录影响与证据，不自动扩大修复范围；不单独阻断本次 action |
| 当前需求、源码和测试可解决的疑问 | 自行核实，不转交常规工程判断 |
| 证据无法解决且需用户决定的实质产品歧义 | 明确受阻部分并请求具体决定，其他独立工作继续 |

返回 ready 或 blocked，以及 documents_checked / documents_updated。集中说明 action、实际变化、产品与技术核对依据、相关验证和剩余问题；无需逐页填写“不适用”。ready 只覆盖本次 action 或阶段，部分交付不代表整个目标完成，文档 diff 不证明语义准确。

强制检查与授权不因证据复用或无关问题分类而削弱。不使用 --no-verify，不增加原任务以外的提交、推送或对外发送授权；过度设计检查按根规则触发。
