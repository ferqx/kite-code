# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test packages/agent/test/isolated/permissions/policy.test.ts apps/service/test/isolated/shell-configuration.test.ts apps/service/test/isolated/web-permissions.test.ts packages/agent/test/isolated/execution/authorization-check.test.ts`；旧 Kernel/SAQ 对应验证继续保留 `bun test packages/agent-kernel/test packages/builtin-runtime/test packages/runtime-host/test tests/runtime tests/policies`

相关：[Agent Note 0118](../../.agents/notes/implemented/feature/2026-08-18-trusted-workspace-unrestricted-file-access.md)、[Agent Note 0119](../../.agents/notes/implemented/bug-fix/2026-08-18-acknowledged-host-shell-availability-fallback.md)、[Agent Note 0131](../../.agents/notes/implemented/simplification/2026-08-24-whole-workspace-sandbox-admission.md)、[Agent Note 0132](../../.agents/notes/implemented/feature/2026-08-24-sensitive-external-paths-use-exact-approval.md)、[Agent Note 0133](../../.agents/notes/implemented/feature/2026-08-24-mode-aware-sensitive-external-authorization.md)、[Agent Note 0137](../../.agents/notes/implemented/bug-fix/2026-08-25-shell-sandbox-durable-approval-queue.md)、[Agent Note 0138](../../.agents/notes/implemented/simplification/2026-08-25-silent-session-format-compatibility.md)、[Agent Note 0189](../../.agents/notes/implemented/bug-fix/2026-09-17-auto-review-uncertain-shell.md)、
`tool-gated-autonomy.md`、`cancel-resume-cleanup.md`、`plan-mode-implementation.md`。

2026-10-26 已按用户要求删除除 `apps/kite-cli` 外的旧架构模块。当前实现由[现行 workspace 边界](unified-agent-boundary.md)及各现行 owner 定义；本文指向删除前固定 revision 的源码、旧模块机制和旧测试仅供历史追溯，不再是可运行入口。仍适用的授权、未知结果、恢复、数据保护与发布资格约束继续生效，删除源码不表示这些门禁已经通过。

## 当前 V1.3 正式授权

三策略与 Shell 命令分析由 [Agent 独立权限模块](../../packages/agent/src/permissions/README.md)负责，正式宿主通过 `@kite-ai/agent/permissions` 与 `/permissions/shell` 装配。Service 保留接口、身份核对和当前宿主事实读取，不解释 Shell AST、签发命令摘要或实现模式分支；执行接纳、真实审核与最终控制 revision 复核仍归原 Core。模块与解析依赖 owner 的迁移不改变已有审批、恢复或系统沙箱合同。

计划业务人答和 Tool 权限分别满足。`/plan` 或 Planning 显式 review 在三模式均要原准确计划的人答，不选择 mode 或派生权限 ceiling；答复期间单纯模式切换不替换原卡或重答，信息接纳保原 stamp 并独立核当前控制 CAS。工具 owner 可在资源前沿原 approval once 声明单次执行确认，仅消费准确当前调用及已冻结封闭内部 Job 的普通挑战；每一策略参与方须明确支持，硬拒绝、当前能力与信任、来源、父子上限、取消和最终 SQL 仍核验。信息 receipt 不得转换成该证明；准确步骤一次消费、不跨 Run／兄弟复用，持资源时不等人。负责合同与最终验证归[权限 owner](../../packages/agent/src/permissions/README.md)、[Interaction owner](../../packages/agent/src/storage/sqlite/interactions/README.md)和[Planning owner](../../packages/agent/src/business/planning/README.md)。

能力身份以真实注册的 kind／定义／版本为准，Service 在同一注册项绑定所属描述器；普通权限和 Planning 共用路由，Model 使用静态描述，不向 Shell／Files／Task 广播请求。动态事实若改写身份则失败关闭，不能通过合并顺序覆盖另一能力的效果或硬限制。注册描述只提供事实，审批决定、工具交集与最终派发证明保持独立；具体装配及分支回归归[Service owner](../../apps/service/README.md#默认装配与业务规则归属)。

能力描述可接收本次已经读取、校验的 policy 隔离副本，不能修改原授权判定，也不凭宿主根偏好重新推断模式。有效 Full 允许原 Files 工具直接写入／编辑普通外部绝对文件，但执行仍须核最终证明中所有实际父子权限叶与独立 Planning 业务门禁、准确能力与目标 revision；Full 不覆盖 trust、工具集合、硬限制或 Profile／运行资产保护。会话 Output／Plan／Input 的准确私有边界优先于通用外部适配，普通外部文件不纳入 Workspace checkpoint。原生 CAS、取消、发布未知与禁止重放合同保持，具体能力和验证范围归[权限 owner](../../packages/agent/src/permissions/README.md)与[Service 装配](../../apps/service/README.md#默认装配与业务规则归属)。

Shell 只读证明按固定 rg 的实际参数取值消费，执行 hooks、外部解压及未知参数不能借 safeRead 绕过普通审核。该分类不再充当只读子角色的调用门禁。当前默认 explore 的只读要求作为冻结的可信任务指导传给子模型；Shell 继承父会话当前审批策略、权限交集和普通 OS 范围，不增加专属逐项语义审核或 OS 禁写／禁网上限。Full 下角色只读是任务约束，不是后端禁写保证；主会话 Planning 业务门禁仍独立。准确命令授权区分无截止时限与显式期限，同名 Model 不参与 Shell 描述。源码与回归归[权限 owner](../../packages/agent/src/permissions/README.md)。

正式 Service/Client 经唯一 Agent 的原权限、人工/模型交互和最终 dispatch 事务执行。界面三策略为 `accept_edits` 请求批准、`auto` 自动审核、`full` 完全访问；正式类型、HTTP/IPC、持久控制和调用者均已退役 raw `ask`，旧输入/控制记录失败关闭，不映射为其他模式。正式 Shell 的范围请求与 `web_fetch` network 描述均经该链，固定危险拒绝先于所有模式；Scope 来自可信宿主描述与最终接纳快照，调用输入不能签发 grant。原审核拒绝原因由公共 Execution 的 `authorization.check`与 Tool `result.details.reason` 保存，TUI 结果读取和 Native 原回执可展示，私有适配器错误正文不进入该 reason。实际产品、owner 与验证归[手册](../handbook/features/tools-and-approvals.md)、[Service](../../apps/service/README.md#默认-shell-装配)与[Jobs owner](../../packages/agent/src/jobs/README.md)。

新默认 Auto 将 Shell 执行事实、模型风险分类和权限决定分开：Shell owner 提供有限语法事实和受限直接入口快照；审核模型输出 ordinary／high／critical 与短理由；Shell 工具自身的可信解释器映射为 approve_once／ask_user／reject，并保原风险 JSON 与派生决定。模型不接收业务任务授权材料，不能通过风险分类扩张真实范围。Shell 网络仍仅 none／internet、文件仍仅 workspace_write／full_access，不产生按主机或路径的新范围。

默认 Shell 风险行为与实际 Tool／Job 对象及准确 kind／id／version 在可信宿主登记，其他工具只能使用自身已登记行为；普通 Extension／MCP 元数据和配置文本不能注册。Run 冻结实际 reviewer preset、预算、checker 与行为 contractRef／configurationDigest。新版恢复缺失或无法重建时明确失败，不推断旧 Run 缺省；完整结果只读原封存回执，不调用当前解释器或 Provider。工具行为的 prepareReview／interpretReview 负责领域材料与映射，Core 不按工具名选择算法；check.behavior 由策略明确选择，混合独立检查不能借 Shell 解释器替代。

默认 Shell 风险审核采用独立 low reasoning preset，不发送输出 token 上限。默认总期限 8000 毫秒，覆盖同操作等待、准备、队列与 Provider，由 `autoApproval.timeoutMs` 配置。超时保存 `authorization_check_timeout`，原 Shell 无派发、无人工卡，业务模型收到该次未执行的结果。任一参与策略要求停止时，组合策略也停止。SQLite 按原检查截止时间拒绝迟到的完整决定，也拒绝该检查签发、继承或通过人工消费超时执行依据。模型传输、空输出、无效答案和提供商截断仍各自保存准确原因。

Windows 桌面选择 PowerShell 时，真实 AST 分析提供已知的写入、联网、委托和无法确认的效果。Auto 将准入通过且效果未明的调用交给同一 Shell 风险审核，只有 high 产生人工卡。请求批准和 Full 对这类调用继续要求准确的本次人工批准。审批绑定解释器与分析资产、命令、工作目录和独立文件／联网范围。已识别的系统委托在 Shell 准入时拒绝。派发复核当前身份及父子范围，实际监督和证据归 [Windows Shell 沙箱](windows-shell-sandbox.md)。

原审核终态绑定准确调用。新调用单独求当前权限，执行链检查硬拒绝、独立人工义务及当前派发证明。

Auto 复用沿既有 Command／policy evidence，不新增授权账本。已有许可及有效人工范围先处理，工具行为与策略显式声明允许覆盖默认检查时不再调用该 reviewer；未被满足的独立 checker／人工条件继续执行。有限 `pwd`／`ls`／bundled rg 的单命令或纯字面量 `&&` 链共用分类／可信重写，保持失败短路；未知语法回原审核。风险材料 fingerprint 与当前策略／范围共同绑定复用，脚本动态依赖不扩大跨调用资格。

[统一 v1 审核回执](../../packages/agent/src/authorization-check-output.ts)在完整 EOF、stop、零 ToolCall 后由实际可信解释器产生，保存原 ModelOutput／正文摘要和通用 answer。Worker 核原目标、attempt、inputDigest、封存输入、原 Run 行为和私有 owner 来源，只消费 answer，不执行领域回调；内联和 Artifact 使用同一逻辑合同。普通模型输出、ToolResult 或 Extension records 不能自报回执；缺失、错绑定、不完整和晚到结果不批准。准确父 Tool→自身 Job 通过 owner 提供的通用 parent proof 核原父链、输入与当前权限；只有真实完成的材料审核提供 materialReviewed，grant／timeout 及其继承不伪造此事实。

后续授权使用冻结 options／optionId、统一 GrantOffer 和稳定 reuseRevision。Shell 同命令、Files 精确位置 edit／write、worktree create 父目录直接子项及 remove 精确目标共用原接纳、grant、epoch 和最终派发事务。所有真实参与策略（含 already allowed）均须支持该能力／范围，AND 精确交集；缺支持只提供单次。来源完整 policy revision 保留，消费保存本次完整 revision 和准确 binding。范围／稳定绑定再次匹配可复用，clear 永久撤销原授权；隐藏选项不取消已有有效授权。资源取得后重新核当前事实，markDispatching 同事务核原选项、scopeDigest、消费 binding／许可位、epoch、控制与必要检查；SQL 不做领域 I/O。选择或复用范围授权后，worktree prepare 的固定 commit 或父锚点与批准范围失配时不启动 mutation，也不降级单次；原单次及 Auto 免审保持各自语义。

当前 Store formatMajor=1，使用本轮独立 reviewed baseline。profile.json 的 schemaChecksum 在打开 SQLite 前排除不匹配的历史结构，数据库仍独立核完整 schema/checksum；不转换、清空或改写原库。API 保持 `/v1` 并原位替换字段，不保留旧答案／旧回执 reader；Tool／Job 定义和 worktree worker 协议版本保持。具体消费及撤销合同归[grant owner](../../packages/agent/src/storage/sqlite/permission-grants.README.md)。

用户2026-10-29进一步确认：准确内置浏览器能力免自动审核和用户审批，不受三种模式的常规逐项审批分支影响。可信capability工厂及policy双重核固定builtin.browser@1定义，保真实effects和硬能力、页面／任务／租约／取消／unknown约束；Service／Workflow不把审批重新加回，也不把网络输入伪装只读。Native新任务正常释放控制并final，不装配人工等待／Continue；新消息新Run在VM准入前等原Job准确收口，只以真实acquire保留的私有pageId／incarnation重新绑定原页，URL不代替身份，新引用重新取得；同URL别页、身份替换或缺页不能作为替代。Main网页所有权独立于租约／任务，观察切换不关闭网页。旧拒绝、Question和unknown不转为新控制权，原安全事实和历史格式保留。

原任务身份由[resolveExecutionRun](../../packages/agent/src/execution/task-origin.ts)在Core统一沿有界、同Store／Session／RootWork／主体父链解析；嵌套Operation的runId保持真实null，通用审核上下文也可读取已验证的原任务，不再把直接runId缺失当作任务必然不可用。权限读取的任务／计划仍是证据，不是grant。

Tool 的失败、adapter 抛异常、人工／自动拒绝和 unknown 是原调用的结果，须先保存准确 Execution 与原 call ID 配对，再交给下一 Model 解释；Loop 不因这些结果或五次同参失败硬退出，不自动重试未知效果。人工 deny 保 `approval_denied` 并停止本批未开始后继，已开始调用须先清理；它不提交整 Run／Command 取消。明确用户取消仍停止，真实 Store／authority 故障和无法保存结果仍失败关闭。自动拒绝只作用于准确未派发目标的既有边界保持；[当前决定](../../.agents/notes/implemented/architecture/2026-10-29-tool-results-preserve-agent-loop.md)部分替代旧人工拒绝终止工作语义，历史证据不改写。

工具入口范围限制不能被解释为用户已经拒绝整个业务效果。准确内置 Files 的 `file_full_access_required` gate 回执可补充入口不可用说明，原错误码、原因、未派发事实与权限映射保持；其他工具的独立请求仍完整经过原审批，已有明确拒绝、unknown、父子权限／Planning 业务门禁及保护资源继续生效。该说明不构成执行许可，具体身份检查与回归归[权限 owner](../../packages/agent/src/permissions/README.md)。

策略硬拒绝的公开原因不仅保存在 `result.details.reason`，还须进入原 Tool 正文及下一模型请求；准确未启动的 Job／Action 同样保留拒因。只有 Core 确认未调用 adapter、未派发的分支才能声称未执行；已尝试 adapter 的私有异常正文不投影为公开拒因。等待人工时策略撤销使用同一公开拒因路径，原错误码、调用身份、派发和未知事实不改变。受控验证见[权限 owner](../../packages/agent/src/permissions/README.md)。

SQLite `finishRun` 只对准确 `run_id` 中已落定 Tool unknown 允许解释 Run completed，原 unknown、revision、引用与效果未被解决。同范围 Model／Job unknown 和活动执行继续阻完成；nested Job 的监督、permit／binding、关闭及恢复门禁不由回复状态解除。可信 `ToolContext.resourceCapacity` 仅是冻结总容量事实，不是当前空闲量或批准；统一 Browser 执行要求 process 至少 2，容量不足在代码／Browser Job 创建前准确失败。容量足够时审批、资源与原启动等待沿原 Job 边界，不叠加 5 秒超时，也不释放仍活许可绕过等待。

默认 `web_fetch` 的代理自动适配只选择传输出口，不授予网络权限：用户级设置、继承环境及系统已登记代理由 Service 封存到原 Run；项目、Tool 输入及页面不能修改它们。全部 Fake-IP DNS 才触发可信 HTTPS 解析，真实地址及每次跳转仍接受全候选公网检查。CONNECT 固定已验证 IP，保留原 Host、TLS 名称和证书校验；禁止代理失败后隐式直连。冷恢复先比较 `snapshot.web`，出口、解析策略或宿主资源策略变化先于凭据读取和模型派发失败；旧默认 Run 不会悄悄升级到新网络选择。具体范围与测试归 [Web Fetch owner](../../packages/agent/src/tools/web-fetch/README.md)。

准确同 Store 原 Run 显式接续中，可核实的已结算私有审核 fencing 与零派发目标在同一事务交接；原回执、请求、输出凭据和独立人工审批保持，不生成新授权或重复审核。新检查的原目标、检查 Model 及当前权限仍须核对准确代次和封存绑定；旧审核 child 回执的 reader、ownership 交接及派发适配不再进入新版；格式检查拒绝旧库。身份失真整项回滚，冷记录不创建新检查；边界归[Store owner](../../packages/agent/src/storage/README.md#原-active-run-的显式恢复)。

同一根会话下，child/grandchild 的工具审批模式动态读取根当前 applied `permission.mode` 与 revision，不冻结为创建时父模式。默认和可信注入的 child policy 都与当前根策略及原 capability ceiling 相交；局部根变更不修改其他根或用户默认。真实 `accept_edits/auto/full` 双向变化会唤醒原人工审批、自动权限检查、资源等待和未派发队列，准确原动作按新策略重新判断。Full 不能解除工具交集、主会话 Planning 硬约束、信任、明确拒绝/取消、工作控制和 unknown fence；只读子角色的任务指导不另成 Shell 硬上限。

Service 注入 `permissions`／`permissionPolicy` 时仍允许用户通过原 HTTP 控制修改根模式；注入只保留能力、信任、硬拒绝与明确人工要求上限，原宿主拥有的 trust／grants 管理边界不随模式入口开放。TUI／Desktop 仅将合法 applied 控制事件作为重读信号，按实际 Store、根 Session、Workspace 及明确 default 变更更新显示；首次子视图读取、在途保存和切会话的晚回包分别保留作用域与读取代次，事件正文或显示缓存不签发授权。TUI 的 Ctrl+P 可在问卷中打开权限面板，原答案和步骤保持，字面 slash 文本仍是回答。

Native 普通工具审批采用输入组件上方的单卡分页，根和子待批均保留 Composer／模式入口；切 Auto／Full 仍通过原持久模式和最终 dispatch read-set 重判，不由移除卡片模拟执行。主名称隐藏、子名称与稳定彩色图标只作展示，不改变准确来源 Session／Run／Interaction。分体菜单只提交原卡实际提供的 optionId，范围与完整说明均取冻结选项；紧凑附件仍须完整 EOF／hash／UTF-8 核对才有回答能力。问答、计划和 MCP 特殊授权保持独立门禁。排队消息的撤回／编辑／调序只影响尚未消费的输入，不授予工具权限、不取消已执行效果，准确跨层 authority 见[执行边界](unified-agent-boundary.md)与[Native owner](../../apps/desktop/README.md#原审批面板与授权观察)。

子 Agent 的会话授权选项必须保留父子策略的共同结构化范围、准确能力与稳定策略绑定；独立必需权限检查不得因会话授权被跳过。可复用的人类批准按真实来源 Session 保存，父展示根、兄弟和后代均不能借用；Auto 有效审阅的复用与持久会话授权的绑定分别核实，规则和反例由[权限 owner](../../packages/agent/src/permissions/README.md)维护。

最终 `markDispatching` 重读原根 applied revision，已获但未消费的一次性／范围批准及权限检查 proof 仍须按当前策略重判；旧 revision 不能直通，也不能借兄弟或新轮批准。旧人工卡以独立准确失效事实收束，原 request/answer 保留，不伪造用户答复；迟到旧答案或检查结果不改变新轮，已派发效果保留原事实。模式写入响应丢失查原控制回执，当前策略无法读取时阻挡新效果，冷只读不执行。运行中双向竞争、直接子 Agent 的可信策略注入、旧 grant／检查 proof 与资源等待由[真实模式测试](../../packages/agent/test/isolated/execution/live-permission-mode.test.ts)覆盖；[物理强杀](../../packages/agent/test/isolated/recovery/live-approval-crash.test.ts)核待批崩溃、冷读零 Provider、当前 revision 显式接续及一次效果。合成 effect、真实策略、原生工具和实际客户端范围分别由 owner 记录，不将一种证据推广为全部平台资格。

下面保留旧 Kernel/SAQ 实现及仍适用理由；其中人工拒绝后结束 turn 且不再调用模型的历史规则已被上述当前合同部分替代，不据旧模式/State 推导新正式执行范围。RSS、完整观测、Windows Shell 及平台资格未因本次迁移退出。

## 概述

Runtime Kernel 的授权系统以 State 27/SAQ epoch 的 live `interactionMode=accept_edits|auto|full`、phase、编译后的
policy facts、sealed sandbox scope 与 durable queue facts 为准。`interactionMode=full` 是唯一 Full authority；旧
`authorization.mode`/Full grant 只作为不可执行历史事实，不得在 restore、fork 或 mode change 中复活。

Builtin catalog 只声明 operation 的 schema、availability、effects、traits 与 minimum approval；它不签发用户
授权。Kernel/Runtime policy 依据 canonical facts 作 governance/admission decision，Host 只验证同一 frozen
registry snapshot 对应的 execution identity，App/Controller 只能把已批准的 grant 注入唯一执行 port。源码 caller/owner
closure 已切到唯一 App/Host/Builtin seams；RM-16 final Gate 与完成证据已经闭合，不能形成第二 schema/effects/grant authority；
dynamic MCP 的 binding/catalogRevision 与 Builtin projection revision 也必须保持独立。

当前 authority trust model 与真实 serialization/process boundary 以 `runtime-authority-boundary.md` 为准。
同进程 typed grant 使用 exact identity、single-use、expiry/revoke 与 structural binding digest；Store/Artifact
使用 strict codec/checksum，child process 使用 OS channel/control frame。内部 Runtime 不使用 secret key/HMAC authenticity。

## Control source（非 grant authority）

Mode changes and approval facts carry a bounded source for audit projection:

```ts
type ControlSource = "user" | "config" | "test" | "system";
```

`user` is the only source that can request a live permissions change or focused approval. `config` selects
the initial `interactionMode`; `test` is test-fixture metadata; `system` may record an auto-review decision but
cannot sign a user grant. Source is not an authorization mode and cannot add a second Full authority.

## 数据结构

`SessionCommandGrant` is the only live session grant record. It is keyed by the complete session command
identity (session/thread, canonical workspace, cwd, exact trimmed command digest, shell/executor identity,
execution environment, sealed sandbox scope, effects, and parser/executor/policy revision). Description,
timeout and subagent id are deliberately not part of the match key. Each released invocation additionally
has its own receipt, generation and attempt identity; an old `ToolGrant`-style workspace/thread/command
record is historical inert data and cannot authorize execution.

### SessionApprovalState — Session 级审批事实

```ts
interface SessionApprovalState {
  interactionMode: "accept_edits" | "auto" | "full";
  interactionModeRevision: number;
  pendingApprovals: Map<string, PendingApproval>;
  activeApprovalId: string | null;
  sessionCommandGrants: Map<string, SessionCommandGrant>;
  approvalReceipts: Map<string, ApprovalReceipt>;
}
```

`PendingApproval` 保存 parent/child/runtime identity、原始 route、binding digest、scope/effects、sequence、generation、createdAt
和状态。[Agent Note 0138](../../.agents/notes/implemented/simplification/2026-08-25-silent-session-format-compatibility.md) 的已知历史 profile 会把旧 grant/review/event 只读投影为 inert history；未知 profile 静默忽略。
当前格式中的未知字段、缺 identity 或 Full grant 仍使该单个会话 fail closed，不能影响其他会话或恢复 live authority。

## 硬规则（Agent Kernel authorization domain）

`packages/agent-kernel/src/core/authorization/` 与 Tool Governance 是唯一生产决策 owner，输入只包含 canonical facts；App、TUI、
Builtin 和 Host 不复制授权 decision。硬规则包括：Full 只从 `interactionMode=full` 派生；Auto reviewer 只能产生
`approve_once|reject|ask_user`；approval grant 只能是 `approve_once|same_command`；hard deny、schema、binding、phase、policy
revision 和 sandbox capability 任何一项失败都 fail closed。

TUI 的 permissions 选择使用同一 interactionMode contract。Full 选项不因 workspace sandbox availability 被降级为审批，也不
写入第二个授权字段；实际 execution backend 若 unsupported 则在 dispatch/admission 处明确 fail closed。Windows
`windows_restricted_token`、macOS/Linux candidate 与 Full UI 选择是独立维度，development Full 不等于 production qualification。

host Shell 只在用户脚本前的 sandbox environment/essential startup capability unavailable，或 Runtime 已持久化
attempt/preparation intent 后得到 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 时选择。它要求
完整 Runtime invocation identity/lifecycle；已启动、取消、超时或 cleanup unknown 的 native 调用绝不重放。

`/permissions` 无参数打开 selector；确认后持久化用户默认和当前 Session 的 `interaction_mode.changed`。清除 Session grants
使用 canonical `session_grants_cleared(sessionId, sessionRevision, generation)`，不改变 mode。该事件先提升 Session 的
approval generation：仍由 `same_command` 保持 `authorized_queued` 且尚未 dispatch 的调用恢复为原 route 的等待状态，所有仍可交互的
queue record 同步重绑到新 generation 后才重新暴露人工焦点；已 running 或由独立 receipt 授权的调用不被撤销。Kernel 与 TUI 必须从
同一 durable event 得到相同投影，旧 generation 的 Enter/Esc 继续 no-op，不能留下永远无法解决的旧焦点。受限 backend unavailable 时可以
报告 unsupported/fail closed，但不得把 Full 降级为审批 grant；Full 只由 interactionMode 表达。扩 scope 的 exact invocation
按 phase/mode 进入 direct、Auto reviewer 或 user approval；native denial 不切换 host、不 replay。Workspace 内 hidden names 与
`.git` 不触发 basename deny，hard deny 与 Host-control 隔离继续有效。
新配置和新 TUI 会话默认 `interactionMode=auto`，使待审查命令优先进入模型 reviewer。项目配置可提供
尚无个人选择时的初始 mode；用户在 `/permissions` 选择器确认的 mode 同时写入用户级
`~/.kite-code/kite-code.jsonc`，在后续启动中优先于项目默认。配置写入失败不回滚当前会话的 live mode，
但 TUI 必须明确提示未保存。持久化 session mode 与运行中 `/permissions` 选择保持权威；内部调用若遗漏显式 mode 仍 fail-safe 使用
`accept_edits`，不能从产品默认值推导更宽授权。
恢复已有 session 后开始新 turn 前，SessionRuntime 必须比较个人/会话 preference 与已恢复 Kernel State 的
`mode`；两者不一致时先持久化并确认 `interaction_mode.changed(source=user)`，再允许 Tool Governance 或
Subagent dispatch。只更新 TUI Footer 或 `RuntimeSessionCoordinator` identity 不构成 mode 变更，否则会出现
Footer 显示 Auto 而 parent/child 实际按旧 `accept_edits` 请求人工审批的分裂状态。Full 的恢复同步只需
确认 live `interactionMode=full` 与 policy facts；受限 mode 的 dispatch 才依赖 sandbox backend capability。
backend 不可用时受限执行 clean fail closed，不影响 Full mode 的持久化或 Plan lifecycle，也不得绕过 policy invariant。

## 受信任 Workspace 边界

[Agent Note 0118](../../.agents/notes/implemented/feature/2026-08-18-trusted-workspace-unrestricted-file-access.md) 把内建文件工具与进程执行授权分开。普通 Workspace 外读取进入 observe-only `external_read` scope；
按 [Agent Note 0132](../../.agents/notes/implemented/feature/2026-08-24-sensitive-external-paths-use-exact-approval.md)/[Agent Note 0133](../../.agents/notes/implemented/feature/2026-08-24-mode-aware-sensitive-external-authorization.md)，`read_file` 直接访问敏感外部 identity，或任何无法预先证明遍历范围的外部 recursive
search 时必须完成模式感知授权：Full 直接授权、Auto 三态审查、其他模式 exact approval。授权后仍使用 sealed
read scope，Provider 不再按 protected name 二次拒绝。
当前 Workspace 的物理位置不影响信任，文件工具可直接读写其中 `.git`、`.env`、`.ssh`、`.codex`、
`.agents` 等名称。Building 阶段的 `accept_edits` 直接放行 Workspace 内 mutation；Workspace 外
`write_file`/`edit_file` 按 [Agent Note 0135](../../.agents/notes/implemented/simplification/2026-08-24-mode-aware-workspace-authorization-boundary.md) 进入模式路由：Full 直接授权、Auto 三态审查、Accept Edits 请求 exact
invocation approval；批准后形成 `approved_external`，文件名与宿主祖先不得再二次拒绝。canonical/no-follow
identity、read-before-edit、preimage/stale、single-use commit、取消、大小/编码与真实 OS failure 仍由
Provider 执行。

[Agent Note 0160](../../.agents/notes/implemented/bug-fix/2026-09-01-uncertain-shell-requires-exact-approval.md)与[Agent Note 0189](../../.agents/notes/implemented/bug-fix/2026-09-17-auto-review-uncertain-shell.md)保留phase、sandbox与durable queue：可证明只读命令按phase baseline
direct；Building中效果已知的Workspace mutation继续按当前mode治理；无法证明只读且无法完整确定effects的命令（包括
`bun test`与任意project script）在Auto模式进入审批模型，即使审查熔断也不直接跳到人工；在Accept Edits/Full请求exact真人审批。命令不因不在列表而hard deny；只有Compiler
明确`allowed=false`的关键系统规则不可覆盖。显式same-command grant只按完整Session identity匹配。

Planning 非 Full 使用 Workspace read-only baseline 直接运行已知可承载的 Shell；已知扩 scope 按 Accept/Auto 路由审批。Planning
Full 直接执行并保持 Plan lifecycle。空命令、关键系统递归删除和针对关键系统 repository 的 destructive Git 继续 hard
deny，任何 mode 都不能覆盖。`isReadOnlyShellCommand`同时拥有可证明只读的免审事实、hardened environment、只读
Subagent role ceiling与scheduler metadata；未命中只能生成`uncertainEffects`并按模式审批，不能生成destructive deny。
`git_inspect` 已从 Runtime capability registry 退役，所有模型 Git/脚本命令统一通过 `shell_execute`。

命令环境硬化与沙箱文件范围分别核验：Builtin preparation 和实际 Provider 对原命令／封印 argv 重新执行闭集分类，再选择可信解释器和 Git 中性环境。Full 的 `full_access` 不能通过 `policy_proven_read_only` 标记收窄，但 Full 中匹配闭集的 Git 读取仍使用硬化环境。反向也不成立：Planning 的 `read_only` 文件范围本身不证明任意命令只读，不签发该信任标记；已授权命令继续在原 scope 中执行。伪造只读标记而命令未通过分类时 preparation 拒绝，模型参数不能取得这个环境或授权事实。
主Agent的当前Prompt同时约束常规Workspace检查：优先使用file/search能力；Shell已经运行在当前Workspace，因此不生成冗余`cd`或当前Workspace的`git -C`，Git读取优先拆成单条简单命令，也不只为拼接、分组或裁剪输出引入`&&`、pipe和loop。该约束只降低无谓的unknown/审批与展示碎片，不能替代Builtin只读grammar，也不能让未证明命令取得read-only授权。

只读证明收敛到 Builtin-owned、冻结的 v1 Shell semantics registry；registry digest 必须进入
`shell_execute` capability revision，语义升级不能复用旧binding。普通只读program由descriptor声明，参数敏感program
由descriptor选择局部inspector；未注册或未命中只生成低基数本地诊断，不产生allow，也不进入远程telemetry。

RM-12 只迁移该链路的物理 owner，不改变上述授权：五个文件 Builtin catalog entry 已移除旧的
`execute/projectResult`，由 filesystem Runtime module 消费 Tool Pipeline 在 exact invocation 完成 Policy、
approval、protected-path 与 durable attempt acknowledgement 后注入的 filesystem mechanism。`git_inspect` 已退役；Git 通过受治理的 Shell 执行。缺少 Host
execution port、binding 不一致或 mechanism 缺失均 fail closed，不回到旧 handler；当前使用 State 27/SAQ epoch 的
Runtime State 与 SQLite Store。`kite-runtime-modularization-v1-2026-08-19` 仅是 RM-12 的历史迁移标识，不是当前授权格式。

RM-14 同样只迁移 Plan/Task/Subagent/Verification 的物理 owner，不改变授权结果；以下 owner 说明属于历史迁移背景，
当前 queue/approval contract 以 State 27/SAQ epoch 为准。App 的
`read_plan/update_plan/write_plan/task` adapter 已禁止 concrete executor/result owner，唯一 Builtin executor 只能消费
Tool Pipeline 在 phase、Policy、approval、capability attempt acknowledgement 与现有 Subagent sealed grant 后注入的
Plan/child mechanism。Builtin Subagent role ceiling 可收紧 allowed tool 与 Shell command shape，不能签发用户批准、
提升 phase/workspace access 或绕过 parent authorization。`ask_user` 仍是 Kernel-owned interrupt；Builtin module 的
同名 operation 不形成 execution 旁路。缺少 mechanism、binding 或 grant 均 fail closed，没有旧 handler fallback。

[Agent Note 0131](../../.agents/notes/implemented/simplification/2026-08-24-whole-workspace-sandbox-admission.md) 把同一 identity 规则扩展到 Shell、MCP executable/cwd 与原生 sandbox：canonical Workspace
内 read/write/execute 不得因 `.git`、`.env`、Agent/MCP 配置、credential-looking 名称或 additional deny
二次拒绝。Skill reference 仍有独立 schema 和 capability routing；Git 命令统一受 Shell 的 Policy、approval、
sandbox 与 receipt 治理，不构成 Workspace 名称级 deny。下文的`externalRead`/sealed
`filesystem=full_access` scope 只描述
Shell invocation；Workspace 外 destructive、提权、关键系统删除、credential/persistence 等极高风险进程
操作仍可在审批前 fail closed。

## MCP Tool 策略边界

MCP descriptor 的 `minimumApproval` 不能单独把 unknown/write/destructive effect 变成无审批调用。只有 effective effects 全部为 `none|read` 且 `minimumApproval: none` 时，Approval Policy 才把它当作只读；`minimumApproval: user` 始终要求单次用户批准。远端 annotation 不直接进入该判断，project 配置也不能降低 minimum approval 或 effect 风险。Tool filter 只决定 catalog 可见性，不产生 authorization grant。

## Shell 逐项审批与重叠执行

Shell 文件系统授权也按 invocation 投影。默认 `workspace_only` 继续由 macOS Seatbelt、Linux
bubblewrap 或 Windows restricted-token 执行；Building 阶段可证明只作用于 Workspace 的 direct command 由
Policy 直接放行。工作区外读写和无法静态限定路径的命令必须完成当前模式授权，批准后以与 UI 一致的 sealed scope 投影到
三个平台各自的 native sandbox 执行一次。临时目录、缓存目录与普通
外部文件属于可批准操作，不得再被 native Workspace ceiling 二次拒绝。Auto 模式先由自动审批模型
判断：安全则自动产生单次 grant，明确不安全则拒绝，意图或授权不足则请求真人审批；模型异常、无效响应或
circuit breaker 同样转真人审批。Workspace 外凭据、Shell/Agent/IDE 配置、Git hook/config、启动项和关键
系统文件使用 `sensitiveExternalAccess` 参与该模式路由：Full 直接授权，Auto 三态审查，其他模式请求 exact
approval；显式敏感 identity 不允许 same-command 静默复用。明确的关键系统递归删除仍硬拒绝；普通外部
目标可在 Full 或审批后执行。未经授权不 dispatch，因此不会出现用户
先批准再收到 Kite protected-path denial。命令本身、宿主 ACL/TCC、磁盘或目标状态仍可正常
返回执行失败；“批准后可执行”不伪造命令成功。

Shell 网络授权按 invocation 投影。精确的 `node|npm|pnpm|yarn|bun --version|-v` 与其他可证明本地
命令在未获授权时使用 network-disabled，不因 executable 名称本身触发网络审批；明确网络命令进入scope审批，无法证明
local-only或无法完整确定effects的arbitrary script使用`uncertainEffects`请求审批。Auto先由reviewer判断，
Accept Edits/Full请求exact真人审批，并保持编译的sealed sandbox scope；只有明确外部/网络facts才能
请求对应扩scope。exact same-command grant仍按编译策略与完整identity复用。
按[Agent Note 0162](../../.agents/notes/implemented/simplification/2026-09-01-remove-read-only-trial-grant.md)，uncertain Shell不提供额外的只读试跑选项，只使用正常的`approve_once`、符合条件的
`same_command`与拒绝；不得把classifier或Sandbox实现差异暴露为新的用户决策。
用户一旦对该 exact invocation 授予 `approve_once`，本次 Shell 只获得该 invocation 的 sealed scope；
静态 effects 只决定审批文案与 filesystem scope，不能在批准后再次把该调用强制改成 network-disabled。
拒绝则命令不启动；不能兑现 governed network 的 sealed production consumer 必须在审批前拒绝。
development prepared consumer 也不得把已批准的 `network=allow_all` 重新解释为 production host allowlist；
它必须在继续核验 exact grant/identity/lifecycle 的同时执行该 unrestricted scope，而 production allowlist
qualification 仍由独立 boundary/evidence gate 决定。
macOS/Linux native sandbox 消费该模式；Windows protocol V6 对已批准的
`filesystem=full_access, network=allow_all` sealed scope 使用当前登录用户 token
运行该 exact command，并保留当前用户 profile 的 Schannel 路径。它不创建本地账户、不请求 UAC，也不依赖
持久 credential state。未获网络授权的 Windows 调用继续使用 restricted token。由于 Schannel 不能在该
restricted primary token 下取得凭据，Windows 已批准联网调用不再声称 restricted-token filesystem ceiling；
Job Object 仍限制进程树。该 development authorization 不构成结构性 network-off evidence，不能提升 Full 或
production qualification。

`curl -w/--write-out` 中的安全 `%{name}` 状态占位符仅是 curl 输出模板，不是 Shell 控制语法；它不应把
本来只访问网络、或写到 `/dev/null` 的健康检查升级为 `uncertainEffects`。模板中其余 Shell
元字符、未知命令组合或实际工作区外读写仍按保守规则要求相应 filesystem scope。

同一条模型消息产生多个连续的 `shell_execute` 调用时，每个调用独立完成参数解析、策略预检和 durable queue admission。某一调用
获批后进入 `authorized_queued`，不等待 sibling 共同收敛，也不跳过 Scheduler concurrency；每个 invocation 有独立 receipt/attempt。
TUI 同一时刻只显示 `activeApprovalId` 对应且可见的人工请求，后台 auto-review 或 off-screen request 不夺取 Footer；解决后一个
审批时不得重置已经运行的 sibling Shell 的 `startedAt` 或累计耗时。
`approval.batch_released` 的 `cancelledReviewIds` 只终止仍未匹配、未运行且未终态的 auto-review record；同一 interaction 已在
`matches` 中获得独立 receipt 时，即使 reviewer id 同时出现在取消列表，Kernel 与 TUI 都必须保留其 `authorized_queued` 结果，不能由
后处理取消覆盖原子 batch 的授权事实。

Subagent 内部工具触发审批时，持久化 interaction 由 parent `task` Tool Call 拥有，child/runtime id 保存在 continuation 与
approval facts 中用于精确恢复。只有同一 model message/turn 中并发的多个 Explore children 在非 Full parent 下派生 Auto；single
Explore、plan/code/review 继承 parent。Enter 必须绑定 exact interactionId+generation；Esc在Approval overlay拒绝focused
request并原子取消同turn sibling、结束turn；Ctrl+C仍是独立的whole-turn cancel输入。每个新的canonical interaction必须重置审批面板焦点与输入缓冲；TUI不能依赖private
deferred slot 或 local acknowledgment。

auto-review 的 Model/Prompt/response parsing 属于 Builtin reviewer；是否接受 reviewer 结果则由
`@kite-ai/agent-kernel#decideAutoReview` 对 JSON-safe facts 纯确定性裁决。reviewer 只接受 operation-bound 的
`approve_once|reject|ask_user`，不得签发 `same_command` 或 Full；技术失败、未知字段、矛盾 failure facts 或缺失 grant
升级真人审批。Kernel 不生成 UUID、时间或事件；Runtime State adapter
只为 Kernel 的 `request_user_approval` 决策补 interaction identity 并投影现有事件，App 不能重写一份升级规则。
Builtin reviewer 的当前响应协议只接受 `decision=approve_once|reject|ask_user`，且结果必须绑定当前
queue generation 与 invocation facts。旧 `decision=approve`、`approved` 布尔、`grant`/`approval` 对象、
`same_command` 或 `full_access` 均直接 `invalid_response` 并升级真人审批；不得用 compatibility alias
或把旧 shape 映射成新的 grant。未知字段、非法 risk assessment 及 identity/binding 不完整同样 fail closed。
Builtin package 的公开 Model API 不暴露可自行注入 Gateway 的 reviewer 函数；production 只能调用 App 注入的
`BuiltinModelEffectCoordinator`。Coordinator 依据已解析 reviewer 配置创建模型并复用其构造时绑定的唯一 Gateway，
App 不创建第二 reviewer model，也不存在 direct helper、第二 Gateway 或 Provider-denial fallback。

审批载荷只有 Protocol `ToolApprovalPayload` 一份 JSON-safe 定义；Policy、Controller、Executor 与 App
直接共用该类型。不得再声明同义 approval DTO，也不得通过类型强转连接分叉字段。
`summary` 只是 App 审批界面的有界展示标签，不属于 Kernel policy fact、approval binding 或 authorization
identity；Shell 的完整命令只保存在载荷的 `command` 字段。命令长度和展示文案变化不得改变 Kernel
授权结论，也不得使 otherwise valid 的治理事实失效。

Shell 重叠范围只限同一 `modelMessageId` 和同一任务的连续 sibling；遇到非 Shell 调用、不同模型消息、不同任务、`ask_user` 或方案审核时，Runner 必须等待已启动 Shell 收敛，不能跨过交互和副作用边界。`approval.rejected` 必须携带对应`toolCallId`。Approval overlay的用户Esc或“拒绝”会将focused target记为rejected，并在同一个durable command transaction中把当前turn其余queued/awaiting/authorized/running sibling记为cancelled、完成必要reconciliation并写入`turn.aborted(cause=user)`；拒绝后不得推进下一个审批、启动尚未开始的工具或再次调用模型。Ctrl+C复用相同整轮终止边界，但仍是独立的全局取消输入。策略拒绝、sandbox 缺失和系统审查失败不是用户取消，但审批目标仍保留对应终态记录。`approve_once` 与 `same_command` 的授权范围和溯源规则保持不变，一个调用的单次授权不会扩散给其他命令。当前事件集合不包含 `tool.execution_ready`；State 26 已知历史 journal 中的未知或旧授权 event 只转为无副作用 `runtime.action_ignored`，current journal 的未知 event 仍只使所属会话恢复失败。

## 入口覆盖

| 入口                    | source 值  | 位置                                             |
| ----------------------- | ---------- | ------------------------------------------------ |
| CLI/start configuration mode | `'config'` | App composition / Session mode                |
| TUI 权限选择器确认 Full | `'user'`   | `apps/kite-service/src/bootstrap/runtime/RuntimeSessionCoordinator.ts` |
| 测试注入                | `'test'`   | `packages/runtime-host/test/policies/authorization-elevation.test.ts` |
| System (禁止签发 grant)  | `'system'` | Auto reviewer / Kernel validation              |

TUI 入口通过 `buildRunAgentParams` → `RuntimeSessionCoordinator` 传递 live `interactionMode`；Full 不再映射为第二个
authorization mode。Kernel 在线初始化/restore 只接受 State 27/SAQ epoch 的 mode、queue、grants 与 revision；已知历史会话
必须先经纯迁移清空 queue/grant/receipt/effect 并把旧 Full 降级，未知 source 不进入 Kernel。production transition decision
由 `@kite-ai/agent-kernel` 拥有，App coordinator 不复制该 decision。

当 Runtime 正在回复时，`/permissions` 的选择同样必须立即生效：`SessionRuntime` 通过 live
Kernel control 持久化 `interaction_mode.changed`。事件只能来自显式用户选择，并带 `source: user` 与
时间戳；Kernel 在持久化前按 interactionMode、policy facts 与可兑现 scope 校验。reducer 在同一状态转换中更新
mode/revision，并清除
当前 Task 的临时 `executionMode` 覆盖；降级会使尚未 dispatch 的 prepared grant stale，已批准计划本身仍保留其历史
展示选择。事件推进 revision，已在旧 mode 下启动但尚未提交的 effect 不能再提交结果，后续调度按新 mode
重新计算。该路径不直接改写 RuntimeState，也不依赖 TUI ref 的下一次渲染。

Subagent 工具面与执行策略以父 Runtime 当前 live `interactionMode` 为输入，不从模型参数或可能过期的 task config 推导。唯一的模式特化是同一模型响应中存在多个结构化 `task(subagent_type=explore)` sibling 时，该批并发 Explore child 在父级 `accept_edits` 下使用 `auto`；单个 Explore 以及 Plan/Code/Review child 继续继承父模式。父级 `auto` 仍为 `auto`，父级 `full` 仍为 `full`，不能降级或扩大。子 Agent 因审批挂起后，恢复时必须用相同的 parent Tool Call、model message 和 sibling 结构重新推导，不能依赖展示组或任务正文；挂起期间的 `/permissions` 变化仍是权威。内部调用若无法证明该结构，只能继承父 live mode，不得猜测为 Auto 或 Full。
Subagent model invocation 产生的 child Tool Call 进入 Session durable approval queue；只有持有该 child identity 的 parent Task
continuation 可以批准、dispatch 和消费它。多个 sibling 同时等待时保持各自 queue record、route、generation、sequence 与
binding facts；不再以 private `subagent.approval_deferred`/single slot 覆盖 canonical request。恢复必须使用原 parent/child/runtime
identity，不能 synthetic child request/grant 或让迟到结果抢占当前 focus。

`/permissions` 只接受无参数形式并打开可用模式选择器，确认某一项后才改变 mode；任何附加参数都不
触发模式切换。`full` 选项由 interactionMode 单独表达，即使受限 backend 不可用也不伪造旧 grant；
实际受限 dispatch 在 capability unsupported 时 clean fail closed。
这不会把模式选择伪装成 production capability admission。production execution-status 只可由 CLI
`--execution-status` 查询；它不是 grant，不能扩大 capability surface。

`/rewind` 从恢复点 fork 新 thread 时不继承源 thread 的授权。Fork 必须清除 source-derived queue、active approval、Session
grants、receipts、generation-sensitive waiters、turn-scoped capability binding/disclosure 与 Provider session waiver；新 Session
的 interactionMode 只能由默认/用户显式选择恢复。历史旧 Full/grant 不得复活为 live authority。

## 测试

```bash
bun run --cwd packages/agent-kernel test
bun test packages/runtime-host/test/policies/authorization-elevation.test.ts packages/agent-kernel/test/shell-policy-matrix.test.ts apps/kite-service/test/runtime/actions.test.ts
```

测试覆盖：

- Full 只由 interactionMode 派生且不要求第二个 authorization field
- auto-review 只接受 approve_once/reject/ask_user，same_command/旧 shape fail closed
- Session grant key 的 workspace/cwd/executor/env/scope/effects/revision 任一变化都会失配
- 各 source 值正确传播到 state 和 grant 记录
> 路径同步：Host state adapter 已使用无版本文件名，Runtime State 仅作为当前持久格式 metadata 名称。


## 内部权限检查与子 Agent 边界

authorization.check 请求在 Runtime 封存前加入其合同的独立 system 指引；旧任务授权合同的原用户请求只作为范围证据，新默认风险合同不发送该业务材料。任务／参数／历史工具正文不能签发授权。checker 技术失败是无决定而非 reject；历史失败次数、缺少先前批准与不可用本身不能成为新调用的拒绝或转人工依据，后续调用继续按准确目标和当前策略独立判断，真实拒绝仍有效。不可用 Tool、Action 与 Job 结果保留未派发／零 adapter 事实，并以可读正文和 details.authorizationCheck 的原检查身份及有限 Core failureCode 解释已知原因；私有 adapter 消息与不完整输出不投影为拒绝理由。旧封存输入、输出和 proof 不改写，冷记录不重发；实现与受控回归范围见[权限 owner](../../packages/agent/src/permissions/README.md)。

内部审核的模型失败处理保留真实 SDK 已去敏的服务不可用、连接失败和流不完整固定分类，与普通 Model 链一致；只对白名单原因生成可读 Tool 反馈，不透传任意异常 message／cause。原 Tool 正文以准确 call／source 完整进入下一模型；未取得审核决定仍零派发、无新增人工卡，不因此获得自动重试或放行。原生 Provider 请求、有限诊断与历史故障的可追溯范围归[真实验收入口](../../tests/e2e/live/model/README.md#审批策略与原生-shell-执行)。

通用失败可读性属于模型上下文呈现：只在核原 Tool／call／Session／Run／Store 后解释裸码、取消和 unknown，是否未派发取 Core 真实观察，原 receipt／outcome／批准和已封存 ModelInput 保持。完整公开拒绝原因不被通用说明覆盖，私有 details 不自动公开；后台 Source 保原完整 JSON 及既有投递／抑制边界，不因报错主动创建新模型。[呈现 owner](../../packages/agent/src/model-tools.README.md#结果呈现)与各工具 owner 负责具体安全原因、已完成动作和恢复说明，不在审批层重解释业务效果。

自动审核统一命名 `authorization.check`／`authorizationCheck`，由权限系统保存原会话中的一次无 Run Model，不创建 child Session、Run 或子任务 carrier。最终派发核原 target／attempt／定义／input/source／policy/controlReads，以及准确请求与完整结果，强制人工要求继续保留双 proof。标题生成同属内部模型调用，记录为 `session.title`。 原标题 Model 的宿主与已解析 policy ceiling 仍须共同通过；准确用途不提供绕过权限的许可，资源等待后的当前控制和最终 SQL 证明继续独立核实。通用子 Agent 只以类别配置差异，`review` 只表示代码审查类别。旧 `authorization.review` 回执与派发适配不再保留；不支持的旧 Store 在打开前拒绝，不转换或重跑旧审核；[边界决定](../../.agents/notes/implemented/architecture/2026-10-22-internal-model-calls-without-child-agents.md)解释迁移理由。

旧Browser人工等待路径曾为独立控制Action选择原Run审核上下文；当前Native默认不装配人工等待／Continue，固定内置浏览器定义在三模式免审核／审批。以下只记录原来源绑定的兼容边界，不能据此重新增加浏览器审核。可信宿主须核准确人工请求，或Controller持有的Browser Job及open／可选execute父链，才可保留该原活动Run的冻结审核器；不能回退到全局空审核器制造人工审批，也不能借同Session的新Run。此私有绑定只选择审核器及其配置租约，不授予权限：原Action定义、当前策略／controls、read set、取消、期限、页面和selection继续复核。原来源失效拒绝恢复，停止保持原缩权路径；具体实现与来源负例归[Agent Browser](../../packages/agent/src/tools/browser/README.md#异步人工交接候选未发布)。

旧准确Action记录的审核来源包含原任务正文、原人工请求原因及恢复控制本身的效果，材料仅作上下文，不能把网页文字或任务文本当权限。对其准确原Run的准备读stamp只绑定实际依赖的身份与isActive，正常处理进度进入等待不制造重复审核；Run取消／结束、work／selection及记录CAS仍严格核实，其他Action不缩减读stamp。旧审核用途不足时不得补造上下文；当前内置浏览器的审批豁免不提供跨页面、跨任务或越过unknown的派发资格。
