# Runtime Host

## 定位

`@kite-ai/runtime-host` 是通用 Runtime mechanism、Session command authority 和 module lifecycle owner。

## 拥有职责

- 是唯一 Runtime execution owner：管理每个 Session mailbox、revision conflict、scoped idempotent command replay 与 durable notification。
- 管理 attempt acknowledgement、effect lease、cancellation、cleanup 和 restart recovery。
- 拥有 persistent scoped command receipt 的验证与 replay decision；Store 负责持久记录的原子落盘，bridge/Server/Client 不得推断或另建 receipt authority。
- `/storage`已定义SQLite-neutral `RuntimeStoredRun`、ASC keyset query/page、insert/transition port、closed terminal detail与可选
  receipt resource result。该contract只冻结Store 8 mechanism shape；Host start/activation/interaction/terminal transaction尚未接入，
  不能据此发布Run query/mutation或建立第二lifecycle owner。
- 翻译 Kernel facts，并管理 process supervision、storage port 与 observability。
- 接收 Runtime Server 的进程内 `RuntimeCommandContext`，在 Host inspect/commit 到 prepared execution bridge 时保持同一冻结
  connection/request/binding identity；Host 不把它序列化、不从 Session 反查 Worker binding，也不持有 Worker credential。
- 启动一个 frozen RuntimeModule snapshot，关闭 bridge 后逆序释放 module。

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
- prepared execution只允许command类型对应的封闭operation。`respond_interaction`仅在Service从durable State恢复pending
  interaction并原子提交applied receipt后，作为同一Turn的single-use continuation调度；其他command不得借此启动Turn。
- `delete_session` 由 Host 串行化并委托 SessionStore 在一个 transaction 中提交 retained receipt 与删除；
  删除后 registry/lifecycle 不得再 flush snapshot 重建该 Session。
- command context 不是新的 Runtime authority：只有 App-owned admission 可以提供 opaque binding reference；Worker effect composition
  必须按该 reference 与当前 Controller/resource authority 验证，缺失或漂移时 fail closed。
- Run neutral validator固定phase/status、Session-scoped identity、origin pair、revision/time monotonic与terminal closed shape；resource result固定
  schema/canonical JSON/digest triple。现有Store 6/7 receipt writer会拒绝携带resource result，直到Store 8 Host transaction在KRSRUN-01B接入。

## 测试

`bun test packages/runtime-host/test`（当前197 pass、1 skip；含neutral Run/receipt-result contract）

## 文档影响

模块局部变化更新本 README；authority、恢复或韧性变化同时更新 [Runtime Authority](../../docs/active/runtime-authority-boundary.md) 和 [韧性验证](../../docs/active/runtime-resilience-qualification.md)。
