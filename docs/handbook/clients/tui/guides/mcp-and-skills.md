# MCP 与 Skills

MCP 提供外部工具和资源，Skills 提供可发现的任务指导或工作流。它们的可用性取决于配置、认证、模型工具能力和功能开关，不能把列表存在视为所有操作可执行。

## MCP 管理

项目来源已有独立 Review、明确批准/拒绝/cancel 与原决定查回，步骤见[项目来源与原决定](#项目来源与原决定)；本片已完成的源码外键盘和当前完整默认验收及限制见[Source 决定](../../../../../.agents/notes/implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)。

当前原目录工具快照与完整描述查看已接入通用 Terminal；暖读和同Profile冷重开后的实际键盘链已验证，准确范围仍按[总体进度](../../../../plans/unified-agent-refactor-v1-progress.md)核对。

完整管理的产品预期包括配置、认证、连接重试和工具查看。当前新正式 Terminal 的 `/mcp` 已提供安全目录、范围启停、显式连接、强制重连、基本来源条目增删、HTTP Source 认证与各自原申请查询。owned OAuth 本地清理与声明发布分别显示；实际制品、系统浏览器、OAuth PTY 和平台资格按[当前进度](../../../../plans/unified-agent-refactor-v1-progress.md)核对。

保存配置、项目来源批准、实际连接和本地 owned OAuth 凭据清理各自核实，不由配置保存推断全部完成。

输入 `/mcp` 打开管理面板。上下选择 Server，Enter 查看详情；按界面提供的操作进行连接、配置、认证或查看工具。Esc 返回上一层。操作失败时保留结果提示，不能因下一次状态刷新就假定配置已应用。

选择“Saved tool snapshots”查看原连接或刷新保存的目录。列表按原generation区分，Enter选择原快照，再选择工具；“Next tools”和“Previous tools”翻页。名称预览标为未完整时，打开工具后读取完整原name、description、inputSchema、可选outputSchema及其他metadata。读取中或失败不显示complete；完整EOF与hash确认后，上下逐行、左右翻页、Home/End到首尾，Esc返回。

Server移除或冷重开后仍可查看已保存的历史；旧generation不会换成当前目录，当前live状态独立显示。查看不连接、不发现新工具、不读取凭据、不启动模型、不授执行许可。缺少原Artifact、历史读取不可用或正文校验失败时保持明确失败，不自动重连修补。关闭、Ctrl+C和切会话只停止所属读取，原任务与审批继续。

配置来源和范围决定能在哪里修改；项目新增 Server 可能需要单独确认。禁用、重连和写配置前，阅读面板影响提示。连接 ready 不代表写操作已获得审批。

认证需要浏览器或系统凭据能力时，完成外部操作后返回继续。连接未知或结果不确定时先检查状态，不重复提交可能已生效的修改。

## 离线备份与恢复

[离线维护](../../../cli/commands.md#通用开发入口离线维护)保存 Profile 的 MCP 声明、项目批准记录和凭据引用绑定原文，缺失文件保持缺失，原配置可能含敏感内容。项目声明仍由工作区文件提供，Vault中的凭据正文不复制。

恢复生成新 Store后，无认证用户来源沿原信任规则可用；项目来源和使用 credential ref的来源需分别回答当前批准／绑定问题。旧记录保留原身份，不能作为新提交或执行许可。目标 Vault缺少原凭据时，绑定记录不证明凭据可用。查看目录不连接、不读凭据或启动模型，实际连接仍须独立申请。

## 通用 TUI 的 MCP 目录与选择

`/mcp` 不接受参数。上下选择 Server，Enter 打开安全详情，显示准确名称、来源、传输、当前配置选择、可用状态和原因。列表、详情与“刷新 Server”只读取事实，不启动模型、连接 Server 或读取凭据；配置被选择不代表已连接，也不授予工具权限。

在详情中选择启用或禁用的用户设置、项目设置，再按 Enter 核对范围；确认页再次 Enter 才申请，Esc 放弃。项目设置仅影响当前工作区，用户设置可影响后续其他工作区。审批待决时回到原请求明确回答；命令受理和等待审批均不表示配置已保存。来源未准入、观察过期或只读时操作不可用，应先核对并重新读取。外部配置冲突保原结果，不自动换版本覆盖。

结果未知时选择“查询原操作”，只核原申请，不重复启停、不生成新命令。重开同一 Profile 后，面板保留当前会话的原申请 ID；上下选择原 ID、Enter 选中，再选择“查询原操作”并 Enter，才查询该申请。即使 Server 已从目录消失、目录为空或读取失败，列表与详情仍提供原 ID。仅选择原 ID不会发送查询或修改。

同一范围存在未知配置写入时，新冲突操作会被拒绝；未知用户设置还会阻止其他工作区的冲突写入。保存申请失败、记录损坏或容量已满时不发送新修改，也不删除未知记录腾出空间。查询确认前不会用新事实覆盖原意图。受支持的离线备份保存原申请；恢复生成新 Store 后，旧申请仍属原身份，无法关联时保持不可用，不重做配置。

上下、Enter、Esc 是业务导航键，不使用状态字母快捷键。面板内 Ctrl+C 只关闭读取，切换会话或关闭面板不会取消已提交的工作或原待决审批；迟到结果保原申请身份。一次目录刷新成功也不表示持续观察流已恢复。实现与已执行证据见[TUI owner](../../../../../packages/ui/src/tui/README.md)及[CLI host](../../../../../apps/cli/README.md#tui-mcp-目录与配置选择)。

## 显式连接与原申请

当前 Server 已准入、被选择、配置可用，且目录观察有效时，详情提供“Request connection”（申请连接）。先选择该选项，再在确认页核对准确 Server ID、来源、transport 与 Session；独立 Enter 才申请。请求和实际连接 Job 分别经过普通审批，等待或命令受理都不表示目录已就绪。来源未准入、已禁用、不可用或观察过期时，先核对来源和目录。

结果分别显示原目录是否 ready、当前 live 是否确认，以及原申请新建还是复用了连接。申请连接可以复用同一来源的现有连接；“Reused original connection”不表示重新连接。原目录 ready 可以在冷重开、移除来源或停止连接后继续存在，当前 live 与 current generation 单独显示。连接和查看不授予工具执行权限。

同 Session 的原连接申请 ID 保存在 Profile 中；空目录、目录失败和 Server 已移除时仍可选择。上下、Enter 只选择原 ID，再选择“Check original connection”（查询原连接申请）并 Enter 才读取原结果。冷重开不自动查询或提交。结果未知时先查原申请，不能用新 key 绕过同 Store、Session、Server 的未确认申请；404、无法核对原身份或坏结果都保留 unknown，不重发。冷后确需新连接时，在核原申请后重新选择可用 Server，以独立确认和新的普通审批申请。

关闭、Esc、Ctrl+C 和切会话只释放所属读取，已提交的工作与原审批继续。离线恢复生成新 Store 后，旧申请保持原身份，不能成为当前 Store 的查询或提交许可。实际 Host、普通连接和源码外 80×24 暖冷键盘验证见[CLI owner](../../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)；该普通连接窗口不证明强制重连；强制重连的实际范围见下一节，完整认证、增删和三平台发行仍分别验收。

## 强制重连与原申请

普通申请连接仍可复用同来源连接。确需替换当前连接时，先明确查询准确原连接或原重连申请，确认当前 live 后选择“Review reconnect”（审查重连）。审查页重新核对原 carrier、连接 Job、观察代次及当前替换来源；再以独立 Enter 确认本次申请。同一会话的后台历史刷新保留这次确认页；手动重新选择会话、工作区变化、离线或历史读取失败后，需要重新审查。旧原目录 ready 不等于当前 live，观察失效时需重新读取。

原重连 Action 和新连接 Job 分别经过普通审批。旧 owned transport 已确认停止、原 Job 已保存停止终态后，才申请新的连接 Job；等待新 Job 审批时，旧连接已经停止。新连接收尾期间原申请仍为待决，确认拒绝、来源变化或建立失败后保留“旧已停、新未建立”，不会自动恢复旧连接。停止本地 transport 不证明远端 Tool 已停止。停止或收尾未确认时保持 unknown；迟到的 Job 结果不自动改写原未知申请，也不能通过新的 key 绕过同 Store、Session、Server 的冲突。

“Forced reconnects”（强制重连申请）保存同 Session 的原 ID。上下、Enter 只选择原 ID；明确选择“Check original forced reconnect”才查询原 Command 和结果。冷重开不自动查询或重连；来源文件或工作区目录已移除时仍可查原结果。原 ready、旧停止、当前 live 和 current generation分别显示。离线恢复至新 Store 后保留原申请身份，原记录不成为新 Store 的查询或提交许可。

Esc 或 Ctrl+C 返回父 MCP 面板，再返回主界面；它们只结束所属读取，已提交工作和原待决审批继续。主界面有待决审批时先回答原卡片，完成后才恢复任务输入。关闭或切会话后的迟到结果只保存到原记录。当前实现、有限实际 Host 和源码外键盘验收范围由[CLI owner](../../../../../apps/cli/README.md#tui-mcp-强制重连与原申请)、[共享 TUI](../../../../../packages/ui/src/tui/README.md#mcp-强制重连与原申请)及[总体进度](../../../../plans/unified-agent-refactor-v1-progress.md)分别记录。

## 项目来源与原决定

在 `/mcp` 中选择“Project sources”（项目来源），上下选择来源，Enter 查看详情。目录为空或读取失败时，该入口仍可进入，并保留原决定申请。目录按可见的上一页/下一页浏览，不把管理 Server 列表的容量视为项目来源数。

有效项目传输及来源身份存在时，详情提供“Review project source”（审查项目来源）；尚未准入、已拒绝或禁用的项目也可申请，已经准入的项目可以再次审查并拒绝。用户或程序来源不经项目批准。在独立确认页核对准确 Server、名称、来源和传输，再 Enter 申请。确认只提交申请，普通 Action 许可与随后原 Source Question 分别决定，不连接 Server，也不授予 Tool 权限。

原 Source Question 初始没有答案；用上下键明确选择 approved、rejected 或 cancel，再 Enter 回答。空 Enter 不提交答案。该 Question 的 Esc 清除尚未提交的选择，Ctrl+C 关闭当前面板；这些按键不代替 cancel 决定，也不取消原工作。其他普通审批或问题继续使用各自的回答方式。命令受理、等待或保存答案均不表示决定已发布；原证明和实际发布确认后才显示来源批准或拒绝已保存。

结果未知时，先选择原申请，再选“Check original source decision”（查询原来源决定）。同一 Workspace 可看到其他 Session 的原申请；只选择零查询，明确 Check 才读取准确原 Session/Command。重开同一 Profile 不自动查询原结果或重复提交；移除来源文件、改名或删除工作区目录不妨碍读取已经保存的原决定。不能用新 Session、来源版本或新申请 ID 绕过同 Store、Workspace、Server 的未知决定。

关闭来源面板、返回或切 Session 仅结束所属读取，原待决 Question 和已提交工作继续。离线恢复生成新 Store 后，旧申请保留原身份，不能成为新 Store 的查询或提交许可。实际操作和验证边界由[共享 TUI](../../../../../packages/ui/src/tui/README.md#mcp-项目来源与原决定申请)、[CLI Host](../../../../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)及[当前进度](../../../../plans/unified-agent-refactor-v1-progress.md)维护。

## 来源条目增删与原申请

在 `/mcp` 中选择“Source entry changes”（来源条目变更）。选择“Add source entry”（新增来源条目），依次输入名称，选择 HTTP 或 STDIO，输入无凭据 HTTP URL 或绝对 STDIO command，再选择 Current project 或 All projects。名称须为最多 128 字符的字母、数字、点、下划线或连字符，首字符须为字母或数字；同一来源层已有名称时拒绝覆盖。基本表单不收集 args、env、headers、认证或工具策略；这些高级声明仍按[手工配置参考](#手工配置参考)维护。空值或非法值保留当前编辑内容和错误提示，不提交修改。

Review 显示本次输入和目标范围，可上下滚动，Home/End 到首尾；Enter 进入独立 Confirm，再次 Enter 才申请普通 Action。若普通执行许可需要审批，回到主界面回答准确原卡片。等待、命令受理或回答审批都不表示文件已保存。新增项目声明仍需另行审查项目来源；保存不连接、不启动模型，也不授予工具权限。新增同名项目条目会遮蔽用户声明，尚未批准或不可用时仍然如此。

移除时选择准确的“Remove source entry”（移除来源条目）行。Review 与 Confirm 均展示原来源、原条目摘要和同名用户 fallback。对该来源自有 OAuth 凭据，先检查后端可用性，再删除声明并清理准确本地凭据；后端 locked/unavailable 时拒绝发布。声明已删而清理失败或未知时，分别保留“来源已删除”与凭据清理提示，不回滚声明、不默认撤销远端 Token。手工共享 Bearer 引用保留。旧执行与连接仍保原身份，移除不停止已有连接，也不证明远端工具已停止；source-entry saved 只证明声明发布。

“Original source change”（原来源变更）行保留原申请 ID、Store 和 Session；只选择零查询。明确选择“Check original source change”才核原 Command 和有限结果。选择或查回原申请不取消当前来源目录的读取；读取完成后，当前可移除的条目仍会显示。冷重开不自动查询或重新提交；来源文件或工作区目录被移除仍可查已经保存的原结果。未知时先查原申请，不能用新 ID、另一个 Session 或同文件其他名称绕过未确认修改；用户来源的未确认修改也会阻止其他工作区触及同源。来源批准与修改共享实际来源依赖的冲突检查。坏申请文件、容量满或保存失败均拒绝新修改，不删除 unknown 腾出空间。

Esc 返回当前编辑步骤或父面板；Ctrl+C、关闭或切 Session/Workspace 只结束所属读取，已提交工作和原待决审批继续。离线备份保完整原申请字节；恢复到新 Store 后仍显示原身份，原申请不能成为新 Store 的查询或提交许可。实现和实际资格由[CLI Host](../../../../../apps/cli/README.md#tui-mcp-来源条目增删与原申请)、[共享 TUI](../../../../../packages/ui/src/tui/README.md#mcp-来源条目增删与原申请)及[当前进度](../../../../plans/unified-agent-refactor-v1-progress.md)核对。

## HTTP 认证与原申请

HTTP Source 详情提供“Authentication”（认证）。读取当前状态显示凭据后端与是否已有凭据，不打开浏览器、不连接 Server。显式 OAuth 来源经批准且启用后可申请 Login；省略 auth 的来源须先由真实连接遇到 401，显式 none 或手工 credential 不升级。来源批准、普通执行审批和工具权限分别处理。

Login、Refresh credentials、Clear local credentials、Revoke remote credentials 均先进入 Review，再独立 Enter 确认；Esc 放弃尚未提交的申请。Login 需要系统浏览器及可用的原生凭据后端；回到终端后核原结果。Refresh 只用已有材料，不重新注册或打开浏览器；失效时需另行 Login。Clear 仅清准确本地自有材料；远端不支持 Revoke 时凭据保留并明确提示。成功登录只证明凭据已保存，连接需另行申请，不重放旧工具。

“Original authentication requests”（原认证申请）在来源移除、空目录或冷重开后仍可选择。选择原 ID 零查询，明确“Check original authentication”才查原 Caller 与结果；Command 受理不等于认证完成，unknown 先查原申请，不重复提交。恢复到新 Store 后保原身份，不把旧记录改成新提交许可。

关闭、Esc、Ctrl+C 或切 Session 只停止所属读取，已提交认证与待决审批继续。需要终止业务时明确选择“Cancel original authentication”，核准确原请求并独立确认；取消不能证明已经开始的凭据写入没有生效。页面不显示 Token、code、PKCE、scope、完整授权 URL 或原始错误正文。实际 Host/Ink 与协议证据分别由 [CLI owner](../../../../../apps/cli/README.md)、[共享 TUI](../../../../../packages/ui/src/tui/README.md)和[认证边界](../../../../active/mcp-authentication.md)维护。

## 使用工具、资源与提示

告诉 Agent 要使用哪个集成以及任务目标。大量工具可能按需发现，并非一次全部进入模型上下文。MCP 提示可能以动态命令出现，具体名称来自当前 Server；不属于固定斜杠命令表。

## Skills

可发现且启用的 Skill 可出现在命令候选中，通过 `/<Skill 名称> [任务]` 激活。Skill Workflow 默认受功能开关限制；没有候选时先检查发现与配置，不凭旧手册猜测内置 Skill 名称。

全局语义及限制见[扩展能力](../../../features/extensions.md)。

## 通用开发 TUI 的 Skill 目录

通用开发入口的 `/skills` 不接受参数，显示当前已信任 Workspace 的真实知识目录。上下选择条目，左右翻阅完整详情，R 重新读取，Esc 返回；面板内 Ctrl+C 只中断本次读取。目录包含可用、禁用和不可用项，详情提供配置 ID、名称、描述、内容版本、缺失能力与有限失败原因。禁用项不会读取其文件；目录失败显示未知，保留同范围最后确认的内容，不把失败显示成空目录。

目录按同一版本完整读取，读取途中发生变化会失败，需明确刷新。切换会话后，原读取结果不能覆盖新视图；目录读取成功也不表示持续连接已恢复。查看、刷新和详情导航都不创建任务、调用模型或运行 Skill 脚本，可用状态不授予工具执行权限。

宿主同时支持 Workflow 目录与激活时，详情显示独立的 Workflow 状态、失败原因和合格的 `/<Skill 名称> [任务]`。知识可用不代表 Workflow 可用；名称重名、禁止手动调用、需要结构化输入、缺角色或核验能力的项目不能借目录激活。固定命令及别名优先，不被同名 Skill 覆盖。

输入动态命令后会重新读取当前完整目录，再以空对象作为原 Workflow 输入；任务文字只作为任务内容，省略任务时使用该 Skill 的默认请求文字。空闲会话启动新 Run，活动会话排为准确原 Run 之后的 follow-up。读取期间 Ctrl+C 只取消读取；切换会话或修改草稿使旧读取失效。提交结果未知时保留原草稿，Ctrl+L 查询原命令后刷新当前会话，不重复提交；迟到回执不会清除后来编辑的草稿。目录显示的版本不预订未来执行版本，实际开始以 Service 核实的可信源为准。

CLI 的 `--skill` 仍用于选择本次 Run 可以按需使用的知识；显式 Workflow 使用 `--activate-skill`。这些通用开发操作尚不代表正式旧入口和全部终端交互已经切换。

## 手工配置参考

新正式入口的用户 MCP 文件位于选定 Profile 的 `mcp.json`，项目文件位于 `<工作区>/.kite-code/mcp.json`。不会自动读取旧全局 `~/.kite-code/mcp.json` 或转换旧数据。顶层 `mcpServers` 按 Server 名称保存配置。修改项目文件后仍需核实际来源批准，文件内容本身不是批准记录；同名项目声明即使不可用也遮蔽用户声明。

| 字段 | 用途 |
| --- | --- |
| `type` | stdio 或 http |
| `enabled` / `required` | 是否启用／原配置标记；`required` 不再因 Provider 不可用而阻止普通对话 |
| `command`、`args`、`cwd`、`env` | stdio 启动与环境 |
| `url`、`headers` | HTTP 地址与请求头，避免直接存储真实秘密 |
| `auth` | none、credential 或 oauth；使用凭据引用及对应认证参数 |
| `enabledTools` / `disabledTools` | 允许或禁用指定工具 |
| `tools` | 单工具配置；不能用配置宣称未知副作用是安全的 |

认证参数与敏感值优先通过提供的管理动作维护。项目声明改变后，旧批准不能自动适用于新命令、地址或环境。添加后先查看连接和工具清单，再执行具体任务。

当前默认源接受 none、已独立绑定的有限 Bearer credential 和 OAuth metadata。OAuth 的 credentialRef 是 profile label，clientSecretRef 必须是 opaque credential:<uuid>；命名手工 secret、inline secret 或其他 header/scheme 不因此可用。省略 auth 的 HTTP 只有观察到当前准确来源的真实 401 后才允许显式 Login；none/manual 不升级。配置字段不会自动打开浏览器。当前安全来源与支持范围见[MCP 配置边界](../../../../active/mcp-config-management.md)。
