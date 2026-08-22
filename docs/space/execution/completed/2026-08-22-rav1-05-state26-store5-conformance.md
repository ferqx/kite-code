# RAV1-05 State26 / Store5 production storage

状态：qualification_pending

实现：`packages/runtime-storage-sqlite/src/store5.ts` 是 package 公共 target constructor/profile；App bootstrap 只调用 `createSqliteRuntimeStorageV5`。真实 SQLite schema 为 10 tables/4 indexes，包含 authenticated Event/Snapshot、DataOrigin、EgressAuthority 与 receipt/nonce ledger。event→origin→authority→receipt 同事务；fork 重绑 provenance，rewind/delete 按 reachability GC，reopen 扫描 ledger completeness。`store5-conformance.ts` 与 production compatibility adapter 已删除，Store4 constructor/path/constants 不从 package `.` 导出。

本地 Gate：Store5 conformance 12/12，覆盖 exact DDL、normal commit、fork/rollback/delete/reopen、tamper/key loss/missing ledger/orphan/cycle、multi-session corruption 与 explicit legacy metadata rejection；generated manifest 精确显示 State26/Store5/new epoch。

待闭合：implementation commit SHA 与 final-SHA workflows。旧 Store4 独立路径前后 bytes 不变，不读取、不迁移、不双写。
