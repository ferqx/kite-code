# Agent Note: Sealed readonly Fork execution and media sources

Status: implemented

## Problem

跨 Fork 的文件恢复需要核实原 Tool 后像、实际 Model 请求和完整原像媒体，即使该 Tool 的 trigger 不属于新分支的 selectable history。仅转交 namespace records 会丢失这些读取边界；放宽一般 Session reader 又会把同主体的其他执行变成可读来源。来源 Session 后续更新 head 也不能改变已经形成的 Fork 业务快照。[恢复产品定义](../../../../docs/handbook/features/recovery.md)与[当前 Fork owner](../../../../packages/agent/src/extensions/fork/README.md)分别定义产品与通用宿主边界。

## Decision

可信 rebuild 规则显式声明 `sourceReads:'declared'`，返回有限原 execution kind/ID 与准确 refs，或现有同 namespace anchor 的封存子集。纯规则没有 Store、I/O 或审批能力。Host 从实际 Tool decisionSource 自动封闭原成功 Model，通过可信完整 input/output 与 Artifact reader 核实际调用和媒体 EOF/hash；最终 Fork SQL 核完整原 root group 静止、namespace、选择、原 metadata/ref 与版本化 private proof，再同事务建立新 Session/records/receipt。未知、accepted 或未结算工作不能形成可用来源。

`openForkSourceProjection(localKey)` 只由当前实际 anchor 打开 callback 生命周期内的有限 Execution/Run、Model 全文与准确 refs reader。原 Store/Session/IDs 保持，当前 Store 另作观察身份；普通 foreign reader 和授权语义不变。原 mutable head 后变不污染已经封存的 immutable 来源，继承不能收集后续新增 effects/refs。Action prepare 自动登记 bindings，最后 SQL 复核实际 anchor、原 immutable 元数据与当前 context/group；关闭及 in-flight 结束各自复核生命周期。

可选历史另按实际每层 Fork 的完整 Message aliases 核对当前与全部祖先 IDs/seq、creator/selection/upper、role/status/source/parts。准确 getMessage 仅开放这一集合；User sourceId 撞名 Execution 不构成执行身份。未选中后像的只读证明不使其 trigger 可选。既有[records observer](2026-10-03-sealed-fork-record-observation.md)仍要求 live source revisions/rawDigest，本决定未改变其合同。

## Alternatives considered

- 只按已选择 Tool Message 提供来源：会在 session-only 排除后序 trigger 时丢掉实际后像连续性证据，改为规则声明来源并独立核 selectable aliases。
- 重读原 mutable head 或扩大普通 Artifact/Execution reader：前者改变历史快照，后者扩大 foreign scope；采用精确 anchor 子集和原身份。
- Core 识别 Files JSON、合成业务历史：会把业务规则引入通用 SQL，业务 snapshot 与恢复资格仍归 Files leaf。
- 截断大正文或 source graph 后返回完整：无法支持真实 EOF/hash 与权限证明，超预算明确拒绝。

## Consequences

增加有限 private metadata 与可信完整 reader 的核验成本。保持原 records 的64项、两种 binding 共用64项/32KiB以及 source graph、parts、祖先深度的有限预算；完整性预算不能冒充全会话历史配额。实际通用新文件20/313/0，相关七文件62/601/0；最后两个深度/字节反例在新20项中复验，不能将其推成未实际运行的邻接新计数。实际 Ask 后 source/Model/ref/anchor 漂移为零 adapter，正文超过300KiB、媒体 EOF、关闭在途、两层 Fork、head 后变、future refs、mixed 来源及 foreign/碰撞/循环均有真实资格。

本决定只交付通用来源子片。[完整恢复设计](2026-10-03-sealed-readonly-fork-sources-and-file-restore.md)的业务与客户端范围按各 owner 的实际资格维护，不据本 Note 宣称三种客户端范围或整个 V1.3 完成。
