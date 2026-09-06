# 客户端启动、服务生命周期与发布升级规范

状态：阶段 1、2 本机实施完成；阶段 3 门禁实现完成，跨平台 qualification 待执行。

## 本次交付与剩余验证

- 已实现 lifecycle v1、实例绑定停止、busy/--cancel 重启、状态可用操作、启动前 endpoint 排他、只读 Store 格式预检、Web document/API 实例绑定，以及 TUI 协议不兼容诊断。
- 默认 TUI/CLI 沿用同 candidate 子进程，新增安装版本切换后的旧客户端重连/新客户端配对验证；没有新增后台更新器。
- 合并后默认测试通过：workspaceFiles=373、integrationFiles=96、isolatedFiles=65。后续状态提示与 TUI 诊断补充通过对应定向测试。16 个 workspace 类型检查、文档/归属、核心/依赖/首发架构门禁通过。
- macOS arm64 本机已通过 candidate build/verify/smoke，包括 installed TUI PTY、同包服务、独立编译旧业务协议 fixture 的 lifecycle restart、安装升级回滚卸载；这不是 Linux/Windows hosted 证据。
- 剩余：在 Linux/Windows 运行新门禁并取得 hosted 结果；首次正式发布后，将真实受支持 predecessor 制品加入升级矩阵。当前只有独立 fixture，不能宣称测试了不存在的历史发布版。
- 当前源码改动与候选资格分别陈述，不用历史成功 run 覆盖新增实现。

## 目标与现状

发布升级后，用户应能识别正在运行的版本，通过明确命令切换到当前版本，不必手工查 PID。业务协议不兼容不能成为正常生命周期管理的死路。普通连接、状态查询、资源构建与安装不得暗中替换运行中的服务。

本次现场证据：当前 checkout 的旧 daemon 返回 `protocol_version_mismatch`；release client 曾将它分类为 unavailable，随后 dead cleanup 返回 alive。本次已修复错误分类与 Web 启动失败中止，并增加独立生命周期接口以支持跨业务版本停止与重启。

设计时实现入口为 [release client](../../scripts/release/app-server-daemon.ts)、[daemon owner](../../apps/kite-service/src/app-server-daemon.ts)、[endpoint owner](../../apps/kite-service/src/native-endpoint.ts)。原 `server/status`、`server/shutdown` 依赖 Runtime initialize；shutdown 会取消活动执行。目标增加稳定生命周期入口和显式 restart，不改变 Session writer 的 Store authority，不恢复 manager、watcher 或 previous-build client。

设计时 TUI 手册将退出和取消区分为用户动作，但未完整说明自有服务退出对活动执行的影响；stdio transport 与 Service EOF 收尾表明自有进程不会作为共享 daemon 保留。本次已对照真实 PTY/子进程验证并补齐手册说明，明确自有服务与共享 daemon 的区别。

## 客户端范围与进程所有权

这是一份覆盖发布客户端的统一规范，daemon restart 只是其中一种路径。当前生产入口包括默认 TUI、foreground CLI、显式连接 daemon 的 TUI/CLI，以及本机浏览器 Web；独立桌面客户端尚不是当前发布制品，下面只规定其未来接入必须遵守的所有权边界，不宣称已实现或新增打包项目。

| 入口 | 启动服务责任 | 版本配对 | 关闭客户端的含义 |
| --- | --- | --- | --- |
| 默认 TUI | 自动启动安装包内配套 stdio App Server，无需用户先运行 server start | 客户端与子进程固定同 candidate/build | 关闭自己拥有的子进程并完成清理，不影响其他 TUI/daemon |
| 默认 foreground CLI | 执行需要 Runtime 的命令时启动配套子进程；help/version 不启动服务 | 同 candidate/build | 命令结束释放子进程；异常退出由父子连接断开触发服务收尾 |
| TUI/CLI 显式 --server | 仅连接用户选定的共享实例，不隐式创建替代服务 | exact 业务 protocol/capabilities；build 可不同 | 仅断开连接；不停止共享服务，也不自动取消其他客户端任务 |
| 浏览器 Web | 本机 daemon 提供页面及 API；浏览器无本机 spawn 权限 | HTML/JS/API 属于该运行实例的发布制品 | 关闭页面不停止服务 |
| 未来独立桌面客户端 | 原生宿主必须明确选用自有子进程或显式共享 daemon，renderer 不拥有进程控制 | 分别沿用上面两种配对规则 | 以实际进程 owner 为准；窗口关闭与应用退出策略在桌面产品设计中明确 |

同一个客户端实例选定一种连接模式后不得因故障静默切换模式、profile 或 Workspace。多个默认 TUI 可以各有服务，Session writer 竞争仍由现有 Store generation fencing 解决；不能为了“统一启动”把它们改成全局 daemon。未来桌面端复用这些契约，不另建第三套发现/升级服务。

## 面向发布用户的启动与退出

默认 TUI 的产品流程为打开已安装入口 → 校验配套制品 → 启动子进程 → exact initialize → 加载配置/信任与会话 → 可交互。普通用户不需要 Bun、源码 checkout、Vite 或额外 server start；源码开发命令不能代替安装版验收。

同版本配对由不可变 candidate 和显式 executable 路径保证，不查 PATH 中的 kite-service。缺文件、校验失败或 same-build mismatch 视为安装问题，显示修复/重装建议；不能建议用户停止某个无关 daemon，也不能尝试跨 build 连接。只有完成 initialize 和必要加载才报告 ready；启动有界等待，失败应区分启动权限、子进程退出、安装不完整、配置/信任及连接问题，不显示成空会话。

首次使用时配置和 Workspace Trust 仍按已有产品流程执行，启动服务不等于授权任务或信任工作区。启动诊断只显示有界脱敏信息，不直接输出 stderr 中可能包含的凭据；CLI 自动化失败非零退出，TUI 保留可读错误和退出操作。

默认 TUI 退出应关闭自己拥有的连接，服务执行取消/资源清理；不能承诺退出后任务仍在后台继续。区分主动取消与退出动作，但必须向用户说明退出自有服务也会终止其执行承载。共享 daemon 模式退出只断开，其余执行按服务和会话规则继续。父进程崩溃/被终止时通过 EOF/既有 watchdog 收尾，不能留下仍执行的受控工具子进程；仍无法确认的副作用进入已有恢复语义。

服务异常退出或连接丢失时，客户端停止宣称任务正在正常执行，保留历史和尚未提交的输入，区分已确认提交、未提交与提交结果未知。恢复连接不能自动重发 mutation、审批或工具请求；查询可重新读取，但旧连接 generation 的响应不得覆盖新连接。TUI 明确操作后可以重建自有连接，必须仍使用该 TUI 固定的 candidate；不能因 active pointer 更新而在旧 TUI 下启动新版本服务。foreground CLI 本轮失败退出，不后台循环重启；共享模式重新连接原目标，不自动接管 daemon。

## 客户端升级与共享数据

安装更新只影响下一次启动的客户端。旧 TUI 与其旧服务继续固定版本；新打开的 TUI 使用新 candidate 的配套服务。更新器不得在运行中给旧 TUI 热换服务或删除其仍需加载的 candidate 资源。当前阶段保留不可变旧 candidate，不新增自动垃圾回收和进程登记表；未来清理策略须先证明不会破坏运行实例。

客户端/服务配对兼容不等于共享数据兼容：旧 TUI、新 TUI、daemon 可能同时打开同一 installed profile。发布支持表必须分别覆盖客户端↔服务、生命周期、Web API、存储 schema/读写语义。允许新旧并存的升级必须验证双向读写语义与执行 fencing；格式不兼容的版本不得在正常启动时悄悄迁移，必须在可变存储打开前明确拒绝。本阶段不支持有破坏性存储变更的在线混跑；如未来需要迁移，必须单独设计所有访问者停机/独占与恢复流程，仅重启 daemon 不足以实现这一点。

source profile 与 installed profile 的隔离保持现状，安装版不得把源码会话缺失误报成数据删除。卸载、磁盘回滚和进程退出分别说明；磁盘回滚不承诺新格式数据可由旧版读取，不能仅因 candidate 完整就宣称降级安全。

## Web 在服务切换后的行为

安装版运行 daemon 的 HTML、JS/CSS、API Docs 固定在它的 candidate 内，不读取更新后 active candidate 的资源。API 返回的 build/instance 信息用于检查当前页面与服务身份；客户端在初始读取及服务恢复后核对。页面 build 与运行 API build 不匹配时停止把结果当作当前快照，显示重新加载提示，不能继续以旧 schema 解码并伪装成空数据。

daemon 重启后 Web origin 可能变化；restart/web 命令输出实际新地址，不承诺旧标签页自动跳转。旧页连接失败保留已有内容并标明陈旧/断连，引导重新运行 web 获取地址。若 origin 恰好相同，也必须重新校验服务身份与浏览器访问会话；不搬运旧 cookie、信任或审批。HTML/身份响应不得被旧缓存长期遮蔽，资源缓存按内容标识隔离；不新增 service worker 或自动页面重定向注册表。

源码模式 Web build 会写入 checkout 的 dist，不能拿它证明已安装制品不可变。源码预览需要变更资源时显式重启；同样执行页面/API 身份核对。打包验证必须使用 installed candidate 的真实资源路径。

## 命令与授权

| 命令 | 目标行为 |
| --- | --- |
| `server status [--json]` | 只读，报告进程阶段、业务兼容性、运行/目标 build、工作区、Web 地址和可用操作；不创建 profile 或凭据 |
| `server start` | absent 才启动；同工作区兼容实例可复用，build 不同明确提示仍运行旧版及 restart 命令；不兼容、draining 或工作区不符则失败，不替换 |
| `server stop` | 明确授权取消该 daemon 拥有的执行并停止，与当前语义一致；利用稳定生命周期接口，不要求业务协议兼容 |
| `server restart` | 明确切换到调用方已解析的版本；默认只在 idle 时接受停止，busy 不改变原服务状态 |
| `server restart --cancel` | 明确授权取消该实例活动执行、等待清理、停止并启动当前版本；不重复询问，也不自动升级为强杀 |
| `web` | 只发现业务兼容、ready 的实例地址；不启动或重启 |
| 安装/升级/回滚 candidate | 只更换磁盘制品与 active pointer，明确提示已运行服务不会随之更新；实际切换使用 restart |

`--cancel` 只接受于 restart，不扩散为通用绕过参数。不增加 `--force`、隐式提示交互或后台排队重启。自动化与交互终端使用相同行为。start/restart 的 `--workspace` 必须与现存实例匹配；未指定时重启沿用经校验的实例工作区，absent 时沿用 start 默认解析。stop 仍按选定 profile/endpoint 管理整个 daemon。

restart absent 等同 start。并发操作、超时、权限或身份不明均返回非零及明确诊断。status 成功读取生命周期状态时退出 0，即使业务不兼容；absent 是有效状态；无法可信读取则非零。其他命令仅在其目标已确认达成时退出 0。既有 status JSON 消费者随实施同步更新，不静默改变字段含义。

## 稳定生命周期协议

在同一个 owner-only Unix socket / current-user named pipe 上新增独立 `kite.lifecycle.v1` 会话。首帧以固定 discriminator 选择 lifecycle 或现有 Runtime 通道；选择后整条连接固定，不混用、不二次降级。分流发生在 Runtime initialize 与业务消息 codec 之前，生命周期 codec 不依赖 Runtime 协议版本。旧 Runtime 客户端继续走原入口。

生命周期仅两个操作：

- `status`：返回 lifecycle 版本、instanceId、PID/OS start identity、homeDigest、canonical workspace、running build、业务 protocol/capabilities、phase、activeOperations（现有 gate/Host 的布尔忙碌事实，不另建计数） 和 ready 时的 webOrigin。目标 build 由客户端自行解析，不信任服务器选择替代 executable。
- `shutdown`：必须携带 `expectedInstanceId` 和 `mode: if_idle | cancel`。返回 accepted、busy、instance_changed 或 already_draining。响应确认接受不等于进程已退出。PID/start identity 仅用于退出观察与现有 dead proof，不授权信号终止。

请求包含 schema、requestId、operation 及该操作精确字段；响应使用同 requestId 和闭集结果。无任意 command、文件访问或 Provider 能力。首版限制单帧 16 KiB、首帧 5 秒期限，每连接单个未完成请求；复用现有 endpoint 连接数上限。未知版本/操作返回有界错误，不尝试业务执行。连接结束不撤销已接受的 shutdown。

生命周期 v1 的基本 status/shutdown 在受支持发布线中保持可用，独立于业务版本升级。新能力通过显式 capability 引入，客户端只调用双方支持的能力；不得随业务版本修改基本字段或枚举含义。首版不实现 v2、版本协商框架或旧业务协议适配层。若未来必须破坏 lifecycle v1，需先发布保留 v1 的过渡版本及升级路径，并重新评审支持窗口。

客户端只有在 owner-only endpoint 校验通过、响应 homeDigest/workspace 符合目标后才能控制。shutdown 的 instanceId 必须与刚读取的同一实例一致，并由服务端原子校验；不能靠旧 PID 文件或 build 字符串授权杀进程。保留现有 dead-only cleanup：PID/start identity、reservation、socket identity 必须全部符合既有证明要求。不新增跨平台 PID 强杀回退。

## 状态与执行边界

endpoint ownership 取得后即可提供 lifecycle starting 状态，再初始化 Store/业务资源；此时业务请求拒绝为 not_ready，restart 返回 busy，stop 由 owner 标记启动取消并在初始化安全边界释放资源，不能并行释放仍在创建的资源。starting 状态尚未产生的 Web 地址省略。初始化失败由同一 owner 清理并退出。

进程阶段和业务兼容性分别表达。phase 为 starting、ready、draining；absent/unavailable 是客户端观察结果。businessCompatibility 为 compatible、incompatible 或 unknown；build 不同不是协议不兼容。重启失败属于命令结果，不建立持久 failed daemon 状态。

`shutdown(if_idle)` 必须在与任务 admission 相同的串行边界内完成“检查活动执行并关闭新执行入口”。不能先在 client 查 active 数量，再无条件停止；数量只用于展示。活动执行包括运行中、工具执行中、等待审批/用户回答以及归属该 owner 的子任务；idle 检查必须覆盖所有执行入口，不能只看当前连接。

- busy：保持 ready，接纳行为不变，无排队 shutdown。
- accepted：原子进入 draining，禁止新执行及恢复执行；已有只读访问和 lifecycle status 在可用范围继续，重复停止同一实例返回 already_draining。
- cancel：进入同一 draining 边界，然后调用现有取消/清理链；停止不撤销已经完成的外部副作用，不重放任务。
- 清理顺序：停止新执行 admission → 完成取消与受控子进程清理 → 关闭 Web/业务 carrier → 释放 Store/Host 资源 → 关闭 lifecycle endpoint 并清理该实例 reservation → 退出。

endpoint 保留到资源释放完成，避免新 daemon 抢先打开尚在清理的 Store。进程停止策略必须由唯一 daemon owner 实现；既有业务 shutdown 和 OS signal 都进入同一状态机，不能各维护一份 stopping authority。信号仍按当前取消语义处理，不属于 CLI 自动降级通道。

## Restart 流程、并发与失败

1. 解析并固定目标 executable/candidate、build、profile、工作区和 Web assets；验证路径、制品完整性、静态资源及可只读判断的数据格式兼容性。任何失败在旧实例仍运行时返回。
2. 通过 lifecycle status 取得旧实例；校验目标范围，再提交绑定 expectedInstanceId 的 shutdown(if_idle/cancel)。不支持 lifecycle 的旧实例进入下述一次性开发处理。
3. 等待旧 endpoint 释放及旧进程退出证据，默认停止等待上限 30 秒。超时返回 stop_timeout，不发 SIGKILL、不 spawn、不删锁。已接受的停止可继续完成，不能承诺原服务仍 ready；用户可通过 status 检查后重试。
4. 使用现有排他 endpoint reservation 启动目标。并发 start/restart 必须先获得 endpoint ownership，再初始化可变 Store/执行资源；失败方不能短暂运行第二个 Host。首版不引入跨 stop/start 的持久操作锁或替换日志。
5. 启动等待上限 10 秒，验证 ready、目标 build、workspace、业务协议和 webOrigin。若并发客户端已启动其他实例，只有它满足全部目标条件才可报告目标已达成，否则报告 concurrent_change；不得停止新出现的实例。
6. 输出新 instanceId、实际 build 和 Web 地址。启动失败报告 new_start_failed/start_timeout 与实际观察状态，提供有界、脱敏启动原因。清理只针对自己拥有的启动子进程/endpoint，不影响竞争者；不能将暂未 ready 等同 dead。

restart 不是磁盘与进程的原子事务。CLI 在旧服务停止后崩溃，系统允许保持 absent；重试先观察实际状态。CLI 在新服务启动后崩溃，服务继续运行，status 可发现。无需持久 restart intent、自动恢复启动或操作历史表。

启动失败不自动切回旧 executable：新进程可能已触及存储，自动回滚不一定安全。发布必须声明支持的数据格式与升级来源，破坏性数据升级未设计前不得宣称可无损升级；不能用 lifecycle 成功替代数据兼容证明。数据迁移、备份和降级不是本阶段实施范围，不新增空迁移框架。

## 首发与旧开发实例

当前项目处于未发布 clean cutover。首发必须携带 lifecycle v1，后续受支持版本通过它升级。今天已经运行、未实现该接口的开发 daemon 无法被事后赋予新协议；若收到明确的不支持响应则报 lifecycle_unsupported，按现有排障手册核实并显式停止一次；连接关闭或超时只能报告 unavailable/timeout，不能推断为旧版本，也不能触发信号回退。普通启动不做一次性开发迁移，也不将手工 PID 清理当作正式发布升级流程。

正式跨版本验证必须以两个独立制品进程运行：业务协议不兼容、生命周期 v1 兼容。安装切换后确认旧进程仍运行旧 build，再执行 restart 并验证新 build/Web。不能仅让同一份源码修改 client 版本字符串就声称升级可用。首次发布尚无真实 predecessor 时使用独立旧协议 fixture 证明机制，标明限制；第二次发布起保留受支持已发布制品的升级证据。

## 模块职责与实施阶段

| 阶段 | owner 与交付 | 验收后同步 |
| --- | --- | --- |
| 1：稳定控制入口 | kite-local-runtime 拥有独立 codec/client；kite-service endpoint 首帧分流与 daemon 唯一停止状态机；Runtime Protocol 不承担跨版本生命周期 | local-runtime README、Service owner 文档、active app-server-local-runtime |
| 2：客户端启动与显式重启 | TUI/CLI 的自有与共享模式启动/退出/故障展示、candidate 固定与 Web 身份检查；release composition 负责目标预检、预期实例控制、等待、排他启动与结果；CLI 解析 restart/--cancel/status 展示；补齐初始化先后顺序 | TUI/Web 入门与连接恢复、CLI 参考、服务生命周期与排障、源码开发说明 |
| 3：发布闭环 | candidate 安装/升级提示、默认 TUI/CLI 新旧版本并存及共享数据兼容、跨版本制品测试、三平台 endpoint/admission/process 验证；核对 release 文档中已退役自动换代描述 | release-control、open-source-first-release、release 测试入口与实际资格证据 |

每阶段完成执行 iteration_complete 和 overengineering-check；已有上一阶段验证在输入不变时复用。阶段 1/2 不足以宣称跨版本发布通过。所有阶段完成后将当前事实归回产品/owner/active，移除此计划，ADR 保留决策历史。

## 必要验收

- 干净安装环境无需 Bun/源码即可打开 TUI 并启动同 candidate 服务；CLI help/version 不 spawn；缺配套服务、启动无权限和初始化超时给出对应错误。
- 升级时旧 TUI/旧服务继续配套，新 TUI/新服务配套；旧 TUI 重连不混用新 candidate，显式 --server 从不静默转入自有模式。
- 两个 TUI 与 daemon 并存，关闭一个自有服务不影响其他 owner；共享客户端关闭不 shutdown；父进程异常退出清理受控执行树。
- 子进程崩溃、提交响应丢失与重连不重放 mutation；保留输入和历史，不将未知结果展示为未发送或成功。
- 支持的新旧制品同时访问 installed profile，双向读写与 same-session fencing 正确；不支持的 schema 在可变打开前拒绝；candidate 回滚不绕过数据兼容检查。
- Web 旧标签页跨重启正确展示断连/陈旧，origin 改变可取得新地址，origin 复用时仍验证 instance/build；浏览器缓存不导致旧资源与新 API 混用。

- 业务 initialize 不兼容但 lifecycle status/shutdown 成功；未知 lifecycle 拒绝且无 spawn/kill。
- 同 build、兼容不同 build、不兼容业务、工作区不符分别符合命令表；start/web 无隐式替换。
- idle restart 成功；busy restart 不改变 admission；--cancel 取消父任务/子任务并完成清理，未知外部结果不重放。
- 最后一项任务退出与新任务入场竞争：if_idle 绝不在漏算执行时 accepted；所有执行入口受同一 draining 边界保护。
- expectedInstanceId 改变、重复 shutdown、两个 restart、start 与 restart 竞争：不停止新实例，不创建第二个执行 owner，不删除他人 reservation。
- 预检失败保留旧实例；停止超时不启动；新启动失败不自动回滚；CLI 在每个 stop/start 间隙崩溃后可只读诊断及显式重试。
- socket/link/owner/PID/start/inode 漂移维持 fail closed；absent status 不写文件；Windows 使用 current-user pipe，与 POSIX 等价语义但不伪造 inode 检查。
- active candidate 切换不会隐式替换；重启后实际运行 build、静态资源和 Web 地址一致；Store 格式不支持时明确拒绝。
- 新旧业务协议制品的升级测试在 macOS、Linux、Windows 通过后，才更新对应发布资格结论。
