# Agent Note: 事务内维护的增量恢复证明

Status: implemented

## Problem

首次冷接续逐行重审 Execution 和 Interaction，并重新生成完整历史摘要。连接内缓存不能跨进程，任务越长，首次恢复的 SQL 与正文核验成本越高。直接信任旧摘要会漏掉历史变更、删除、跨 Run 移动和未确认外部效果。

## Decision

原记录、来源和执行身份保持；以闭合的第二项 SQL 迁移增加事务审计索引，不修改 0001 baseline、format major 1 或公开 HTTP。SQLite 持久 trigger 登记 Execution/Interaction 全列新增、修改和删除的 OLD/NEW Run/key，另在 REPLACE 冲突删除前捕获原身份；failed Model 的派生效果、Command/Session/child 身份和交互资格依赖也会失效。Store 在同一业务事务 COMMIT 前认证已结算历史的增量，保存完整行 SHA-256/资格问题并推进单调序号；活动 Execution 在恢复时独立完整校验，活动写入同样推进序号而不重复散列正文，没有相关变更的事务无需认证。不能在业务写入与证明之间 ACK。证明写门只在该认证阶段开启，故障或真实强杀使业务和证明共同回滚/提交。

新的 bindingDigest 绑定协议版本、原 Run/selection 与准确单调序号。历史任一列变化均使旧申请失效；改回原字节不能倒退已提交序号。证明及已认证队列的普通直接 SQL 修改受守卫，外部业务 SQL 不因省略 change_event 逃过触发器。信任边界是原私人 Store/profile 和闭合 schema，不接收客户端/模型自报证明，也不承担对任意管理员改写数据库文件的认证。

健康证明的冷读仅验证未认证增量、索引内的原资格问题及当前 frontier，末次 Model、live/unknown 执行和未决交互有对应索引。子任务闭包只从实际 live 工作和必要祖先发现；原 Command/Run/Store/subject/selection、完整来源 scope/hash、权限、配置、OS root 锁及最终 CAS 保持。未知 Tool/Job、历史缺失和跨 Run 移动不能被摘要变成成功。来源正文、实际 live 树和旧 continuation 的必要重建仍各自核验。

原 0001 历史在首次写入升级时完整认证一次，readonly/preflight 不迁移。缺证据、未知协议或 schema cookie 失效沿原完整 canonical 审计回退，不能把缺失证明当成完整认证。失效/旧来源证明退出增量认证并压实队列，未来普通事务不重复积压其旧变更。正常写入、WAL checkpoint、关闭和重开不使证明失效。增量分页每批200个 key，不保留全部正文或无界 native statements。

构建、只读打开与维护共用两项准确 schema/checksum 版本；旧 baseline checksum 保持，新 capture checksum 绑定全部已应用迁移，未知项拒绝。完整 SQL 清单由 sqliteStorageAssets().migrations 提供，Service 文件保护逐项纳入。恢复新 Store 保旧 origin/unknown，旧证明不取得执行权。所有权 CAS 使用 UPDATE RETURNING 核准确行，避免 Bun changes 把审计 trigger 副作用计入主更新。原 Run 正式删除时同事务清理派生证明/队列，审计优化不改变原 ledger 的删除权限或其他记录。

该决定部分替代[前一恢复决定](2026-10-16-durable-continuations-and-group-recovery.md)的首次全扫描与固定 canonical 摘要；其 owner、未知效果、来源、身份和组原子性规则继续适用。

## Alternatives considered

- 仅持久化摘要或通知 cursor：无法证明原历史未被无通知 SQL 修改。
- 每次恢复重算 Merkle 全树：构建仍线性；原子 Store 的单调失效序号已能完成同一 CAS 目的，不需要第二份完整业务历史。
- 单独恢复数据库/后台审计器：业务提交与证明存在崩溃窗口和双重 authority；选择原 writer 的同一 WAL 事务。
- 只看最新若干行或自动重放工具：漏掉未知效果和历史损坏，丢失原任务安全边界。
- 改写 baseline 或静默丢弃不兼容证明：破坏旧 Store 与维护资产的准确格式身份；选择明确增量迁移与安全回退。

## Consequences

历史审计从每次首次恢复的线性读转移到受影响写入，健康冷读访问量由前沿/未认证增量决定，B-tree 仍有对数成本。付出额外索引/摘要空间和每次写入认证；首次升级、失效证明回退与真实来源/活动树仍有必要成本，不宣称任意损坏后常数恢复或实际持续数周。

[增量审计回归](../../../../packages/agent/test/isolated/recovery/run-resume-audit.test.ts)的受控 SQL 容量夹具从100到10000条历史，另配同等数量的已结束子任务，planned/running 前沿分别均返回18/22行 SQL结果，并核末次 Model/效果依赖/live 状态索引计划；时间只作本机测量，不代表 Provider 业务吞吐。所属子进程在证明写完的 COMMIT 前/后真实 SIGKILL，分别保共同回滚/提交；真实证明 SQL 故障回滚原激活与回执。坏正文/来源、缺失/移动、unknown、旧失败 Model 新效果、无事件变化与旧 CAS 均有反例。

[升级](../../../../packages/agent/test/isolated/recovery/run-resume-audit-migration.test.ts)核原 schema/readonly 字节、一次认证及后续冷读、checksum与未知版本。[Windows 维护和实际包内 leaf](../../../../packages/agent/test/isolated/maintenance/windows.test.ts)核真实 Worker、两项构建资产、原来源的备份/新Store恢复及GC；其他平台/安装资格仍按原 owner 证据判断。[当前协议](../../../../packages/agent/src/storage/sqlite/run-resume.README.md)负责实现与限制。
