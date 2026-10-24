# Agent Note: Native 历史以持久变更游标接续完整基线

Status: implemented

## Problem

用户要求桌面正常流式输出避免每次重读全部历史，降低显示延迟，同时断线和重开不丢不重。Message.seq只标识历史位置，模型partial在同一id/seq上改正文；旧输入的替换关系、压缩和虚拟子结果又依赖其他持久记录。仅凭下一条消息序号或正文前缀不能证明完整历史同步。

## Decision

Native首次打开、重开、暂停恢复、观察epoch变化及变更凭据失效时保持原完整基线读取和EOF替换。同View.snapshotCursor作为基线持久游标，SSE仅提供可领先View的目标游标；正文事件直接唤醒增量读取，跳过View刷新及其100ms合并等待。新增可选message_changes只读协议复用change_event，不新增业务数据表或第二个消息owner。

每批最多200个全局事件，正文事件按消息ID定位；其他元数据事件保守重投影展示依赖候选，包含原用户消息、解释/压缩消息和result_ref。首个候选页取得位置上界，后页固定；全部候选页完成后Native原子合并upsert/removedIds并推进变更游标，空批也前进。未变化对象保原引用；增量失败不提交半批，实际失败撤销准入。历史回收和过期刷新View/epoch后重新建立完整基线。所有消息仍由原Runtime/Service公开投影，SSE目标和读取缓存不变成ACK或执行权限。

本决定仅替代[此前完整刷新](../bug-fix/2026-10-08-native-observation-output-refresh.md)中“每个同scope修订均完整扫描”的部分；完整基线、固定上界、页预算、发布快照、迟到隔离及[reset保正文](../bug-fix/2026-10-16-native-history-reset-reading.md)的理由继续适用。缺少新能力的旧Service仍沿兼容全读路径，Web/TUI不切换。

## Alternatives considered

- 只读afterSeq之后的尾页：同序号partial更新会漏正文，拒绝。
- 直接拼接SSE payload或维护Main内存变更日志：当前事件不带完整公开消息，日志还需独立证明覆盖和回收，且重开失去连续性；复用Store现有持久事件。
- 只追message.updated：原输入duplicateOf、解释回执、压缩和子结果可能不修改物理Message，不能保证原展示语义。
- 为全部展示依赖建立新持久消息版本表：扩大事务写入和维护范围；当前按元数据变化保守重投影依赖候选，在普通正文事件走准确ID快路径。
- 每次发送前强制全读、Run内完全停止同步：不能读取运行中保存的同序号更新或恢复缺口。连续覆盖可保持已有基线，断线/失效仍须完整恢复，不以发送时机替代同步事实。

## Consequences

初始完整历史仍是线性成本，元数据重投影的依赖候选也可能较大；本轮避免普通正文事件反复传输全部历史，不宣称所有读取O(1)或Markdown解析增量。每页继续预算与校验，不限制活动历史总条数/字节。新协议需重启Main和配套Service，renderer HMR不足以加载。

实现、当前验证和限制分别归[Store](../../../../packages/agent/src/storage/README.md#消息历史变更读取)、[Client](../../../../packages/client/README.md#消息历史增量)及[Desktop](../../../../apps/desktop/README.md#会话消息渲染验证)；隔离真实SSE断连/冷重开和生产renderer窗口分别证明协议与展示，不代替用户实际会话、安装包或其他平台资格。
