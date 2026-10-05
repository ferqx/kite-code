# Agent Note: 默认 MCP 来源按 Profile 与原执行捕获装配

Status: proposed

## Problem

新 MCP 已通过 programmatic registry、普通连接 Job、Tool/资源/提示和 live-only refresh 的资格，但默认 process 不读取用户与 Workspace 的原始 Server 声明。把原始 URL、command、env 或认证材料放进通用配置 snapshot 会泄露私人输入；在启动时扫描全局 home 或借当前配置替换旧 Run 会破坏 Profile 与原执行身份。

## Proposal

默认用户源为选定 Profile 的 `mcp.json`，项目源为实际 canonical Workspace 的 `.kite-code/mcp.json`。本轮不兼容旧数据，不自动读取旧全局 `~/.kite-code/mcp.json`。程序化宿主的已有 Server 装配继续保留。来源文件使用有界、无跟随、准确原字节 ETag 的 JSONC leaf，完整 raw entry digest 包含 unknown 字段、原变量和数组顺序。项目同名条目始终遮蔽用户来源，即使 disabled、invalid、pending 或 rejected，不能借失败回退获得用户源能力。

原始条目留在 host 私人源；公开 registry 只有准确 ID、显示名、transport、来源身份、摘要、enabled、准入状态与有限 reason。rawEntryDigest、实际解析后的 transportDigest 和准确 Store/Session/Workspace/source/approval/auth 元数据的 registry revision 各自负责自己的绑定，不能互换。URL、command、args、env、headers 和凭据正文不进入普通 Query、Command、Run snapshot、日志或 Model。变量仅由显式可信有限供应端口提供；不任意读取 ambient process.env、不以空串替代缺值。

保留单个 MCP extension。可信 scoped resolver 根据真实 Execution、原 Store/Session/Workspace 与 Run capture 选择冻结 Server 和 transport port；普通固定版本 source connection Job 只保存安全 ID、digest 与原 bootstrap 身份。Job 实际已存在、独立许可和最后预检通过后才连接或启动。旧 Run/Fork 保原 source capture；冷重建只读元数据，capture 不等时局部拒绝，零 Model、vault、socket、spawn。历史 Query 不复活连接，未知原 Job 不重做。

项目 source approval 独立于 Tool grant、Workspace trust 和 credential use。普通用户决定必须绑定原 source/raw/transport/read-set；宽权限也不能代替该决定。批准通过既有 ordinary Interaction/Action 与 HostMutation 保存，等待后和最后 socket/spawn 前重核准确来源、Workspace identity、取消、approval 与 credential binding revision。源、审批与绑定写入按 canonical 顺序持有短锁；文件发布和 SQLite 回执非原子时保原 mutation unknown，只查原 ID。

认证最小接线仅接受明确 none 或已由可信私人元数据绑定的 opaque Bearer credential。绑定包括 Profile、Workspace、source、server、auth profile 和 purpose；配置写出 vaultRef 本身不授予读取权。旧命名 credentialRef、任意 scheme/header、OAuth 与续期在尚未实现时分别明确 unavailable；不能静默转换、回退或登录。它们仍属于完整 V1.3 后续必须闭合的范围。

持久 approval/auth binding 作用于准确 Profile、Store、canonical Workspace、source/server/auth profile/purpose，不加入 Session，使同一已批准 Workspace 的后续 Session 可重用来源事实。原用户决定的 Store/Session/Interaction/主体与接受 revision 永久保留，不能重标或成为后续 Session 的 Tool grant。每次执行和 registry read-set 仍独立绑定实际 Session/Run/Execution；恢复为新 Store 不自动重绑旧批准或凭据。

## Alternatives considered

- 启动时读旧全局 home：拒绝，本轮不要求旧数据兼容，选定 Profile 不能承接其他 Profile 的隐式授权。
- 把原始 MCP 放进通用 named configuration：拒绝，普通配置和 snapshot 明确拒绝 env/header/credential-body。
- 每 Workspace 注册同名 builtin.mcp：拒绝，Runtime 重名检查有意义；只扩展可信 scoped source resolver。
- 项目源无效则回退用户源：拒绝，它会改变用户看到的来源和批准对象。
- source approval 同时 connect 或授予 Tool：拒绝，保存/批准与实际副作用分别取得原执行许可。
- 用新默认配置恢复旧 Run：拒绝，原 capture 不等必须保留历史并局部拒绝。

- UI直接调用 generic config.patch：会绕过已存在普通 Action 的实际执行、Ask与最终read-set，采用固定 MCP Action 与公共 Client。
- Command accepted 直接显示已保存：受理与文件/SQLite效果不相同，须核原成功Execution及准确HostMutation；unknown只查原ID。
- 在新MCP面板恢复状态字母快捷键：违反既有可见Select的产品取舍，保上下/Enter/Esc及独立范围确认。

## Current implementation

raw leaf、真实 scoped source factory 和默认 Service 接线已实施。普通 mcp.sources.list 与 Query 公开安全目录，mcp.source.approve/mcp.credential.bind 各自通过原 question/HostMutation 保存，独立 mcp.source.connection@1 Job 仍在真实派发后做最后 vault/socket/spawn 预检。原静态 programmatic Server 仍要求自己的 transport，不能借 raw source port 资格；全配置层省略选择有效已准入源、显式解析空集合选择零。实际 canonical root/devino 允许 macOS /var 祖先别名，但仍拒最终 Workspace 目录 symlink。

当前独立raw leaf三文件28/225、MCP/raw/source十七文件105/1218、默认Service原冻结七文件41/490真实通过。default factory三段Ask与low-trust remote annotation、原八字段安全Job input、cold source变更前零Model凭据查询、坏可选源普通Files继续已核。源码树外无configure stdio制品已另过1/47：独立Profile/HOME、built guardian `.js`与专用Server、一次真实效果、公开脱敏、准确取消两个所属PID及冷查询零RPC，未用源码TS回退。

source child的有限派生协议已落在实际默认调用者：真实parentExecution/Run/Session/Command/Workspace封原parent snapshot，准确carrier与child.start激活核实际role wrapper/configuration/version；原scope/raw/transport/approval/auth不重标，tool/sourceJob/remote调用各自审批。nested祖先policy只沿已核实际Run继承链保持原source/schema上界，父grant不借给子。最终默认child三例3/117与二十文件115/1433/0fail，日志kite-mcp-default-child-full-second-qualified、kite-mcp-child-source-full-twenty-second-qualified；nested采用30秒总观察预算，direct/deny/drift/cold仍15秒。原15秒失败与实际Model时间线保留，产品30分钟、required/attached和原权限未变，不形成性能承诺。公开child冷resume、OAuth/renewal/旧policy、完整UI、OSvault与三平台仍有必要工作，本提案继续proposed。

### 当前 TUI 的有限 Server 选择

新 `/mcp` 已接固定 `mcp.servers` Query 与普通 `mcp.server.select@1` Action。共享 UI 的 [MCP port](../../../../packages/ui/src/tui/mcp.ts)只保闭合安全目录、原 scope/read-set 和有限选择意图；[真实 host](../../../../apps/cli/host/tui-mcp.ts)只通过公共 Client 提交和查询，不新增通用配置权威。沿 [原 Select 决定](../../implemented/feature/2026-07-19-mcp-tui-select-management-center.md)保上下/Enter/Esc 与可见确认，不恢复其已退役 App/Supervisor 路径。

Query/列表/详情只读，完整32项固定上界不裁成首页；未知字段、非实际数组、错 hash/enum/scope 全部拒绝。用户或当前项目的启停保原观察 read-set，实际配置 CAS 与普通 Action Ask 由 Service 决定；显示 source 与配置选择不代表连接 ready 或 Tool 授权。第一次 Enter 选择操作和范围，独立确认后才提交。关闭/切Session只取消读取，迟到结果仍属原 intent。

accepted Command 只表示等待；成功须原 subject/Store/Command kind/request SHA、准确原 Action Execution 的成功结果绑定、真实配置 HostMutation 的原请求/CAS/applied receipt 和有限公共 mutation GET 都一致。文件已发布而 SQLite 回执未知仍 unknown，仅原 GET，不换 ID、不自动再 POST。controller 最多128个意图，CLI host 的独立私有 journal 首次 POST 前 durable prepare，cold只恢复未知原意图、无POST权利，unknown不淘汰；未知用户范围阻止其他Workspace的冲突写入，当前Workspace未知阻止本scope新写。空目录或读取失败时，列表与详情仍提供全部同 Session 保存原 ID；真实上下/Enter先选择，再明确查询。历史 GET 不依赖当前 catalogue/物理 Workspace，fresh 修改仍核实际 scope。独立持久/备份 v8 的决定与限制见[原 MCP 资产](../../implemented/architecture/2026-10-04-original-mcp-selection-intent-assets.md)。

当前 Host 四项43断言核实际默认 Service/SQLite、JSONC 注释及未知字段保留、零连接/凭据、原回应丢失/CAS/审批前零修改，以及发布后真实 SQL receipt 故障仍unknown。Ink15项501断言核32条选择、范围确认、empty/failed目录真实键盘选择第二原 ID后显式GET与读取隔离；独立 review 的数组 enum coercion 已由严格字符串检查和两个反例修正，旧红复现保留。当前源码真实 PTY1项21断言及同 Profile 源码外 cold Host 的物理断线/SIGKILL已通过各自有限范围；源码外cold TUI逐键重新打开另有1项44断言，只覆盖macOS paired正常退出后同Profile/Store/subject/S/W空目录选择第二原ID再GET-only，冷轮零POST/Model/Run/凭据/RPC/取消；异常清理分支未完整资格验证。当前原工具详情已由[原 metadata 决定](../../implemented/architecture/2026-10-05-original-mcp-tool-metadata-artifacts.md)补齐：真实 connect/refresh Tool或Action封存完整descriptor，两种有限Query与公共Artifact reader只读原snapshot，空/failed/removed Server与暖冷TUI均可查看原generation。Agent13/952含普通Tool refresh及公共maintenance A→B原origin；Client实际HTTP40/128、UI/Host25/550、源码外80×24暖冷PTY1/43各保自身范围，当前只读整组8192 records上限与未注入异常清理不外推。三平台/安装、OAuth/认证、强制warm重连及增删仍未闭合，有限启停与原Tools查看不构成完整管理中心。对应当前操作与剩余产品差异分别归[TUI owner](../../../../packages/ui/src/tui/README.md)和[手册](../../../../docs/handbook/clients/tui/guides/mcp-and-skills.md)。

### 当前显式连接与原申请

可见Request connection、独立Enter和普通mcp.connect/connection Job已接默认公共Host，暖复用保原Job，冷原ready与当前live分别显示。独立caller journal与条件backup v9保原request/subject/Store/Session/Workspace/SHA/phase；冷/既有记录无POST权，Store+Session+Server unknown不借新key绕过。空/失败/removed目录可选原ID，选择零GET、明确Check才GET；实际公开A→B恢复后B Host在任何HTTP前拒旧A，原bytes/cursor/RPC保持。持久取舍见[原连接申请决定](../../implemented/architecture/2026-10-05-original-mcp-connection-intent-assets.md)，实际Query3/106、Host4/90、恢复Host1/37、journal5/174、维护4/37、UI含邻接30/593及当前源码外PTY1/61分别保有限范围。来源批准/认证UI、OAuth/续期、强制warm重连、完整增删及三平台仍未完成，本提案继续proposed，不改变原source或Tool独立许可理由。

## Acceptance criteria

不传自定义 configure 的默认 process 使用 disposable Profile、固定 loopback Model 和拥有的 HTTP/stdio 进程。无源/坏源/禁用/项目待批或拒绝/同名遮蔽目录可读且零 vault/socket/spawn；显式用户连接创建真实普通 Job 后才 IO；两个 Workspace 同名源互不串作用域。审批期间危险字段或 Workspace identity 变化零启动；原 Run source drift 与冷不等零重做，冷相等历史读取零 IO。错 credential scope/purpose、过期/撤销/取消零 socket；所有公共 projection 与日志无 secret。文件发布后 SQLite 故障保原 unknown，不重放。每个实现 owner 和实测限制进入当前文档，不能借旧 owner 或 programmatic 资格冒称新默认源已完成。

当前管理与原始源边界归 [Service owner](../../../../apps/service/README.md) 和 [MCP owner](../../../../packages/agent/src/mcp/README.md)；现行产品行为见 [MCP 配置](../../../../docs/active/mcp-config-management.md)。

## Risks

实际 OS vault、OAuth、完整编辑界面和跨平台 adapter 尚未因本设计获得资格。跨文件最终核查与不合作编辑器仍有竞态，不能称为任意文件系统事务；文件已发布但 SQLite 回执未知必须保留原申请。只读目录不能把 unsupported 或坏源投影成已准入 Server。动态接线完成前，现有 programmatic slice 的通过只证明其原范围。
