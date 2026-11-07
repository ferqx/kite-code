# Agent Note: 扩展主动业务审批与工具权限分离

Status: implemented

## Problem

用户于2026-11-07要求 `/plan` 的计划实施在 Manual、Auto、Full 下均由人批准，扩展主动发起业务审批；计划批准不能顺带选择工具权限。原批准 mode 及局部 ceiling 混淆这两个条件，信息回执又要求等待前后完整权限快照相同，单纯切换模式就会使答案失效。用户随后明确：内置工具自行取得执行前确认后，只覆盖本次展示的调用及封闭内部步骤，不再重复进入普通人工／模型审批；计划批准仍不覆盖后续工具。

## Decision

沿用唯一 Interaction、Extension records、requirements 与派发链。Planning owner 保存准确正文、版本及 accepted informational receipt，提供自己的业务 gate/evaluator；Core 不按计划工具名解释业务。每个 Run 封存 Planning policy 和可信只读定义；只有原 Run 已登记的准确 `plan.required` 激活本地门禁。单独写计划不触发人批，显式 review 在展示前单调登记门禁。继承父 ref 保持父作用域，不变成子 Run 自己的规划意图。

计划卡只有 approve/revise/deny 和反馈，无 allowedModes、answer.mode、默认批准或执行模式 ceiling。三模式均人答；批准后各工具沿当前真实权限。修改不解除业务门禁，新版本重新批准，完成仍需真实步骤回执。初版拒绝仅返回未批准；用户后续明确拒绝计划应直接结束当前轮次，工具只返回简短拒绝说明，不再调用模型收尾。当前由 Planning owner 在原 accepted deny 后返回通用停止指令；原成功 Tool／消息与准确 root work 取消同事务保存，复用原 attached 传播、停止与清理，不按计划工具名新增 Core 分支。新消息独立处理，普通权限拒绝和要求修改仍保原语义。通用 `createBusinessPermissionPolicy` 仅组合 current 与 gate，执行范围只来自真实 current。

信息请求的原 `informationPermission` 保持原字节。答后另观察当前权限，SQL 独立核当前 controlReads CAS；只有当前控制竞争最多三次即时重读同一已存答案，不重发卡、不调用模型、不固定睡眠。硬拒绝、能力、来源、对象、refs、身份和取消变化各按原合同失败。动态登记只允许真实当前 Tool continuation 对同 owner 原有同身份 runtime_state 的新增门禁状态重新捕获；原持久决策、兄弟调用、计划正文及其他来源不重绑。

可信实际定义 owner 可声明 `executionConfirmation`。Core 在 planned、资源前沿原 approval once 取得准确人批，Full 也不代答。每一策略参与方用可选 `consumesExecutionConfirmation` 明确消费自己的软挑战；硬拒绝不发卡，未支持的独立 checker／人工条件在发卡前失败，内部新增不支持条件也直接失败，不补第二卡或审核。原本 allowed 的参与方仍保 owner 人卡。普通 question/plan receipt 不能生成这种证明或 Session grant。

首卡冻结当前 Execution/attempt/input/request/实际 owner binding，以及最多16个准确内部 Job 的 key、定义与输入。最终 SQL 独立核原 accepted approval/approve/once、source、refs、主体、同 Store/Session/Run/root work、真实 attached 父链和一次消费。已在父执行中登记的封闭 Job 可排队到父成功后派发；父 failed/cancelled/unknown 不可借用。额外步骤、不同输入、兄弟、其他 Run/Store 均不能继承。真实消费者由 FileRestore Action owner 注册，删除通用权限层按恢复工具名强制审批的分支。

人答不占进程／串行资源，持资源及其祖先事实贯穿嵌套 Action/Tool，违规立即失败，不自动释放并恢复任意适配器 lease。已派发效果按原授权收尾；后续派发读取最新已应用权限，仍核能力、信任、父子上限、来源、取消及最终事务。

2026-11-07 apply 复核收紧实现：AND／父子组合用本次实际返回的 PermissionDecision 对象关联各原策略决定，不用可选或复用的 snapshot 作来源键，避免并发覆盖并支持无 snapshot 的合法消费。Gate 先核当前硬拒绝，再以已读取的真实 Execution 准备声明；一次接纳后只保留原人答 proof，资源排队与模式刷新不再重新生成声明，旧权限／审核缓存仍清除并重读当前策略。原卡实际确认正文须与 requestDigest 一致；Gate 核完整材料，最终 SQL 独立核 inline 正文或原 Artifact 不可变登记。各守卫保护不同 authority，保留独立核验；普通扩展没有 Store 写入资格。原 owner binding 解析复用通用合同，保留既有512长度，不另设256限制。

保持 `/v1` 原位替换字段、Store formatMajor 1、内部自动审核回执 version 1 和现有 Tool/Job/worker 版本，不新增表、Store 方法或执行循环。当前 request/answer/proof 只使用无 mode 合同；不保留旧 mode 的类型、响应 schema 或 Native journal／维护读取分支。旧冻结 Planning binding 不兼容续作时明确拒绝，不迁移、重算或清库；原始历史材料不因删除 reader 被改写。

2026-11-07 用户明确未投产期间只将本次改造涉及的版本统一为1，上述编号覆盖原先 Store／审核回执升2的决定，不回退实现。当前完整 schema、行为与准确 target／输入／输出摘要、归一答案和 SQL 派发核验保持。历史 major 1 缺当前 schemaChecksum 的 Profile 在 SQLite 打开前拒绝，保原 WAL／SHM 字节；伪造当前指纹仍须通过数据库实际 schema/checksum，不能借编号重用恢复旧审批 reader。当前本机开发库仅在已关闭且独占、完整 schema 与原 checksum 确认匹配后重标 major／准确 checksum／清单指纹，26张表其他事实及 Store ID 均保持；不形成通用旧库迁移入口。

2026-11-08 全仓复核：移除无生产消费者的全局 plan approval 副本，保留原 Run 不可变证明与上下文投影。普通 Run 不再登记仅属于 runless 文件恢复 Action 的确认 binding；全局准确 Action owner 及 SQL 消费保持。冷恢复子 Agent 时由 Core 传入已核 carrier／Session／Store／root work 的原 Run，宿主据此重建同一业务门禁，不能从当前轮次或兄弟调用猜身份。

产品与当前接口分别归[计划手册](../../../../docs/handbook/features/planning-and-tasks.md)、[授权手册](../../../../docs/handbook/features/tools-and-approvals.md)、[Planning owner](../../../../packages/agent/src/business/planning/README.md)、[权限 owner](../../../../packages/agent/src/permissions/README.md)和[Interaction owner](../../../../packages/agent/src/storage/sqlite/interactions/README.md)。本决定承接[原授权复用方案](../../../../docs/plans/2026-11-06-approval-reuse-and-auto-review.md)的可信工具规则、单一路径及不消费旧合同路线；会话范围授权仍按[结构化 grant 决定](2026-11-06-structured-session-grants.md)独立核验。

## Alternatives considered

- 把 Full 加入 allowedModes：仍把业务决定与权限选择耦合，保留第二个 ceiling。
- Core 按计划／恢复工具名发卡：将业务规则放回核心，其他扩展无法沿同一能力使用。
- 新业务审批表、审批器、交互 kind 平台或第二执行循环：现有端口和事务足够，新增状态放大恢复与维护成本。
- 删除全部权限/freshness 校验：会忽略硬拒绝、能力、来源、准确对象和取消。
- 把信息 receipt 变成 grant，或让 Auto／Full 代答：扩大人答范围，违反业务与工具许可独立的要求。
- 为所有自定义策略隐含跳过 checker：不能证明独立条件已满足，采用显式本方消费且不支持时立即失败。
- 用 snapshot 充当策略决定身份，或刷新时重做 owner 声明：snapshot 可缺失或复用，声明可随准备变化；改为本次决定来源与原已答事实各自绑定，当前权限仍重新核验。
- 内部调用一律免审：无法约束额外步骤及重复效果，采用首卡前有限冻结和最终一次消费。
- 自动释放正在执行的资源后等人：任意适配器不能通用暂停，采用资源前确认与持资源 failfast。
- 转换旧 mode proof、重算原记录或长期双 reader：破坏原证据及不兼容旧任务边界；不保留旧 mode 专用 reader，不授执行权。

## Consequences

权限模式与计划批准可以独立改变。普通 Native 没有文字 `/plan` 解析，其“先审核计划”仅为隔离 Diagnostic 入口，普通构建关闭；普通 Native 使用已启用 Planning 工具主动 review，TUI 保留真正 `/plan`。Native 等计划／问题时保留独立权限与停止入口；未知答案只查原 Command，不重投。该能力不让任意扩展直接 I/O 自动取得派发权，也不对未提供 controlReads 的自定义 adapter 冒称 SQL 原子保证。

2026-11-07，macOS arm64／Bun1.4.4，`fb4bebd0` 加本次工作树：确认／嵌套／等待／计时／模式五整文件57项405断言；信息／SQL安全等四整文件53项973断言；默认消费者与信息25项316断言；Planning三整文件30项323断言、Service三整文件12项202断言；Native bundle／工具栏／配对恢复20项594断言通过。全仓6543文件／9项目类型检查通过。新私有模型报告的文件名日期沿用自有命名，实际运行日期按原时间戳核对。

此前3402个非 Markdown 文件／`2273a30b…` 源码的真实 `gpt-6-luna/medium` 新13场景、运行中放宽及补充收紧的三个主体均通过；业务低信任错误参数的准确拒绝仍保留。13组 reviewer low/default5000 的准备26～35ms、queue 0、Provider1547～1935ms；178次派发 RPC P50/P95为3/6ms、最大9ms。Native/CLI/TUI各三模式实际观察卡、回答、独立工具权限、丢回复原查询、效果、正常退出及冷读零重放。首轮模型误用 shell_id 和原收紧探针提前并行的 failed 均保留，不改 gold 或回写成功。当前测试入口及原证据边界归[模型验证](../../../../tests/e2e/live/model/README.md#计划业务人答与当前工具权限)和各客户端 owner。

2026-11-07 本轮 apply 复核后的3404个非 Markdown 文件／`e4d8736a…` 源码：核心九整文件97项／1022断言、消费者六整文件42项／591断言、固定业务入口整文件15项／118断言通过；6545文件／9项目类型检查通过。新真实13原场景为11整例通过、1模型遗漏业务完成、1模型错误摘要后循环并准确取消，原失败保留；后者没有到达原计划卡及待回答模式切换阶段，未取得该方向新真实资格。运行中放宽和收紧均核主／general／explore 当前权限、原 Job 授权收尾与附着终态；收紧样本中模型额外发起了不同调用，每个准确 Execution 独立审核与执行一次，不是 Core 重放，该样本不证明业务只发起一次探针。完整原始结果、时延、清理和有限资格仍归[模型验证](../../../../tests/e2e/live/model/README.md#计划业务人答与当前工具权限)。

这些结果不证明所有工具、模型、输入或平台的99.99%长期正确率。原非本机平台、完整安装及发行资格保持各自范围；本次没有用旧三万次固定批次代替新合同真实验证。
