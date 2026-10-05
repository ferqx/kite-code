# Agent Note: Current recovery boundaries and independent intent assets

Status: implemented

## Problem

父 Session 的 Files point 保留原 Message 身份，Fork 后当前 Session 的选定消息却使用新身份。客户端只拿原 point 的 before/trigger 或相同 seq 无法证明当前合法 Fork 边界。CLI/TUI 文件 journal 与 Desktop 私有库又要在首 POST 前保存适用的两条请求身份；把它们塞进旧恢复记录或旧备份版本会让准确 reader 接纳未声明的字段、表与路径。[完整恢复设计](2026-10-03-sealed-readonly-fork-sources-and-file-restore.md)现已包含三个客户端开发路径的实际窗口；本记录只描述已交付的当前边界与独立离线资产。

## Decision

[Files owner](../../../../packages/agent/src/business/file-checkpoints/README.md)新增固定 `files.checkpoint.recovery-boundary@1` Query，输入仅原 pointId。它复用完整 selected lineage 与所有 sealed ancestor aliases，独立核原 point 的 trigger/before，返回当前 Store/Session/Workspace/selector、完整原 checkpoint 与当前 boundary/trigger Message 身份。读后再核实际 group Store/Session/contextRevision；全部四个 Files Query 的入口核实际 execution-group scope 与 subject。此 Query 只提供有限当前选择证明，不读文件或媒体正文，不执行恢复，物理 conflict 不等于 session-only 无合法边界。

[Native API 与 Client](../../../../apps/service/README.md)只映射四个固定 Files 查询，分别保当前观察和原 checkpoint，不开放任意 namespace/query 或新执行 endpoint。Browser 仍使用其原三个有限只读入口。客户端不能从 metadata、文件预览或相同序号推导写权限；原 Code journal/carrier 成功是历史事实，当前文件是否仍处于该 point 需另行读取。

[维护 owner](../../../../packages/agent/src/maintenance/README.md)另核 CLI/TUI 的 `ui/file-recovery-intents.json@1` 与 Desktop DB4 的准确 `file_recovery_intents(intent_id,state)` 表。closed metadata 一次保全部适用的原 Code/Fork Command、restore/newSession IDs、完整 point/current aliases、两条 canonical Core SHA 与各自 phase。所有记录的两种 Command ID 全局唯一，最多 128 条与 16MiB UTF8，不删除 unknown 或改写原身份。Code 摘要使用实际 `extension.invoke.actionId`；Fork 摘要使用实际 `session.create.fork`，不能仅从 HTTP request 删除外层字段。

备份只在新文件存在或实际 DB4 时写 closed manifest v6，必须声明独立 `fileRecoveryIntents` 资产；纯旧资产仍写 v5。v2–v5 的字段、树白名单与 DB 版本契约保持准确，不能改 manifest 版本或格式声明来冒充新 schema。源、副本、inspect、restore 核完整 proof、私有 FD 身份、no-follow/单 link、fatal UTF8、全部字段集合、原请求 SHA、SQL PK 和跨行 Command 唯一；DB 以真实 BLOB hex 拒绝替换解码。Agent 维护实现不依赖 Client、CLI、Desktop 或 UI workspace。

## Alternatives considered

- 客户端从原 point、seq 或最深 origin 推断当前 cut：两层 Fork 的 aliases 与当前 selector 需要实际 selected membership，改为 leaf 返回有限且可复核的当前边界。
- 开放任意 namespace Query 或用 detail 冒充当前 Fork cut：前者扩大 Native 读面，后者缺当前 Message 身份；采用第四个固定 metadata Query，沿用实际 scope/subject guard。
- 把新 intent 放旧 recovery/caller journal 或旧 manifest：会混合不同请求合同并扩大旧格式白名单；采用独立文件/表与条件 v6，旧格式保持精确。
- 用 HTTP 请求去掉 ID 后计算 Fork 摘要，或只核外层文件 hash：与实际 Core canonical input 不同，也可能隐藏有效外层 proof 下的坏内部请求；重算准确 Core SHA 并独立核所有闭合字段。

## Consequences

增加一个有限只读 Query 和显式私有资产格式，不新增执行权限或恢复批准。新 Store 恢复保原 Store/subject/point/request/state 和完整 Unicode/CRLF 字节，不生成热 permit、换 IDs、自动 POST 或替用户回答 Ask。既有 `coverage.profileComplete:false`、vault 排除和配置/Core/UI 非瞬时原子的采集边界保持。

2026-10-04 当前 Files 与默认 Fork/压缩/A→B/媒体五文件实际 24 项 602 条断言、零失败；Native 四类 API/SDK 六文件 13 项 629 条断言是独立运行。私有资产定向 4 项 67 条断言，完整维护六文件当前 51 项 677 条断言、零失败，含真实 Node DB4、新 Store 冷读零 HTTP 和既有实际 SIGKILL 恢复 journal 窗口。旧 manifest 的正反例使用真实 DB3/DB2 与实际 ready 文件，不用不受检查的参数代替物理格式。

这些资产证据不替代各客户端的实际两步窗口，也不完成全 §35、37 项能力或正式 legacy 退役。完整恢复决定已按各 owner 的实际客户端窗口实施；其 both 显式第二步要求新读原 point detail、完整当前 scope/selector 与全部 `unchanged`，避免把 Code 的过去成功当作当前磁盘证明，也不宣称最后读到 Fork 间锁住外部编辑。
