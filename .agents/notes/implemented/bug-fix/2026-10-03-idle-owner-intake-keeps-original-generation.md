# Agent Note: 空闲受理窗口沿原 owner 继续派发

Status: implemented

## Problem

Runtime 读到空 accepted 列表后，新的准确 Session 命令可能先于 release 事务提交。实际 release 为 false，但原 hot Run/operation 已结束时，旧分支错误返回 `session_recovery_required`，把正常空闲交接当成恢复。Service after-turn/full unified 的真实失败和 SQLite barrier 反例证明这一窗口；单独重复通过不能替代交错证据。

## Decision

可信 Store 增加有限 `inspectOwnerDispatch`：同一短事务核原 Store、root owner instance/generation 和准确目标 Session，只返回该 Session 的普通 accepted Command 是否存在，以及原执行组是否有 active Run/未结算 Execution。acquire/release/inspect 共用同一阻塞谓词，保留既有准确 Job reconciliation 例外。它不重绑 owner、不新增恢复权，不进入 Extension、Model 或 HTTP。

仅在空列表、实际 release=false、无原 hot work 的旧分支进入观察。无未结算工作且有本 Session pending，沿原 generation 继续循环；pending 已取消则有限 release 后退出。其他 Session 保持自己的调度。真实 unknown/cold active 仍拒绝，不能因为另有 accepted 命令便自动恢复或重放。此规则限定正常 idle handoff，并非禁止原 hot owner 执行所有独立后台工作。

## Alternatives considered

- 只重读 accepted 列表：无法证明原执行组没有 unknown/cold active，会混淆正常新命令与恢复。
- 重新 acquire 或递增 generation：正常交接已有原 OS owner，引入不必要的接管和旧回调 fencing 风险。
- 接受后延迟或重复测试：不能修复事务之间的窗口，也不能证明未知效果安全。

## Consequences

实际 SQLite、真实 accepted Command 和所属 detached Job 结算 barrier 稳定复现原错误；修复后 pending/unknown/cancel/独立 Session 四场景 4 tests/25 assertions 通过，owner/recovery/child 七文件 76/936 和 Service after-turn 两文件 4/100 通过。日志保存在 `/private/tmp/kite-owner-handoff-baseline-failed.log`、`/private/tmp/kite-owner-handoff-final-qualified.log`、`/private/tmp/kite-owner-handoff-combination-qualified.log` 和 `/private/tmp/kite-service-after-turn-owner-handoff-qualified.log`。

独立 Session 反例是不同 root group；同 group 跨 Session 的准确过滤由 Worker owner scope 和 session_id 查询保证，尚未新增专门运行反例。当前整目标仍按 V1.3 §35 闭合；本 Note 的 implemented 只覆盖上述修复，不代表正式入口、平台或完整重构已经完成。

负责合同：[Store owner](../../../../packages/agent/src/storage/README.md)。验证：[确定性交接测试](../../../../packages/agent/test/isolated/execution/owner-handoff.test.ts)。当前边界：[统一 Agent](../../../../docs/active/unified-agent-boundary.md)。
