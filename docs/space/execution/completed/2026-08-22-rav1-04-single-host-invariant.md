# RAV1-04 single-Host invariant

状态：completed

裁决：当前仓库的 Runtime Host、SessionManager、SQLite Store 与 sandbox supervisor 均在单一 App 进程内组合；未发现可对同一 Project/Workspace 并发 dispatch 的第二 Host authority。因此不引入 ProjectResourceFenceStore。

实现：`packages/runtime-host/src/single-host-invariant.ts` 提供 owner-only lock-directory lease；`apps/kite/src/bootstrap.ts` 在真实 Runtime storage owner 创建时取得 lease。第二 Host、stale owner 与 owner identity mismatch 均 fail closed，不能静默接管。

Gate：`bun test packages/runtime-host/test/single-host-invariant.test.ts`（2 passed）；runtime-host 与 apps/kite typecheck 通过。覆盖 double-host admission、release/reacquire 与 stale-owner rejection。

约束：该 invariant 不改变旧 Store 4、State 25 或当前 epoch；若未来引入真实 multi-Host dispatch，必须另行增加 ProjectResourceFenceStore 设计与 ADR，不得把本 lock 当作 fencing token。
