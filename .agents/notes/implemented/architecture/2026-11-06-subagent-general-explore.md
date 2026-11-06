# Agent Note: 通用与探索子角色及冻结历史配置恢复

Status: implemented

## Problem

默认 `worker/code` 与 `explore/plan/review` 的任务职责存在重叠，父 Agent 可以通过任务正文表达实现、规划和审查要求；五个角色未形成五套必要的执行机制。原探索工具集合又缺少向父发送消息、等待答复、停止自身 Shell、核已有执行证据及读取网页的能力，限制了正常调查与异常收束。

直接把默认目录改成两个名字会同时改变旧根模型的工具 schema、旧 child 的配置身份和角色工具集合。旧 Run／carrier 已封存 Model、工具和只读 Source，冷恢复、同一协作者续作及结果通知需要使用这些原事实；把它们解释为今天的默认角色会造成身份不符、工具扩张或错误地补造指导。只改快照而继续使用进程全局的新 Task factory，也不能使实际工具定义与原历史一致。

## Decision

用户确认新默认角色只保留 `general`、`explore`。`spawn_agent` 沿用 `prompt/task_name/preset`，省略与显式 `general` 等价，新默认 schema 不接受旧角色别名。父任务正文表达准确职责、一次性效果与 fallback；默认共享工作区，不新增任务模板、fresh／fork 参数或独立 worktree。工具、角色及持久格式版本保持原值。

`general` 使用父当前选中集合，根专属创建、邮箱等待观察与 `ask_user` 不向 child 模型开放。`explore` 保留原只读绑定，并在父集合内补入准确 `task.message@1`、`shell.stop@1`、`execution_evidence.read@1`、`web_fetch@1`，不补协作者列表、追问或中断工具；准确 Extension owner、ID、版本及当前注册继续参与交集。Skills 和 MCP 继承策略不因角色合并扩大。

后续用户确认子 Agent 发送消息只需原发送工具的成功回执，不再提供等待来信的工具；主 Agent 仍需等待子任务事件。此前验收提示中的2000ms等待是显式测试步骤，不是发送协议。准确内置 `task.events@1` 在真实 child 模型目录与新调用入口受限，已保存静态绑定和历史原文保持，避免直接删除冻结工具导致恢复身份不符；通用 Extension 邮箱接口不因此收窄。发送成功仅证明消息入队，不证明父级已读或处理；确需决定的 child 交回完整问题和已完成／未完成事实，父级随后沿原协作者续作。这个取舍减少无用等待，并放弃子 Agent 自行挂起等来信的交互方式，不增加父级新义务或自动等待状态。

原 Model 已完成而工具尚未执行的冷恢复另有完整目录比较；只保留静态工具ID不足以跨过本次目录和说明变化。恢复仅为可信原请求重建两项已知历史事实：准确内置消息工具的旧完整说明、child 原有的准确事件工具声明，再执行整目录全等比较。原Model请求、Source、快照及指纹不改写；其他owner、版本、schema或说明变化仍拒绝，下一新Model与Host继续使用新边界。新旧文案只在内部单一常量文件维护，不增加通用迁移框架、公开参数、持久格式或版本。真实SIGKILL回归核原Model不重跑、原审批和工具ID复用、效果一次，以及无关漂移零效果拒绝。

保留[只读任务指导与继承权限决定](2026-11-03-readonly-task-role-permission-inheritance.md)的核心理由：任务职责、工具集合、审批判定与 OS 执行范围是不同边界。只读仍是可信任务提示和工具收缩，不重新建立 Shell 命令白名单、跨模式角色语义审核器或角色专属 OS 禁写／禁网层。Shell 沿父当前模式、父子权限交集及原平台沙箱；Full 不提供角色禁写保证。有限 safeRead 只证明普通免审事实，不能替代实际任务授权、工具范围、硬拒绝或保护资源。旧记录中的五角色分工由本决定收束；其提示词与 Shell 继承理由继续适用。

历史支持限于原生产修订可核对的目录和快照。[Service 历史目录](../../../../apps/service/src/task-history.ts)只为原 root 重建原角色目录与 Task schema；Runtime 在恢复或原协作者续作时重读真实 carrier，核 Store、Session、直接父子与根关系，再向 Service 提供冻结原配置。旧 child 保持原 role／Model、工具集合和 Source 正文，旧 `explore` 不获新增工具，旧 Source 缺字段保持缺失；无法重建明确失败，不改用新默认、其他模型或较宽目录，也不重跑原工作。旧角色身份可恢复不等于恢复旧审批，当前 mode、trust、allowlist 与定义资格仍须成立。原只读决定记录的外层角色封套恢复缺口由本路径处理，其当时未取得的资格仍按历史范围保留，不反写成旧测试已经证明完整恢复。

可信 `RunConfiguration.extensionOverrides` 把重建的 Task factory 绑定到原 Run：只能替换已注册同 owner ID、版本及 API major 的 Extension，保留全局顺序，拒绝新 owner、重复和版本冲突。它不是模型或公开 Command 参数，不改写进程全局声明。Model、step、child、报告与恢复都使用实际替换对象；权限描述器也绑定实际 Run Task Extension 对象。父子 Tool／Job 的完整定义身份比较保持，不能因 owner／版本相同就容许不同 schema、description 或资源范围。

原协作者的明确 follow-up 是同一 child Session 中的新轮，MCP lineage 须按真实新父 Run／Execution 重新派生；配置比较仅对该场景排除顶层 `inheritance`，server、scope、scopeDigest、selection 和 readSet 仍必须相等。实际 Source 与执行继续核完整持久因果和原 carrier；冷恢复原轮不使用此例外。

真实 Desktop 的跨父轮续作暴露了恢复目的的另一项区别：根 command 的临时 reasoning effort 属于该根轮，不属于子 Model 的配置 preset。恢复分支不能因为同时承担 child follow-up，就把当前父 command 的临时 effort 写进原 child；首次 child、恢复和续作均保配置 preset 或原缺省。根恢复仅在有可信原根 Run 身份时重现根 command effort，不修改父 command 来凑原 digest，也不放宽配置比较。真实失败历史保留，修复后复用原 child 成功续作；loopback HTTP 回归覆盖子 preset 缺省与 `high`、父 `low`，并核根临时 effort 的原恢复行为保持。

[普通委派仅一层的决定](../bug-fix/2026-11-05-single-level-agent-delegation.md)继续完整适用。模型目录隐藏与 Host 原新建入口分别限制再委派；静态注册、同名工具、历史恢复和 Full 均不扩大层级。直接协作者管理、普通 Tool→Job、原回执优先、取消与未知效果边界保持。

## Alternatives considered

- 保留五个默认角色：未解决职责重叠和探索工具缺口；规划与审查要求可以准确写入通用任务正文。
- 只保留提示词而取消工具收缩：保留与探索任务无关的直接写入与管理面，不符合已确认的探索角色边界。
- 为只读增加所有模式下的硬禁写、命令白名单或独立 OS 上限：混淆任务语义、免审分类和进程能力，改变 Full 的含义；用户选择保留继承权限和普通 Shell 链。
- 将旧角色映射到 `general/explore` 或按新目录重建：改变原 role、工具 schema、Source 或可用工具，损害冻结历史与继续能力。
- 只恢复旧 snapshot、不替换实际 Run factory：实际工具仍来自进程全局新注册，原完整父子定义比较会正确拒绝；不能靠放宽 schema／description 比较消除该冲突。
- 建通用历史插件注册器或递增协议版本：本次只需有限旧生产目录及同 owner／版本的可信 Run 绑定，未授权扩展为新兼容系统或版本升级。
- 同时增加 fork、自动 worktree 或任务模板：不属于本次确认范围，也不是完成角色收束与历史连续性的必要前置。

## Consequences

当前产品行为归[执行手册](../../../../docs/handbook/features/execution.md)和[工具授权手册](../../../../docs/handbook/features/tools-and-approvals.md)，职责与准确工具集合归[Task owner](../../../../packages/agent/src/extensions/task/README.md)、[Service owner](../../../../apps/service/README.md)和[权限 owner](../../../../packages/agent/src/permissions/README.md)。本记录解释取舍，不构成另一份角色目录或权限 authority。

[历史角色回归](../../../../apps/service/test/isolated/task-role-history.test.ts)使用固定原生产修订夹具，核旧根 schema、五类历史协作者续作、原配置与工具保持、实际读取、当前父工具收紧、未知角色／版本和损坏 Source 拒绝，以及 SIGKILL 后原执行组恢复与准确重试。[Run override 独立回归](../../../../packages/agent/test/isolated/execution/run-extension-overrides.test.ts)核真实 Runtime／SQLite／固定 Model 的实际 schema 与效果、step 选择、全局声明不变、错误 owner／重复／版本拒绝和子 schema 越父零效果。[默认角色](../../../../apps/service/test/isolated/default-task-roles.test.ts)与[只读指导](../../../../apps/service/test/isolated/child-readonly-guidance.test.ts)继续核新目录和实际模型输入。

这些受控断言不保证真实模型始终遵守只读任务，也不证明完整客户端体验或全部平台发布资格。最终命令、环境、结果和普通客户端全过程观察由本次负责文档保留；Shell 的原生权限、未知效果、恢复与发布限制沿各自 owner 继续生效，不因角色收束或历史样本通过放宽。
