# Agent Note: Forced MCP reconnection and original outcomes

Status: implemented

## Problem

普通连接复用暖holder，不能表达用户明确停止旧transport并建立当前新来源的意图。调用者只看到原目录ready或Command.applied时，也不能判断旧transport是否真正停止、新Job是否真实建立，尤其是来源变化、独立许可、停止无回执和冷恢复后。旧carrier可以是复用原Job的另一个connect，公开Execution不含完整input，简单用同key或阶段字符串会把原观察变成权限或漏掉未知副作用。

本主题属于[通用Agent V1.3](../../../../docs/plans/unified-agent-refactor-v1.md)的强制重连。产品按[MCP手册](../../../../docs/handbook/clients/tui/guides/mcp-and-skills.md)，当前实现按[Agent owner](../../../../packages/agent/src/mcp/README.md#强制重连持久发布与原事实)、[Service owner](../../../../apps/service/README.md)与[CLI owner](../../../../apps/cli/README.md#tui-mcp-强制重连与原申请)。新协议、Core/Service/Host/UI/维护、发布证明和未提交普通Action串行边界已实施；本机有限目标图、源码外TUI与当前完整默认分别取得实际资格，实际版本和限制见[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。这份决定只归位本切片的已交付边界，OAuth/续期、增删、持续Soak、三平台和完整§35仍分别验收。

## Decision

使用独立普通Action `builtin.mcp/mcp.reconnect@1`、独立准确原结果Query与Caller journal。新key和Command不能覆盖旧carrier或underlying Job；完整target、六字段operationRef和tagged replacement进入实际inputDigest。carrier与旧Job分别由原Execution/result/record证明；成功R可作为下一次准确carrier，不递归保存targetRequest历史。

static仅接受factory固定注册、digest与可信port；source独立捕获当前完整read-set、selected/admitted server、配置及实际R输入。普通Run的host-selected server仍必需，但旧Run snapshot不充作当前replacement；新Source捕获不改写Run或旧Tool definition。stop前和新Job最终open前再次核同一capture，credential只在实际新transport open沿原broker路径获取。

同一factory的Store+Session+Server使用bounded private fence，协调实际owned Entry、epoch、原record revision与新bootstrap。ordinary connect、Job open/ready、Step与Tool final wire同核fence；claim前拒绝不撤旧目录。先持久核原input与目标，再真实stop并确认准确旧Job终态及transportStopped，最后ensure新Job。Action不占process/serial槽等待另一个process Job。stop held/unknown或可能late-open的new Job保quarantine；不由Action终态或通用finally清除。停止transport不证明远端Tool停止。

独立record保存完整原input及有限stop/new-ref/catalogue索引，阶段CAS失败不继续下一副作用。Query只读真实Execution/result/ref与stage完整inputDigest；ready、live、旧stop分别证明。停止旧连接后新来源漂移或新建立被拒绝，保持旧已停、新未建立，不自动恢复旧holder。缺回执或实际权限/取消证明不足保unknown。

新目录 staged ready 与普通Action结果持久成功分开。publishing ticket保留到完整原R succeeded/result/inputDigest/catalogue、新N parent/ref及当前Entry/config/epoch均证明；Step、Tool/Task最后wire、warm connect、后续R、refresh/Resource/Prompt同核。Query先读完整成功事实，再await精确holder发布确认；它不凭阶段清票、不补回执。回调在holder上保留以继续拒绝后来的证明漂移。

ensure已保存真实N、但new_planned CAS/preflight失败且port尚未open时，唯一私有ensure ticket可返回准确unopened supervision handle。它仍核实际Job/ref/inputDigest/parent/Store/root-work，没有port或adapter效果；真实observe保存ended/failed与transportStopped证明。自报bootstrap、已打开和迟到handle继续拒绝，通用Execution终态合同保持。

结果最终提交失败可使Command已applied、主Action Execution仍dispatching。原Runtime catch继续循环，同instance复用OS owner又可能跨过新owner恢复检查；因此每个本Session accepted Command派发前沿真实owner短事务检查该原receipt主Execution。hasUncommittedAction只核完整Store/S/root/generation/root-work/定义和runless planned/dispatching/running主Action；真实detached Job与已持久terminal unknown不混入。后续保持accepted、零新Execution，重复调度继续拒绝，原结果读取与owned关闭仍可进行。这个补充不替代[正常空闲交接理由](../../implemented/bug-fix/2026-10-03-idle-owner-intake-keeps-original-generation.md)中准确pending intake同generation继续与unknown恢复分离。

独立原申请资产与ordinary connection journal在同一短data lock中核Store+Session+Server未知冲突；successful durable prepare只给当次进程首次POST权，cold/duplicate仅原GET。新backup v11条件携资产，保v10及旧版本物理白名单；A→B保原bytes和身份，不retag或重建hot permit。Profile lease、private/no-follow/held entity、hash、容量及恢复边界沿现有公共维护能力。

2026-10-06补充：真实CLI事件刷新复用select读取同Session历史，原实现会无条件撤掉已独立Review的确认页。现在仅由实际后台调用者显式标识健康同scope刷新，保留准确Review对象；显式选择、Session/Workspace变化、离线与失败快照仍拒绝旧确认，失效时Abort既有在途Review/原查回Reader，迟到回复即使忽略Abort也不发布旧确认；健康后台刷新保留当前读取状态，恢复ready不复活旧观察。Host提交前的完整fresh target/source/read-set和普通Action/Job审批保持。相比取消历史刷新或每个事件重新Review，这一局部边界保住当前事实和用户独立Enter，并由实际Controller及源码外PTY消费；不增加Core票据、恢复权或私有持久协议。当前实现与验证范围见[共享TUI owner](../../../../packages/ui/src/tui/README.md#mcp-强制重连与原申请)及[CLI owner](../../../../apps/cli/README.md#tui-mcp-强制重连与原申请)。

[原连接决定](../../implemented/architecture/2026-10-05-original-mcp-connection-intent-assets.md)、[原Source决定](../../implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)与[原Tool metadata决定](../../implemented/architecture/2026-10-05-original-mcp-tool-metadata-artifacts.md)仍负责已交付的ordinary connect、Source批准与原描述保存。本决定补充强制重连，不替代这些理由，也不宣称[scoped来源提案](../../proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)中的OAuth、增删、平台与全部资格完成。

## Alternatives considered

- 用新key重复ordinary connect：现有connect合法暖复用，不能证明用户要求停止；改变普通语义也会破坏已有调用者。保留复用并用独立Action。
- 由UI顺序stop再connect：两请求无法把准确原target、未知stop和新Job统一为原申请，关闭面板容易丢失未知。采用producer私有协调及独立历史证明。
- 单独扩旧connect的force flag或共用journal：会混淆旧两字段digest、原ready及cold恢复合同。保旧定义和资产，用新完整closed输入与跨journal冲突。
- 用公开record revision/preview或stage当许可：公开连接Query没有revision；观察和字符串不足以证明actual parent/ref/result及owned holder。revision仅在producer内部捕获、CAS，Query另核原事实。
- 把stop/open包入SQL原子事务或factory全局锁：外部transport不参与SQL事务，独立factory也没有共同handle权威。仅声明本factory私有fence，保未知及普通SQL/资源/调用者边界。
- Source重连沿原Run snapshot或以static fallback救活：会拒合法当前配置更新或绕过当前完整来源与准入。采用tagged分支及独立当前capture，普通Tool配置准入不放宽。
- 在父Action返回、超时或Entry terminal时清fence：可能仍有held stop、late bootstrap/open。只用准确实际终态零adapter、确认停止或经完整原R持久成功发布的新ready holder settle。

- 仅让Runtime本次pump抛错：后续同instance reschedule仍能复用owner，不能持续保护原未提交Action。使用每次accepted派发前的持久主receipt观察；不把所有后台Job一律阻挡。
- 用新目录ready或Query公共phase释放publishing：可以在R主结果提交失败时授Step/Tool，或让ready读取跨过最终持久水位。使用完整原成功结果与精确当前holder的异步证明。

## Verification and limits

最新有限23主任务157/2771/0、normal八types/build和源码外80×24整例1/226/0分别取得实际资格；普通Action结果提交前故障保原dispatching/null/rev0、queued/later accepted零派发、独立S效果一次，MCP未提交目录不授Step/wire。原两个waiter直接await同一5000ms Promise再断言真实wait_timeout，正常close确认；早期30s timeout和精确owned监督保留，pure timer/Worker对照未复现，底层停滞原因未知。真实public v11 A→B保7317bytes/SHA，foreign原lookup HTTP0，冷cursor与Model/credential零、所属TUI/Service正常退出。当前完整默认实际结果如下；真实版本、日志摘要与未验证窗口按总体进度维护。

本机当前持久源码、真实SQLite与owned peer、实际Service/Client/Host/Ink、公共create/inspect/restore及源码外80×24候选分别证明last process slot=1、独立Action/Job Ask、old-stop terminal先于new-open、warm B→A与重复R、stop未知零新ensure/open、来源两个freshness窗口、跨普通connect/fence/Tool/Step竞态、phase/最终结果提交故障与原GET无副作用。测试只证明各自断言，实际完整范围按对应owner和总体进度核对。

当前37能力项全部保持partial，Goal active；本切片归位并删除局部计划，独有合同进入上述owner、手册、active与本Note。完整默认只覆盖其实际冻结的545文件/441主任务和3796个regular输入；运行后仅文档/Note归位，代码、依赖和生成输入保持，新的docs/impact门禁单列。本机正常窗不扩大到全部T/E、持续负载、异常收尾或其他平台。

完整默认新动态545唯一测试文件/441唯一主job实际全部started/completed/passed，runner/wrapper0、753.536s正常排空。raw2556pass/3expected nested fail/17skip/0error/37370assert；同名formal-terminal nested多一start/end，原442条事件与441唯一主任务分开。3796个regular输入、空links、真实el-refactor/HEAD c1714314860412d0b3375b44cc327a7ffea0fd5e和dirty状态前后保持；两个前置docs gate0、audit/cleanup无错误、owned HOME删除、logFD关闭。completion SHA `7144f72cfc6e343fd9f9d600d0513c6b66704f87eb1de85aa4e23331446aba43`、inputs SHA `9fabf52ee2d21879b9af41fc706e53ebe4f249a8132bfea91a919cd518c9da13`、log SHA `b047108be8c03647cd0d7c68c0ed6d3ada26aa6c8cea6ae76328c1ed3bb9adc2`。wholeDefaultQualified=true，wholeV13Qualified=false、snapshotPolicyGateQualified=false。

Native主job107.104s通过，但45s timer实际53.336s触发，driver53.193s success/finally、53.336s exit0/两流EOF且无SIGTERM接收记录；它不证明45s硬期限、信号送达或旧exit1因果。上述限度与早期提交/阶段CAS/PTY失败分别保留，局部绿不追改历史红。

## Consequences

external stop/open和SQL回执不原子，unknown可能长期阻挡同domain；这是保护未知副作用的明确代价。private fence只覆盖本factoryowned handle，不是全局分布式锁。公开Query只保有限事实，缺原record/result/parent时宁可unknown，不能由UI补record修复。

两个原资产的cross-domain检查必须在同一data lock内；分别检查内存map或锁外读取会留竞态。完整Source/read-set与targetRequest增加codec和有限容量成本；不能截断或淘汰unknown换空间。backup v11只表达资产持久范围，profileComplete仍false。

Source配置改变后，新holder可ready但原Run旧Tool仍可能按配置版本拒绝；成功重连不扩大权限。transportStopped与远端Tool停止分开。异常清理、真实Vault/OAuth、三平台、连续Soak和完整V1.3资格须按各实际窗口记录，不由本片正常本机链外推。
