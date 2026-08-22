# RAV1-05 State26 / Store5 production storage

状态：completed

实现：`packages/runtime-storage-sqlite/src/store5.ts` 是 package 公共 target constructor/profile；App bootstrap 只调用 `createSqliteRuntimeStorageV5`。真实 SQLite schema 为 10 tables/4 indexes，包含 keyless integrity-checked Event/Snapshot、DataOrigin、EgressAuthority 与 receipt/nonce ledger。event→origin→authority→receipt 同事务；fork 重绑 provenance，rewind/delete 按 reachability GC，reopen 扫描 ledger completeness。`store5-conformance.ts` 与 production compatibility adapter 已删除，Store4 constructor/path/constants 不从 package `.` 导出。

本地 Gate：Store5 conformance 12/12，覆盖 exact DDL、normal commit、fork/rollback/delete/reopen、corruption/writer mismatch/missing ledger/orphan/cycle、multi-session corruption 与 explicit legacy metadata rejection；generated manifest 精确显示 State26/Store5/new epoch。digest 只作 corruption guard，不声称同用户 authenticity。

完成证据：implementation SHA `604db49d0d32e55bc6761e181856967759cbbb1e`；[Platform Capability Probe 32587639601](https://github.com/ferqx/kite-code/actions/runs/32587639601)、[OSS Release Candidate 32587641939](https://github.com/ferqx/kite-code/actions/runs/32587641939) 与 [Runtime Resilience Qualification 32587644604](https://github.com/ferqx/kite-code/actions/runs/32587644604) 均绑定该 SHA 并成功，正式 7 case × 8 measured report 及独立 verifier 已通过。 旧 Store4 独立路径前后 bytes 不变，不读取、不迁移、不双写。
