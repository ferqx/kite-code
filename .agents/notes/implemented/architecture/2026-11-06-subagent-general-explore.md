# Agent Note: 通用与探索子角色及冻结历史配置恢复

Status: implemented

2026-11-06 用户明确不考虑升级前旧执行数据兼容；[清理历史兼容的决定](../simplification/2026-11-06-remove-subagent-history-compatibility.md)部分替代本文的旧角色目录重建、旧工具声明转换和每 Run 扩展替换。两角色语义、当前配置的冻结校验、消息、权限及同身份续作理由继续适用。

## Problem

默认 `worker/code` 与 `explore/plan/review` 的任务职责存在重叠，父 Agent 可以通过任务正文表达实现、规划和审查要求；五个角色未形成五套必要的执行机制。原探索工具集合又缺少向父发送消息、等待答复、停止自身 Shell、核已有执行证据及读取网页的能力，限制了正常调查与异常收束。

实施初期曾要求保留旧目录：角色收束同时改变旧根模型的工具 schema、旧 child 的配置身份和角色工具集合，不能把原 Run／carrier 的 Model、工具和只读 Source 直接解释为新的默认角色。只改快照而继续使用进程全局的新 Task factory，也不能使实际工具定义与原历史一致。这是当时增加有限兼容的理由；用户随后撤销旧执行数据兼容要求，当前边界按上方清理决定执行。

## Decision

用户确认新默认角色只保留 `general`、`explore`。`spawn_agent` 沿用 `prompt/task_name/preset`，省略与显式 `general` 等价，新默认 schema 不接受旧角色别名。父任务正文表达准确职责、一次性效果与 fallback；默认共享工作区，不新增任务模板、fresh／fork 参数或独立 worktree。工具、角色及持久格式版本保持原值。

`general` 使用父当前选中集合，根专属创建、邮箱等待观察与 `ask_user` 不向 child 模型开放。`explore` 保留原只读绑定，并在父集合内补入准确 `task.message@1`、`shell.stop@1`、`execution_evidence.read@1`、`web_fetch@1`，不补协作者列表、追问或中断工具；准确 Extension owner、ID、版本及当前注册继续参与交集。Skills 和 MCP 继承策略不因角色合并扩大。

后续用户确认子 Agent 发送消息只需原发送工具的成功回执，不再提供等待来信的工具；主 Agent 仍需等待子任务事件。此前验收提示中的2000ms等待是显式测试步骤，不是发送协议。准确内置 `task.events@1` 在真实 child 模型目录与新调用入口受限，当前 Explore 只读表也不再保留该绑定；通用 Extension 邮箱接口不因此收窄。发送成功仅证明消息入队，不证明父级已读或处理；确需决定的 child 交回完整问题和已完成／未完成事实，父级随后沿原协作者续作。这个取舍减少无用等待，并放弃子 Agent 自行挂起等来信的交互方式，不增加父级新义务或自动等待状态。

原 Model 已完成而工具尚未执行的冷恢复保留完整目录比较，原 Model 请求、Source、快照及指纹不改写。早期为旧消息说明及旧 child 等待工具重建等价声明的转换已移除；当前定义不一致直接拒绝。真实 SIGKILL 回归改为核当前同版本的原 Model 不重跑、原审批和工具 ID 复用、效果一次，以及无关漂移零效果拒绝。

保留[只读任务指导与继承权限决定](2026-11-03-readonly-task-role-permission-inheritance.md)的核心理由：任务职责、工具集合、审批判定与 OS 执行范围是不同边界。只读仍是可信任务提示和工具收缩，不重新建立 Shell 命令白名单、跨模式角色语义审核器或角色专属 OS 禁写／禁网层。Shell 沿父当前模式、父子权限交集及原平台沙箱；Full 不提供角色禁写保证。有限 safeRead 只证明普通免审事实，不能替代实际任务授权、工具范围、硬拒绝或保护资源。旧记录中的五角色分工由本决定收束；其提示词与 Shell 继承理由继续适用。

早期有限兼容只支持固定原生产修订，使用旧角色目录重建和可信每 Run Task factory 替换，使实际声明与原快照一致；父子完整定义比较不能因 owner／版本相同而跳过 schema、description 或资源范围。该实现、冻结 producer 及当时回归通过的事实保存在[整合前代码](https://github.com/ferqx/kite-code/commit/4e9024f6fbc69d9583821b1f71830f96d68bf571)，当前已取消这一兼容要求并删除专用路径。Runtime 仍在当前配置恢复和同身份续作时重读真实 carrier，核 Store、Session、直接父子、根关系及原 Model／工具／Source；当前 mode、trust、allowlist 与完整定义资格继续成立。

原协作者的明确 follow-up 是同一 child Session 中的新轮，MCP lineage 须按真实新父 Run／Execution 重新派生；配置比较仅对该场景排除顶层 `inheritance`，server、scope、scopeDigest、selection 和 readSet 仍必须相等。实际 Source 与执行继续核完整持久因果和原 carrier；冷恢复原轮不使用此例外。

真实 Desktop 的跨父轮续作暴露了恢复目的的另一项区别：根 command 的临时 reasoning effort 属于该根轮，不属于子 Model 的配置 preset。恢复分支不能因为同时承担 child follow-up，就把当前父 command 的临时 effort 写进原 child；首次 child、恢复和续作均保配置 preset 或原缺省。根恢复仅在有可信原根 Run 身份时重现根 command effort，不修改父 command 来凑原 digest，也不放宽配置比较。真实失败历史保留，修复后复用原 child 成功续作；loopback HTTP 回归覆盖子 preset 缺省与 `high`、父 `low`，并核根临时 effort 的原恢复行为保持。

[普通委派仅一层的决定](../bug-fix/2026-11-05-single-level-agent-delegation.md)继续完整适用。模型目录隐藏与 Host 原新建入口分别限制再委派；静态注册、同名工具、历史恢复和 Full 均不扩大层级。直接协作者管理、普通 Tool→Job、原回执优先、取消与未知效果边界保持。

## Alternatives considered

- 保留五个默认角色：未解决职责重叠和探索工具缺口；规划与审查要求可以准确写入通用任务正文。
- 只保留提示词而取消工具收缩：保留与探索任务无关的直接写入与管理面，不符合已确认的探索角色边界。
- 为只读增加所有模式下的硬禁写、命令白名单或独立 OS 上限：混淆任务语义、免审分类和进程能力，改变 Full 的含义；用户选择保留继承权限和普通 Shell 链。
- 将旧角色映射到 `general/explore` 或按新目录重建：改变原 role、工具 schema、Source 或可用工具，损害冻结历史与继续能力。
- 只恢复旧 snapshot、不替换实际 Run factory：实际工具仍来自进程全局新注册，原完整父子定义比较会正确拒绝；不能靠放宽 schema／description 比较消除该冲突。
- 建通用历史插件注册器或递增协议版本：实施初期只为有限旧生产目录增加可信 Run 绑定，未扩展为通用兼容系统或升级版本；后续用户明确不要旧数据兼容，有限实现也一并移除。
- 同时增加 fork、自动 worktree 或任务模板：不属于本次确认范围，也不是完成角色收束与历史连续性的必要前置。

## Consequences

当前产品行为归[执行手册](../../../../docs/handbook/features/execution.md)和[工具授权手册](../../../../docs/handbook/features/tools-and-approvals.md)，职责与准确工具集合归[Task owner](../../../../packages/agent/src/extensions/task/README.md)、[Service owner](../../../../apps/service/README.md)和[权限 owner](../../../../packages/agent/src/permissions/README.md)。本记录解释取舍，不构成另一份角色目录或权限 authority。

[默认角色](../../../../apps/service/test/isolated/default-task-roles.test.ts)与[只读指导](../../../../apps/service/test/isolated/child-readonly-guidance.test.ts)继续核当前目录和实际模型输入。[当前 Task 冷恢复](../../../../packages/agent/test/isolated/recovery/child-message-resume.test.ts)核真实终止后的原身份、审批与唯一效果；旧生产者和扩展替换的专用回归随兼容实现删除，不再作为当前资格。

这些受控断言不保证真实模型始终遵守只读任务，也不证明完整客户端体验或全部平台发布资格。最终命令、环境、结果和普通客户端全过程观察由本次负责文档保留；Shell 的原生权限、未知效果、恢复与发布限制沿各自 owner 继续生效，不因角色收束或历史样本通过放宽。
