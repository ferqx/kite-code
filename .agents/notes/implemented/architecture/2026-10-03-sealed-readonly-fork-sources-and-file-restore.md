# Agent Note: Sealed readonly Fork sources and actual file restore baselines

Status: implemented

## Problem

[恢复产品定义](../../../../docs/handbook/features/recovery.md)承诺客户端可恢复会话、代码或二者，Fork 保留来源但不继承授权。当前 [Files checkpoint owner](../../../../packages/agent/src/business/file-checkpoints/README.md)已有完整原像、逐文件 journal、独立人类审批及实际 A→B code-only 恢复；[通用 Fork owner](../../../../packages/agent/src/extensions/fork/README.md)只交付 namespace rebuild 与封存来源 records 观察。原执行与 Artifact 仍按原 Session 读取，因此跨 Fork 的早期点、后来文件状态及组合恢复尚未闭合。

所选历史与文件恢复证据具有不同边界。仅会话恢复到 B 的 trigger 之前时，磁盘仍可能保留 B 的后像；较早 A 点需要真实 B Tool 后像收据来检验物理连续性，即使 B trigger 不在新的 selectable history。组合恢复实际写回后会产生新 inode；若 journal 忽略 `files.restore` 返回的确认 baseline，则后续更早恢复点仍拿旧 inode 比较，正确的恢复也会被当作外部漂移。原 namespace source head 可在 Fork 后继续改变，不能靠重读它猜回旧业务链。

## 当前实施边界

截至2026-10-04，通用[sealed readonly来源](2026-10-03-sealed-readonly-fork-sources.md)、[Files完整时间线/实际confirmed baseline](2026-10-03-sealed-file-checkpoint-timeline.md)与Web有限只读已分别交付。历史原Run选择由[private observer](2026-10-04-original-run-selection-observation.md)派生，当前selected资格独立核实。CLI/TUI/Native 开发路径现已交付三种范围、持久两步骤与原 ID 冷查询，各自真实 carrier 和窗口分别验证。本决定覆盖这些已交付行为；正式入口、完整 Native 发行安装、三平台和 V1.3 整体完成仍各有独立条件。

恢复effect ledger在任何物理restore/remove之前持久完整before-image/pending，成功后使用actual postbaseline。精确failed carrier+完整空ledger可证明零文件效果并保留no-op来源事件；pending/partial/unknown不能如此解释。同Run的restore→resume推演被既有active/group门禁排除，未新增segment schema。

Files leaf的有限current selected boundary/trigger aliases、Native四类固定GET与独立意图维护资产已交付，见[原边界与独立意图资产](2026-10-04-file-recovery-boundary-and-intent-assets.md)。原point仍保original Store/S；客户端不能按seq或最深origin猜当前Fork边界。完整caller intent在首POST前一次持久适用的两条Command/restore/newSession IDs及准确Core request digest，状态与immutable身份分开；CLI/TUI新独立journal与Desktop准确DB4通过条件manifest v6保存，旧格式不扩大。oldStore intent在A→B后保持foreign只读，不自动绑B。三客户端实际提交、独立 Ask、丢回应、冷查询及强杀窗口均按其 owner 的真实运行保留；此决定不扩大 Web 恢复控制或增专用执行 API。

## Decision

### Generic sealed readonly sources

可信 `RecordForkRule.rebuild` 可显式 opt-in `sourceReads:'declared'`，默认没有新的 source 权限。纯规则除已验证、冻结的 namespace snapshot 外，不得到 Store、I/O 或批准能力。它返回有限 `readonlySources`，只声明实际原 execution ID、kind 与精确 ArtifactRef ID；继承则只能从现有 sealed anchor 取同原 execution/ref 的子集。模型、JSONC、HTTP、普通 record value 或扩展自报 hash 不能创建 source 权限。

Host 准备期核原 Execution/Command/Session/Run/subject/Workspace/decisionSource、known terminal result/revision；Tool 的原 Model 关系和完整 input/output ref/metadata 由既有可信 reader 推导，不用声明字符串替代 authority。ArtifactRef 必须是实际注册、精确同 execution scope、原 origin、size/hash/mediaType。Fork 的最终 SQL 同时检查完整 source execution group quiescence、namespace/read-set/selection、原 metadata/ref 与 private proof，在新 Session 和 records 的同事务封存版本化 provenance；未结算、accepted work、unknown 或缺媒体不能静默得到可用 Fork source。

`ReadContext.openForkSourceProjection(localKey)` 仅从当前 Session/namespace 实际封存 anchor 打开有限 callback-lifetime reader。它保原 IDs/scope/current Store observation，只允许 sealed exact sources 的 Execution/Run、原 Model full input/output 和精确 Artifact 读取，不能调用执行、写入、grant 或一般 foreign reader。callback 与 in-flight 返回后均检查关闭；共用有限读集、source graph 与完整性预算，不截断后声称完整。最终当前 Action SQL 自动复核实际 anchor、原 immutable Execution/Model/ref proof 及当前 context/group；不以 Fork 时的 mutable source head revision 约束后来读取。

真实 Fork path 还必须提供每条已选 Message 的全部可核祖先 aliases，而非仅最深 origin。每层 creator/selection/upper、Message 的 role/status/source/parts 与原 identity 精确对应；User 可撞名 IDs、歧义、循环、未来 parts 或缺证据都不能授权。aliases 仅用于 selectable checkpoint，readonly source delegation 可另保未被新 selection 选择的真实后像 evidence。

现有 [sealed records observer](2026-10-03-sealed-fork-record-observation.md)继续按 live source stamps 工作；本决定新增 immutable source delegation 与业务完整 snapshot，不放宽已有 scope 或用旧 reader 冒充新能力。

### Files namespace snapshot and confirmed restore result

Files rebuild 由独立业务规则保存 Fork 时完整 checkpoint/file-chain metadata、准确原 A/B origin Store/Session/Tool/Model/Artifact identities、当前物理状态对应的真实已确认文件 baseline 与有限 readonly delegation。point eligibility 按真实 selected aliases 判断；后像 receipt 可作为恢复证据保留，不因它没有 selected trigger 就丢掉。普通 Query/Action 不把 derived namespace record 重标为原 point 身份，不靠 head/URL/hash 猜源 scope。

每次恢复只在 `files.restore` 或 remove 的实际返回已经确认时发布新的 confirmed post baseline（含实际 inode/hash/size 或已确认 missing），逐文件 CAS 与 journal 保原 restore/execution identity。失败、取消、unknown、部分发布不能用预期 preimage 冒充确认结果；原 journal phase 和实际 carrier Execution 状态各自保留。新的 Fork 再转交已经封存的 subset，不收集 Fork 后新增 Source effects/refs。

### Callers and Browser observation

CLI/TUI/Native 的三种范围以同一闭合 caller intent 保原 point/boundary、code Action Command/restore ID、Fork Command/new Session。code-only 独立人类 Ask；session-only 不写文件；二者先执行 code leg，已知成功后才执行 Fork leg。code partial/unknown 时不得 Fork；code 已成功而 Fork 回复未知时仅查原 Fork Command，不能重写文件或生成替代 IDs。呈现每一 leg 的实际状态，不声称跨文件/跨 leg 原子。

Code的原journal/carrier已知成功仅证明过去结果。显式继续both Fork前必须实际新读原point detail，核current Store/S/W、完整原checkpoint及前后selector，所有 files.status 必须为 unchanged；Client 另核路径唯一及覆盖原 Code journal 的每一条路径，拒绝缺少原路径的空列表；后续合法Run可能给restore/remove，不能只排除conflict/unavailable。条件不成立保留Code succeeded/Fork not_started，零Fork POST、零Code重做；冷历史lookup仍只查原Cmd/status，不能降级过去事实。此有限新读不声称在最后detail到Fork间取得外部editor全局锁。

Web 仅新增闭合只读目录、preview detail、restore-status。宿主固定三个 Files Query，不接受任意 extension/query/action JSON；DTO 分别保当前 Store/Session/Workspace observation 与原 point boundary。detail 会实际只读校验原 Artifact bytes/hash 和当前 postbaseline；没有下载、打开文件、恢复、Action 或批准入口。目录仅 keyset 分页，没有固定快照；stale、abort、迟到响应、protected/conflict/unavailable 与 journal/carrier 状态必须准确展示。

## Alternatives considered

- 仅由 selected Tool Message 授予媒体读取：首版设计考虑过，但 session-only 留下实际后像、B trigger 被排除时会丢掉合法连续性证据；改为可信纯规则声明的有限 immutable source delegation，并另核 selected aliases。
- 重用 live records observer、重读 source head 或猜旧 revision：会让来源 Session 的后来变化污染历史 Fork，且不能恢复已修改的旧 metadata；保留 Fork-time 完整业务 snapshot 与封存 source proof。
- 放宽普通 `getExecution`、Artifact reader 或重标来源到当前 Session：会使相同 subject 的任意 foreign execution 可读，掩盖原 Store/Session 因果；保持原 reader 范围并新增精确 private projection。
- 在 Fork SQL 中识别 Files checkpoint ID/JSON、或让 Core 合成文件历史：破坏通用宿主边界；Core 仅核 trusted rule 声明与通用原事实，文件 metadata/eligibility/confirmed baseline 归 Files leaf。
- 两个 restore leg 伪装原子、unknown 后重发或替换 IDs：无法撤销已发布物理效果，也会重复写或创建分支；保存完整原 caller intent，逐 leg 呈现并只查原命令。

## 当前验证

1. 实际 session-only 排除 B trigger 后，早 A point 仍凭真实 B receipt 校验并恢复；两层 Fork 的中间 aliases 不丢，未 selected point 不被展示为 selectable。
2. 实际组合恢复保存新 inode/缺失的 confirmed baseline，随后更早点恢复成功；外部漂移、unknown/partial 恢复和 unsupported/budget 明确拒绝，无伪成功。
3. 同主体 foreign Session、User ID 碰撞、未声明 refs、后来 source effects/refs 不扩权；原 Execution/result revision/Model/ref/anchor 在 Ask 期间漂移由最终 SQL 拒绝，零 adapter。
4. 真实原媒体 full EOF/hash 与 callback/in-flight 关闭；当前 B observation 与原 A source 各自准确；sealed delegation 不复制执行/批准/grant，不依赖 mutable source head 未变。
5. 三种 caller scope、物理丢回复/cold 查询、code 已知成功而 Fork unknown 均核固定原 IDs 和效果次数；CLI/TUI/Native 各有实际 carrier 证据。 Code成功后外部编辑或后来distinct completed Run，即使selector不变，也由显式第二步fresh detail阻止Fork且不重做Code。
6. Web 闭合 DTO/Gateway/SDK 恶意字段反例、DOM 分页/stale/abort/late、真实默认 Service + Cookie Gateway + Browser 点目录/detail/status；查询前后 Provider/Command/Execution/cursor/文件 bytes/hash 恒定，无任何写入口。

## Consequences

sealed source proof 与 full namespace snapshot 会增加私有 metadata，必须受现有有限 budget 约束；无法完整封存应明确 unavailable，不能裁剪。Artifact 内容的物理 EOF/hash 校验归 trusted reader，SQL 只核注册及 immutable metadata，二者不能互相替代。恢复会改变 inode，只有实际确认返回能成为后续 baseline。本决定的开发路径已交付，不代表 §35、37 项全部能力、正式 legacy 退役、通用 Shell、真实 vault 或三平台已经完成。最后 detail 到 Fork 间仍有外部文件变化窗口；纯 DTO 完整性检查不提供密码学来源认证，也不提供文件与 SQL 两步骤原子提交。

2026-10-04 当前限定证据：Files 五文件 24/602/0，Native 固定 API/SDK 六文件 13/629/0，完整维护六文件 51/677/0；Client 两文件 14/345/0（纯 13/180 与真实默认 1/165，同一次组合运行）。CLI/TUI 真实恢复十二项 124 条断言，另外两个单 scope PTY 项 16 条断言为独立运行；Native 邻接十一文件 30/249/0，另两个 Electron 邻接 2/18/0。各次运行、制品身份与实际限制见[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

当前 Web IAB 使用 terminal-5edf2829c7c000fb3565551e19060b39e1e2b7517945fe375dc3cbb53359f291：真实目录/detail/原 status 三 GET、关闭与切换 Session 两 held GET abort；前后十二项事实相同，Provider 8/cursor 124、250003 字节完整 BOM/CRLF 原像及新 inode 分别核对，fixture 自动关闭退出 0。根 tsc 与 26 workspaces 当前整合 typecheck 退出 0；这些计数各保实际范围，不能合并成一次全 §35 资格。
