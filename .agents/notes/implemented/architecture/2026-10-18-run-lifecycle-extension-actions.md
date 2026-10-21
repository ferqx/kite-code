# Agent Note: Run 生命周期通过普通扩展 Action 承载业务

Status: implemented

## Problem

新会话需要 AI 生成的可读标题，模型不可用或首轮失败时取首条原文前10个Unicode码点。前一版将标题用途放入 Core Model、恢复、公开 DTO 和客户端过滤；同一业务规则分散在多层，扩展无法完整承担它。用户明确要求先加强 Agent 扩展能力，再由扩展实现命名。后续补充要求规避消息中的连续空行或空格，原文兜底因此允许仅规整空白，不提取或改写主题。

本决定统一保存此前未提交命名方案仍适用的需求与取舍，取代其 metadata Model、用途字段及专用恢复／展示机制。原文兜底、10码点上限、手动名称保护及原始模型证据的要求继续适用；前一版未提交的重复记录已合并移除。

旧 SQLite 在首条用户消息事务中截取120字符并改名；Native 曾把“新对话”保存为明确名称，CLI 曾提前保存正文截断。这些路径让标题业务散落在存储和客户端。客户端改为保存空 title 标记、单独显示占位，自动命名只由扩展承担。

## Decision

全局注册的 Extension 通过纯 `lifecycle.beforeRun/beforeRunComplete` 分别在显式 run.start/input.follow_up 的启动前和正常完成前按注册顺序选择自身已注册 Action。内部 child.start 激活与自动 job.report 不进入这两个业务阶段，防止 Action 创建的 child 从完成钩子递归调度自身；这些 Run 的通用 start/end 观察仍存在。Core 只提供冻结的真实事件、稳定 Command ID 去重，并通过原受管 Action carrier 执行；没有命名开关或模型用途分支。启动前 Action 在模型解析前完成，因此配置缺失也可保存兜底；完成前 Action 在原 Run 最后 CAS 前等待，CLI 读取终态后退出不会抢先取消命名。最终 CAS 的输入／义务核对继续独立执行。

SQLite 消息写入不再推导标题或隐式增加控制修订；首条消息自动改名的旧 helper 已删除。未装配命名扩展时，普通 Store 写入保持原标题，只有显式 rename 命令能改名。

命名扩展用首个 Action 保存原文规整空白后的10码点及自有 namespace marker；完成前 Action 先把 attempted 写入 marker，再通过已有 `operations.ensure(agent)` 创建无工具内部子会话。实际 Model、输入／输出／用量、资源槽、权限、取消和恢复事实沿既有 Agent 执行，不在 Service 或扩展外另调 Provider。Service 只注入读取／rename 端口及原轮选定模型 ID 当前配置的模型绑定。标题专用副本去掉首尾空白，把连续空白合并为一个空格后，分别截取10码点兜底或8192码点命名输入；保留其余原文，不构造整份规整副本。全为空白时保存“新会话”且不调用命名模型。仅向命名模型提供该有界前段作为不可信 user 数据，不携带整个项目来源或工具资格，主模型输入与原消息历史保持不变。

普通扩展子 Agent 增加显式 `resultDelivery:caller`：真实结果交由调用扩展消费，不自动投递下一主模型；成功、失败和取消状态保持，复用原 delivery suppressed／caller_owned。该选项封存于原命令并参与幂等冲突，Host 和 Store 都拒绝非 Agent、必要结果义务和 after-turn 报告等矛盾组合。省略字段保持原自动投递。

标题输出保存在内部子会话，扩展验证单行、可读且不超过10码点后，复用原主体和 Session revision CAS 改名。可重试模型错误在这个业务 adapter 中终止一次命名请求，不改 Core 的普通重试合同；10秒发起准确取消，收尾核实原 child 状态，未知保持 unknown。主业务结果独立于普通生命周期 Action 的失败；历史读取和后续输入不会补发标题请求。

公开回调已按用户后续要求统一为 Extension.lifecycle 的 beforeRun/beforeRunComplete，不再依赖传入 phase 分支；原 before_start/before_complete 仍只作为持久命令 key，保证旧操作的 Command ID 与幂等关系不变。通用 onRunStart/onRunEnd、onModelStart/onModelEnd 只读事件与平铺执行规则见[生命周期观察决定](2026-10-18-settled-lifecycle-observers.md)。

2026-10-19，用户明确确认待澄清首输入仍保留原文标题兜底。可信宿主的 sessionInputMetadata 在真实 public/raw 耐久保存后、解释 revision 捕获前，只沿本会话 rename CAS 保存兜底；它不调度 Action、Tool、Job 或 Model，也不选择工作。原始主体、Store、Session、observed revision 0、空 selection/历史及准确保留注册事件均须可核；手动改名和事件缺口拒绝推断，同一 metadata Command 去重。实际业务随后沿 public/raw/decision/business 回执确认同一原文，由原启动 Action 补 marker，AI 仍只在业务正常完成前经原受管 child 执行。原 processing guard、两业务钩子范围和只读 on* 均保持，Core 不包含标题规则、公开用途字段或专用恢复格式。

## Alternatives considered

- 将首输入一概作为业务、放开解释轮通用 Action，或等到业务准入后才保存标题：前两者会给未决输入业务效果，后者违背用户确认的原文兜底承诺。选择可信宿主的有限本会话元数据接点，复用原 rename CAS；AI 资格仍须真实业务证明，元数据不成为执行许可。

- 仅截取首条正文：不满足正常情况下由 AI 概括主题的要求；提取自然语言主题作兜底也不符合用户明确要求的原文截断；后续只规整连续空白的要求不授予主题改写。原文只作为等待或失败时的例外，成功结果仍须是可读的简短名称。
- 将模型命名放在原任务首次模型请求前：会延迟原任务首次回复，因此启动前只保存本地原文兜底，AI 请求留在首次任务完成前。

- 保留标题专用 metadata Model：能在父 Run 内隔离 Message，但造成 Core、存储恢复、HTTP 生成物及 TUI 的同一业务分支。用户要求扩展承担业务，故移除这些专用机制。
- 仅增加裸 `onRun` 回调并直接调用模型：代码短，但没有实际 carrier、统一资源和精确取消证据；现有 `operations` 又要求真实 Tool／Job 父执行，不能凭空构造上下文。
- 复用 completion governance：它负责必要义务和 mutation 完成指导，标题并不属于这些义务；强行加入会改变主模型任务和完成条件。
- 新建专用生命周期执行类型：会再增加持久类型和恢复分支。选择普通 Action 和已有内部 child，缺少的仅是通用通知与调用者结果交付方式。
- 完成落库后异步命名：配套 CLI 在读到终态后会关闭 Service，容易取消尚未完成的命名；选择最后完成 CAS 前等待。

## Consequences

正常新会话增加一次受管子模型请求和两次普通生命周期 Action，不新增数据库表、公开 HTTP schema 或客户端用途字段。原 Chat 的正文、上下文、最终答案读取及恢复主模型选择保持原有接口。内部子执行仍是真实历史事实；不能把它们当作不存在，也不能把取消受理当作已停止。

这是当前需求所用的两个全局生命周期边界，不承诺任意阶段或用户配置可注册执行钩子。业务扩展失败可能保留原 unknown 事实，不能凭 fallback 标题宣称资源已经收尾。标题语义质量仍受模型影响，规则校验只能拒绝部分不可读结果；模型命名失败时的原文例外来自用户明确要求。

当前实现与合同归[Agent owner](../../../../packages/agent/README.md#入口与职责)、[Service owner](../../../../apps/service/README.md#默认装配与业务规则归属)及[会话手册](../../../../docs/handbook/features/sessions.md#自动命名)。

## Verification

2026-10-18，本机 macOS／Bun 1.4.2，真实 SQLite 的[生命周期测试](../../../../packages/agent/test/isolated/execution/run-lifecycle.test.ts)、[caller 交付测试](../../../../packages/agent/test/isolated/child/result-delivery.test.ts)和[命名集成](../../../../packages/agent/test/isolated/execution/session-title-generation.test.ts)覆盖模型不可用前的 Action、稳定去重、完成 CAS 重试、父上下文隔离、实际 Provider 重试错误、手动改名竞争及取消。连续空白回归另核超过8192字符的前导空白不挤掉主题、全空白兜底零命名模型，以及原消息／主模型输入完整保留。[Store 标题测试](../../../../packages/agent/test/isolated/storage/session-titles.test.ts)另外核实消息写入不再隐式命名，手动改名及跨 Worker 保存仍保持。使用[本机模拟 HTTP](../../../../apps/service/test/isolated/session-title.test.ts)与[真实 CLI argv](../../../../apps/cli/test/isolated/host.test.ts)核所选模型／参数和完整17MiB原回复；不代替付费 Provider 或安装制品资格。

既有 child Runtime 的排队取消测试在原始 HEAD 与本次工作树均出现同一等待超时，未纳入本次通过声明；本次调用者交付、标题取消和通用生命周期测试独立核实。
