# ADR-0102：Subagent 执行上下文由 Runtime 签发并按 Actor 隔离读取状态

状态：accepted

日期：2026-08-13

决策者：github:@ferqx

调整：ADR-0042 §1 的“本会话”读取状态口径；不改变先读后改与过期拒绝本身

## 背景

Subagent 的文件工具与 Parent 共用 `threadId` 级 read-state tracker，因此 Parent 或 sibling 读过某文件后，子 Agent 可以在没有自己看过内容的情况下通过 `edit_file` 前置校验。这把 session 当成了模型主体，与实际的隔离模型上下文不一致。

同时，Subagent Runner 硬编码 `accept_edits`，且模型可见 CWD 取启动进程的 `process.cwd()`。这使 child 的实际权限与父 Runtime 当前 interaction mode 脱节，并使 CWD、Workspace 和工具路径可能指向不同的根目录。审批挂起期间还允许用户通过 `/permissions` 改变 live mode，continuation 不能成为第二个、过期的权限权威。

## 决策

1. Parent 保持稳定的 session read-state scope。每个 Subagent 使用 Runtime 签发的 child id 作为 actor scope，Parent、child 和 sibling 不共享 read-before-edit freshness。
2. child id 在正常 loop、阻塞工具获批执行和 continuation 恢复后的 loop 中保持稳定。tracker 只存内存；进程重启后未恢复的 actor 状态必须 fail closed 为 `not_read`。
3. `interactionMode` 由父 Runtime 显式传入 child 工具面和执行策略。恢复时使用父 Runtime 当前 live mode，不将 mode 持久化为 continuation 内的第二权威。若内部入口遗漏 mode，只能回退到 `accept_edits`，不得从 task config 放宽。
4. Subagent 入口将 `input.workspace` 规范化为绝对路径，模型可见的 `Workspace`、`CWD` 与所有 child 工具执行共用该路径。
5. actor id、interaction mode 与 Workspace 都是 Runtime-owned context，不暴露为模型可修改的工具参数。

## 备选方案

- 继续按 thread 共享 tracker：拒绝。这会让一个模型主体借用另一个主体的已读事实。
- 将 interaction mode 写入 continuation：拒绝。挂起后的 live `/permissions` 更改必须立即生效，持久化旧 mode 会形成漂移。
- 使用 `process.cwd()` 作 child CWD：拒绝。进程启动目录不是当前 Actor Workspace 的权威。

## 后果

- Subagent 首次编辑 Parent 或 sibling 已读的文件时会收到 `not_read`，必须自行读取后再修改。
- 同一 child 的审批暂停/恢复在同一进程中保留 freshness；进程重启会安全地要求重读。
- 子 Agent 工具对 `auto`、`full` 和运行中 mode 更改的行为与父 Runtime 一致；漏传参数不会意外扩权。
- tracker 容量现在按 actor scope 计数，可能更早淘汰旧 freshness；淘汰只会导致安全重读，不会放宽权限。

## 回滚

可以恢复 thread 级 tracker、固定 child mode 或 `process.cwd()`，但会重新引入本 ADR 解决的跨 Actor freshness、权限漂移或路径漂移问题，因此需通过新 ADR 显式决策。
