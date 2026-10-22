# 权限策略与 Shell 授权

默认产品策略声明可信 `toolDispatchOrder: model`，由 Agent 冻结为 Run 的批次准入顺序；审批等待不能让后续免审工具提前派发，拒绝取消真实未开始兄弟。实际 dispatch 后仍可并发执行，不增加累计 Tool 数量门槛。子权限与 planning 包装保该标记，Service 只透传装配；自定义 Permissions 没有声明时保通用独立并行能力。普通已知参数／策略失败仍可交给模型纠正，不能混同用户明确拒绝、未知效果或取消。

本模块拥有 Kite 的三策略规则与 Shell 命令分析，公开入口为 `@kite-ai/agent/permissions` 和 `@kite-ai/agent/permissions/shell`。Service 读取可信宿主事实并装配这些工厂；HTTP、客户端和配置正文不产生权限。用户合同归[工具和授权](../../../../docs/handbook/features/tools-and-approvals.md)，本次边界及证据归[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

[index.ts](index.ts) 的 `createPermissionPolicy` 接收 `readPolicy/describeCapability/readCheckContext?`，按请求批准、自动审核、完全访问返回通用 `PermissionDecision`。当前模式、工作区信任、真实能力、控制 revision 与准确命令身份共同参与摘要。硬拒绝先于模式；旧 raw `ask` 拒绝。import 和工厂创建不读取宿主资源，真正审核、人工决定、原接纳与派发复核继续由 [Execution](../execution/interactions.ts) 与 Store 执行。

`CapabilityDescription.internalRecordOnly=true` 是可信分类事实，只接纳非空且全部为 `read/record_write` 的效果，并进入原 revision／快照摘要。硬拒绝、真实注册、信任和控制核验仍先执行；普通 `record_write`、unknown 或混入 external／process／network／workspace 的描述不能借此免审批。默认 [Task classifier](task-request.ts) 仅匹配完整且未覆写的有限正式角色声明、原请求输入和实际已注册定义；custom 配置来源仍保守。Service 只装配实际来源，Model 的角色名或配置正文不授予这项事实。前台与后台结果处置归 [Task owner](../extensions/task/README.md#前台完整结果与后台处置)。

[check-context.ts](check-context.ts) 的 `createPermissionCheckContextReader` 通过只读 Runtime 接口核实际 Execution／Run／Command／Session／Workspace、主体、root work 和真实 carrier 父子链，形成 `rootUserTask/parentUserTask/isChild/role` 及准确计划观察。身份或来源不完整时返回 unknown，不按同名任务、客户端标签或 fixture 元数据推导。读取前后核取消；审阅材料只保存稳定 Run 身份，不把自身审批等待进度纳入请求绑定；Core 仍独立核当前 active／取消／fencing。历史拒绝只取同范围中其他执行的已保存拒绝，不将当前被审核执行的结果反向加入自身请求，保证完成后的绑定复核仍是同一审阅材料。task、plan 和历史拒绝原因始终是低信任审阅材料，不是授权或派发命令。

父子权限交集沿 [Runtime.childPermissions](../runtime.ts) 保留每一方的实际策略。自动审核策略同时提供 check 和审核不可用时的人工 fallback；fallback 不表示每次审核成功后还必须人工批准。只有某一方明确 `approval` 且没有 check，或 check 明确 `requireApproval=true`，才形成强制人工 ceiling，与原 [constraints](constraints.ts) 的组合规则一致。真实 checker 的 `approve_once` 仍不能覆盖硬拒绝、父人工要求或 Workflow minimum；审阅失败继续走原人工／拒绝合同，不制造自动成功。

审核返回 `ask_user` 后，真实人工接纳只提供原 Interaction 的决定证明，不产生 check grant。[Execution](../execution/index.ts) 保留同一 policy revision 下准确审核引用供最终请求复核；缺少人工证明仍拒绝派发，revision 改变仍丢弃旧引用。这样最终资源内核验不会因丢失引用而重复启动审核，也不会把审核建议当成人工批准。[child 整文件](../../test/isolated/child/bindings.test.ts)核真实人工前零效果、去除人工证明后的 Store CAS 拒绝与原 cursor 不变，以及完整证明下仅一次派发；审批、动态模式和真实崩溃回归继续保留各自最终核验。

子孙的审批模式沿真实根 Session 当前 applied 控制动态读取，`accept_edits/auto/full` 在同一 Run 内双向生效；Service 的 `permissionPolicy` 注入保留能力／信任上限，`permissions` 注入保留额外硬拒绝与明确人工要求，均不能取代根当前模式及派发 read set。局部模式不传播到其他根，单次和同命令批准仍绑定原 Session／Execution。已派发效果保留原真实授权，不因切换模式重放或声称 OS 范围已热修改。

[InteractionGate](../execution/interactions.ts) 和 [Execution](../execution/index.ts) 通过已有持久 change cursor 等待模式变更，人工／审核／资源等待都在原未派发 Execution 重核；通知丢失或 cursor 压缩只触发事实重读。旧卡保留原 request、source 和 answer，准确 `interaction.invalidate` 回执记录 `permission_policy_changed`，旧按钮以 cancelled 失效，不伪造批准。原审核由 `authorization.invalidate` 记录准确 target／check／当前策略；SQL 仅在当前策略回执匹配时忽略该旧要求。资源先释放再重新审核／请求人工，不持有执行资源等待答案。只有可证实的持久模式变化允许这条重判路径；任意业务 revision／审核正文变化、信任撤销、取消、fence、拒绝及 unknown 保留原失败关闭合同。

[动态模式测试](../../test/isolated/execution/live-permission-mode.test.ts)使用真实 Runtime／SQLite，覆盖原卡自动关闭、最终派发竞争、未消费批准、迟到审核、资源等待、三层可信子权限、另一根隔离及只读拒绝；[Service 权限装配](../../../../apps/service/test/isolated/permission-configuration.test.ts)另核默认和注入策略的实际 SDK 请求、同 Run 模式切换及文件效果。测试不替代完整客户端卡片显示或所有平台恢复资格。

同一整文件另在主 Agent 与第三层 child 的原 active Run 中先持有已经派发的首工具，再收紧模式并核下一工具仍 planned、零新效果，准确批准后仅派发一次；同时覆盖三层 child 的资源等待双向切换与 Auto 迟到批准。审核场景沿原 generator 关闭与 check Command 终态同步，不用固定等待代替旧审核结算。已派发工具不因模式变化被取消，下一工具必须绑定新根控制 revision。

[files-request.ts](files-request.ts) 只为准确绝对路径 Files Tool 版本1建立当前物理父目录和目标身份摘要，并校验最终实际 `dispatchAuthorization` 的全部父子叶证明。身份由 Files 引擎的可信 `inspectIdentity` 提供，Windows 不把 Node stat 身份与原生 volume／128-bit FileID 混比；派发重核使用实际已锚定的父对象。请求批准模式对外部写入要求人工；自动审核交实际模型决定；完全访问只移除普通审批，仍保 protected/private、危险目标及未合格平台拒绝。读与 mutation 的完整路径、CAS、checkpoint 和实际 Windows 验证范围归 [Files owner](../tools/files/README.md#绝对用户文件)。

本次 macOS 当前工作树复用 [policy](../../test/isolated/permissions/policy.test.ts)、[Task 分类](../../test/isolated/permissions/task-request.test.ts) 和 [只读审阅上下文](../../test/isolated/permissions/check-context.test.ts) 的实际叶证据；另运行 [Task 整文件](../../test/isolated/business/task/task.test.ts)，11 项、74 断言通过，其中真实父人工／子自动组合证明审核后零效果、实际批准后效果一次且不重放 checker。原 [subagent 终端整文件](../../../../tests/tui-system/scenarios/subagent-approval.test.ts) 9 项、120 断言通过，证明自动审核实际外部写入与人类拒绝／取消。局部证据不代替全体客户端或发布门禁。

[capabilities.ts](capabilities.ts) 的 `builtinCapability` 统一实际 Tool、Job 与 Action 的固定效果和 safeRead；权限装配与 `workflowCapabilityDescription` 使用同一份分类，Shell 工厂也复用原 Shell 分类。Workflow 的 Job 三维 unknown、最低人工审批和未知 Files 的保守 write 投影保持，不能据此给执行策略补写入授权。MCP source/auth 分类只接收宿主原三个已注册定义 ID；Service 仍提供实际注册、选中 server、transport 可用性和网络配置事实。[constraints.ts](constraints.ts) 组合当前策略与原计划约束、Workflow 最低人工审批、明确文件恢复审批。宿主提供已校验的原状态和身份，约束不能放宽硬拒绝或改变原授权范围。既有 reason、revision/快照格式、单次与同命令授权、取消/恢复语义保持。

Web 固定效果也由同一分类提供：仅准确 `builtin.web/web_fetch` Tool 版本1返回原 `network/unknown`、`safeRead:false`，宿主必须传实际注册版本；同名外部定义、不同 kind 和未知／缺失版本保持 unknown。Service 的 Web 工厂只组合可信网络 policy、原 revision 与 hardAllowed，默认权限登记和 Workflow 投影共用这份 Agent 规则，不再各自覆盖或解释 Web 效果。Task 固定效果沿 `taskToolCapability`，Service 装配对象的无正式调用者 `describe` 转发已删除；原角色、选择、after-turn 与效果期望保持。

[after-turn.ts](after-turn.ts) 的 `createDefaultAfterTurnPolicy` 统一默认 Task／follow-up 结果汇报许可。宿主只提供冻结角色 id/version 与当前可信 policy/trust/controlReads 读取；本模块核 request/apply 的原 Command／Run／Session／Execution／role／source／root work、取消／删除与当前信任，生成原 revision 摘要。工厂不执行 I/O，authorize 保原读取前后 signal 检查；它不授权 Task、carrier、报告 Model 或递归 report。Core 激活、报告应用和 SQL 最终 CAS 仍核独立事实，不能合并成这次策略读取。完整正式 Service 消费者及原纯策略断言保留在[原默认整文件](../../../../apps/service/test/isolated/default-after-turn.test.ts)，无需平台 skip；下层完整 Task 场景由 [Task owner](../extensions/task/README.md#task-的-after_turn)维护。

Planning 默认宿主直接调用 `createPlanningPermissionPolicy` 并提供原状态 reader，原 Service 转发工厂和重复 options 已退役。当前策略判定先于 required/run/state 检查，普通 required=false 请求不读取计划；其他请求仍使用当前真实绑定与原 constraint，不缓存一次状态来代替派发复核。

[shell.ts](shell.ts) 的 `createShellConfiguration` 接收 Workspace、选中工具及可信平台路径/环境，检查原资产后装配普通 Shell Tool/Job。输入请求与实际授权分开；`hostExecutionScope` 只读取最终已接纳证明，逐维求父子文件系统和网络交集。命令摘要绑定原命令、范围、环境、配置和执行/解析资产，真正启动前重核资产与硬拒绝；原 8192 proof 上限及失败关闭保持。Service 不保留策略或范围解释副本。

Shell 工厂通过本包既有 `@kite-ai/agent/jobs/shell` 与 `/shell` 公共入口装配，保留 Job 的独立构建和资产位置。这里用包内相对导入会使 Bun splitting 将 supervisor 定位函数提升到根共享 chunk，破坏基于 `import.meta.url` 的原相对路径；真实源码树外制品测试已证此失败。保留 public entry，而非增加资产回退或放宽校验。

Shell 与绝对路径 Files 的最终证明共用内部 [dispatch-scope](dispatch-scope.ts) 遍历器，只解释原 permission-intersection 的 version、parent/child 顺序与最多8192节点。遍历逐叶交回原调用者，保留原错误顺序；Shell 继续独立核 Job 和 filesystem/network 交集，Files 继续独立核 Tool 与准确 target revision。`allowed:false` 的已接纳审批挑战不在遍历层改成硬拒绝，遍历结果也不建立新 grant。[消费者回归](../../test/isolated/permissions/dispatch-scope.test.ts)核双上界、叶身份、8192边界、错误顺序及原错误码。

[shell-command-policy.ts](shell-command-policy.ts) 使用本包固定 `tree-sitter-bash 0.25.1` 与 `web-tree-sitter 0.25.10` WASM。有限字面量 AST 与危险扫描分开，保原 cwd 分支预算与资产完整性校验；动态或不透明命令不取得安全证明，由实际系统范围约束，越界失败不自动扩权重跑。两个公开 entry 均进入本包 build；正式制品按 Agent manifest 复制完整解析依赖。

绝对分析路径保自身语义：盘符及反斜杠 UNC 按 Windows 解析，POSIX 绝对路径按 POSIX 解析，相对 cwd 才使用宿主实际目录。POSIX 的 `//etc` 保原系统目录归一化和极危险拒绝，不因测试宿主或 UNC 猜测改变结果；已确认的 Windows UNC cwd 在后续命令中保持其语义。三端共享测试同时核盘符危险目标和 POSIX 双斜杠拒绝，支持 Shell 清单、审批模式及危险路径集合保持；这些纯解析结果不补齐 Windows 实际 Shell 后端资格。

[原策略测试](../../test/isolated/permissions/policy.test.ts)、[独立解析与资产篡改测试](../../test/isolated/permissions/shell-command-policy.test.ts)、[独立范围测试](../../test/isolated/permissions/shell-scoped-permissions.test.ts)从原 Service owner 迁入，原用例及断言保持；策略测试另通过真实 Core 核同名扩展不能借只读权限、Workflow Job 不降格。实际 macOS [Service Shell](../../../../apps/service/test/isolated/shell-configuration.test.ts)和[网络审批](../../../../apps/service/test/isolated/web-permissions.test.ts)继续验证正式调用链。边界检查沿公开导出和 barrel 拒绝本模块反向依赖 Service、Service 直接解析依赖或重新实现原工厂。

Linux/Windows 真实执行依用户安排后置，Windows 正式 Shell 后端仍缺失；发布 RSS 稳定性、完整 Runtime 观测资格及 V1.3 阶段退出门禁保留。当前开发阶段的正常运行和内存稳定证据不等同于取得这些正式资格，源码迁移和本机通过也不解除它们。

[真实 pending approval SIGKILL 回归](../../test/isolated/recovery/live-approval-crash.test.ts)在审批卡和原 planned Tool 已耐久后杀死自有进程（核 SIGKILL/137），只读重开保持原卡/Run/执行和 cursor、模型 ledger 不增长。随后持久根模式由请求批准改为 Full，冷 Runtime 观察仍不准备 Provider；错误主体显式恢复被拒，准确原 Run 显式恢复才读取当前 applied control revision、同事务失效旧卡并派发原 Tool。外置 ledger 核原效果一次、已成功原 Model 不重放、重复同一恢复不增效果；原 request/source 不变、answer 仍 null，唯一失效回执保准确原revision/当前controls。该 fixture只验证这一实际进程丢失与模式变化边界，不替代其他平台或所有自动审核崩溃场景。
