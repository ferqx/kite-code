# Agent Note: Workspace 原受理回执与显式离线历史清理

Status: implemented

## Problem

原 PC 的空间移除需要一次处理全部根及子会话；逐会话循环会产生部分删除和重复等待，回复丢失后又不能用新 commandId 重做。普通目录隐藏并不证明 owned 资源已经结束或正文已物理擦除。已发布却未被 Core 引用的附件还需要明确离线回收，不能在正常历史读取或删除受理时隐式猜测。

本记录解释当前批量封锁、原申请，以及已移除空间的显式离线正文清理。原按钮受理仍先保留历史，单会话按同一维护入口扩展，安装版维护资格尚未闭合；它不取代[原删除与资源收尾](2026-09-29-session-deletion-live-execution.md)的产品理由或旧路径的已实施机制。[Session 管理](2026-10-02-sealed-fork-and-session-management.md)的tombstone／准确旧ID／封存来源理由仍适用；空间全部删除且无外部来源依赖后，正文可按下述离线边界清理。

## Decision

在现有 Workspace metadata 保留闭合 `removal@1`，一次具名事务核全部根的原创建主体并保存原 receipt、整组 tombstone、停止边界及取消／delivery／Interaction 意图。Store 不逐根等待，不改写 unknown，不提升另一 Runtime owner。原 commandId／规范请求摘要返回同一原计数与时间，目录隐藏与迟到工作拒绝共用提交事实，无新 Core 基线表。

沿用原侧栏和 Main 原生确认，默认保留。确认后 fresh 核原 scope／名称／根，Node 在一次 FULL 事务惰性建 DB8 表并存完整原申请，然后仅 POST 一次。冷、submitting、unknown 只有原 GET 资格；恢复到新 Store 时保原字节并在 HTTP 前拒绝改绑。DB8 由专属 closed manifest v17 采集，旧 v2–v16 grammar 和 DB7 默认未移除路径保持。

显式 `collectProfileGarbage` 与CLI GC持同一外置Profile排他锁，核准确当前Store与私有DB/WAL副本。原源证明和副本回调结束后，才以验证过的无跟随读写连接修改Core。全部成员tombstone、过宽限且无活动／未知／待核对工作的Workspace以单事务清除关系历史正文及保留记录中的输入／结果正文；原receipt、身份／摘要／终态与删除边界不改。正常Fork在同一Workspace内，因此可一起清理内部来源；外部真实关系或未知扩展scope拒绝。metadata另存闭合 `historyCollection@1`，Session DTO以可选 `historyPurgedAt`说明历史已清理，原 `removal@1`不扩展。

单独删除的root组沿相同离线边界清理，以闭合 `sessionHistoryCollection@1` 的root→时间映射表达，不修改原delete receipt／控制快照，也不改Session基线。实际Fork creator request与闭合关系决定来源依赖；存活分支保留全部祖先，即使无Message aliases。候选仅在连接内存TEMP表中存在，保留向祖先传播后，合格的删除链同事务清理，不要求多轮维护。历史source tombstone不撤销已有sealed只读证明；当前namespace必须未删除，已清理来源拒绝，原creator／subject／Workspace／receipt／selection／stamps与普通执行权限保持。此范围补充[封存只读来源](2026-10-03-sealed-readonly-fork-sources.md)，不改变其不可执行与有限读取理由。

正文删除同步提高通知replay floor，并留下全局维护事实。事务开启secure_delete，提交后checkpoint／VACUUM／truncate WAL并同步；后续显式调用对已有标记也重做物理收尾，保证中断后仍能处理当前Core页和WAL。附件在SQL前完整预检namespace，随后只按当前 `blob_ref`／`execution_output`和宽限／全量SHA／同实体规则unlink。不修改独立备份、项目文件或Desktop私有未发送草稿。未结束／unknown／needs_review工作保留整空间证据，GC结果给出留存计数，不能通过TTL抹去恢复材料。

## Alternatives considered

- 复用逐会话删除并在 UI 等待所有收尾：循环不能形成 Workspace 原子结果，旧 ID 未知也不能成为重发依据；当前原批量事务保存一次受理事实，收尾仍由真实 owner 观察。
- 新 Core receipt 表并修改未发布基线：当前需要一个不可变 Workspace marker，现有 metadata 能明确表达并闭合解析；不为这一单项增加 schema 和基线 checksum 变更。
- 复用普通 caller Command 保存空间级请求：该 carrier 需要准确 Session，移除空 Workspace 或其全部根之后不能选另一个 Session 代替；保存在同一 Native private DB 的专属有限行，主线 UI复用而身份职责明确。
- 删除受理顺便擦附件／自动 GC：仍被历史引用的对象必须保留，在线 owner 和发布者也在使用同一 Profile；显式离线排他、准确引用和宽限边界才能限定当前回收范围。
- 只保最小tombstone、按宽限删除unknown执行正文：恢复、外部效果核实和原去重仍可能需要这些来源；当前选择保留整个未结束／未知／待核对空间，明确报告留存，终态合格后才清理。
- 在线等待停止后自动物理清理：删除受理与真实资源终态属于不同owner，客户端退出不代替停止证据；计划首版限定显式离线GC，沿稳定排他权和宽限处理。
- 逐root独立清理或以Message aliases作为唯一依赖：会使已删除来源链需要重复维护，也会丢失空历史Fork的实际祖先。选择joint候选与原typed创建来源，保留闭合关系；不从任意JSON扫描媒体权限。
- 用当前 Store 重标恢复申请：它会把已备份旧意图变成新 Store 写许可；保原请求字节，只允许真实原 Store 的原结果查询。

## Consequences

目录和工作封锁原子提交，但真正资源终态另行确认。删除受理后准确旧ID历史先保留；显式GC可清理合格已移除空间的正文与引用，同时原控制回执、去重和已保存草稿保留。单会话执行组也可按相同条件清理，未结束执行的后续核实与完整永久删除资格尚未闭合。同目录重加使用新 Workspace ID；项目文件不删除。macOS 原PC数据的安装版五项常用维护已沿Native自带／登记前门取得有限证据；过期GC只由安装包公开Host选择器与外部夹具时钟验证，原时间和回执不改。Node DB8 回退到不识别的新旧 builder、其余维护恢复窗口、Windows GC和完整平台资格尚未验证。按D08排除旧Store/State；当前没有新基线已发布前版样本，首发后的向后兼容要求仍保持，不能将本决定解释为完整 W19或V1.3退出。

实现、数据合同与实际验证由 [Native owner](../../../../apps/desktop/README.md#native-空间批量移除)、[Store owner](../../../../packages/agent/src/storage/sqlite/session-management/README.md#workspace-原子移除)、[maintenance owner](../../../../packages/agent/src/maintenance/README.md#desktop-db8-与-manifest-v17)和[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-空间批量移除与显式附件-gc)维护。双 Worker 原事务、真实 owned Tool／Job取消、实际 Node backup／restore／cold以及 SDK原回执反例均按有限证据核，不替代独立审查或整个阶段回归。实际清理、Core/WAL正文检查、原回执／去重、其他空间／独立备份及真实Node私有资产的证据归同一maintenance owner和当前进度。
