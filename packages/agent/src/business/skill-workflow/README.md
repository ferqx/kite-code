# Skill Workflow 业务扩展

[`@kite-ai/agent/skill-workflow`](index.ts) 显式注册既有 Workflow 行为；[知识 leaf](../../skills/README.md) 继续只负责可加载知识。工厂不扫描目录、打开 Store 或执行脚本，Core/Loop 不解析 Skill 状态。默认宿主接线与可信配置由 [Service](../../../../../apps/service/README.md) 负责。

## 契约与激活

[编译器](../../skills/workflow-contract.ts) 读取显式位置的完整 YAML Workflow Contract，使用 Ajv 验证对象 input/output schema，合并实际依赖的风险和最低审批，保存文件、依赖 revision 与 canonical root/dev/ino。缺能力、坏契约或来源漂移属于该 Skill 的局部不可用。引用读取走[原来源与资源校验](../../skills/workflow-contract/reference.ts)，不执行声明脚本，不按旧固定引用数或正文大小截断。

不可用 descriptor 仍是有效持久 JSON；没有有效契约时省略 provider 的可选 version，不保存 `undefined`。同一可信目录可以混合普通知识、坏合同和合法 Workflow，局部诊断不会使无关合法激活的 Run 配置无法落库。

每份 schema 独立编译其注册表，相同 `$id` 可在不同 Skill 重用，跨 Skill 未声明的 `$ref` 不借用另一份缓存。异步 Ajv 扩展被明确拒绝，Promise 不能被同步验证误当成功；标准 Draft-07 的局部引用、条件和组合约束仍完整执行。

`skillActivation` 与 `skillWorkflow` 均为 true 才能激活；`verification` 是独立准入开关。启用核验时，effective effects 中的 write/destructive/unknown 要求 required；否则使用原契约 mode。关闭核验仍校验完整 output schema，且不抹除已经在 Run 中登记的义务。

公开 `run.start/input.follow_up.extensionInputs` 保存原具版本扩展意图。Workflow 使用 `builtin.skill-workflow@1` 与 `{activations:[{key,skillId,input}]}`；版本、重复项、结构、可用性与输入均在初始化前检查。initializer 只创建原 Run 下不可变 executable activation records 和必要条件，不调用 Model/Tool/Job。动态 `activate_skill` 通过同一普通 Tool 路径创建同类记录，同 key 仅允许同原意图。用户已初始化的 manual-only activation 可由模型用原 key 启动 fork，不因此获得创建其他 manual activation 的资格。

初始化记录只保存 Skill revision、原输入摘要、激活身份和核验义务，遵守通用 initializer 的 32 KiB metadata 边界。完整契约由可信配置封存，完整用户输入仍在原 Command 与 Service 快照中；冷绑定由宿主从原请求重建 `initialActivations`，使用前逐次核对 anchor 摘要。进程内输入缓存不是持久权威，缺失或不符时拒绝执行。动态激活的完整输入归其普通 Tool 记录。超过 1 MiB 的指令和超过 32 KiB 的有效输入通过原 Artifact 正文路径完整进入 Model，不截断或增加正文配额。

目录只贡献封存摘要。用户初始化意图在首次 Model 前贡献原输入、inline 指令与输出 schema；动态 inline 激活把完整指令、输入和 schema 放入真实 ToolResult，交给下一次原 Loop。capture 仍二次校验活动或待核验 Skill 的原文件和依赖，但内部 anchor/head/attempt/proof 更新不改变 source 内容，不跳过 Runtime 对其他来源、权限和用户输入的新鲜度检查。已满足原核验或准确 waiver 的历史契约不因为后续文件变化重新成为活动约束。

## 普通执行与证明

活动必要条件按真实 kind/id/version 限制 Tool/Job capability ceiling。已 closed 但 required 核验失败的尝试继续保留原 ceiling、最低审批及来源新鲜度。runless 子 Job 沿原同 Store/Session 的 parent Execution 追溯归属；不同 child Run 的实际权限由可信 child resolver 缩小，不能在 prompt 声明能力范围代替授权。生命周期豁免限准确 Tool@1；fork opening 封存实际 activate/repair/decide carrier 的定义、输入摘要、原 Store/Session/Run/head/attempt 与可信角色版本。

fork 使用普通 `operations.ensure` 的 Agent carrier 并等待原结果。完整 UTF-8 Artifact 按准确 execution scope 读取，正文必须是单个符合原输出 schema 的 JSON 对象，代码围栏、数组、截断或无成功结果均拒绝。closed 绑定原 carrier、result revision 和完整输出摘要；后续 `complete_skill` 不能手填另一对象冒充子任务成功。fork 失败保存 invalidated，不能再关闭。

不可变 activation anchor 位于原 Run namespace，`<anchor>/head` 只以实际 revision 做 CAS；独立 `<anchor>/attempts/N` 保存 opening、closed、verification、operations 与 invalidation。初次 attempt 是 1，complete/verify/read_reference 省略 attempt 时始终指 1，不能指向后来 head。`complete_skill` 保存不可变结构化输出；`verify_skill` 查回准确原 proof 或启动该 attempt 的一次普通核验 operation。schema proof 绑定原生命周期 Tool 与完整 output digest。script proof 绑定原 operation、Job/parent、输入摘要、定义版本、attempt、output digest、result revision 和实际结果；failed/unknown 不能满足 required。Job 自身终态不等待尚需由父 Tool 写入的 proof，最终 Run completion 才核该完成义务。原 operation 的等待以有限观测窗口继续查同一项，人工审批或正常子任务超过一次窗口不造成隐式重启；取消和来源变化仍拒绝继续。

[脚本 verifier](verifier.ts) 接受可信已编译 entries 与 Shell 装配，普通 Job `skill.workflow.verify@1` 的闭合输入是 skillId/revision/activationId/attempt/outputDigest/output。start 重核正安全整数 attempt、完整 canonical output digest、原来源、依赖、输出和 script strategy，在原 canonical root 用固定 Bun 执行原 entrypoint，不接受模型提供 command/cwd/env/path。观察、取消和 dispose 复用原 Shell guardian；超时等待真实停止结果，未确认停止仍保 unknown。它不建立隐藏 Provider、Loop 或补偿调度器，也不把进程监督称为文件/网络沙箱。

正式macOS／Linux Service verifier传入已封存host配置，执行cwd仍是原Skill根，写范围独立绑定原Workspace；最终scope核准确`skill.workflow.verify`策略。Profile来源在原完整revalidate后，由可信工厂把准确canonical root作为私有`readOnlySourceRoot`交给host，JSON／模型不获得这个选项。它只开放原Skill子树与必要祖先metadata，保原相对导入、package resolution和忽略目录资源；整个其余dataRoot／coordination仍不可读，来源不可写／移动／native exec-map。Workspace来源不新增只读限制。目录投影不表示被忽略文件进入原revision摘要，也不增加任意同UID外部替换的保证。

默认macOS verifier已切到完整coalition后端，正式调用者不再选择原group路径；显式无host的程序化POSIX装配继续保其有限group合同。明确Linux配置缺host／错误平台拒绝，无group fallback。Linux独立tmpfs祖先链与原来源只读bind在业务gate前由init逐项封RO／NOEXEC／NOSUID／NODEV；其实际Linux运行资格仍待重构后的原生验收，不能用macOS或mock代证。来源投影边界归[Jobs owner](../../jobs/README.md#profile-skill-的准确只读来源)，取舍见[原来源决定](../../../../../.agents/notes/implemented/architecture/2026-10-10-profile-workflow-read-only-original-source.md)。

verifier 从公开 `@kite-ai/agent/jobs/shell` leaf 取得进程实现。完整包构建保留该依赖边界，使 guardian 始终相对于所属公开 leaf 定位；不把带相对资产路径的实现复制到任意共享 chunk，也不回退源码或系统安装目录。

anchor、head、opening、closed、operation、verification、decision 和 invalidated 都是本 namespace 的 executable records。条件读取包含 current head、原 attempt、原失败与用户决定，最终事务核原 Store/revision；replan 的新 opening 仍依赖原 accepted question。可信 child resolver 的 scoped record 读集由 Host 自动封存，并在新 carrier 创建及 child activation 的最终事务重核，不以进程预检替代 CAS。Run 私有记录在 Session fork 时明确 omit，不复制旧执行资格。

## 修复与用户决定

`repair_skill@1({activation_id,attempt,detail})` 只从准确已失败的原配置 verifier 建立一个新 attempt，detail trim 后非空；inline 返回完整原输入、指令及 schema，fork 启动准确新普通 child carrier 并读取其完整结果。旧输出与失败永久保留，迟到或缺省的旧 complete/repair 不能关闭或推进新 head。已派发外部效果未知、source 无效或原证据不可核实时，不借 repair 盲重做。

`decide_skill_verification@1({activation_id,attempt})` 由可信 factory 的版本化 `userDecisions` 决定是否提供 replan/waive/compensate；Skill、JSONC 和 Model 不配置该 policy。compensate 还要求原契约声明与准确受限后端可用。普通 question 要求真实用户选项及 trim 后非空 detail。请求绑定准确原 Store/Session/Run、activation/anchor、requirement 与 Skill revision、head/attempt/output digest 和原 verifier proof；接受后重读实际 Interaction、accepted decision revision 与原 subject。普通答案不成为 Tool 授权，等待期间权限、来源、head 或取消变化拒绝旧决定。

waiver 保存独立 immutable `user_decision` 和 head 指针，原 verification 仍是 failed；它只解除对应 completion obligation，不解除输出 schema、实际权限或未确认副作用。Core 的 `readRunExecutionSafety` 查询原 Run、实际 parent/child 执行闭包，Host 封存其 read-set 后由最终事务复算；缺事实或 unconfirmed 拒绝 waiver。replan 保存真实非空指令并建立新 attempt，原失败、准确接受事实及新的 opening 均进入最终判定。`recordedAt` 表示业务采用决定时间，不能描述为用户精确回答时间。

[声明补偿](compensator.ts) 是普通 `skill.workflow.compensate@1` Job。其八字段闭合输入绑定原 Skill/revision、activation/attempt、完整 output/digest、accepted decision key/digest；opening 在 ensure 前保存准确原父决定 Tool 与输入摘要。每个 attempt 只有一个 operation，重复选择与有限等待只查原 Job/result revision。dispatch condition 核实际原 planned Job 与准确父 Tool，第三项 unknown 或来源/head/决定漂移拒绝，最终通用安全 read-set 复算整个闭包。compensated、failed、cancelled、unknown 分别追加；原 failed 验证不改，完成仍须新尝试真实通过或准确 waiver。

可信factory提供macOS Seatbelt与明确Linux native init／Bubblewrap的禁止子进程后端，Windows仍不可用。start重核原canonical Workspace、整个dataRoot／coordination保护目录、临时根与完整编译来源，将所有声明资产含二进制原字节封入Workspace外的独立只读副本，再由固定Bun在原Workspace执行声明脚本。环境只有固定PATH/LANG，网络、非线程fork、保护目录写和副本写由对应固定后端拒绝；Linux的NOEXEC／mount／seccomp与真实退出资格仍待原生验收，源码／callee装配不代运行通过。模型不能传命令、环境或路径。独立Job minimum:user审批不能借verifier或question许可。只有真实停止证明才释放资产；owner丢失且子进程仍活着时保unknown与原副本，不伪称清理成功。需要派生子进程的脚本当前不可用，无普通Shell fallback。

## 验证与当前范围

[契约测试](../../../test/skills/workflow-contract.test.ts)、[真实 Runtime 测试](../../../test/isolated/business/skill-workflow.test.ts) 与[真实 guardian 测试](../../../test/isolated/business/skill-workflow-verifier.test.ts) 分别负责原文件/schema、SQLite/固定模型/普通 child、准确用户决定与脚本进程。默认 Service 的真实 repair/replan fork 见[宿主测试](../../../../../apps/service/test/isolated/skill-workflow-fork-attempts.test.ts)；[补偿 leaf](../../../test/isolated/business/skill-workflow-compensator.test.ts)核完整原字节、二进制、拒绝边界、真实 guardian 丢失和取消/超时；[默认 Service 补偿](../../../../../apps/service/test/isolated/skill-workflow-compensation.test.ts)核完整大审批附件、一次效果、拒绝零效果与后续修复。当前证据及未完成客户端、恢复和平台范围见[实施进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

当前 attempts 与准确用户决定的持久取舍见[决定记录](../../../../../.agents/notes/implemented/architecture/2026-10-03-workflow-verification-attempts-and-user-decisions.md)，声明补偿的身份、资产与停止边界见[补偿记录](../../../../../.agents/notes/implemented/architecture/2026-10-03-declared-workflow-compensation.md)。源码外包也通过真实受限补偿；这些本机资格不代表完整 V1.3 已交付。
