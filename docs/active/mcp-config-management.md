# MCP 双来源配置与热重载

状态：active
读取时机：修改 MCP 配置来源、schema、路径、Repository mutation、文件 watcher、Supervisor reconcile 或 TUI 配置边界时。
验证：`bun test packages/ui/test/tui/mcp.test.tsx packages/ui/test/tui/mcp-connection.test.tsx apps/cli/test/isolated/tui-mcp-host.test.ts apps/cli/test/isolated/tui-mcp-connection-host.test.ts apps/cli/test/isolated/tui-mcp-connection-restore.test.ts`、`bun run typecheck`、`bun run check:unified-agent-boundary`；默认来源、认证与实际平台资格分别按[Service owner](../../apps/service/README.md)、[MCP owner](../../packages/agent/src/mcp/README.md)与[当前进度](../plans/unified-agent-refactor-v1-progress.md)核对。下面旧owner测试只属于历史范围，不参与当前正式/default/CI调度。
相关：[Agent Note 0019](../../.agents/notes/implemented/feature/2026-07-19-mcp-two-config-locations.md)、[Agent Note 0013](../../.agents/notes/implemented/feature/2026-07-16-mcp-credential-store-and-oauth-session.md)、[Agent Note 0014](../../.agents/notes/implemented/feature/2026-07-17-mcp-tool-visibility-and-policy.md)、[Agent Note 0018](../../.agents/notes/implemented/feature/2026-07-19-mcp-tui-select-management-center.md)、`apps/kite-service/src/config/mcp-config-repository.ts`、`apps/kite-service/src/config/mcp-config.ts`、`packages/builtin-runtime/src/mcp/supervisor.ts`、[`mcp-authentication.md`](mcp-authentication.md)、`apps/kite-cli/src/tui/mcp/`。

## 来源与优先级

可见 Source Review、有限原决定读取、跨 Session 未确认冲突与离线 v10 资产已接入，当前合同见[项目来源决定与历史读取](#项目来源决定与历史读取)；本片源码外键盘和当前完整默认已验收，取舍与有限资格见[Source 决定](../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

新正式/default/CI已使用通用Service。trusted programmatic registry 提供 `mcp.servers` Query、`mcp.server.select` 普通 Action，以及准确原 live connection 的 `mcp.catalogue.refresh`；六字段 read-set 和实际 Workspace identity 进入文件锁/HostMutation复核，不由通用patch注册原始Server。默认用户来源是选定Profile/mcp.json，项目来源是canonical Workspace/.kite-code/mcp.json；同名项目声明即使disabled/invalid/pending/rejected仍遮蔽用户来源，不读旧全局home或转换旧数据。raw原文留宿主私人源，目录只保安全ID/transport/source/digest/status；批准来源、绑定凭据和实际连接分别是普通Action/Job，不授Tool权限。当前实现与实际三段Ask、漂移前零vault/RPC、默认源码外stdio及nested source child证据归[Service owner](../../apps/service/README.md)、[MCP owner](../../packages/agent/src/mcp/README.md)和[scoped提案](../../.agents/notes/proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)。OAuth/续期、公开child冷恢复、完整UI/OSvault与平台仍待闭合。

## 当前 TUI 的有限选择

新 `/mcp` 通过共享UI的[MCP port/panel](../../packages/ui/src/tui/README.md#mcp-安全目录与原选择意图)和[CLI host](../../apps/cli/README.md#tui-mcp-目录与配置选择)接固定Query及普通Server选择Action。上下/Enter/Esc、可见刷新/原结果查询与独立user/project范围确认保原Select取舍；Query零Model/连接/凭据。准确Command受理仅pending，保存确认须原subject/Store/requestSHA、成功Execution binding及真实HostMutation applied/CAS receipt和原GET一致；发布后SQLreceipt故障继续unknown，不重POST。JSONC注释与未知字段保留，外部CAS冲突零修改，普通Ask批准前零修改。

CLI host 现在独立持久保存 `ui/mcp-selection-intents.json@1`。成功 durable prepare 才允许当前首次 POST；原 body/request SHA、subject、Store/Session/Workspace/identity 与冲突判定在短写锁内核实，同 ID 或冷记录只查原 GET，128/16MiB 不淘汰 unknown。冷列表与详情提供全部同 Session 原 ID，空或失败目录也可用键盘选择；选择本身不查询，显式“查询原操作”才 GET。历史读取不要求 Server/物理 Workspace 仍存在，新修改继续核当前 identity 与完整 read-set。关闭/切 Session 只停读取，原结果不授予新的权限，成功 GET 不清 SSE stale。

当前 Ink15项501断言和源码外真实 PTY1项21断言证明键盘可达、范围确认、原 active Run/审批/history/draft 保留；冷 Host 的物理 socket 丢失/SIGKILL 和历史查回、journal 边界另由[CLI owner](../../apps/cli/README.md#tui-mcp-目录与配置选择)记录。维护 closed v8 以独立 Agent codec 采集完整原字节；旧 v2–v7 白名单不扩大，换 Store 恢复不重绑身份、不自动 GET/POST，详见[维护 owner](../../packages/agent/src/maintenance/README.md#mcp-选择意图的独立离线资产)。[真实冷重开 TUI](../../apps/cli/test/isolated/tui-mcp-cold-pty.test.ts)当前1项44断言覆盖首轮真实两申请、正常 Ctrl+Q 与同 Profile/Store/subject/Session/Workspace 空目录逐键选择第二原 ID，再显式 GET-only；冷轮所有 POST/Model/Run/凭据/RPC/取消均零。它限 macOS paired 正常退出，独立于物理丢响应/SIGKILL 的 cold Host，未涵盖全部异常收尾。原工具详情已由不可变metadata和公共reader补齐；完整认证、强制重连、增删、正式安装及三平台仍未闭合。产品预期和当前可执行步骤见[MCP指南](../handbook/clients/tui/guides/mcp-and-skills.md)。

公开 Service 的[冷后显式新连接](../../apps/service/test/isolated/mcp-cold-reconnect.test.ts)当前1项65断言通过：同 Profile/Store 的旧历史 GET 不连接，新 key 经新的独立 Action/Job Ask 后发现新目录并完成真实 Tool，旧 record 不被替换连接污染，source 漂移阻止派发。该本机 auth:none/loopback 正常 paired 关闭资格由[Service owner](../../apps/service/README.md)维护；它没有增加面板重连、认证或增删功能，也不证明崩溃接管和三平台。

## 当前显式连接与原申请

新面板的可见Request connection经独立确认，只申请普通 `builtin.mcp/mcp.connect@1`；准确selected/admitted/available来源与完整Workspace目录在Host复核，来源捕获与实际connection Job仍沿Service普通许可和最后派发检查。accepted不等ready，warm可复用原Job；原ready、当前live/currentGeneration和created/reused独立。有限只读 `mcp.connection@1` 核原Action/Job/parent/ref/inputDigest，完整envelope≤16KiB，不输出transport、凭据或定义正文。holder unavailable时generation为null，原ready不变。

独立 `ui/mcp-connection-intents.json@1` 沿private/Profile/data-lock/CAS持久保存原request/subject/身份/摘要/phase。128条/16MiB与Store+Session+Server未知冲突在prepare前核实；冷或既有记录只有原GET，不恢复首次POST权。空/failed/removed目录仍可选择同Session原ID，选择零GET、明确Check才查询；换Store/subject在HTTP前拒绝。closed backup v9只在资产实际存在时创建，v8及所有旧白名单不扩大，恢复保原bytes和A身份。实际Host A→B已有list/lookup/duplicate submit全HTTP0、RPC0增量、原cursor/bytes保持资格。

当前普通实际Host4/90、Query3/106（含stop pending/unknown）、journal5/174、维护4/37、UI与Select/Tools/preferences邻接38/699和源码外80×24当前PTY1/61分别保各自范围。当前候选暖新建/复用、同Store冷原GET与明确新申请、shared detach保持live和正常清理均已验证；中文固定文案与外部metadata保真由Ink单独核实，当前实际PTY为英文。异常cleanup、强制warm重连、完整认证/增删和三平台未由本片完成。精确合同及证据归[Agent](../../packages/agent/src/mcp/README.md#原连接申请的有限事实)、[CLI](../../apps/cli/README.md#tui-mcp-显式连接与原申请)、[TUI](../../packages/ui/src/tui/README.md#mcp-显式连接与原申请)与[maintenance](../../packages/agent/src/maintenance/README.md#mcp-连接申请的独立离线资产)。

## 项目来源决定与历史读取

安全 Source 目录独立于32项管理目录的 selection/admitted 条件。当前有效项目 source binding 与 transport 才允许 Review；普通 `builtin.mcp.sources/mcp.source.approve@1` 许可后仍要求准确原 Source Question 的显式 approved/rejected/cancel。确认页不预答，空 Enter 零 Answer。取消决定保存原八字段证明而不 begin mutation；批准/拒绝必须由真实 applied HostMutation 和原 Question/结果共同证明，不能从 Command.applied 或单独 mutation 推断 saved。

Process host 只解析一次真实 subject，并同时交给配置 factory 和 `startService`；自定义 configure 收到冻结的第二参数。这个 observer 不来自 startup JSON、Query 或 JSONC。有限 GET-only `mcp.source.result@1` 只读原 Store/S/Command/Execution/Interaction/HostMutation，从原 readSet 和 Session.workspaceId 重建持久 scope，不读当前 Source、凭据、transport 或物理 Workspace。缺 observer、主体不符、部分发布、未知 finish 和任何不完整证明保持 unknown，不能释放新申请冲突；普通许可明确零 adapter 的失败/持久取消与 Source Question cancel 分别核证，不能互相补造证明。完整闭合 Query 和证明合同归[Service owner](../../apps/service/README.md#项目来源决定的有限历史事实)。

CLI 新提交核当前完整 Workspace、physical identity 与完整同版本 Source 分页。独立 `ui/mcp-source-approval-intents.json@1` 私有 durable prepare 才赋予当前首次 POST 权；冲突域为 Store+Workspace+Server，不含 Session 或 source fingerprint。128条/16MiB不淘汰unknown；冷记录或重复只原GET，错Store/subject在任何HTTP前拒绝，历史不依赖当前物理目录。条件 backup v10保持旧v2–v9白名单及原bytes，恢复新Store不retag、不恢复热权利。当前事实分别归[CLI](../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)、[TUI](../../packages/ui/src/tui/README.md#mcp-项目来源与原决定申请)和[maintenance](../../packages/agent/src/maintenance/README.md#mcp-来源决定申请的独立离线资产)；它们不完成认证、强制重连、增删或三平台发行。

## 强制重连的来源、发布与恢复边界

新正式TUI以独立普通 `builtin.mcp/mcp.reconnect@1`替换准确当前live holder，普通connect继续同来源暖复用。target与新replacement分别证明：旧Run host-selected server只证明选择，当前Source完整capture/read-set/config由Service独立准入，static只核factory固定config，不能互换或改写旧Run snapshot。完整协议和holder发布归[Agent owner](../../packages/agent/src/mcp/README.md#强制重连持久发布与原事实)，可信resolver归[Service](../../apps/service/README.md#当前来源的强制重连准入)。

旧owned transport实际stop与原Job持久transportStopped成立后才ensure新Job。R和新Job许可独立；旧停新deny/drift/fail保持旧停止事实，无自动恢复。阶段CAS只是索引，结果提交前保private publishing fence；完整原R succeeded与真实新Job/catalogue证明后才发布Step/wire/live。Query按成功事实后await该私有确认，cold旧ready不重建ticket。未提交原Action的Core串行边界与实际故障复验单独保进度，不以目录ready代证。

原重连Query闭合有限事实≤16KiB，历史零Source/Workspace文件/vault/transport/Model/补写。Caller独立原intent journal与ordinary journal同短锁核Store+S+Server未确认冲突；只有本次durable prepare可首次POST，cold/duplicate仅原GET，foreign身份全部HTTP前拒绝。条件v11保存原bytes/subject/SHA/phase，旧v2–v10白名单不扩大，新Store不retag或授热权利。操作归[TUI手册](../handbook/clients/tui/guides/mcp-and-skills.md#强制重连与原申请)，Caller与维护归[CLI](../../apps/cli/README.md#tui-mcp-强制重连与原申请)及[maintenance](../../packages/agent/src/maintenance/README.md#mcp-重连申请的独立离线资产)。当前有限真实范围、失败和未验证窗口沿[进度](../plans/unified-agent-refactor-v1-progress.md)记录，OAuth/续期、增删、持续Soak及三平台另验。

## 历史实现与仍适用的约束

下方记录旧Repository/Supervisor和App的历史实现，旧home路径、owner和测试不能作为新入口支持。原JSONC保未知字节、来源审批、secret隔离、generation和未知效果不重放等理由仍适用；已退役路径不因历史记录而重新参与正式调度。

默认目录按以下顺序选择同名 effective Server：

```text
project <workspace>/.kite-code/mcp.json
> user ~/.kite-code/mcp.json
```

`project` 与 `user` 是默认目录仅有的来源。TUI Add 的 Current project 映射 `project`，All projects 映射 `user`。调用方显式 `configPath` 是独立的单文件 `explicit` 来源，不与默认目录合并。项目来源必须通过项目配置摘要审批。

移除只删除选中的 source entry。若 user 来源存在同名配置，它会在下一次 catalog 计算中成为 effective；任何提供 remove 的非 TUI 前端都必须在确认前展示该来源。被审批阻止的项目条目不回退到 user 来源。

## Mutation 与文件安全

所有写操作通过 `McpConfigRepository.mutate()` 的 typed command：add、update、remove、set_enabled。名称长度为 1–64，只允许稳定的字母、数字、点、下划线和连字符组合，不能使用连续下划线或保留 MCP 命令名。

MCP 配置 schema 不识别数据分类、正文授权或 egress permit 字段，解析时不会把这类未知字段
带入 effective config。项目/user Server policy 可按既有规则收紧 Tool 可见性、副作用与审批，
但不能绕过最终参数的 bounded JSON/schema/secret inspection、exact endpoint 与 execution boundary。

- mutation 重新读取文件并验证 source/entry expected revision；
- 外部变化返回 `config_conflict`，不得覆盖；
- 每次project/user mutation只取得目标文件自己的`.kite-lock`，持锁后重新加载catalog并执行expected revision CAS，再以fsync + atomic rename替换；
  不同配置文件可并行，锁busy/identity不确定返回typed write failure，不建立全局配置锁或daemon；
- JSONC edit 只修改 `mcpServers` 下的目标键，保留无关字段、注释和环境变量占位；
- 写入使用目标同目录临时文件、文件 flush、权限设置和原子 rename；已有文件保留原 mode，新建 user 文件为 `0600`，新建 project 文件为 `0644`；
- project add 只产生 pending approval，保存动作不得同时批准。

Watcher 只把文件事件视为 reload 提示，debounce 后重新读取全部来源。事件内容不作为配置事实；TUI 不提供手动 reload，watcher 不可用或事件丢失时通过重启 TUI 触发完整加载与 reconcile。Builtin `McpSupervisor.reload()` 继续作为 App composition 可调用的显式控制面能力。

## Schema 与 secret 边界

Schema、Repository 与手工 JSONC 支持 stdio/HTTP transport 以及 `enabled`、`required`、`cwd`、timeout、args、env/header 配置。`enabled: false` 保留完整配置和环境引用，但不连接、不发布未来 capability。`required` 仅兼容原配置与管理投影，不再创建模型调用前的准入等待；`/mcp` 不展示该字段。`mcpProviderAction` 继续控制真实按需 Provider 操作，不决定普通模型请求能否运行。

Tool 可见性按以下顺序解析：

1. `enabledTools` 存在时作为 allowlist；
2. `disabledTools` 在 allowlist 后应用；
3. `tools.<name>.enabled` 作为精确 override。

逐 Tool policy 还可配置 `effects`、`minimumApproval`、`retry` 和 `idempotencyKeyArgument`。user 与调用方授权的 explicit 来源可以使用完整字段；project 获批后只保留 allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never`。项目声明的精确 enable、annotation trust、effect 降级、较低 minimum approval 或 retry 放宽不会进入连接配置。引用 discovery 不存在的 Tool 只产生 control diagnostic，不使 Server 配置无效。

普通 JSONC 可以为 HTTP transport 保存 credential profile 与 OAuth metadata，但不能保存 inline OAuth client secret；stdio 声明携带 `auth` 会被拒绝。认证只接受 `none`、`credential` 与 `oauth`；不存在 ambient-environment 认证形态。`credential` 只保存 header、scheme 与 `credentialRef`；`oauth` 只保存 profile、scopes、client id、`clientSecretRef` 等非 secret metadata。TUI Add 不录入这些字段。Disable 和普通 Repository mutation 不删除 credential；TUI Remove 经 Supervisor 删除配置后尝试清理已投影的本地 OAuth credential，失败必须报告部分完成。未显式配置 auth mode 的 HTTP Server 可由真实认证状态触发 OAuth。完整持久化与生命周期见 [`mcp-authentication.md`](mcp-authentication.md)。

## Reconcile 与 Runtime 一致性

Supervisor 将 reload、retry 和 mutation 放入同一串行 reconcile 队列。新 catalog 到达后：

1. 先发布新的配置可见性；
2. 对 changed、removed、disabled Server 撤销 Manager capability/prompt 可见性；
3. 关闭旧 generation client；
4. 对通过配置与审批门禁的 added/changed/enabled Server 建立新 generation；
5. 未变化 Server 保持原连接。

provider version 绑定 source identity、Server 名称和规范化配置。即使 Tool schema 没变，配置或 effective source 变化也会改变 descriptor revision，使旧 turn binding fail closed。reconcile 不自动重放已登记、结果未知或正在完成的外部写。

## TUI 行为

`/mcp` 不接受参数或管理子命令；管理动作只由 Overlay 的可见 Select 产生。List 只导航，Detail 才可调用 controller。Add 收集 name、HTTP URL 或 STDIO command、transport 和 project/user availability；不收集 arguments、cwd、env/header、timeout、required、auth metadata 或 Tool policy。

Add、set_enabled 和 remove 都使用 Repository typed mutation 与 snapshot expected revision。冲突保留当前 UI 状态并显示 App controller 投影的稳定 message，不覆盖外部变化。TUI 只写两个规范路径、不编辑其他配置位置；项目 transport 前置决定在 Detail 的独立 Review route 完成，不与 config mutation 合并。
