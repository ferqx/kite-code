# RAV1-05 State 26 / Store 5 conformance

状态：completed（isolated conformance only）

实现：`packages/runtime-storage-sqlite/src/store5-conformance.ts` 冻结 State26/Store5/new epoch 常量、State25 逐字段保留 mapping、Store5 DDL/index manifest 与 isolated constructor。Target path 尚未接入 production bootstrap。

Gate：`bun test packages/runtime-storage-sqlite/test/store5-conformance.test.ts`（3 passed）；runtime-storage-sqlite typecheck 通过。测试确认 source State25 不被修改，target DDL 精确返回，production constants 仍为 State25/Store4/`kite-runtime-2026-08-18`。

约束：RAV1-06 前不得创建 target production DB、不得读取旧 Session、不得双写或在线迁移；旧 Store4 保持不变。
