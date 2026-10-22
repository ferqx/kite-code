# Child Core 绑定证据

[bindings.test.ts](bindings.test.ts)使用真实 SQLite、新临时 profile、固定模型与无害计数，验证普通 child 仍由同一个 Loop 执行。静态 `childConfigurations` 密封追加 Extension、Tool/Job metadata、sources、conditions、permissions、initializer、Step reader 与授权检查配置。模板持有 base lease 到 Runtime.close；每个 child Run 与后台 Job 共享引用，不因第一个 child 完成而销毁仍可复用的模块。

宿主可提供 [RuntimeOptions](../../../src/runtime.ts)的 `resolveChildRunConfiguration({configurationId,parentExecution,parentRun,parentSession,workspace,command,signal})`，在首次新 carrier 前返回完整 RunConfiguration。输入是实际持久身份的只读快照，workspace 从原 parentSession.workspaceId 查询真实 Store 记录，不从 snapshot 或调用者路径推导；返回配置继续使用已声明 child id/version/inputSchema，不能从扩展请求注册权限。同 operation key 查回原 Command/配置/父关系，只返回原引用，不解析新配置、不重建 child、不自动重放冷历史。fresh 配置在失败准入时释放，在已运行 child 的最后一个后台 Job 结束后释放。

[configuration-reads.test.ts](configuration-reads.test.ts)以实际 resolver 的 `records.forExtension(id).get(key)` 读取原父 namespace；返回完整 clone/freeze 投影且 lifetime 结束关闭。Host 自动封存 present/missing digest/read-set，carrier 创建和 child activation 的真实最终 SQL 事务重新核原 Store/Session、manifest、revision 与完整投影。测试包括源记录在资源/权限等待后变化、final transaction 与 preflight 之间变化、缺记录后来出现、越 namespace、保留 getter 和真实 handler 资源收尾。空读集不为无祖先 Run 的普通 Action→Tool→child→grandchild 增加权限要求，该原链另由 [Service 选择回归](../../../../../apps/service/test/isolated/skill-selection.test.ts)核实。

普通 child 的工具与 Job metadata/version/namespace 不能超过原父执行捕获的实际 Step 目录；runless operation Tool 继承原父绑定，有限真实父链只定位原 Run 容量，不以全局目录授予新工具。父 Step v2 允许可信 child v2；初始 manifest v1 不可覆盖真实父 Step。旧 authorization.review child 仅保留历史只读证明，不再接受新执行；自动授权检查记录为原 Session 内无 Run 的 Model，普通 snapshot 标志不能开启内部用途。

父子 permission 对同一准确调用串行读取并形成复合 policy revision：硬拒绝优先，双 Ask 形成一张真实根 Session 卡，双 Check 的单个闭合请求列明双方要求。Ask+Check 的 `check.requireApproval=true` 先在无资源许可阶段运行 durable checker；approve_once 仍须真实人工答案，最终派发同时携带并由 SQL 核实 check 与 interaction 引用。ask_user/失败保留现有人工 fallback，不伪造人类答案。Model permission 仍按 Model kind 交集处理；checker 记录为同 Session 中无 Run 的 Model，不创建 child。

同一整文件另核父子策略均允许时的 `same_command`：原 child 卡可选择会话批准，实际接受后同 Session 连续调用无需重答，父、兄弟和嵌套子 Session 仍各自批准；单次答案不生成会话授权。包含摘要不一致、完整 input 回退、单次上限及同 upstream revision 下选项／摘要变化的反例。Auto 使用真实 `createPermissionPolicy` 产生每次不同的 invocation，核显式人类会话批准可复用；纯 checker 和原始必需 checker 继续逐次核验。实现边界及实际整文件证据归[权限 owner](../../../src/permissions/README.md)。

断言涵盖追加模块自有记录与 sources、Query 不读取 sources、caller 替换 sources.capture 不改变封存回调、连续 child 模板不早 dispose、动态 v2 与旧 v1 拒绝、runless 不扩权、硬拒绝零效果、双 Ask/双 Check、Ask+Check 的零资源等待和真实 human proof、ask_user fallback、静态/fresh 后台 Job 的真实终态及 lease、并发同 key 只有一个 carrier 且落败 fresh lease 及时释放。相邻 [runtime.test.ts](runtime.test.ts)、[result-context.test.ts](result-context.test.ts)与 [authorization-check.test.ts](../execution/authorization-check.test.ts) 验证独立 owner/取消/唯一 Loop 与内部授权检查边界。

绑定切片不声明默认 Service child 配置或 task 满容量立即失败已实现；也不把固定模型断言当作真实付费 Provider 或 SIGKILL checker 资格。

[deadline-store.test.ts](deadline-store.test.ts)与 [deadline-runtime.test.ts](deadline-runtime.test.ts)验证后续已实现的 child 持久固定 30 分钟期限、只读重开、最终派发拒绝与实际 macOS 取消；夹具只在私有库成对调整激活/期限，不给生产期限加公开短配置。这份默认短窗口不代完整30分钟资格，Store/Core 的期限边界及既有独立长窗口见 [owner 说明](../../../src/storage/sqlite/child/README.md)。第二私有SQLite写连接采用正式writer已有的native busy_timeout=1000，仅等待原paired UPDATE的短WAL竞争；原Date.now()+500仍在UPDATE前计算，等待计入期限，不扩5秒整例／fact预算、不重发activation。2026-10-11原三整例3pass／26expects／1.285s与真实SQLITE_BUSY／unknown现场归[本轮进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，生产取消及未确认清理合同不变。

显式完整 30 分钟资格脚本为 [child-deadline-soak.ts](../../../../../tests/fixtures/unified-agent/child-deadline-soak.ts)，用 `bun tests/fixtures/unified-agent/child-deadline-soak.ts` 单独启动，不进入默认 suite。它不改 deadline/Date.now 或公开短配置：固定 child 的第二次实际 Model 保存 partial 后等待真实 signal，attached/detached 无害 Job 验证取消域，root Run 已完成且 deadline 为 null。进程向私有临时目录 report.json 写有限启动/终态事实，完成后准确清理自身 Job 并关闭 Runtime；必须读取最终报告和退出码才能声明本机完整期限资格，waiting 不等于 passed。
