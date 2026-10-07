# CLI 命令与参数

当前根正式入口已使用通用 Agent V1.3 候选，旧参数、State/stdio 拓扑及旧桌面截图只作历史参考；新入口的实际参数与行为以本页“通用”段落和[当前进度](../../plans/unified-agent-refactor-v1-progress.md)为准，未实现能力不能借旧描述启用。发行、安装与跨平台仍有未取得资格，详见[发布边界](../../active/release-control.md)。

正式 Terminal 与显式开发入口共享当前业务参数；区别在完整候选或已构建 Service 的选择及所选 profile。未发布平台和尚未接线功能保持按计划验证，不从旧帮助恢复参数。

| 命令 | 用途 |
| --- | --- |
| `--help` / `--version` | 只读帮助与版本，先于 Profile/Service/Provider I/O |
| `run --task <文字>` | 原 Workspace 发起新任务；省略 thread 时创建新 Session |
| `resume --thread <原Session> --task <文字>` | 原会话输入新任务，必须明确 thread；不是冷接续原 Run |
| `trace <events.jsonl> [--turn N] [--format json]` | 离线读取已有事件；turn 为正整数 |
| `server start/status/stop/restart` | 明确 daemon 生命周期；status 可 `--json`，restart 的 `--cancel` 明确允许取消活动工作 |
| `web [--json]` | 读取已经运行的 daemon Web 地址 |
| `session rename/delete/fork <sessionId> --input '<闭合JSON>'` | 固定原 Store/Session/control revision 的管理申请 |
| `context read/rewind/compact/reset <sessionId> --input '<闭合JSON>'` | 读取或提交准确原上下文操作；rewind 只选择上下文，不代替 Files 恢复 |
| `context include <sessionId> --execution <原Execution> --input '<闭合JSON>'` | 明确纳入已发生的原结果，不重跑工具 |
| `work/caller/recovery/job/files/maintenance` | 各自有限原申请、查询或离线维护；具体范围见下文 |

| 参数 | 范围与含义 |
| --- | --- |
| `--workspace <路径>` | 明确工具工作区；共享服务须与原范围一致 |
| `--thread <原Session>` | run 选择已有 Session；resume 必须提供 |
| `--task <文字>` | run/resume 的完整任务 |
| `--data-root <绝对路径>` | 明确新 Profile 所属根；不自动读取旧配置或数据库 |
| `--server <本地endpoint>` | 明确连接所选 profile 的原 daemon，不启动替代服务 |
| `--trust-workspace` | 明确记录适用工作区信任；不授予任意工具权限 |
| `--model <ID>` | 选择配置可用的模型 |
| `--ask` / `--auto` / `--full` | run/resume 三选一；ask 选择 accept_edits，未指定时用有效配置 |
| `--skill <名称或ID>` | 可重复，选择已配置知识，不自动启用工具 |
| `--activate-skill <名称或ID>` | 显式合格 Workflow 请求，保留原单次完整 envelope |
| `--execution-status` / `--release-status` / `--telemetry-status` | run 的状态查询，先核连接与适用信任，不创建工作；不附加 `--json` |

JSON 管理入口只接受相应 DTO 的闭合字段。命令回执 applied 不等于 Run/Job 完成；旧身份、错误 scope、缺少本地原申请或未知回执不能换 ID 重发。当前严格解析拒绝已退役的 `--feature`、`--checkpoints`、`--no-sandbox`、旧授权覆盖和 `--stdio`，未知参数也不能获得权限或绕过制品验证。准确词汇见[参数 owner](../../../apps/cli/src/arguments.ts)，工具与信任含义见[授权](../features/tools-and-approvals.md)。

## 通用开发入口连接共享服务

开发入口支持 `bun run cli:dev run --task <文字> --data-root <绝对根路径> --server <本地socket>`；`resume --thread <原会话ID> --task <文字>` 可使用同样的连接参数。先显式启动同一 data root 的开发 daemon，具体命令见[服务生命周期](../server/lifecycle.md#通用-agent-开发生命周期)。这些命令不读取配套 Service 制品、不启动替代实例，正式 Terminal 也使用同一新业务调用者；三平台与完整能力资格仍按当前进度核对。

连接核对所选 profile、原实例及必需接口。省略 `--workspace` 使用 daemon 启动时的工作区，不按客户端当前目录新建工作区；显式工作区不同或原会话属于其他工作区时直接拒绝。兼容 daemon 的 build 可以与客户端安装版本不同。缺席、不兼容或数据不可用时明确失败，不显示空业务列表，也不切换 profile。

共享客户端正常结束或收到宿主退出信号只断开自己的网络，不停止 daemon 或其他工作；Ctrl+C 仍只请求取消当前原 Command。人工问题遇到 EOF 或无有效答案时，返回等待状态与退出码 3；结果未知返回 2，保留输出中的原身份，不重新提交。服务失联不代表原任务已取消或完成。

开发配对与共享路径均支持重复 `--skill <名称或ID>`，只选择该次任务中已经配置、实际发现的 Skill。名称须唯一，未知或重名会拒绝该任务；不传选项时使用配置目录。共享 Service 必须支持每次任务的 Skill 选择，其他会话和已运行任务的选择不受影响。选择本身不授予工具权限或工作区信任。开发入口现已支持三种状态查询，具体边界见下方。开发管理命令 `session/context` 同样接受 `--server <本地socket>`，作用于该 daemon 工作区内明确指定的原会话；不传时使用配套服务。读取或提交前 Ctrl+C 只结束本地等待，已核实原管理事实后才请求取消；冲突或结果无法核实时保留原身份，不猜测取消其他操作。当前共享 socket 验证限 macOS，其他平台范围见服务手册。

通用开发 `run/resume` 另支持可重复的 `--activate-skill <名称或Skill ID>`，显式请求 Workflow；可与知识选择 `--skill` 同时使用。名称来自宿主当前编译目录，或使用准确的 `skill:<名称>`；未知、重名、开关关闭或空对象输入不合法时拒绝，不自动改配置或猜测输入字段。任务文字只作内容。显式 thread 若有活动 Run，激活排为绑定原 Run 与上下文的 follow-up；原 Run 的契约和知识选择不变。目录和激活能力缺失时不提交执行，丢失回执只查原命令。该参数不用于状态查询、维护或会话管理命令。

Workflow 的 replan/waive 问题使用普通 stdin JSON 答案，例如 `{"decision":"replan","detail":"调整实现后再验证"}`，可选值以当前问题为准，detail 必须非空。问题答案不批准其他调用，verifier Job 仍可能独立要求人工审批。答复提交或查询回执丢失时，CLI 保留原答复命令并查询原 ID，不换 ID 重答；无法核实时保留 unknown 结果。普通 EOF 仍返回等待状态。

## 通用开发入口的持久普通申请

普通开发 `run/resume`、显式 Workflow 激活和下面的有限 JSON 入口，在首次发送前保存完整原申请。`resume` 仍表示在所选会话输入新任务，不是崩溃后接续原 Run；显式 Workflow 激活遇到实际活动 Run 时，沿现有分支保存绑定原 Run/context 的 follow-up。单次 Plan/Workflow 输入完整保存，不裁剪正文或改成永久权限。

| 命令 | 输入与用途 |
| --- | --- |
| `bun run cli:dev work <sessionId> --input '<JSON>'` | 闭合的五类原请求之一，必须提供原 `expectedStoreId` 和 `commandId` |
| `bun run cli:dev caller list <sessionId> --input '{"expectedStoreId":"原Store","workspaceId":"原Workspace"}'` | 只列出此原 Store/Workspace/Session 的本地已保存申请，输出 `caller.directory.records` |
| `bun run cli:dev caller lookup <sessionId> --input '<完整原intent JSON>'` | 将目录中对应 `records[].intent` 原样作为输入，只查该保存申请的原 Command |

这些命令可带 `--data-root <绝对根路径>` 和 `--server <本地socket>`，分别选择配对或原共享服务。`work` 只接受 `run.start`、`input.steer`、`input.follow_up`、`command.cancel`、`execution.cancel`；不是任意 HTTP 代理。start 提供完整 `content`；steer 另提供准确 `targetRunId/contextSelectionId`；follow-up 提供原 `afterRunId`（可为 null）及必需的 `contextSelectionId`；两种取消分别提供原 `targetCommandId` 或准确 `executionId`。可选模型、Skill 和单次扩展输入仍按原请求契约校验，不能通过 JSON 请求扩大授权。

首次 POST 前的持久保存失败会明确返回 `not_submitted`，零 POST。同一 ID 已存在时，即使尚未收到服务端回执，也只查原 Command，不自动补发。`caller lookup` 要求完整原本地记录、正文摘要、subject、Store/Workspace/Session 和准确目标一致；缺记录、改正文、错 scope 或原 GET 无法核实都保 unknown。关闭读取或进程重开不会清除原申请；容量与冷恢复边界见[普通申请恢复](../features/recovery.md#开发统一调用者的普通申请恢复)。

`work run.start/input.follow_up` 的 stdout 依次输出 `caller.intent`、`caller.receipt`、`work.event` 和 `work.outcome` JSON。回执核实后，只沿原 Command 取得的实际 Run 继续观察原审批、问题和输出，准确 completed 才成功退出；排队 follow-up 继续查询原 Command/Run 关系，不借当前 active Run。等待输入、EOF 或结束观察不能称为完成；失败/明确未提交为退出 1，未完成或 unknown 为 2，等待审批或问题（包括 EOF 和无效答案）为 3，信号结束按原取消/退出语义保留申请。Ctrl+C 的业务取消是另一项持久申请，目标固定原 Work Command；共享服务只 detach，配对服务会明确提示所属服务收尾可能中断仍活动的工作。steer、两类取消及 caller 查询输出各自原回执或目录；取消请求已应用不表示 Job 已停止。Run/report 的显式 recovery 观察仍按[恢复说明](../features/recovery.md)处理，Ctrl+C 不另发普通业务取消。

安装 Native 的 `kite run/work --server <原socket>` 也按上述状态处理实际 stdin：无效纯空白和 EOF 保留原问题；重开 CLI 后使用完整原 Work 申请回答，选项按原 ID、自由输入按闭合 `{text}` 原对象提交。重复输入与查询已完成 Work 不自动开始新任务。当前真实安装范围见 [CLI owner](../../../apps/cli/README.md#cli-普通问题-stdin)。

默认 ask_user 的原问题提供 `null` 取消选项时，一行 JSON `null` 只取消这份问卷，原任务继续；空白行和 EOF 仍保持等待，Ctrl+C 仍取消原工作。其他问题以实际 schema 为准，不能用 null 绕过未提供的选项。

普通 CLI 邻接实测为 30 项、589 条断言；独立实际 main argv 正例为 3 项、83 条断言，使用一次原 Tool 审批、一次真实文件效果和三次本机 Provider 请求核原 Run completed 后才关闭配对服务。完整 Workflow queued/accepted 强杀例只证明原完整申请与冷查回，尚未证明 queued follow-up 全等待至终态，不称 Workflow 业务执行成功。对应源码、测试与 source-free shared 范围见 [CLI owner](../../../apps/cli/README.md#普通-cli-caller-的持久原申请)。这些资格不切换正式旧入口，也不代表三平台或完整 §35。

## 通用开发入口离线维护

正式 Terminal 的 `kite maintenance ...` 与通用开发入口 `bun run cli:dev maintenance ...` 提供同一独立离线维护，不启动 Service 或模型。只对调用者明确指定的 data root/profile 操作；路径必须是绝对路径，profile 是有限名称，不读取缺省用户 profile。

| 操作 | 参数 |
| --- | --- |
| 创建 DB/媒体及配置/UI 备份 | `backup --data-root <绝对根路径> --profile <名称> --destination <绝对备份根路径>` |
| 完整验证所选备份 | `inspect <绝对备份目录>` |
| 只读未完成恢复观察 | `status --data-root <绝对根路径> --profile <名称>` |
| 显式替换当前数据 | `restore <绝对备份目录> --data-root <绝对根路径> --profile <名称> --expected-store <原观察StoreId> --confirm-data-loss` |
| 核实并完成或回退原恢复 | `reconcile --data-root <绝对根路径> --profile <名称> --restore-id <原观察ID> --journal-digest <原观察SHA256> --decision complete\|rollback --confirm-data-loss` |

`maintenance --help` 不触碰 profile。未知、重复、缺值、相对路径及缺少恢复确认的参数直接非零失败。成功输出 JSON，失败输出有限错误码；busy 不杀进程、不升级共享锁，不改变当前数据。只读 status 在没有 journal 时输出 null，不创建空 profile。未完成 journal 阻止普通开库；调用者核对 status 的准确 restoreId/digest，再明确选择 complete 或 rollback，入口不会自动选择。

恢复表示明确回退到选定备份内容；必须提供当前原 StoreId，错误身份拒绝，成功后产生新 Store，旧写身份继续拒绝。原历史 ID 与来源身份保留，旧目录单独保存，路径在结果中输出。恢复不会自动重做旧工作或模型请求。

JSON 中的 `coverage` 列出 Desktop 私有 UI 的 DB1–7 支持范围，以及 MCP 选择意图 `ui/mcp-selection-intents.json@1`。支持范围不表示文件必然存在；选定备份的 manifest 另列实际存在、格式和完整摘要。冷读这些意图不会重发原申请或重新连接 MCP。

Profile 的 `mcp.json`、`mcp-approvals.json`、`mcp-auth-bindings.json` 也按完整原字节备份；存在或缺失如实记录，损坏内容不会被修复。恢复后无认证用户来源继续按原规则可用；项目批准和凭据绑定需重新回答当前问题，旧决定保留原出处。项目文件仍由原工作区提供，凭据正文不在备份内，目标 Vault缺少原凭据时仍不可用。查看来源不会自动连接或读取凭据。

当前范围包括SQLite与被引用不可变媒体，并分别采集实际profile的config.jsonc原字节、Desktop私有UI一致副本、真实TUI未提交文本文件和终端显示偏好 `ui/preferences.jsonc` 原字节；每项记录存在/缺失、采集时间与摘要，不能当作跨介质同一瞬间原子。原配置可能含敏感内容，备份按私有0600保存，不解析vault或自动脱敏。恢复发布备份中存在的这些文件，保留原草稿/创建身份，不重放旧意图。credentials/vault及未采集宿主私有文件仍排除，旧当前字节保存在保留目录。TUI草稿保留原Store/Workspace/Session且不自动发送或改绑，JSON保留 `coverage.profileComplete:false`；本命令尚不满足整个W19或三平台发行资格。实现与实际临时制品验证见 [CLI owner](../../../apps/cli/README.md#开发-cli-离线维护)。


## 通用开发入口核实原 Job

`bun run cli:dev job reconcile <根会话ID> --input '<JSON>' [--server <本地socket>]` 核实原外部任务；JSON 必须提供 `kind:"job.reconcile"`、原 `expectedStoreId`、新的 `commandId`、原 `executionId` 和观察到的 `expectedResultRevision`。不传server时使用所选profile的配套Service，传入时只连接该工作区的原共享Service。

输出先保存原申请身份，随后显示核实结果。退出0只表示原结果与结束事实已经核实；拒绝为1，仍运行/未知/查询中/无法确认回执为2。丢回复只查询原commandId，不换ID自动重发。Ctrl+C结束本客户端等待（130），共享模式不取消原任务；配套进程按自身关闭规则收尾。此入口不同于继续新任务的resume，也不执行离线maintenance reconcile。默认适配器没有可靠冷核实能力时明确拒绝或保留未知，不能据命令存在推导支持任意Shell/MCP恢复。


## 通用开发入口状态查询

`bun run cli:dev run --execution-status`、`--release-status` 或 `--telemetry-status` 读取选定服务的当前事实并输出一个JSON后退出，可带 `--server <本地socket>` 查询原共享服务。先检查工作区信任；未信任时拒绝，显式 `--trust-workspace` 才保存信任。查询不会创建会话、运行模型或执行任务，已信任时不写入业务记录。显式 `--thread` 只查询已存在且属于所选工作区的会话。信任操作的原身份与服务收尾提示写到stderr，不混入状态JSON。

执行状态分别报告权限/信任、Shell进程监督与沙箱；有进程监督不表示有文件或网络沙箱，权限状态也不是后续工具已获批准。发行状态没有准确制品证明时保持未验证，不凭版本文字判定生产资格。遥测未配置发送器时明确禁用，不输出目标地址或秘密。数据不可用仍可输出安全诊断并返回退出码2，不显示假空任务列表；共享查询结束只断开客户端。

## 通用终端候选入口

新候选可通过明确安装目录下的 `<prefix>/bin/kite` 调用通用 CLI，TUI 为 `<prefix>/bin/kite-tui`；默认使用 `~/.kite-code/unified-agent` 下 `default` profile，隔离验证可显式给 `--data-root`。它不读取旧正式配置和数据库，需要为新 profile 配置模型与工作区信任。构建/安装/回滚/卸载命令见[终端制品说明](../../../apps/cli/docs/terminal-release.md)。根正式入口已固定新候选，当前本机资格限 macOS；已有服务保持原版本，卸载前须显式停止仍使用候选的服务。


## 通用开发入口文件恢复

| 命令 | 操作 |
| --- | --- |
| `files checkpoints <session>` / `files list <session>` | 只读实际恢复点完整目录 |
| `files detail <session> <checkpoint>` | 只读完整原点和文件预览 |
| `files restore <session> <checkpoint> --scope=session\|code\|both` | 明确三范围申请，先保存所有原 IDs 和请求再发送第一步 |
| `files intents <session>` | 列出本地完整保存的申请 |
| `files lookup <session> --input '<完整原 intent JSON>'` | 只 GET 原 Command/status，不开始新一步 |
| `files continue <session> --input '<完整原 intent JSON>'` | 已开始一步只查原结果；两者的未开始 Fork 要明确继续与重新核实 Code/文件事实 |

仅会话创建实际 Fork 而不改代码；仅代码等待独立普通 Job 审批与已核文件结果；两者先 Code 成功，再明确 continue Fork。Code 成功、Fork 未确认是部分完成，不重做 Code。EOF/信号只关闭本地读取，不取消原任务。完整 intent 在 `ui/file-recovery-intents.json@1` 首 POST 前持久发布，冷 unknown 只查原 IDs，无自动 POST 或未知驱逐；新 Store 不重标旧申请。继续 Fork 前 fresh detail 须证明目标文件仍 unchanged，外部编辑或后来完成的任务会拒绝并保原部分结果。

退出 0 表示所选全部 leg 已核成功，1 表示失败，2 表示 pending/unknown/部分完成。恢复点来源与捕获范围见[恢复功能](../features/recovery.md)，独立编译 argv/PTY 与强杀证据见 [CLI owner](../../../apps/cli/README.md#files-三范围恢复-caller)。当前具名通用入口证据不代替全部能力或其他平台资格。

## 安装 Native 与标准命令恢复

独立 Terminal 安装的标准前门可以显式登记 Native。登记后实际 CLI/TUI、Bun 与配套 Service 均来自完整 Native；源码或明确 candidate 选择不参与登记。Native 卸载以原 nonce 撤销自己仍拥有的登记，独立前门恢复 Terminal，不改变业务 Profile 或当前 Run。若父 shell 缓存的是已删除 Native-bin 路径，执行 `hash -r` 或使用新 shell 后恢复 PATH 查找。安装器不修改 PATH/RC，也不能清除父 shell 缓存。当前操作及平台限制见[Native owner](../../../apps/desktop/docs/native-release.md)。
