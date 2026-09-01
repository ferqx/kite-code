# Runtime Host

## 定位

`@kite-ai/runtime-host` 是通用 Runtime mechanism、Session command authority 和 module lifecycle owner。

## 拥有职责

- 是唯一 Runtime execution owner：管理每个 Session mailbox、revision conflict、scoped idempotent command replay 与 durable notification。
- 管理 attempt acknowledgement、effect lease、cancellation、cleanup 和 restart recovery。
- 拥有 persistent scoped command receipt 的验证与 replay decision；Store 负责持久记录的原子落盘，bridge/Server/Client 不得推断或另建 receipt authority。
- `/storage`定义SQLite-neutral `RuntimeStoredRun`、ASC keyset query/page、active lookup、insert/transition/rewind/fork maintenance port、closed terminal detail与可选
  receipt resource result。Store 8 capability存在时，State session把start queued row、original Run resource receipt与
  State/event/snapshot放入同一transaction；activation必须通过现有`attempt_start` transaction把queued推进running，不能直接调用Run port绕过
  Store writer；interaction/terminal/cancel/recovery event batch同步推进同一Run。
- 翻译 Kernel facts，并管理 process supervision、storage port 与 observability。
- 根入口导出纯函数`isRuntimeHostStateSettledForMigration`，保守验证terminal Turn、idle Interaction、已知external effect、
  terminal Tool/Capability/Model/approval、无cleanup/subagent/recovery authority；SQLite owner仍独立验证effect lease与durable authority row。
- 接收 Runtime Server 的进程内 `RuntimeCommandContext`，在 Host inspect/commit 到 prepared execution bridge 时保持同一冻结
  connection/request/binding identity；Host 不把它序列化、不从 Session 反查 Worker binding，也不持有 Worker credential。
- 启动一个 frozen RuntimeModule snapshot，关闭 bridge 后逆序释放 module。
- Store-authoritative query返回Session projection时通过同一NotificationProjector发布event-free durable snapshot；这只hydrate
  process-local registry/history与已等待的subscriber，不写Store。订阅先于query建立且Session仅存在于Store时，pending subscriber也会
  收到该snapshot并完成ready，不能只更新registry后永久等待。

## 不拥有职责

- 不解释具体 Prompt、Skill、Tool、MCP 或 Model 业务语义。
- 不拥有 SQLite driver、Builtin schema 或 TUI 展示。
- 不提供 registry-taking alternate execution factory。

## 允许依赖

只依赖 `@kite-ai/agent-kernel`、`@kite-ai/runtime-contract` 和 `@kite-ai/runtime-spi`。

## 公开入口

导出根入口以及 `/observability`、`/storage`、`/kernel-adapter`。Kernel fact translation 只能从 `/kernel-adapter` 使用。

## 关键不变量

- Provider work 前必须完成 durable attempt acknowledgement。
- 任何不确定外部结果收敛为 unknown，不重放、不 fallback。
- Session lifecycle、mailbox、effect lease、cleanup、recovery 与 persistent scoped receipt decision 只有一个 Host owner；Server 仅通过 `RuntimeAccess` 调用它。
- Host从同一`SessionLifecycleSupervisor`投影`hasActiveSessionOperations()`聚合只读事实，供Service在关闭mutation admission后判断普通stop是否
  必须返回busy；该方法不创建第二份Run registry、不取消Session，也不把terminal projection误报为active。
- prepared execution只允许command类型对应的封闭operation。`respond_interaction`仅在Service从durable State恢复pending
  interaction并原子提交applied receipt后，作为同一Turn的single-use continuation调度；其他command不得借此启动Turn。
- `delete_session` 由 Host 串行化并委托 SessionStore 在一个 transaction 中提交 retained receipt 与删除；
  删除后 registry/lifecycle 不得再 flush snapshot 重建该 Session。
- command context 不是新的 Runtime authority：只有 App-owned admission 可以提供 opaque binding reference；Worker effect composition
  必须按该 reference 与当前 Controller/resource authority 验证，缺失或漂移时 fail closed。
- Run neutral validator固定phase/status、Session-scoped identity、origin pair、revision/time monotonic与terminal closed shape；resource result固定
  schema/canonical JSON/SHA-256。Host只在preflighted `storage.runs`存在时创建Run mutation；Store 6/7路径明确拒绝，不做partial fallback。
- Start receipt lookup发生在recovery/inspect/prepare之前。Store8 response loss或retry返回持久original queued Run resource，不重新recover、
  activate、prepare或schedule；current Run状态另由private `get_run`/bounded `list_runs`读取，query本身不触发recovery。
- Host restart后、Session尚未admit/recover时，private Run get/list把唯一nonterminal行只读投影为`unknown/recovery_required`；投影复用最后
  一个durable Run clock值，不读取HTTP/Logger wall clock，也不写Store或触发recovery。显式resume完成existing Host recovery后恢复canonical
  active/terminal投影；真实unknown只允许由reconciliation原子细化为更精确terminal，并保留原`finishedAtMs`。
- current production Workspace Worker已打开committed Store 8并消费上述Host Run机制；Store 7只保留为显式offline migration source。
  Agent ServerInfo和Public handler仍不发布`runs`，所以Store authority cutover不等于Public mutation开放。

## 测试

`bun test packages/runtime-host/test`（当前203 pass、1 skip；含Run restart projection/recovery refinement、lifecycle/resource replay/private query与Store7 fail-closed）

## 文档影响

模块局部变化更新本 README；authority、恢复或韧性变化同时更新 [Runtime Authority](../../docs/active/runtime-authority-boundary.md) 和 [韧性验证](../../docs/active/runtime-resilience-qualification.md)。
