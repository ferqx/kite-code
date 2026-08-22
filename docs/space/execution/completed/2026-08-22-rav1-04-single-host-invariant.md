# RAV1-04 single-Host invariant

状态：qualification_pending

裁决：当前仓库的 Runtime Host、SessionManager、SQLite Store 与 sandbox supervisor 均在单一 App 进程内组合；未发现可对同一 Project/Workspace 并发 dispatch 的第二 Host authority。因此不引入 ProjectResourceFenceStore。

实现：`packages/runtime-host/src/single-host-invariant.ts` 提供 owner-only lock-directory lease；`apps/kite/src/bootstrap.ts` 在真实 Runtime storage owner 创建时取得 lease。V2 exact owner record 绑定 ownerId/PID；第二个活 Host、legacy/malformed/unverifiable owner 与 owner identity mismatch 均 fail closed。只有 OS 明确报告 PID 已退出时，Host 才把旧目录原子 rename 到唯一 quarantine、复核 owner identity 后删除并重试一次 acquisition。

Gate：`bun test packages/runtime-host/test/single-host-invariant.test.ts`（3 passed）；runtime-host 与 apps/kite typecheck 通过。覆盖 double-host admission、release/reacquire、dead-PID reclaim 与 legacy/malformed owner rejection。

约束：该 lock 只机械证明当前 single-Host composition，不是 execution grant 或跨 Host fencing token。若未来引入真实 multi-Host dispatch，必须另行增加 ProjectResourceFenceStore 设计与 ADR。待 implementation SHA/final-SHA Gate 后再恢复 completed。
