# Agent Note: Trajectory 事实投影与受限 Trace 消费者

Status: implemented

## Problem

Store 的权威业务记录、有限事件快照及不可变材料不能由最新业务行还原任意历史时点；可信进程内扩展和 best-effort Observer 也不能独自兑现第三方可靠消费与隔离承诺。需要在保留原业务 authority、材料保留和权限边界的同时，提供第一方历史读取与第三方受限消费。

## Decision

完整 V1 的本机开发交付已按用户确认的七项 review 边界实施。产品语义归[会话](../../../../docs/handbook/features/sessions.md#执行轨迹与只读重放)与[扩展手册](../../../../docs/handbook/features/extensions.md)，当前实现按[Agent owner](../../../../packages/agent/src/trajectory/README.md)、[Client owner](../../../../packages/client/README.md)、[Native owner](../../../../apps/desktop/README.md)、[Trace owner](../../../../apps/service/src/trace-extensions/README.md)及[现行边界](../../../../docs/active/unified-agent-boundary.md)判断。本 Note 保留持久取舍理由，不作为另一份产品或发布 authority。

- 原 Runtime/Storage owner 在提交时封存历史事实；在原 change_event 行增加独立事实列，保留唯一事实来源及原 Session Log 严格 envelope。这样不需要第二套业务日志，也不会以新材料字段破坏已有有限诊断。
- 材料复用原不可变发布及 blob_ref 正式引用，业务事务绑定准确 head/可见范围，继续由原 GC 管理引用闭包；本功能不新建通用的“已发布未采用”回收机制。historyCoverage 从事实格式启用点、现有回收标记及原事实计算，不另存逐事件覆盖账本；通知 floor、投递状态、当前展示和衍生缓存都不能替代历史覆盖证明。
- 事件页携带固定 upper、原身份及范围，无状态分页且逐页核当前授权，避免为不可变事件扫描维护另一套读取会话。材料分块仍保留 Evidence lease，负责 offset、版本、取消、关闭和授权复核。
- 第一方 Reader/Replay 与第三方授权投影共用规范事实，第三方仅取得有限 API。TraceHost 属于 Service 消费者，不进入 Runtime 业务 Host；受限 bundle 在独立进程的无默认 I/O engine 中执行，所有材料、配置、凭据和网络均经 Host broker。
- 通用 SDK 只返回 ACK/reject，Host 持久维护消费队列和连续水位；扩展承担 eventId 幂等处理责任，不为任意扩展建设 statePatch/CAS/outbox 事务平台。OTel 的开放 Span state 和 durable spool 由 P5 参考适配器专用 owner 维护，远端出站另行记录；它不成为事实 authority，也不以 SDK 内存队列承担本机可靠性。
- 源删除限制后续事实及材料读取，缺失明确呈现；已复制的安全事件由原导出任务及当前 grant 管理，取消或撤销授权封住未来发送。源删除不隐含撤回已经交付的副本，不新增业务 Store 与 consumer-store 之间的发送 read lease。
- P0/P1 先交付纯协议、原事实和只读能力；QuickJS/broker 与 OTel/exporter 的技术探针分别归 P4/P5，可以提前并行，但不作为 P0/P1 的退出前置。第三方隔离、权限和可靠出站的最终标准保持。
- Shell 沿原保存的事实和预览做 as-of 投影，截断范围明确可见，不以预览宣称完整 stdout/stderr。P1 的事实完整不等于默认全量输出归档；完整流归档不列为本次 V1 必需新增能力，也不阻塞原事实读取。
- 轨迹展示按用户确认的事件树与入参／出参／生命周期详情组织。完整前缀只保留原身份、父子和全部来源 ID 索引，原始事件详情按所选节点有界分页，避免分页裁掉父节点或依赖最后一条事件代表全部过程；树采用迭代展开，深层关系不因 JavaScript 递归栈或缩进宽度而丢失。索引是展示派生值，不接管原事件、子会话读取范围或材料授权。
- 默认轨迹按用户确认只展示模型、工具、自动压缩和审批；在完整树上派生可见集合，必需祖先保留结构，完整保存、原关系及全量入口继续保留。原压缩 trigger 和交互类型以可选有限标量随事实封存，避免为了展示分类预读材料或用当前业务行追补历史；缺少分类的旧事实保持未知。详情按匹配事实重新分页，过滤不改变原来源 scope、导出或第三方消费范围。
- 用户消息与Agent回复作为对话上下文保留，四类过滤只约束执行细节。消息采用独立事实／Evidence，按原消息ID聚合流式版本；这样既能展示起点和结果，也不会把模型全上下文重复拆成消息或把工具结果当用户输入。正文与公开输入解释在原变更事务封存，缺失版本不从当前消息、当前回执或时间邻近关系补造；原Model生命周期仍独立保留。

这些取舍细化本次 RFC 目标，不替代现有[有界 Session Log 决定](2026-10-03-bounded-session-log-observation.md)或[生命周期观察决定](2026-10-18-settled-lifecycle-observers.md)；两者继续维持原职责及丢弃/只读边界。

## Alternatives considered

- 扩大 Observer 队列或把 SessionLogPage 改名为 TrajectoryEvent：没有持久确认、完整历史事实和材料版本，不能满足恢复及 as-of；保留原合同并新增独立消费者。
- 从最新 Execution/Message/Artifact head 重建历史：会把后来状态或正文带入旧游标；只解释已封存字段，缺失保持未知。
- 直接扩展现有 session-log envelope 字段：当前严格五字段解码会退化；选择独立事实列并配套明确迁移、INSERT、备份及兼容测试。
- 新建平行 trajectory_events 业务库：增加双写一致性和 authority 歧义；消费状态可独立存储，事实仍归原 Store。
- 在业务 ExtensionHost 或普通 Node/Bun Worker 中执行第三方代码：可信 facade/线程监督不能强制限制任意文件和网络；选择 engine compartment/broker，平台进程监督分别验证。
- 将 OTel 格式作为内部模型或内存 exporter 接受当作交付完成：限制真实执行关系且无法跨崩溃保留开放 Span；使用独立映射和适配器专用持久 state/spool。
- 为本功能增加通用未采用材料回收、逐事件 coverage 账本或有状态事件分页：重复原引用/GC、原事实和逐页授权的职责；沿原 blob_ref 闭包及格式启用/回收依据计算覆盖，只为确有分块资源的 Evidence 保留 lease。
- 将 SDK 做成通用 statePatch/CAS/outbox 平台，并以源生命周期 lease 协调删除和出站：前者扩大第三方 SDK 存储职责，后者新增已复制安全事件随业务删除失效的产品语义。选择队列/ACK 的有限合同，OTel 私有持久化，以及导出任务/grant 控制已复制事件。
- 先完成 engine/exporter 探针或 Shell 完整流归档，再允许 P0/P1 退出：前两项属于后续消费者的实现风险，后者超出原保存范围的真实投影。将探针移到所属 P4/P5，保留真实事实及截断说明，不把完整流归档增加为 V1 前置。
- 只将当前原始页转成树，或把全量原始正文常驻 renderer：前者会裁断跨页父子及早期生命周期，后者破坏有界读取。采用完整轻量索引与所选节点的分页详情；材料仍通过原 event/ref/version 显式读取，未保存的工具入参不从现态补造。

## Consequences

原事实、材料及消费者 owner 的验证已覆盖旧游标无未来事实、历史绑定准确、原引用／GC闭包、覆盖降级、逐页授权、旧日志与 payload 保持、过滤空洞、消费者故障隔离、撤销及 ACK／发送竞争、死信水位，以及 OTel 私有持久接受与远端确认分离。Shell 只按实际保存范围验证，预览截断不冒充完整输出；这些理由继续约束后续实现。

QuickJS-WASM 0.32.0 独立进程、真实 guest／SDK 生命周期、实际 Host 队列与 ACK 提交前后强杀、SQLite 限页写满，以及官方 exporter／私有 spool／本机 OTLP receiver 已分别验证。Native 在线、两种导出、只读冷开及设置的全过程与最终正式 Terminal 候选包外默认装配也已验证。准确命令、代码范围与限制保留在上述 owner，不另建完成台账。SQLite_FULL 不等于物理卷 ENOSPC；OS 凭据写入在本机未取得成功资格；其他平台、已安装制品和远端后端不由本机结果授予资格。

主要成本在原事实补齐、历史覆盖/材料的 backup/GC 闭包、第三方执行与凭据边界，以及开放 Span/响应未知的恢复。旧历史缺少事实不能补造，真实来源回收会限制尚未读取的范围；已复制安全事件的交付资格由任务/grant 决定，不能向用户承诺业务删除会收回副本。Shell 未保存的完整流无法从预览恢复；网络响应丢失仍可能导致远端重复。平台和安装制品资格分别取得，不能由单个 fixture 或本机成功外推。
