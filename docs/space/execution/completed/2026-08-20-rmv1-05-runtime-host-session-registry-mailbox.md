# RMV1-05 Runtime Host、SessionRegistry 与 Mailbox 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-04-storage-port-v4-adapter.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-05 已把 production `RuntimeAccess` 从 App legacy adapter 切到 `@kite/runtime-host`：

- `DefaultRuntimeHost` 实现 `command/query/subscribe/start/AsyncDispose`；
- `SessionRegistry` 为每个 Session 保留一个稳定 mailbox 和最后 committed Client projection；
- `SessionMailbox` 保证 same-session FIFO，registry 间保持 cross-session concurrency，失败操作不会卡死队列；
- `NotificationProjector` 提供连续 durable delta、gap/full snapshot、有界 history/queue、slow subscriber 断开、
  ephemeral 不重放与 stale work/attempt/stream/sequence 丢弃；
- App composition root 为 CLI/TUI 各组合一个 Host、一个惰性 Store 4 owner 和一个明确 legacy bridge；
- `LegacyRuntimeAccess` 已收缩为无 dedup/history/subscriber/fallback 的单 handler execution bridge。

Host-owned 与 Kernel-owned command 分类已按 accepted RFC 固定。RMV1-05 中尚未迁移的命令仍由唯一 legacy
bridge 端到端执行；Host 不复制 Agent State、Effect、Kernel Event 或第二份 domain receipt owner。

## Mailbox、并发与幂等证据

Host contract test 机械证明：

- 同一 Session 的 deferred command 未完成时，后续 command 不越过；不同 Session 可同时进入 bridge；
- `expectedRevision` 与 Fork `sourceRevision` conflict 在 bridge 调用前返回且调用计数保持 0；
- command identity 按 Session 作用域，相同 payload 的并发/后续 retry 只执行一次并返回原 revision；
- 同一 identity 的不同 payload 返回 `invalid_command`，不执行第二次；
- command 失败后 mailbox 继续处理下一项；
- bridge 调度长期 Provider work 后立即返回 receipt，Host command 不等待该 work。

Store 4 没有 durable command ledger 或 notification outbox，因此上述 idempotency receipt 与 projection history
只覆盖当前 Host 生命周期；本阶段没有声称跨重启 command idempotency。

## Query、Subscription 与 TUI 兼容

Query 读取 registry 中最后一次 committed projection。command 尚未完成时返回旧 revision，完成并刷新后才返回
新 revision。订阅在 retained history 连续且覆盖最新 projection 时重放 delta；history 被裁剪或未覆盖最新
projection 时只发一个 full snapshot。ephemeral queue 溢出先淘汰 ephemeral，不能挤掉后续 durable terminal；
durable-only 慢 subscriber 被单独断开。iterator `return()` 和 AbortSignal 不取消 Runtime work。

TUI compatibility facade 使用独立 completion promise 保留原有 `runTask`/compaction 等待和 idle/presentation
时序；legacy handler 在调度工作后立即 ack，使 Cancel 可在运行中进入 mailbox。完整 AbortController、
durable-before-signal、effect supervisor、cleanup barrier、late/unknown receipt 与 restart recovery owner 仍留在
legacy Runtime，等待 RMV1-06 原子切换。

Store owner 改为惰性、引用计数视图：Host 是唯一 close owner，活动 legacy Kernel view 完成后释放；不兼容
Store 仍在历史会话加载边界 fail closed，TUI 可先挂载并显示脱敏错误。startup PTY fixture 已验证该时序。

## Owner、Delete 与 Source 清单

四张人工清单已更新为 `RMV1-05`：

- `client-runtime-access`、`session-mailbox`、`runtime-query-subscription` 当前 owner 均为
  `target-host-mechanism`，production entry 分别锚定 Host、SessionRegistry 与 NotificationProjector；
- `transaction-effect-lifecycle` 仍由 legacy Runtime 持有，cutover Task 保持 RMV1-06；
- `LegacyRuntimeAccess`、CLI/TUI handler、SessionManager、legacy agent loop 继续为 `present`，删除 Task 保持
  RMV1-16；
- 29 个 operation、18 个 responsibility、38 条 Legacy rule、292 个 source file、417 个 test consumer、
  88 个 public export 全部闭合，architecture exception 为 0；
- package Gate 为 7 个 workspace、11 条 dependency edge、唯一 composition root
  `apps/kite/src/bootstrap.ts`，Host 不导入 App/legacy/SQLite/root Core。

## 格式与范围冻结

State/Event/Store generated facts 保持：

- State schema 25、30 个 root field；
- Event codec 136 个 discriminant；
- Store schema 4、epoch `kite-runtime-2026-08-18`、8 表、3 index；
- Store canonical facts SHA-256 仍为
  `9c943a5db78a1696a514a2d6b390740881c2a4fe6b1fc005bb3942a6240e747e`，Store manifest envelope digest 仍为
  `sha256:8654a70b7a41062dd572acc7f760c9a17be599ff3c863b31646800ad9211178e`。

没有 ProjectIdentity、Composition identity、统一 sealing、cross-Host fence、DataOrigin/Egress/Credential
重写、State 26、Store 5、新 epoch 或 RAV1 production artifact。

Required replay closure 与 RMV1-04 相同：255 个文件，digest
`sha256:f46dd8d73eaec75a8eb29e81da96b14320e73da4bb230cf434f4ea4e938f83ee`；parser 外 manifest authority 为
`sha256:a16967d495c3da0aa4f6430986e3368edf12075148571e8484422c880efd43a8`。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test packages/runtime-host/test apps/kite/test/legacy-runtime-access.test.ts` | 22 pass、0 fail；Host FIFO/concurrency/conflict/idempotency/query/subscription/stream 与单 bridge |
| `bun test tests/session-manager.test.ts` | 107 pass、0 fail |
| `bun test tests/runtime/session-state-machine.test.ts` | 8 pass、0 fail |
| `bun test tests/cli.test.ts tests/cli/trace.test.ts` | 17 pass、0 fail |
| `bun run test:tui:system:core` | 14 个独立 PTY 场景文件、32 pass、0 fail |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、18 responsibility、38 Legacy、292 source、417 consumer、88 export、0 exception |
| `bun run check:runtime-packages` | passed；7 workspace、11 edge、1 composition root |
| `bun run build` | passed；7 workspace |
| `bun run typecheck` | passed；root + 7 workspace |
| `bun run format:check` | passed；1013 files，仅有既有 `session-manager.test.ts` 16 条 `any` warning |
| `bun run test` | main 3759 pass/10 skip；isolated 57 pass/1 skip；workspace 33 pass；合计 3849 pass/11 skip/0 fail |
| `bun run eval:replay:required` | passed；approved suite、macOS seatbelt、无 live fallback |
| `bun run check:docs` | passed |
| `bun run check:docs-impact` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-05 completion evidence 已闭合。下一阶段为 RMV1-06 Host lifecycle、Cancellation 与 Recovery；RMV1 总计划
仍为 active，RAV1 继续 blocked，只有 RMV1-16 completion evidence 闭合后才可解除。
