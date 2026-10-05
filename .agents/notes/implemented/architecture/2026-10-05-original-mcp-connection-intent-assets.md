# Agent Note: 显式 MCP 连接保原申请、原 ready 与当前 live

Status: implemented

## Problem

安全目录和配置选择不能证明已经连接。用户需要从当前可用 Server 明确申请连接，在回执丢失、冷重开、来源移除或备份恢复后查原申请；把 Command accepted、历史 ready、当前 live 和 warm复用混为一件事，会虚构新连接或误重放连接。借旧配置选择 journal 保存不同请求还会扩大原闭合格式和恢复权限。

## Decision

可见Request connection先选择再独立Enter确认准确Server/source/transport/Session，只提交普通 `builtin.mcp/mcp.connect@1`；实际connection Job沿原独立许可和最后source/wire核验。Host新提交读完整公共Workspace目录、实际canonical identity及与原observed全等的安全目录，只接admitted/selected/available来源。read-set仅用于本次观察复核，不加入connect input伪装CAS，不建立第二执行器。

独立 `ui/mcp-connection-intents.json@1` 闭合完整原request、subject、Store/Session/Workspace/identity、body/request SHA和有限phase；key是1–64字符ASCII安全ID。沿Profile-use lease、短data lock、private/no-follow/单硬链/实体、16MiB/128、etag CAS、temp/fsync/rename/目录同步与重读。只有本进程成功prepare=true允许准确首次POST；热权利不写文件，冷或既有ID只核原GET。Store+Session+Server的pending/unknown不借新Workspace或key绕过，unknown不淘汰，journal ready/failed不降级。

只读 `mcp.connection@1` 的16KiB闭合Display沿当前Store/Session/subject的原整组安全准入，读取准确原Action、operation Job和parent。核kind/definition/version/inputDigest、origin/Command、原六字段ref/root-work；原definitions只投toolCount，不输出正文。ready来自已保存真实成功结果，live/currentGeneration来自当前准确holder。created=true要求完整operation key和connection.parent同时归当前Action；warm复用保原Job且created=false，cold或unavailable时原ready仍在但live=false/generation=null。有detached operation的failed/cancelled保持unknown；只有明确adapterAttempted=false且无ref才显示零连接失败。

UI保存独立原意图Map与读取代次；空/failed/removed目录也能选原ID，选择零GET，明确Check才GET。关闭/切scope只abort所属reader，提交迟到归原Map、不盖后选视图，不取消原Run或审批。Host先核保存subject/Store，再核原Command/requestDigest、receipt Action及有限事实；404/坏绑定不换ID/key或POST。历史同Store读取不要求现物理Workspace/Source仍存在。

维护只新增独立Agent codec与closed backup v9；旧v8及其他白名单保持，资产实际存在才升级。采集/inspect/restore保原JSON整字节和A身份/phase，恢复B不授旧caller GET或POST，也不重标。新B明确申请独立普通授权；公共历史Query的当前准入与原origin分开，不能从私有旧intent推导授权。

当前合同和实际证据分别归[Agent MCP](../../../../packages/agent/src/mcp/README.md#原连接申请的有限事实)、[CLI](../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)、[UI](../../../../packages/ui/src/tui/README.md#mcp-显式连接与原申请)、[maintenance](../../../../packages/agent/src/maintenance/README.md#mcp-连接申请的独立离线资产)与[手册](../../../../docs/handbook/clients/tui/guides/mcp-and-skills.md#显式连接与原申请)。本决定补充[原Select](../feature/2026-07-19-mcp-tui-select-management-center.md)的可见确认及独立许可理由，不替代[原Tools metadata](2026-10-05-original-mcp-tool-metadata-artifacts.md)、[原配置选择资产](2026-10-04-original-mcp-selection-intent-assets.md)或[scoped MCP提案](../../proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)的剩余来源、认证和管理工作。

## Alternatives considered

- 打开详情或冷恢复时自动connect：读取会产生连接与凭据副作用，只允许明确新的普通申请。
- accepted当ready，ready当live：受理、原完成与当前holder分别有不同证明，分别显示。
- 每次新key都称重连或新建：warm可以复用原Job，要求operation key和真实parent共同证明created。
- 读取全catalogue或整组Execution后裁剪：扩大会话读取成本；沿原有限整组准入、准确Action/Job读取，保留现有上限。
- 扩大旧选择journal和backup v8：旧格式只接受原Action，独立文件/codec和条件v9保旧闭合拒绝。
- 未确认时换Command/key补发，或恢复B重标A：可能重复实际副作用并洗掉原授权，保原身份，仅明确原GET和当前scope的新申请。
- 用旧Workspace首100页核scope：合法后页Workspace会被拒，使用已有公共完整分页目录。
- unavailable仍投非零generation：producer和闭合decoder矛盾会丢合法ready，当前不可用时generation=null，原事实保持。

## Consequences

维护多一个独立私有资产和精确v9格式，未知容量满或坏文件局部拒绝新POST，不自动清理。原准确getExecution会加载原result，仍受Worker/result预算；current callback处理既有缓存projection，不承诺零内部definitions处理。整组安全准入8192 records保持，超限有限失败。文件最终核查与不合作编辑器后的wire仍非OS原子；本决定不放宽source和permission边界。

实际本机Query3/106含真实stop barrier/unknown、Host4/90含102Workspace、journal5/174、维护4/37和UI含邻接30/593分别通过。公开备份/恢复的实际Host1/37保727原字节、A→B、B中list/lookup/duplicate submit全HTTP0、RPC与cursor不变。当前源码外80×24 PTY1/61核暖新建/复用、同Store冷原ID零GET与明确原GET、新申请及shared detach保持live，Model/credential/Run0且正常所属资源清理完成。原红日志、旧sourcewindow与准确SHA保留。当前1567文件与60 Source冻结的第二十一轮持久checkout完整默认实际exit0/drain，428个唯一原任务、528files全部通过，输入与实际Git来源无漂移；源码外child原任务2/24及normal Root/UI types独立通过，原八build/其他types只按未变输入范围复用。该本机连接切片已经归位，原无Git快照不宣称完整legacy policygate。异常cleanup、强制warm重连、OAuth/续期、完整增删及三平台尚须各自资格，不能把此implemented决定等同完整MCP或V1.3。
