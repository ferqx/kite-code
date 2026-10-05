# Agent Note: Fork 来源记录以当前封存锚点观察并进入原 Action 最终事务

Status: implemented

## Problem

手册承诺创建保留来源的新会话后仍能选择更早的恢复节点。既有 namespace Fork 能封存来源、复制或纯重建记录，ReadContext records 与最终 dispatch 读集却只接受当前 Session。开放任意 foreign Session 或只在准备阶段读旧记录，会分别扩大数据范围或使人工审批等待后的来源漂移逃过最终事务。此 Note 只记录通用 records 原语的取舍，不宣称 Files 跨 Fork 恢复或祖先媒体消费已完成。

## Decision

当前 namespace 真实 localKey 的 sealed fork_provenance_json 是唯一观察锚点。readForkRecordSources 无 foreign Session/Store/key/namespace 参数；Store 独立核 applied Fork command/request/receipt、同 subject/Workspace、有限祖先链、每个封存 source key/revision/origin/rawDigest 与当前 selected complete Message 的实际 origins/parts。返回原 identity 的真实当前 anchor/祖先记录，binding 仅 version/localKey/digest。不重建旧 revision。

Host 自动收集本次 observations；记录 identity 使用 extensionId/Session/key。私有 Action decision 保存 forkBindings，最终 dispatch SQL 在同原 owned-write 事务独立重建绑定、核完整 source stamps 与 selected lineage，缺 stamp 或漂移零 adapter。Action/Ask 的 next_seq 水位不参与 Message 绑定。准备/执行/Query/context capture callback 后 observer 关闭；Model Tool context 不开放它。

rebuild.sourceScope:'namespace' 是可信注册 opt-in。默认仍传原 content type/version group；开启时额外提供 schema-validated、递归冻结的同 extension namespaceRecords，并由宿主固定 sourceKeys。无跨 namespace 内容或 I/O；完整快照规则使用 onUnsupported:reject。

## Alternatives considered

- 任意 records.forSession/sessionId opener：拒绝，caller 可获得未证明祖先或其他 namespace 读取范围。
- 仅复制 record JSON 或解析业务 source IDs：不采用为 authority。复制可保存信息，但不能证明真实 Fork、Message 分支与审批后的原记录 freshness。
- 准备读祖先、dispatch 仅复核本 Session：拒绝，来源/provenance/Message 在等待时变化会绕过实际副作用前的 CAS。
- 用 current source head 补猜旧 revision：拒绝，Store 没有 record 历史读端口。历史 metadata 快照由纯 rebuild 显式保存。
- 默认给所有 rebuild namespace 全记录：拒绝，保持已有 group callback 输入形状与 sourceKeys；显式注册才扩大到同 owner namespace。

## Consequences

记录与 binding 共同最多 64 identities/32KiB 私有读集；单次图/证明/Message 内容观察 1MiB、最多64层，Message及每条Message的parts各8192项。循环、预算或 unsupported 关闭，绝不截断为完整结果；这不是累计 Session 历史配额。源 revision/rawDigest 与 Fork snapshot 不同即 unavailable，不能将此端口当历史版本数据库。

没有 schema/DDL 迁移，没有业务 SQL，没有审批/permission/grant 复制；原 Action 写及授权仍为当前 Session/current expected Store。祖先 Run/Execution/Artifact 阅读与其 final CAS 仍是独立必要合同，普通同 Session reader 不放宽。

实际 macOS/Bun/SQLite：新 observer Store/Host 18 tests/94 assertions；同最终生产五文件邻接42 tests/381 assertions，含旧copy/group rebuild、17MiB原媒体、Action freshness、execution-group dispatch。types/build/Biome/docs结构/边界/ownership通过。第一轮失败为新 helper 将 command.status 误读为 execution.state，诊断及失败日志保留；修正后合法实际两层与63层链通过。
