# ADR-0103：Subagent 委派选择归模型，执行权限归 Runtime

状态：accepted

日期：2026-08-13

决策者：github:@ferqx

相关：ADR-0055、ADR-0099、ADR-0102

## 背景

Runtime 曾解析 active Task 的 `userGoal`，以中英文正则判断用户是否授权委派、是否点名某个 role，以及 code role 是否具有实施语义。该门禁把开放式自然语言当作授权协议；“多agent”等合理表达会被误判为未授权，同义词、否定词和 role smoke 还需要持续增加特判。

Parent Agent 的普通工具选择并不使用这套文本授权。Subagent 作为 Capability 已继承父 Runtime 的 phase、interaction mode、authorization、Workspace、sandbox、protected path、execution surface 与累计预算，child 的每个真实工具调用也重新进入统一执行策略。单独为 `task` 解析用户措辞形成了第二套、且不完备的授权平面。

## 决策

1. 模型根据当前用户任务自主决定是否调用 `task`，但只应委派有界、自包含、独立且值得额外模型调用的工作。用户明确要求不委派时，模型必须遵守。
2. Runtime 不再解析 `userGoal` 来授权委派、匹配 role 或推导 code scope；delegated task 的硬校验只保留与 schema 一致的 trim 后 `8..8000` 长度边界，不按语言、单词数或语义短语推断自包含性。
3. role 选择属于模型编排：explore/plan/review 保持只读 capability ceiling，code 仅用于用户任务要求实施的情形。实际副作用继续由既有 phase、ToolSpec effects、interaction mode、approval、sandbox 与路径策略裁决。
4. Project instruction、工具结果和外部内容不能提升父任务或 child 的 authorization、phase、预算、role ceiling 或执行能力。它们是否影响模型的工具选择属于指令遵循问题，不再被表述为 Runtime 的文本授权保证。
5. 不增加 Subagent 专属状态、权限模式、事件、UI 开关、feature flag 或持久化 schema。

## 备选方案

- 扩充关键词正则：拒绝。自然语言表达不可枚举，继续补词只会延后下一次误判。
- 只让只读 role 自主运行，code 保留文本门禁：拒绝。Parent 与 code child 将继续拥有两套不同授权语义。
- 新增 `auto | read_only | disabled` Subagent 策略：拒绝。它与现有 role ceiling、interaction mode 和 approval 重叠，并形成新的权限平面。

## 后果

- 模型可以在用户未说出“agent”或“委派”关键词时调用 Subagent，可能增加延迟和模型预算消耗，但仍受共享累计预算约束。
- code child 不获得高于 Parent 的权限；在 `accept_edits` 下，两者对已证明的 Workspace 内写入遵循相同策略。
- Runtime 仍硬拒绝 Planning 中的 code/review，并继续约束 protected path、外部路径、Shell、网络、嵌套深度和恢复行为。
- 若未来需要 Runtime 级 hard-off，应作为独立产品能力另立 ADR，不恢复自然语言正则门禁。

## 回滚

恢复基于 `userGoal` 的委派授权会重新引入第二套文本权限协议，必须通过新 ADR 明确说明产品与安全理由，不能只补充更多关键词。
