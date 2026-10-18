# Agent Note: 模型与 Run 生命周期阶段和只读观察

Status: implemented

## Problem

扩展已能通过普通 Run 生命周期 Action 在启动前及完成前执行受管业务，通过 context 在模型前贡献来源；此前缺少模型与 Run 真实结算后的统一只读观察入口。用户明确要求在同步后的代码上补齐生命周期，保留已有标题扩展与执行边界。

## Decision

保留 [lifecycle.beforeRun/beforeRunComplete](../../../../packages/agent/src/extensions/index.ts) 的两个 Action 阶段与现有 context.capture/captureBatch；通用观察使用 onRunStart/onRunEnd、onModelStart/onModelEnd。所有回调均可省略，使仅观察的扩展无需提供空 Action selector。观察只接收有限不可变事实，不获得 Store、owner、operations、资源句柄或完整请求和响应正文。

Model start 在实际派发 ACK 与取消复核之后、进入 adapter 前发布，Run start 在新 Run 激活 ACK 后发布；它们只标记开始，不代表结果成功。Model end 从 UnifiedExecution 实际 finishExecution 返回的原记录生成；Run end 在当前 executeRun 收尾中只读核实真实持久终态，包括提前返回的压缩路径。每条通知包含来源身份、稳定 eventId、实际状态，Model 另有原 attempt、结果 revision 与有限标准用量。标准字段未测量时保持未知，不推算 total，不复制 Provider raw。冷读、不成功的最终提交和配置拒绝不伪造结算；重试的不同 Execution 分别观察。

[观察队列](../../../../packages/agent/src/extensions/lifecycle.ts)最多保留128个在途或排队通知，每个 callback 最多16个排队项；额外通知丢弃。按同一 callback 顺序交付，其他 callback 独立推进；异常局部停用该 callback。模型、工具、Run 完成及 Runtime 关闭不等待观察 Promise。关闭丢弃未交付通知，不将观察函数当资源 disposer。Model 绑定实际冻结 Step，Run 绑定初始冻结配置；另一个 Session 或后来目录不能替换已派发的 callback。

需要可靠后续业务的扩展仍须通过原 Action/Job/必要条件路径登记受控操作，不借观察通知承诺必达或 exactly-once。原[Run 生命周期 Action 决定](2026-10-18-run-lifecycle-extension-actions.md)对前置业务、会话标题与 caller 结果交付继续适用；本次明确显式输入的配对范围，子任务的原执行与取消语义继续保留。

## Alternatives considered

- 将完成后观察也实现为普通生命周期 Action：沿用执行能力，但会把统计和日志变成业务 Execution，并让终态后的关闭受额外业务影响，不能表达纯观察。
- await 通用 before/after middleware：接口表面统一，但观察失败会污染已提交的模型与 Run 结果，慢消费者也会占执行资源；选择将观察与实际执行分开。
- 仅包装 ModelAdapter.stream：无法证明 Store 已提交，不覆盖 Run 终态，且会漏掉准入失败或错误地把 EOF 当成功。
- 新建持久事件队列或后续业务平台：本任务需要的是非权威观察，既有 Command/Execution 已承担可靠工作，因此不新增表或调度器。
- 增加与 context 重复的 beforeModel 转换链：当前已有安全来源贡献、刷新和最终授权边界；本次复用它们，避免出现两种修改同一请求的顺序合同。

## 生命周期命名

用户要求命名采用行业通行词汇，并检查执行流程与不合理嵌套。核对 [OpenAI RunHooks](https://openai.github.io/openai-agents-python/ref/lifecycle/) 的 start/end 事件与 [LangChain middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/custom) 的 before/after 阶段后，保留单层 Extension.lifecycle: LifecycleHooks。框架之间没有统一钩子协议，因此按实际语义命名：beforeRun/beforeRunComplete 是会等待普通 Action 的业务阶段；onRunStart/onRunEnd、onModelStart/onModelEnd 是不等待的只读事件订阅。此前使用 afterModel/afterRun 的命名容易被理解为能变更请求或状态的顺序 middleware，已改为 on*，不保留双入口。

两个前置回调接收冻结的 RunBoundaryEvent，返回 LifecycleAction 或 null；四个观察回调接收 ModelStartedEvent/RunStartedEvent/ModelSettledEvent/RunSettledEvent。事实类型 model.started/run.started 表示原开始边界，model.settled/run.settled 表示原提交结果；后两者的身份不随回调名改变。

执行沿唯一 Runtime/Loop 平铺推进。业务 Action 按扩展注册顺序逐个选择并等待，不引入 next() 或可包裹的主循环。发现原完成钩子也用于 child.start，而启动前钩子不经过 child 激活，这会让通用完成 Action 创建 child 时递归触发自身。两个业务钩子现统一限制到显式 run.start/input.follow_up，内部 child 激活及自动 job.report 不调度它们；这些新 Run 仍完整发布通用 start/end 观察，实际子任务能力继续走普通受控 operations。此限制修正意外重入，没有去掉 Action 创建受管 child 所需的权限、持久事实、取消或结果交付层。

恢复沿原 Run 身份继续，不重发 Run start 或历史 Model 事件；仅本次实际进入 adapter 的 Model 发布 start，已提交的新结果发布 end。权限拒绝或派发前取消可能只有 Model end，没有 start。通知的发布顺序不等于异步回调的完成顺序，单 callback 保序、不同 callback 独立，不能按 middleware 反向退栈使用。

旧分组入口移除，所有本仓库 producer/consumer 与标题扩展同步迁移。before_start/before_complete 仅保留在内部持久 Command ID 的原语义摘要中；run-lifecycle 回归直接核旧 ID 和实际原 Command，确认命名变化不产生重复业务。模型前 context.capture/captureBatch 仍用于可能多次进行的来源复核，不新增一次性 beforeModel 承诺。

## Consequences

普通未注册观察者的执行不增加 Model/Tool/Run，不增加数据库表、公共 HTTP DTO 或客户端开关。通知只携带有限身份、状态、原结果 revision 与标准用量；详细结果继续沿宿主已有准确 scope 读取，事件身份不授予读取权。

观察不持 Run lease、permit 或 Store 使用权，不参与 busy/drain；Run 终态可以早于 Job 实际停止和 disposer。异步观察可能丢失或在 Runtime 关闭后自行返回，不能承担必达业务。进程内 callback 的同步阻塞无法由 TypeScript 接口抢占，也不构成恶意代码隔离。

当前完整合同由 [Agent owner](../../../../packages/agent/README.md#生命周期扩展)维护，关闭交接由 [Runtime owner](../../../../packages/agent/src/lifecycle.README.md)维护，跨层边界归 [active](../../../../docs/active/unified-agent-boundary.md)。

## Verification

2026-10-18，本机 Windows x64／Bun 1.4.3，以原 HEAD bcf70ce8 加本次 diff 验证。`bun test --parallel=1 --max-concurrency=1` 对以下10个完整文件执行，79项通过、807个断言、零失败；其中通知集成16项、恢复2项和纯队列2项：

- [纯观察队列](../../../../packages/agent/test/lifecycle-observers.test.ts)
- [通知集成](../../../../packages/agent/test/isolated/extensions/lifecycle-observers.test.ts)
- [真实进程退出后的恢复](../../../../packages/agent/test/isolated/extensions/lifecycle-recovery.test.ts)
- [调用者结果交付](../../../../packages/agent/test/isolated/child/result-delivery.test.ts)
- [Runtime 生命周期](../../../../packages/agent/test/isolated/execution/lifecycle.test.ts)
- [Model 重试](../../../../packages/agent/test/isolated/execution/model-attempt.test.ts)
- [Model 用量](../../../../packages/agent/test/isolated/execution/model-usage.test.ts)
- [前置 Action](../../../../packages/agent/test/isolated/execution/run-lifecycle.test.ts)
- [会话标题](../../../../packages/agent/test/isolated/execution/session-title-generation.test.ts)
- [Step 绑定](../../../../packages/agent/test/isolated/extensions/step-bindings.test.ts)

Agent 与 Service workspace 的 `bun run typecheck`、`bun run check:unified-agent-boundary` 及受影响 TypeScript 文件的 Biome 检查通过。显式 ACK/提交屏障区分 Run 激活、Model 派发、Provider EOF 与 Store 已提交；真实 SQLite 核成功/失败/取消/拒绝、配置无 Run、完成 CAS 重试、模型重试、原 Run/Step 版本、冷读、字段冻结及无私有正文。业务注册顺序及内部 child 零业务钩子重入沿真实 Action/Job/child 验证；真实进程退出后恢复核 Run start 与原 Model 零重放。开始/结束的慢 Promise 保留未完成，执行及 Runtime 仍可正常完成和关闭。

另外完整执行的下列文件存在4项原有失败。分别将仅本次改动的三个生产源文件替换为 git show HEAD 的原字节运行，再在 finally 恢复工作内容，原 HEAD 均复现同一失败，故不记为本次通过范围，也不以本次改变其既有合同：

- [上下文批处理](../../../../packages/agent/test/isolated/extensions/context-contributions.test.ts)：4通过／1失败；一个工具请求已从实际日志裁去，现有断言仍要求两个输入。
- [Run 绑定](../../../../packages/agent/test/isolated/extensions/run-bindings.test.ts)：4通过／1失败；原版本隔离测试在 Runtime close 后删除 Windows 临时目录时报 EBUSY。
- [Service 标题](../../../../apps/service/test/isolated/session-title.test.ts)：两种权限均在 Runtime 创建前被原 Windows Profile ACL 校验拒绝，报 windows_path_security_denied。

这些失败不证明新通知路径失败，也不解除对应原资格。后续按用户要求执行了全仓默认入口，但失败停止派发，未获得全仓通过，详见下节。Linux/macOS 原生和正式安装资格未执行；通知有限队列和 fixture 的有界行为不代表整个 Runtime 的资源或性能验收。

## Windows 全仓验收

2026-10-18，用户进一步要求全仓验收。本机 Windows 10.0.26300 x64／Bun 1.4.3，原 HEAD bcf70ce843463194ab91ca3938b9fa1375cb22bc 加本任务工作树。完整日志、默认/TUI inventory、4898个文件的输入 SHA、实际退出码和结构化结果保存在本机 `dist/acceptance/lifecycle-20261018-173226/`；这是本机原始验收产物，不是 CI 或发行资格。

根目录及全部八 workspace 的 typecheck、全部八 workspace build、format:check、unified-agent-boundary、runtime-packages、unified-api、test-ownership、docs、plan-evidence、docs-impact all 均通过。format 保留21条既有 warning；构建首次因沙箱无法读取 Cargo 依赖许可证而失败，相同构建入口在允许读取原缓存后通过，保留两份原日志，没有改 ACL 或构建规则。

默认 inventory 为914文件／720作业（Windows：28并发、692独占）。第一次原 `bun run test` 在首次配置夹具的固定25ms等待处失败；原完整文件和原18文件分片单独可通过。夹具现以 React act 内的实际画面和连接状态同步，临时 act 环境标记准确恢复，保7项／38断言和整例超时，不修改生产 UI 或增加诊断入口。第二次原默认命令通过9作业，在 `apps/cli/test/tui-drafts.test.ts` 的文件符号链接创建处 EPERM：共13作业启动、9通过、1真实失败、3由运行器取消、707未派发。不能将取消当作新增业务失败，也不能将未派发记录成通过。当前进程权限列表无 SeCreateSymbolicLinkPrivilege，原完整草稿文件单独复现6通过／1失败；没有更改系统设置或跳过原反例。

其他 Required CI 原入口分别完整执行：

- `test:mock`：28通过／1失败，17MiB压缩摘要在原40000ms命令等待内未结算。
- `test:e2e`：原37通过／1失败；唯一失败是将 SDK wire 工具名当作内部 `files.write`。按现有 AI adapter 的真实 `files_write` 名称改为精确结构断言，保留原派发、热绑定、下一 Run 禁用和持久身份断言；原入口复验38通过／0失败／337断言。
- `test:runtime:fault`：46通过／9失败／3个原平台 skip；失败是私有路径 ACL 准入和目录符号链接创建前提。
- `test:runtime:soak`：退出2，`windows_path_security_denied`，未取得本轮资源资格。
- `test:tui:system`：113文件 inventory，首4个原整文件作业在 ownedUserConfiguration 的私有 ACL 夹具前提失败，其余未派发；尚未到真实 Runtime/PTY 行为，不能视为已完成全部终端验收。

mock、e2e原断言及fault另在四个原HEAD生产文件（runtime、execution、extensions、session-title）下完整复现同一结果；finally逐字节恢复原工作内容并核 SHA，一致。两个默认运行阶段的输入与HEAD均无漂移；后续仅追加已说明的断言修正和文档记录，没有引入生产行为变更。全构建后的本轮生命周期10整文件再验79通过／0失败／807断言。

本轮只修正首次配置的测试同步与 SDK 工具名断言，两者不改变手册承诺、公开扩展协议或权限边界；UI/Service typecheck 和受影响格式复验通过。全仓 iteration_complete 判定为 blocked：原默认门禁和部分 Required 入口尚未通过，Windows 符号链接／ACL、原大正文压缩超时及未派发作业仍待处理。未取得 Linux/macOS、真实付费 Provider、完整安装、资源增长或阶段退出资格。

## Windows 后续验收范围

后续测试环境修复及真实结果归[可移植测试环境](../testing/2026-10-18-portable-test-environment.md)。原符号链接／ACL／file URL、工具链缓存、WAL夹具关闭及大正文等待已分别修复；此前红日志与未派发事实保持。用户最新明确Windows仅验Agent流程，因此本轮不再以全仓通过为完成条件，也不改变默认发现、CI或平台资格。上节blocked保留其当时完整全仓目标与证据，不能用后续有限流程结果改写。

收窄后的最终组合在Windows x64／Bun1.4.3实际25整文件180通过／0失败／0跳过／2340断言；4164项代码与配置输入运行前后无漂移。它覆盖本Note的六个生命周期入口、真实串行Action及内部child不重入，并扩展到权限／取消、绑定和显式恢复。测试环境自测另87通过／2原平台skip／0失败。按当前用户范围iteration_complete可完成；这不解除上节完整全仓和平台资格的历史限制。
