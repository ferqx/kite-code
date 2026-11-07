# 后续授权复用与自动审批提速实施方案

状态：实施与本机目标验收已完成（2026-11-07）。原始确认输入尚未进入 Git 历史，原路径完整保留，避免删除唯一的用户确认方案；当前行为、合同与验证边界归手册和对应 owner。用户于2026-11-06要求严格按照本文实施，确认本文的3秒默认总预算、文件 edit/write 联合位置范围和 worktree create 父目录直接子项范围。

具体版本决定已获用户确认：Store `formatMajor` 1→2、内部审核回执 version 1→2；公开 API 保持 `/v1` 并原位替换字段。Tool／Job 定义和 Worktree worker 协议版本保持现值。旧库明确拒绝，不迁移、清空或改写；不保留旧审批答案及回执 reader。

后续版本决定（2026-11-07）：用户明确当前尚未投产，本次改造涉及的 Store 与内部审核回执编号统一还原为1，公开 API 继续 `/v1`。当前 schema、完整行为绑定、归一答案、派发与恢复实现均不回退；此前既有 Tool／Job、Native 私库、备份清单及其他独立版本不变。历史记录与原实测报告保当时编号；当前只接受本轮完整 schema/checksum，不因同为 major 1 兼容历史旧结构。Profile 的 schemaChecksum 在 SQLite 打开前识别当前基线，数据库最终核验仍独立执行。

后续确认（2026-11-07）：用户将持续评测聚焦于工具执行、权限审批与运行中权限切换，并明确允许3秒不足时调整到5秒或8秒。真实 Luna low 回执出现超过3秒的长尾及原生客户端审核截断后，默认总预算先调整为5秒；扩展真实子 Agent 场景又记录完整准备与Provider合计5001ms的超时后，当前默认调整为8秒，提前完成立即继续，显式配置及已封存设置仍优先。下文3秒保留为本版原始确认设计，不覆盖这一后续授权。当前预算、风险合同与有限实测资格归[授权手册](../handbook/features/tools-and-approvals.md)、[Service owner](../../apps/service/README.md)及[模型验证 owner](../../tests/e2e/live/model/README.md#授权复用与审核性能)，不将工具可靠性目标推为模型工作内容或报告结构要求。

基线：`el-refactor`，`fb4bebd0dcea5b59a3fa717b7e19321d7dc7229e`，2026-11-06。实施开始时 HEAD 与本基线一致，工作树仅有本方案未跟踪文件。原输入为用户提供的 8364 基线 Word 方案及竞品调研。实施沿本文第10节 A–E 顺序推进，不覆盖其他工作。

## 1 目标与设计取舍

自动审批帮助用户连续完成正常开发，同时拦住明显危险操作。它不是严格的任务合规证明，也不承诺识别所有脚本副作用。业务 Agent 继续遵守用户任务；原生执行边界、明确拒绝和结果未知的恢复合同继续负责实际效果。

本次的架构目标是让工具层定义自身的审批与执行行为，新增工具或改变领域规则时，不再向 Loop 核心流程添加工具名分支。工具包提供行为描述和实际执行器，可信宿主登记并施加全局权限上限，核心统一编排。

按用户最新要求，只设计统一的新版实现，不承担旧客户端、旧协议、旧授权记录或旧任务的兼容、转换和恢复。Shell、文件与 worktree 使用同一套候选/答案/授权/审核回执；新版自身的取消、撤销、结果读取和冷恢复仍须正确。本轮只修改方案，不清空、转换或改写现有用户数据。

在这条扩展边界上交付两项用户能力：一是 Shell 同命令、文件同位置 edit/write、worktree 对应操作的后续人工授权；二是减少 Shell 的额外模型审核次数和单次等待。CLI stdio、共享 TUI、Native/Desktop 使用相同范围与答案语义；Web 保持现有只读范围。

采用四项收敛选择：

1. 直接复用原策略、Interaction、grant、epoch、审核证据和最终派发链。
2. 工具包提供审批行为、授权规则及原执行/恢复接口，由可信宿主静态装配；核心只处理通用判定、冻结选项、范围身份及当前策略许可。
3. Auto 优先使用已有许可与小范围确定性快速路径，剩余 Shell 请求由一个轻量审核调用完成。
4. 首期不建设通用权限 DSL、全局规则激活控制面、多模型两阶段、跨 Provider 服务端审核、持久审核缓存平台或新诊断界面。

### 竞品依据与采用范围

| 官方机制 | 本方案采用的部分 |
| --- | --- |
| [Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) 只处理需要批准的请求，建议先减少常见操作的升级审核 | 已有许可先处理，避免为普通工具新增模型门禁 |
| [Cursor Run Modes](https://cursor.com/docs/agent/security/run-modes) 先规则与沙箱，再审剩余请求；[工程说明](https://cursor.com/blog/agent-autonomy-auto-review) 减少独立往返 | 明确快速路径，复用原审核通路；不为模仿同 RPC 架构重构 Provider |
| [Claude Code](https://code.claude.com/docs/en/permission-modes) 将普通操作与模型分类分开，并在部分服务端合并审查 | 独立轻量审核 preset 和短输出；本轮不引入第二模型或服务端依赖 |
| [Devin 权限](https://docs.devin.ai/cli/reference/permissions) 先明确规则，Smart 才判断剩余操作 | 冻结范围和会话内批准复用，区分人工许可与风险审核 |

以上来源核对日期为 2026-11-06，支持机制选择，不构成 Kite 的时延实测。各产品的 Full、Bypass 或更宽持久授权不直接移植。

## 2 实施前基线与改动范围

| 当前事实 | 实施处理 |
| --- | --- |
| [权限策略](../../packages/agent/src/permissions/index.ts) 已对准确 safeRead、允许的工作区编辑和可信 `autoReview:none` 直接允许 | 保留这些路径，不声称本次新建了全工具免审 |
| 默认 Auto 只对需要检查的 Shell 使用风险合同，ordinary 允许、high 转准确人工、critical 拒绝 | 保留分类含义与当前固定危险拒绝 |
| [审核模型装配](../../apps/service/src/authorization-check-model.ts) 继承业务 reasoning，支持时限制输出至 256 tokens | 为默认审核建立独立低 reasoning preset，继续使用当前已配置模型和连接 |
| [Service 配置](../../apps/service/src/configuration.ts) 默认审核总预算 10 秒；Runtime 已有超时继续、在途等待和批准复用 | 默认预算改为 3 秒，保留显式配置；复用原设施 |
| [InteractionGate](../../packages/agent/src/execution/interactions.ts) 当前 grant 要求原完整 policyRevision 与当前一致 | 改为统一结构化范围及稳定策略绑定；原完整 revision 仍保存为批准来源 |
| [接纳事务](../../packages/agent/src/storage/sqlite/interaction-operations.ts) 已保存 grant；[最终事务](../../packages/agent/src/storage/sqlite/operations.ts) 已复核 grant/epoch | 扩展原事务，不增加第二套授权状态机 |
| [inheritance](../../packages/agent/src/permissions/inheritance.ts) 双方待批分支丢失 grant 信息；[Planning 合成](../../packages/agent/src/permissions/constraints.ts) 已有保守交集 | 两处统一使用同一个候选与策略绑定合成函数 |

工作区内普通文件在默认三模式下没有常规人工弹窗；非 Full 的外部 Files 写入仍硬拒绝，Full 本来允许。文件规则仍完整实现，供确实要求人工且明确支持复用的可信策略使用，不为展示新选项制造审批。Auto worktree 继续免审，其后续范围主要服务请求批准模式和支持该范围的可信上限。

## 3 自动审批的产品行为

### 执行顺序

1. 核当前真实能力、模式、信任、父子与 Planning 上限、取消和固定危险拒绝。
2. 当前策略已经允许则直接继续。有效人工 grant 满足当前策略明确允许复用的要求。默认产品策略允许有效 Shell 同命令 grant 满足本策略的默认 Auto 风险审核，命中后不再调用默认 reviewer；宿主、父子、Planning 或自定义策略要求的独立 checker/人工条件继续保留。
3. 命中本方案的 Shell 快速路径则继续，不创建审核 Model。
4. 剩余需要默认 Shell 风险检查的操作，先沿原设施查询合格的已接受证据、等待同操作在途检查或继承准确父 Tool 依据；仍未满足时才创建一次新审核。
5. ordinary 继续；high 显示原准确审批卡；critical 拒绝。审核技术失败按原未执行错误交回业务 Agent。
6. 到达总预算且当前策略支持超时继续时，保存 `timeout_continue` 并继续原权限范围，不生成模型批准或会话 grant。
7. 执行前仍走原资源准入与 `markDispatching`；实际效果、取消及 unknown 沿原适配器处理。

自定义 checker、SDK Permissions 和独立人工上限保持自己的合同；没有显式声明的消费许可或超时继续，不由默认产品策略推断。

### Shell 快速路径

首期只扩展现有 [shell-search](../../packages/agent/src/permissions/shell-search.ts) 和 [有限 Shell AST](../../packages/agent/src/permissions/shell-command-policy.ts)：

- 现有可识别 `pwd`、`ls`、bundled rg 单条命令继续免模型审核。
- 新增由这些现有合格叶命令通过 `&&` 组成的字面量链；每个叶均须通过原参数检查，实际执行沿原可信程序和 rg `--no-config` 重写，保留原连接顺序和失败短路。
- 整条链必须为 `workspace_write/none`；命令替换、变量展开、赋值、重定向、执行 hooks、外部解压、解释器和不支持的复合语法进入原审核路径。
- 分类与实际执行使用同一解析与重写结果，不能只认 bare 命令名或把尾部未经检查的命令拼回去。

首期不新增 Git 命令矩阵，不把所有工作区内离线命令都当安全，也不递归分析脚本依赖。未命中快路径是正常待审核状态，不是拒绝或参数错误。

### 审核 preset 与等待

默认审核仍用当前选定模型及同一连接。支持 reasoning 设置时选择 `low`；不支持时沿真实 adapter 能力省略该字段。业务模型设置保持独立，显式自定义审核器不被改写。checker 身份与封存 settings 沿现有配置摘要机制，按最终实际 `checkOptions` 计算，使 low preset 纳入原复用与恢复绑定。支持输出上限时继续 256 tokens，输出维持 `risk/reason` 短 JSON，不为提速修改工具或风险协议版本。

默认总预算为 3000ms，包含同操作等待、材料准备、排队和 Provider。现有 `autoApproval.timeoutMs` 的用户显式值优先；不自动重写已保存配置。真实超时沿现有继续语义；连接错误、解析失败、输出不足和取消保持各自原因，不伪装为超时，不自动重试审核。

新版 Run 封存实际审核 preset、预算和工具行为绑定。新版自身冷恢复时据此重建，已经完成的检查只读原封存结果，不重新解释或触发 Provider；无法重建时返回明确的恢复失败。不保留旧 Run 设置重建或缺省值推断分支。

同操作合并、`reused_approval`、`parent_review` 继续复用原 Runtime/SQL；不扩大普通解释器脚本的跨调用复用资格。默认 `toolDispatchOrder:model` 保持，后序工具不能绕过前序待审操作提前产生效果。3 秒是待实施验证的产品默认，不是已经取得的性能结果。

## 4 后续授权的统一产品合同

人工卡默认选“仅此次”，仅展示当前可信策略能够提供和兑现的范围。所有后续授权仅作用于真实来源 Session，父、子和兄弟不共享；关闭窗口不清除已经保存的授权。沿现有授权目录查看出处和清除当前 Session 授权。

| 类别 | 后续选项 | 每次继续核对 |
| --- | --- | --- |
| Shell | 本会话内相同命令，沿现行完整可信 commandDigest | cwd、环境、runner/资产、文件/网络范围、timeout 与当前策略；不做前缀或模糊命令等价 |
| 文件 | 本会话内对此精确文件位置的 edit 和 write，两个真实定义显式绑定 | 当前普通文件/目录身份、位置、保护范围、baseline、内容冲突及当前模式 |
| worktree create | 本会话内同仓库、同 action，在本次展示父目录下创建直接子工作树 | 真实仓库与父目录身份、固定 base commit、原分支模式、目标不占用及原保护 |
| worktree remove | 本会话内删除本次精确目标，不含 create 或 force | 同仓库/目标、dirty/untracked/ignored、占用、引用保护与原清理规则 |
| 其他确需审批的类别 | 只有可信宿主已接入有限范围时提供 | 沿相应工具的实际范围、当前策略和恢复条件 |

create 选项把“批准父目录直接子项”明确展示给用户，不暗中从精确目标扩为全仓库。固定本次 base commit；detached 模式保持 detached，newBranch 模式仅允许创建尚不存在的新分支且原校验保持，不授权覆盖已有分支。create 不包含删除、force、递归目录或外部额外范围。

文件位置授权允许正常内容更新与原子替换，不把原 inode 固定成持久范围；本次 baseline 仍独立检查。初始文件不存在时只允许已验证父目录下的准确槽位，不额外授权创建整条未知父目录。范围无法描述时保留原单次路径。

选项展示有效会话、完整资源、action、包含工具及关键限制。长内容可折叠，展开须完整。答案只提交原 interaction/revision、decision 和 optionId，scope、bindings 和有效期不由客户端填写。授权失效、重复点击和回执未知沿原卡与原 command 查询处理。

## 5 最小可信规则与策略接口

### 工具行为的归属与注册

工具包同时导出实际 ToolDefinition/JobDefinition 和相应的行为描述工厂，随现有工具装配一起登记。行为配置采用代码与少量明确字段/回调，不建设新的配置 DSL 或执行协议。

| 负责层 | 自身定义的内容 |
| --- | --- |
| 工具层 | 真实效果与资源事实、快速放行条件、是否需要审核、审核材料准备及结果解释、可复用范围与展示；实际执行和恢复使用原 ToolDefinition.execute/resume 与 JobDefinition.start/observe/cancel/dispose/reconcile |
| 可信宿主与权限策略 | 根据实际定义对象及准确 kind/id/version 绑定行为描述，选择产品默认与审核预算，限制当前模式/信任/父子上限并组合判定；不重新实现 Shell、文件或 Git 的领域算法 |
| Loop/Interaction/通用存储 | 按统一允许/拒绝/check/approval 结果组织等待、冻结、接纳、撤销和派发，调用原注册执行器；不根据工具名选择其审批算法或执行方式 |

行为事实优先接入现有 `describeCapability(request, policy)`；领域审核适配器把材料、指引及模型原输出解释为通用检查请求、决定和证据，仍受当前 Permissions 限制。工具声明“希望免审”或提供执行器，不等于可以绕过全局权限。

本次触及的 Shell 快速路径、风险材料准备和风险输出映射归 Shell owner，Files 位置范围归文件 owner，worktree 范围与自身 Job 证明归 worktree owner。Runtime/Interaction 中相关领域选择改为调用已登记行为，相关旧格式适配分支由统一合同替换。不借本次任务清理无关展示或执行特例。

新增工具的接入步骤固定为：在工具包实现原定义/执行器和可选行为描述，在可信宿主装配中登记，然后补该工具自己的测试。Loop、Interaction 和通用 SQL 不为它增加工具名分支。缺少可选行为时沿原单次/通用策略处理，不要求每个工具实现全部钩子。

### 审核适配与 Worker 的通用回执

工具行为提供 `prepareReview` 和 `interpretReview` 两个可选职责，复用现有审核 Model 执行链。前者提供实际指引、材料和复用指纹，后者把完整原输出解释为通用 `approve_once/reject/ask_user` 与 reason。准确签名按原接口组织，不为工具增加第二套 Model 或执行协议。

Run 的配置快照按准确 kind/id/version 记录所选行为的 contractRef 与 configurationDigest，原检查请求也保存该绑定及封存输入。回调只由可信宿主重新装配，不写入 JSON，不从模型、配置文本或公开 API 加载。新版自身恢复时核原身份，不以当前工具行为重解释已经封存的检查。

本方案选择通用封存回执路线：实际选中 checker binding 的内部 Model 执行链，在完整 EOF、`finishReason:stop` 且零 ToolCall 后调用原可信解释器，将原输出和归一结果一同完成保存。回执逻辑字段为 contractRef/configurationDigest、checkExecutionId、target 的 Execution/attempt/inputDigest、sealedInputHash、必要的材料 fingerprint、完整 ModelOutput/content 摘要，以及通用 answer。内联和 Artifact 输出使用同一逻辑合同，沿原 result/Artifact 机制保存，不新增业务状态表或签名系统；具体格式变化按第7节确定。

SQLite Worker 不接收函数或模块路径，也不重新解释工具语义。它沿私有 owner 命令核验原检查/目标身份、原请求和 Run 冻结绑定、完整 ModelOutput 与回执的 scope/hash/来源，再消费通用 answer。模型输出、ToolResult 或普通 Extension records 不能自报该回执。取消、超时和已结束检查拒绝迟到回执，原判定不被改写。

新版记录只读使用原封存结果，不调用当前解释器或 Provider。缺少有效统一回执时按技术失败处理，不保留旧格式 reader。Shell 仍可输出 `risk/reason`，由 Shell 自身解释器生成通用 answer；核心不再为它保留独立 purpose/格式判断。原始风险文本和原决定作为新版结果一起保存。

### 后续授权的领域规则

领域规则与工具 owner 相邻实现，由 Service/Runtime 可信装配登记。普通 Extension、MCP 描述、配置文本和模型参数不能注册可信规则。沿现有构造约定校验重复 ruleId、未解析能力定义和不兼容合同，不建设可热加载插件平台。

规则只负责两件事：从本次真实调用和适配器事实计算有限适用 scope；提供同一 scope 对应的展示内容和准确能力 bindings。规范 JSON 复用现有工具，路径段和 argv 保序；只有明确的集合字段排序去重。

拟新增内部数据草图如下，准确命名与 owner 保持一致；草图不指定新的协议或定义版本值。

```ts
type GrantOffer = {
  ruleId: string;
  contractId: string;
  scope: Json;
  scopeDigest: string;
  bindings: readonly CapabilityBinding[];
  policyBindings: readonly {
    capability: CapabilityBinding;
    reuseRevision: string;
  }[];
  presentation: { label: string; details: readonly string[] };
};

type ApprovalOption =
  | { optionId: string; kind: 'once'; presentation: { label: string; details: readonly string[] } }
  | (GrantOffer & { optionId: string; kind: 'scope' });
```

`scopeDigest` 覆盖 rule/contract、规范 scope 及完整排序 bindings。`optionId` 仅为原卡的选择键；授权依据是原卡成员校验和冻结内容。展示内容不作等价键，但与选项一起封存。

### 可复用策略绑定

可信权限策略增加一个可选的内部能力：以真实策略快照、目标 capability 和候选 scope 计算 `reuseRevision`。它不构造假 write 请求，也不预判未来正文；它声明该范围可以满足本策略的常规人工批准，以及本策略明确允许被该授权满足的默认审核。审核覆盖许可由工具行为与可信策略显式给出并纳入稳定绑定；缺省不替代 checker，核心不根据工具名推断。

`reuseRevision` 来自明确结构：策略/配置身份、真实主体和 Session/Workspace、当前模式与信任控制 revision、能力/效果上限、rule/contract/scope 以及父子/宿主参与策略。单次正文、baseline、完整 inputDigest 和单次 decision revision 不进入该稳定结构，仍由当前调用完整保存和核验。不能从旧 revision 删除字段猜等价。

签发 edit/write 联合选项时分别解析两个真实定义、计算各自绑定；消费 write 时仅比较 write 的当前稳定绑定。原 edit 的完整 revision 保留为来源证明，write 保存自己的完整 revision。

策略没有实现该能力、当前存在不能被该范围满足的独立人工要求、或无法描述未来能力上限时，该方不提供可复用绑定。当前调用的硬拒绝、必要独立 checker 和业务 required 条件继续生效。无需新增通用 requirement ID/消除列表或策略 DSL。

### AND 合成

合成函数收集所有真实参与策略，包括已经 allowed 的一侧。每个 binding 必须从每一方得到当前范围可复用的稳定绑定，再按固定参与次序计算组合 `reuseRevision`；任一方不支持就不产生联合选项。双方待批时按完整 rule/contract/scope/bindings 精确相交；不能按标签合并或复制单侧宽范围。控制读集冲突、硬拒绝及独立检查继续沿原分支处理。

候选的“是否展示”和当前“是否允许消费”分别由宿主产品选择和策略许可决定。隐藏选项不改变已有 grant 的执行资格。Shell 同命令也使用该统一结构化合同，commandDigest 进入其 scope，完整本次 revision 继续约束各自执行。

### 规则更新的简化语义

规则采用静态可信装配，不保存整份 registryDigest/generation，不新建 Store 级激活 owner 或 CAS 接口。grant 绑定准确 ruleId/contractId 和能力定义；规则缺失或不兼容期间不消费，恢复同一兼容规则时，未撤销且满足当前策略的原授权可以再次使用。

这明确替代原 Word 方案的 A→B→A 永久失效要求。切换规则不是用户撤销；需要永久作废时沿现有 clear/epoch，已经 clear 的授权永不复活。语义不兼容的规则变化更换经确认的合同身份，不把它解释为兼容；工具/协议具体升级仍按仓库规则单独说明和确认。

## 6 冻结接纳与最终派发

原 Interaction 冻结完整候选、原 Execution/attempt、完整 inputDigest、完整 policyRevision 和控制读集。答案中的 optionId 必须属于原卡，源内容不在点击后重新解释。冻结使用隔离副本和持久 JSON，沿已有边界解析，不仅依赖 TypeScript readonly。

`answerInteraction` 先保存原答案；实际 owner 的 `acceptInteractionDecision` 再在原事务内保存接纳 revision、结构化 grant、epoch 和接纳事件。接纳失败时只回滚该事务，已保存答案保留。单次批准、拒绝、question、plan_review、Auto 普通通过和 Full 不创建后续 grant。

结构化 grant 复用原 grant 的 Store/subject/真实 Session/Workspace、原卡/原定义/原执行来源和撤销状态；来源定义不改成消费定义。当前实际定义必须是 frozen bindings 的成员。

当前调用消费时形成绑定本次 Execution/attempt/inputDigest 的使用证据，包含 grant/原 accepted revision、scopeDigest、当前 binding/reuseRevision、完整本次 decision revision、控制与必要条件读集及观察到的 Session epoch。证据只沿可信内部 owner 路径传入 Store，不作为公开 JSON token 或新的执行端口。

grant 命中后，若仍有必要独立 checker，继续检查流程，将准确 `checkExecutionId`/`policyEvidenceId` 纳入最终使用依据；所有剩余要求满足后才返回可派发结果。范围命中不能跳过仍未满足的独立检查或清除独立 `check.requireApproval`。被当前可信策略明确承认的默认审核已经由 grant 满足，不再创建该默认检查。

取得执行资源后，复核当前策略和真实资源事实，再进入原 `markDispatching`。SQL 验证原批准与冻结选项、当前范围和消费 binding、稳定策略绑定、epoch、控制、owner 和原有条件；在同一事务保存此次使用依据并标记派发。SQL 不运行领域 I/O。

适配器继续使用本次准备的目录锚点、句柄和 baseline；不因授权复用重建文件系统安全层。原范围稳定身份与本次完整事实分别处理：文件内容/baseline 变动可使本次请求冲突，不自动清除位置 grant；锚点、位置或 action 变动则不匹配。外部竞争能力保留原适配器的实际限制，不宣称 SQLite 能锁住文件系统。

clear 先提交则旧 epoch 阻止新效果；dispatch 先提交则原效果可能继续，撤销只阻止后续派发。取消、owner 丢失、已派发失败与 unknown 沿原恢复合同，不使用 grant 重放效果。

## 7 存储与公开接口

采用统一新版 grant 记录，复用现有 `permission_grant` 的来源身份、Session/subject 与 epoch 机制，保存 canonical 选项 payload 和 scopeDigest；能力与策略 bindings 在 payload 内作为小型闭合集合保存。不为保留旧记录另设旁路或双格式表，也不拆出多张 rule、registry、constraint、fact 表。

原持久 Interaction 的 frozen option 是批准来源，grant payload 必须与原选项完整匹配。查询按原 Session 和 scopeDigest 匹配，再检查 binding 与稳定策略；仍禁止跨多个 grant 拼接完整调用。性能仅在真实查询证明需要时增加具体索引。

公开审批请求统一使用 `options`。批准答案必须提交原卡的 `optionId`，拒绝只提交 deny；单次和范围选项由 `kind` 区分，单次不创建 grant。移除 `approval.grants` 和答案 `grant` 形式，不保留双答案解析。公共授权目录投影包含规则、资源、动作、真实消费工具和原批准出处；私有主体、owner 及完整策略证据不外泄。

CLI stdio、TUI、Native 同步接入同一新版请求/答案/目录格式，generated Client 由现有生成器更新。交付只验证这套合同，不提供旧客户端降级、字段映射或旧卡接管。

新版库结构与 Worker 资产按现有 reviewed SQL/checksum 和构建机制交付，使用新版独立库验证。旧库数据转换、旧记录读取和软件降级不在范围内；遇到不支持格式沿现有格式检查明确拒绝，不自动清空或改写现有用户库。实际工具定义或协议版本若需调整，仍须按仓库规则说明具体变更并取得确认；不展开旧版本适配设计。

## 8 领域接入细节

Shell 包装现行 commandDigest，完整保留 timeout、cwd、env、runner、定义、资产及执行范围语义；逻辑 key 和 description 沿原合同处理，不新做 trim、别名、前缀或脚本内容等价。

Shell 同命令作为一个工具层领域规则，与文件、worktree 共用 options/optionId、结构化 grant 和稳定策略绑定，不保留专用存储/消费分支。准确父 Tool→自身 Job 的依据改接统一 grant 引用，真实父链、命令与范围核验保持，不向独立 Job 共享授权。

默认 Shell 行为显式声明：有效同命令 grant 可满足其常规人工许可和默认 Auto 风险审核；该声明经可信策略及 AND 上限组合后才生效。grant 证明用户已批准准确命令，不记录为一次新的模型风险判断，也不伪造脚本材料已审核标记；固定危险拒绝和其他独立要求照常生效。

文件 scope 由现有适配器产生实际 Workspace/目录锚点、精确文件槽位和 edit/write actions，明确不递归。沿现有 no-follow、保护路径、内容 baseline 和原子发布能力；不为此增加新的原生文件引擎。不支持的对象或无可核实锚点不提供后续选项，原单次路径仍须通过原工具安全检查。

Worktree scope 使用真实仓库身份、action 和目标边界。create 绑定批准父目录直接子项、固定 base commit、detached/newBranch 模式；remove 绑定准确目标。原 Tool 的 prepare/mutation Job 继续走原证明桥，不把 bindings 扩为普通 Shell Job。每次必要的实际 Git/清理检查继续执行，不另建 worktree 审批状态机。

为兑现固定 commit，生成或消费 create 结构化范围前，由 worktree owner 做只读范围取证：解析 `baseRef`（省略时为来源 HEAD）的真实 commit OID，读取实际仓库和批准父目录锚点，冻结到 offer/本次使用依据并在卡片显示。该取证不提前派发 mutation，也不提前创建 executable 操作；复用原可信 Git/路径读取能力。

Tool 获准后的 prepare 仍产生实际计划。原 prepare/mutation 证明桥增加与本次冻结范围的比较：prepared baseOid、真实仓库、父目录身份、目标直接子项及分支模式都须匹配，才允许 mutation。若 HEAD/ref 或锚点变化，停止本次创建、保持零工作树变更并交回原调用者重新求权；不能按新值重解释旧批准，或失配后自动降级单次继续执行。原单次/Auto 免审路径保持原语义，不为它们增加无关的范围取证。

其他类别沿同一窄接口逐类接入；无明确可信规则的工具仍为原单次行为。未知 MCP 不以 annotations、工具名或参数 hash 推导资源授权。Skills 继续作为知识指导，不获得自签授权能力；已退役的 Workflow 执行能力保持退役。实施交付清单明确每类已接入或保持原行为，不声称所有工具天然支持。

## 9 模块责任与修改位置

| Owner | 主要修改 |
| --- | --- |
| Agent permissions | [原权限类型](../../packages/agent/src/extensions/index.ts)、[index](../../packages/agent/src/permissions/index.ts)、[inheritance](../../packages/agent/src/permissions/inheritance.ts)、[constraints](../../packages/agent/src/permissions/constraints.ts)；增加通用 grants 合同、行为接入与组合函数；现有 [Shell](../../packages/agent/src/permissions/shell.ts)/[search](../../packages/agent/src/permissions/shell-search.ts) 作为工具 owner 的领域实现接入，不成为新增工具时要扩写的中央分支 |
| 各工具 owner | 原 ToolDefinition/JobDefinition 工厂、Shell/Files/worktree 实现及其行为描述；领域分类、审核输入/输出适配、授权范围、实际执行/恢复均归所属工具层，不复制到 Service 或核心 |
| Agent execution/runtime | [interactions](../../packages/agent/src/execution/interactions.ts)、[runtime](../../packages/agent/src/runtime.ts)、[timing](../../packages/agent/src/execution/authorization-timing.ts)；接入通用工具行为、移出本次触及的领域审批选择，完成结构化消费、现有复用与最终证据接线 |
| 审核交接 | [Model 检查执行](../../packages/agent/src/execution/authorization-check.ts)、[输出回执](../../packages/agent/src/authorization-check-output.ts)、[SQL 检查](../../packages/agent/src/storage/sqlite/authorization-check.ts)；统一通用封存回执，移除旧格式适配，Worker 不装配工具回调 |
| Agent storage | [types](../../packages/agent/src/storage/types.ts)、[port](../../packages/agent/src/storage/port.ts)、[grant SQL](../../packages/agent/src/storage/sqlite/permission-grants.ts)、[接纳](../../packages/agent/src/storage/sqlite/interaction-operations.ts)、[派发](../../packages/agent/src/storage/sqlite/operations.ts)、[worktree 原桥](../../packages/agent/src/storage/sqlite/worktree-authorization.ts)、[迁移](../../packages/agent/src/storage/sqlite/migrations.ts)、[worker 资产](../../packages/agent/src/storage/worker/build-assets.ts) |
| Service | [权限装配](../../apps/service/src/permission-configuration.ts)、[配置](../../apps/service/src/configuration.ts)、[审核 preset](../../apps/service/src/authorization-check-model.ts)、[HTTP schema](../../apps/service/src/http/schema/index.ts)；默认预算、可信注册和公开投影 |
| Client 与 UI | 原生成 Client、[共享交互](../../packages/ui/src/interactions.tsx)、[TUI 审批](../../packages/ui/src/tui/approval-panel.tsx)、Native 原 Approval 组件与 [stdio](../../apps/cli/src/stdio-interactions.ts)；选项、原卡状态及目录 |

核心不依赖 Service，不向旧 `packages/agent-kernel` 回迁；领域动作与路径语义留在规则及实际适配器。

## 10 实施顺序与阶段验收

| 阶段 | 实施内容 | 完成条件 |
| --- | --- | --- |
| A 基线与影响 | 核实际 HEAD/diff，跑受影响原测试；确定新版公开字段与库结构 | 基线问题单独记录，具体需要的版本变更已说明；不 reset 现有工作 |
| B Auto 提速 | 独立低 reasoning preset、默认 3 秒、扩只读 `&&` 链，沿原复用/父桥和计时，封存实际配置 | 快路径零审核、普通请求最多一次新审核、超时/拒绝/取消和原批次顺序正确；新版自身冷恢复正确 |
| C 授权纵向闭环 | 工具行为/Run 绑定、通用审核回执、统一规则/稳定策略绑定、冻结选项、grant 存储、接纳/消费/撤销，连通一个客户端；Shell 同命令与 file edit→write 均覆盖 | 非内置审核格式经真实 Worker 完成审核/派发/冷读且不加核心领域分支；缺可选规则时走普通单次；跨工具复用与第三工具拒绝成立 |
| D 领域与客户端完整接入 | Worktree 批准前只读取证与 prepare/mutation 范围核对、其他已登记类别、CLI/TUI/Native 全部选项及授权目录 | 同一范围语义一致，HEAD/ref 漂移零 mutation；所有目标客户端使用同一新版合同，默认免审操作无新增卡 |
| E 必要联验与文档 | 执行受影响回归、真实模型性能对照和客户端全过程；同步负责文档 | 本目标范围全部实现、必要检查通过，准确记录平台/环境限制后收尾 |

B 与统一合同的只读准备可并行；同一文件只有一个实现 owner。C 必须覆盖 Shell 同命令和不同正文的 edit→write，证明两种领域共用同一机制。客户端随纵向闭环进入，不等所有后端完成后才发现选项不能正确表达。

阶段按已确认范围自主推进，不设置额外逐阶段审批。只在工具/协议具体升级等真实授权边界需要决定时提交具体影响；普通命名、文件拆分和测试夹具由实施者处理。Git stage/commit/push/PR 沿用户实际授权及主 Agent 唯一 Git owner 规则。

## 11 必要验证

沿现有测试 owner 增补下面的行为证据，不建立独立评分或安全台账。

| 场景 | 必须断言 |
| --- | --- |
| 工具行为扩展 | 新增非内置测试工具只增加工具包与可信装配，即可走直接允许、Auto check、人工范围及原execute/resume；Loop/Interaction/通用SQL无新增工具名分支，同名未受信工具不能借用该行为 |
| 通用审核回执 | 非内置审核输出格式经真实 Worker 核原绑定后派发并冷读；新合同缺回执/错合同/不完整输出/迟到结果不批准；冷读不运行当前解释器或 Provider |
| 新版 Run 配置 | 实际 preset/预算/行为绑定被封存；新版自身冷恢复与只读使用原保存结果，缺失绑定明确失败且不重发完成的检查 |
| 快路径单命令和 `&&` 链 | reviewer 调用为零；执行保持原短路；混入写命令/重定向/hook/未知语法回原审核 |
| 基本风险分类 | ordinary继续、high转准确人工、critical零效果拒绝；已经取得的拒绝不被迟到答案或超时改写 |
| 普通 Auto 和审核 preset | 一次新检查使用实际支持的 low reasoning/256 上限，业务 preset 不变；显式配置优先 |
| 超时与失败 | 3 秒预算覆盖等待/准备/排队；原 timeout_continue 与技术失败/取消/明确拒绝准确区分；迟到答案不能重新派发 |
| 现有复用和父桥 | 合格同操作/自身 Job 不重复审核；脚本和未知材料不因新默认放宽跨调用资格；独立调用不借父依据 |
| 统一批准和范围消费 | 单次选项不创建 grant，合法范围选项产生 grant；伪造scope/option、过期卡、其他 Session/主体失败；Shell/files/worktree使用同一消费路径 |
| 同命令授权与审核 | 有效 Shell grant 命中时默认 reviewer/重复人工卡均为零；加入独立 checker 时该 checker 仍执行，其拒绝保持零效果；缺少显式审核覆盖许可时不自动跳过检查 |
| edit→write | 新正文和合法新baseline可复用；write另一位置、delete、第三定义不匹配；内容冲突零发布 |
| 策略交集 | 所有参与方支持才复用；一方仅单次、硬拒绝、独立checker和控制变化继续限制；来源与当前完整revision各自保存 |
| Worktree | 同批准父目录不同直接子项的create命中；另一父目录/仓库/base/action不匹配；卡片后 HEAD/ref 从 A 变 B、父目录替换时 prepared 计划不能启动 mutation；remove及原prepare/mutation桥独立成立 |
| SQL撤销与恢复 | 接纳失败不留孤立grant；clear先于dispatch零效果；dispatch先于clear沿原事实；crash/unknown不自动重放 |
| 新版客户端 | CLI stdio/TUI/Native只读写统一格式；双击、断线、重开、原目录clear状态正确；不支持的输入明确失败 |

主要原入口：[权限策略](../../packages/agent/test/isolated/permissions/policy.test.ts)、[Shell 解析](../../packages/agent/test/isolated/permissions/shell-command-policy.test.ts)、[风险材料](../../packages/agent/test/isolated/permissions/shell-risk-facts.test.ts)、[执行 grant](../../packages/agent/test/isolated/execution/permission-grants.test.ts)、[存储 grant](../../packages/agent/test/isolated/storage/permission-grants.test.ts)、[Shell grant 父桥](../../packages/agent/test/isolated/execution/shell-risk-grant.test.ts)、[审核计时](../../packages/agent/test/isolated/execution/authorization-timing.test.ts)、[Service Auto](../../apps/service/test/isolated/auto-configuration.test.ts)、[stdio](../../apps/cli/test/stdio-interactions.test.ts)与[子 Agent 审批过程](../../tests/tui-system/scenarios/subagent-approval.test.ts)。新增文件按真实 owner 命名。

性能对照固定同机器、模型与命令组，覆盖单条/组合检索、普通脚本、首次高风险人工、后续复用及少量明确 high/critical 合成样例。风险负例使用记录适配器或隔离夹具检查真实模型判断，不真正执行危险命令。

记录 reviewer 次数及原 `prepareMs/queueMs/providerMs/totalMs` 的 P50/P95、冷/热差异和超时比例，分别报告模型已完成判定与 `timeout_continue` 样本，区分减少审核、模型判定加速和提前超时的贡献。若明显危险样例经常因 3 秒预算超时继续，先调整审核 preset 或预算，再确定实际交付默认值；不把超时比例上升当作有效提速，不增加固定评分门槛。快路径零额外模型请求、准确父链不重复是确定性断言，真实时延报告实际值，不用构建通过替代提速证据，不预设未经实测的百分比。

真实 CLI/TUI/Native 验收观察提交、等待、卡片接管、点击、重复点击、目录更新、取消、断线及重开全过程，核顺序、重复渲染、草稿和阅读位置。测试辅助只在隔离夹具开启，不增加普通客户端入口。开发交付只验本目标实际环境，不将整个发布资格扩为额外前置。

## 12 文档与完成边界

方案确认后按 `design_complete` 在产品与技术入口链接同一方案；实施中将已交付行为写回 [工具与授权手册](../handbook/features/tools-and-approvals.md)、[模型与配置](../handbook/features/models-and-configuration.md)、[权限 owner](../../packages/agent/src/permissions/README.md)、[grant owner](../../packages/agent/src/storage/sqlite/permission-grants.README.md)、Service/Client/对应客户端 owner，以及实际受影响的 [授权契约](../active/authorization.md) 和 [执行边界](../active/unified-agent-boundary.md)。重要取舍实施时按已有 Note 规范归位，现行正文不提前写成目标态。

本次方案交付运行文档结构/链接与影响检查，不要求尚未实现功能的运行测试。代码实施后按实际 diff 执行 targeted 整文件、typecheck、API生成一致性、边界/测试归属、格式与文档检查；影响恢复时补原 fault 回归，完成后沿仓库适用默认检查验收。不机械运行与改动无关的所有平台和发行流程，也不跳过真实强制门禁。

全部目标闭合后执行 `iteration_complete`，报告实现、验证环境与必要限制；计划知识归回 owner 后按现有生命周期处理。实施前明确3秒总预算、文件联合范围、worktree create父目录直接子项及具体工具/协议格式变更。它们属于同一份完整方案，不拆成日常审批。

## 13 三方独立审查

本轮由三个独立审查 Agent 分别核对完整草案和对应源码，主 Agent 整合修订。审查结果不等于代码实现或用户已确认，以下只记录本次请求的三方审查。

| 审查方 | 初审结论 | 纳入修订 |
| --- | --- | --- |
| 架构与授权链 | 无结构性阻断 | 明确结构化 grant 命中后继续必要独立 checker，并携原检查证据进入最终派发 |
| Auto 性能与体验 | 可落地，无阻断 | 明确先复用后新建审核、实际 checkOptions 参与身份绑定，分别报告模型判定与超时继续 |
| 产品完整性与简化 | 方向通过，需补基本风险验收 | 增加 ordinary/high/critical 回归及低预算的实模覆盖，保持 Workflow 退役，避免超时增加被当成提速 |

三方初审及当时修订复核均已通过。架构方确认独立 checker 和类型 owner 接线；性能方确认复用顺序、实际审核配置身份和时延样本区分；产品简化方确认基本风险覆盖与 Workflow 状态，未引入额外控制平台或审批流程。

用户随后明确工具行为扩展边界，第1、5、9、10、11节补强工具层配置、原执行接口复用、核心中立编排及新增工具不改核心的验收。该补充复用未受影响的原审查结论，并经架构方定向复核通过，无必修问题；不将先前审查自动当作新增内容已审。

再次全文续审核对了工具扩展、Auto/派发和范围/客户端合同；保留的修订包括通用审核回执贯穿 SQLite Worker，以及 worktree 固定 commit 从批准前取证绑定到实际 mutation。用户随后取消旧兼容性范围，已删除旧 Run 重建、双格式读取、双答案、旧客户端降级和迁移/降级要求，Shell 也归入统一结构化机制；早先审查中的旧兼容建议不再作为实施要求。新版自身恢复、原批准出处、撤销及 unknown 合同保持。该范围调整及统一合同已定向复核通过，无剩余必修问题。

最终范围全文终审：扩展/恢复与合同/客户端两路无新增必修问题；Auto 路发现同命令 grant 对默认审核的覆盖语义尚有歧义，已明确有效授权满足默认 reviewer、独立 checker 保留，并补对应零重复审核断言。该语义由工具行为和当前可信策略提供，不增加核心工具名分支。最后一项修订已经 Auto 方定向复核通过，本轮无剩余必修问题。

设计阶段文档验证：`bun run check:docs` 与 `bun run check:docs-impact` 通过；当时变更仅为本方案，未作为代码、真实模型、客户端或平台验收。用户确认实施后已执行 `design_complete` 并同步开发入口；实际交付事实归手册和 owner 文档。

## 14 当前实施核对

A–E 已按本次授权目标闭合。新版自身强杀恢复、旧库原字节拒绝、非内置工具的真实 Worker 回执、稳定策略交集、edit→write、Worktree 范围漂移零 mutation 与独立 checker 已有整文件证据，准确入口归对应 owner。本机验收不等于整个仓库默认检查全绿或完整发布资格。

真实模型对照与原失败样本归[模型测试 owner](../../tests/e2e/live/model/README.md#授权复用与审核性能)：目前证明减少审核次数，没有证明单次模型判定 P50 加速。CLI stdio、真实 80×24 TUI 与普通 Native 已逐步观察单次／范围批准、准确自身 Job、后续复用、目录清除、重复输入／点击、回执丢失、取消及同 Store 冷重开；Native 普通权限菜单的目录入口、长内容换行和原未知回执恢复已修复并实际核验，TUI 审批与目录的有限阅读窗口已实际核验。手动模式保原 Tool／Job 分层合同，未扩大单次批准。过程及适用边界归各客户端 owner。

终审又清除了已经禁产但仍保留的旧审核 reader／Store 适配，通用新版附件、Planning／Question 和必要投影保持。清理后完整 `test:runtime:fault` 为59项／392断言通过，覆盖六个原文件；真实 Worker、HTTP inline／Artifact、冷配置与旧格式原字节拒绝也已复验。待批卡目录的动态高度修复后，相关五个完整 UI 文件22项／341断言及真实 VT 过程通过；类型检查6508文件／9 projects、API生成一致性、边界、测试归属、格式与文档检查通过。

完整默认清单1018个原 job 已执行，保留原隔离、并发、exclusive 顺序及业务预算；本次格式所需的冻结选项、checker／behavior 快照、恢复模板与 baseline 夹具已按实际新合同修正并整文件复验，未减少原安全断言。完整默认结果未全绿，原红不被补验覆盖：本机代理、退役 Files 工具、旧错误说明与拒绝后 Run 状态等已在可靠 HEAD 实测复现；既有 Native private schema 11／12 与维护仅接收1–10不一致，以及其他独立安装、窗口夹具和完整产品链路的资格仍保留其原失败或未取得状态，不能一概标成已证基线。最后可能关联本次批准／恢复安全的疑项已逐一核实，没有本目标未修的必修问题。产品与技术文档已归位，`iteration_complete` 按当前目标范围核对完成；未 stage、commit、push 或创建 PR。
