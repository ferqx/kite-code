# Agent Note: MCP Source 原决定申请、可信历史证明与离线资产

Status: implemented

## Problem

项目来源未准入时需要可达的独立审查，不能借已准入连接条件取得批准。确认申请、普通Action许可、原Source Question答案与实际批准文件发布是不同事实；丢回执、冷重开或Workspace移除后，调用者需要读取准确原决定，不能把applied或不完整mutation当保存成功。批准文件作用域跨Session，旧未确认决定若能被新Session或新fingerprint绕过，就可能重复或冲突发布。

## Decision

安全Source目录与Review确认独立于连接目录，只提交普通Source approve@1。准确原Question默认无答案，用户明确选择approved、rejected或cancel；cancel保存原八字段proof并证明零发布。Process可信observer一次解析，与真实Service主体相同，不来自启动JSON、配置、Query或Question。GET-only有限历史Query在Service核原Command、实际receipt Execution、Interaction、HostMutation、原持久scope及final receipt；缺observer、partial或错proof保unknown，不读当前Source或physical Workspace。普通Action在Source adapter前拒绝或持久取消时，只使用准确原零adapter结果及不存在mutation的独立证明，不虚构Source Question。

CLI完整来源读取要求同版本六字段readSet、registryRevision及errors，所有ID/cursor有序；每页25项、64KiB envelope、完整8192项/16MiB是caller预算，不改变registry每文件1MiB合同。新申请重新核当前Store/subject/Session、完整Workspace及canonical root/dev/ino、来源binding与原观察；历史只核保存身份与原GET，不依赖当前物理目录。

独立closed ui/mcp-source-approval-intents.json@1保存原完整request、subject、S/W/identity、两SHA与phase。只有本次成功durable prepare有首次POST权，cold/duplicate只原GET；冲突域Store+Workspace+Server，不含Session或fingerprint。128条/16MiB不淘汰unknown，saved及已证明零发布的failed/cancelled才解除冲突。maintenance条件v10只采集caller原字节，旧v2–v9白名单保持，恢复B不retag原A或恢复热权利。

当前完整行为分别归[Service](../../../../apps/service/README.md#项目来源决定的有限历史事实)、[CLI](../../../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)、[TUI](../../../../packages/ui/src/tui/README.md#mcp-项目来源与原决定申请)、[maintenance](../../../../packages/agent/src/maintenance/README.md#mcp-来源决定申请的独立离线资产)和[跨包合同](../../../../docs/active/mcp-config-management.md#项目来源决定与历史读取)。此Source边界独立于[原连接意图](2026-10-05-original-mcp-connection-intent-assets.md)；连接的admitted/selected/available与Store+Session+Server冲突理由仍适用原Action。普通答案资产与Source申请也保持独立，不恢复答案预选或扩大通用五类caller格式。

## Alternatives considered

- 复用管理或connection列表作为唯一入口：其admitted/selected/available和32项条件会挡住尚未批准项目；采用独立Source port及完整同版本目录，本地25项展示。
- 在Review确认时直接approved，或从Command.applied/单mutation判saved：会混同普通许可、Source Question及真实发布；保留明确原Question与有限历史证明。
- 把实际文件现态或新Session当历史读取条件：移走物理Workspace后无法查回，且Source批准持久scope跨Session；历史读原证明，新提交独立核当前实体与read-set。
- Source factory缺observer时抛错：实际早期用例显示会使普通原读取失败；改为新增历史Query有限unknown，不猜Command.subject或从不可信输入取得observer。
- 让维护引入UI/CLI codec或扩大旧v9资产：破坏Agent独立性与旧closed白名单；独立Agent codec、条件v10原bytes复制。

## Consequences

Review、普通许可、Source Question和发布结果分别呈现。空Enter不回答Source Question；Esc清未提交选择，关闭或切scope只释放所属读取，不取消已提交工作。原ID在空、失败或已移除来源目录仍可选择，选择零GET，明确Check才查原Session/Command；冷重开不自动查或POST。晚到结果保存回原记录，不覆盖后来选择。

跨独立读watermark暂时unknown是保守结果，必须再次明确查询原ID，不能猜saved。完整原proof及实际applied metadata mutation同时可核才确认saved；terminal、局部mutation或journal phase均不单独授予该结论。跨Session的同W未确认决定继续阻挡新申请，恢复新Store的原身份在任何原lookup HTTP前拒绝。

journal沿既有Profile-use lease、短data lock、private/no-follow/owner/single-link、held实体核验、etag CAS、exclusive temp/fsync/rename/目录sync和完整重读。维护只保存离线caller元数据，profileComplete仍false，不采集Source/approval/credential文件，也不赋予审批或连接许可。

## Verification and limits

当前已运行Service16项133断言、UI24项132断言、Host7项817断言与journal5项44断言通过。真实postpublication物理POST回执与首GET断回复，冷查只原GET、总POST1；公开v10 A→B后的实际Host在全部HTTP前拒绝foreign意图。closed keys按准确keycount/membership验证，带逗号替代键反例通过。

维护Source资产原独立默认文件4项70断言通过，当前本机unqualified SQLite3.51.0的Core DB/WAL/SHM均present，create/inspect前后全部presence及完整bytes保持；同一文件公共restore v10保原字节与身份。另两份qualified真实引擎3.51.3维护文件核缺副文件范围，三个文件合计28项418断言；两种引擎范围分别保留，不能互换absence/presence证据。此前4/58和邻接67/945属于旧窗口，准确范围见owner与进度。

源码外当前80×24真实candidate实际1项280断言、16.249s排空通过。暖三决定各经独立Review、普通许可与原Question，空Enter零Answer；来源移除和物理W移走两冷窗各三原ID，选择零结果GET、明确Check后准确原GET、UI POST0。公共v10 A→B后的真实B终端三原ID均unknown、原Command/result lookup HTTP0及POST0；四窗journal4977原字节保持，四TUI/五Service正常退出且ownedroot清理。该终端窗口未测Store cursor；其合同由真实Host独立验证。

正常Root/八workspace构建与完整类型、源码外正常构建/类型与有限owner jobs已实际通过；后续fixture增量的正常Root/Agent/CLI类型分别复验。第27轮当前持久Git完整默认实际exit0、734.039s排空，534文件/432唯一主任务全部通过，1583文件/86 Source及维护/五owner、14docs/3plans/1259补充policy、lock和真实Git输入前后稳定，HOME删除、log关闭且audit/stage/cleanup errors为空。completion SHA为de5787d6cb2a6c2487e438b0262acd02ece890d07af390cfb5519d46c9574e20，log SHA为e747e8eb41d33819968051e8d7e9e8ac765d464ce4361dab975c67975341d242；原失败、有限packet及完整作用域归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。该整轮关闭Source局部计划，不替代完整V1.3/37能力与§35。

8192正/8193负只属合成页caller预算；真实8193producer20s压力测试失败、runner106.892s排空，不外推及时性能。temp删除失败下短锁finally已修但未故障注入；源码外异常cleanup、强杀、Screen emulator、中文与Linux/Windows无本片资格。第27轮Native exit0但45s timer实际53.123s触发，不能称45s硬期限满足或回填第26轮精确原因。OAuth/续期、强制重连、增删、持续Soak及完整§35继续按V1.3独立实施验收，原产品/owner/active约束不因Note状态放宽。
