# RMV1-06 Host lifecycle、Cancellation 与 Recovery 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-05-runtime-host-session-registry-mailbox.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-06 已把 production execution lifecycle、Cancellation、Store 4 transaction acknowledgement、effect
lease supervision 与 restart recovery 原子切到 `@kite-ai/runtime-host`：

- `SessionLifecycleSupervisor` 为每个长期 turn/compaction 创建唯一 root `AbortController`，把工作排在 mailbox
  外，并以 predecessor cleanup promise 作为同 Session successor barrier；
- 同一 Session 正常运行时拒绝第二条长期 operation；当前 operation 已 abort 后只保留一条 successor，第三条
  返回 `runtime_busy`；
- `cancel_turn` 与 Host shutdown 先通过唯一 bridge 持久化 cancellation facts，再触发 Host signal；
- `EffectSupervisor` 唯一拥有 decision、attempt-start、receipt/evidence、terminal/recovery 四类 transaction
  acknowledgement，以及当前单-Store effect lease claim/renew/release；
- guarded terminal commit 携带 caller-bound owner token，并在同一 SQLite transaction 内核对 effect、owner 与
  expiry；stale/wrong owner 不写 event 或 snapshot，也不能借用 replacement owner claim；续租丢失会中止同
  Session lifecycle；
- Host hydrate 或首次 resume/start/compact 前对每个 Session 恰好执行一次 restart recovery，失败时在 execution
  bridge 与 Provider dispatch 前 fail closed；
- close/dispose 立即关闭 admission，等待已接收 access、durable shutdown、lifecycle cleanup、bridge close 后才关闭
  Store。

唯一 legacy bridge 仍承载尚未迁移的 State 25 Kernel/Executor domain 路径，但只消费 Host execution services 与
Host signal，不再拥有 production root controller、transaction acknowledgement、lease supervisor 或 restart
admission。没有 try-new-catch-old、双写、双 handler 或异常 fallback。

## Cancellation 与投影顺序

CLI/TUI handler 把 Host signal 直接传给 `runRuntimeAgent`，内部 deadline、approval rejection 或其他 Runtime-owned
终止请求通过 callback 回到 Host controller。canonical rejection/cancellation fact 已 durable 后先交给 Client
projection，再请求 Host abort；这样 post-abort Provider delta 仍被丢弃，而 `approval.rejected` 自身不会被误当成
late event 隐藏。

TUI compatibility facade 在 production Host path 不创建 root controller。它仍保留直接单元测试路径的局部
controller 与 manual compaction adapter，登记为 RMV1-16 删除对象；这些路径不构成第二个 production owner。

## Effect acknowledgement、lease 与 recovery 证据

Host 与 Store contract test 机械证明：

- attempt acknowledgement 抛错时外部 dispatch 计数为 0；
- 当前 owner 可在 lease 有效期内提交，过期或错误 owner 的 guarded commit 原子拒绝且 event/snapshot 均不变化；
- owner token 从 Executor 经 execution context、Kernel batch 与 App Store view 传到 Host；旧执行者不能从相同
  effectId 的 replacement claim 反查并借用新 owner；
- compaction 在 Provider dispatch 前立即 renew，并在 terminal events 持久化完成后才 release；
- heartbeat renew 失败保留失效 claim 直到 release，并触发 Host lifecycle abort，不能再 dispatch 或 commit；
- cancellation bridge 调用在 signal observer 之前发生；
- predecessor cleanup 未完成时 successor 不进入 bridge，queued cancellation callback 会收敛 completion；
- recovery 对同 Session 只运行一次，recovery failure 不进入 prepare/dispatch；
- dispose 等待活动 access 与 cleanup，failed startup 也不会绕过 close 顺序。

dispatch 后没有 receipt 的情况继续按 State 25 既有 unknown/reconciliation 规则处理。RMV1 只使用当前单-Store
lease/fence，不声称进程间 authenticity 或 cross-Host Project fence。

## Owner、Delete 与 Source 清单

四张人工清单已更新为 `RMV1-06`：

- `transaction-effect-lifecycle` 当前 owner 从 `legacy-runtime-kernel` 切为 `target-host-mechanism`，production entry
  锚定 `packages/runtime-host/src/effect-supervisor.ts#EffectSupervisor`；
- Host owner profile 同时登记 lifecycle supervisor、effect supervisor、Store 4 atomic lease fencing 与 transaction
  acknowledgement；
- `LegacyRuntimeAccess`、CLI/TUI handler、SessionManager、central executor 与 agent loop 继续为 `present`，删除
  Task 保持 RMV1-16；未伪造提前删除状态；
- 29 个 operation、18 个 responsibility、38 条 Legacy rule、292 个 source file、417 个 test consumer、
  96 个 public export 全部闭合，architecture exception 为 0；
- 新增 8 个 Host lifecycle/lease public type export 均有 RMV1-06 disposition；
- package Gate 保持 7 个 workspace、11 条 dependency edge、唯一 composition root
  `apps/kite/src/bootstrap.ts`。

## 格式与范围冻结

Generated facts 与运行测试共同证明：

- Runtime State schema 25、30 个 root field；
- Runtime Event codec 136 个 discriminant；
- Runtime Store schema 4、epoch `kite-runtime-2026-08-18`、8 表、3 index；
- `runtime_effect_leases` 仍是既有 Store 4 表；本阶段只把 owner/expiry predicate 加入既有 event+snapshot atomic
  transaction，没有新增表、index、marker 或 migration；
- 没有 ProjectIdentity、Composition identity、统一 sealing、cross-Host fence、DataOrigin/Egress/Credential 重写、
  State 26、Store 5、新 epoch 或 RAV1 production artifact。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/runtime/cancel-resume.test.ts tests/runtime/concurrent-shell-cancel.test.ts` | 11 pass、0 fail |
| `bun run test:tui:system:core` | 14 个独立 PTY 场景文件、32 pass、0 fail |
| `bun run test:runtime:fault` | 33 pass、0 fail |
| `bun run test:runtime:soak` | CI profile 7/7 pass、0 fail；digest `sha256:bc8a76c767e9db0861bcb302fc2ba47da85e69e66eebddb046165d4a73f694b2`；orphan PID/worktree/residual path 均为 0 |
| `bun test packages/runtime-host/test/effect-supervisor.test.ts tests/runtime/context-compaction.test.ts tests/runtime/context-compaction-e2e.test.ts tests/session-manager.test.ts tests/runtime/store.test.ts` | 217 pass、0 fail；覆盖 caller-bound owner、replacement claim、atomic lease、manual compaction 与 Store 4 |
| `bun test packages/runtime-host/test packages/runtime-storage-sqlite/test tests/runtime/storage-adapter.test.ts tests/runtime/store.test.ts tests/session-manager.test.ts tests/tui-system/scenarios/tool-lifecycle.test.ts` | 215 pass、0 fail；覆盖 Host 全包、SQLite adapter、TUI rejection projection 与 Store 4 |
| `bun run typecheck` | passed；root + 7 workspace |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、18 responsibility、38 Legacy、292 source、417 consumer、96 export、0 exception；State 25/Store 4/原 epoch |
| `bun run check:runtime-packages` | passed；7 workspace、11 edge、1 composition root |
| `bun test tests/scripts/runtime-modularization-manifests.test.ts tests/scripts/check-runtime-packages.test.ts` | 26 pass、0 fail |
| `bun run check:docs`、`bun run check:docs-impact` | passed |
| `bun run format:check` | passed；仅保留既有 `tests/session-manager.test.ts` 16 条 `any` warning |
| `git diff --check` | passed |

`test:runtime:soak` 是本地 CI profile smoke，报告明确 `qualificationMetricsSupported=false`；本记录不把它提升为
正式 release qualification，也不替代绑定 GitHub source identity 的 qualification artifact。

## 阶段边界

RMV1-06 completion evidence 已闭合并形成 stop-and-report checkpoint。下一阶段为 RMV1-07 Pure Kernel
extraction；RMV1 总计划仍为 active，RAV1 继续 blocked。RMV1-07 尚未开始，只有 RMV1-16 completion evidence
闭合后才可解除 RAV1 阻塞。
