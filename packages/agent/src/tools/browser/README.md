# Agent Browser：受监督的网页操作与有界预览

本模块的[扩展入口](index.ts)、[Controller](controller.ts)和[原生适配](native.ts)将固定的 `agent-browser@0.39.4`（Apache-2.0，源码 `04ba5264dade678062c3cdcce0f4f293e748249f`）接入现有 Agent Extension／Tool／Job／Query／Action 边界。Agent 仍使用原 Loop 和权限策略；浏览器不启动另一套模型决策循环。现有 Native 手动浏览器保持独立，网页不获得 Runtime／IPC／本机文件权限。

## 范围与可用性

- `browser.open` 创建受原 Operations 管理的 `browser.session` Job，返回受理身份而不是伪造启动完成。只接受 HTTP(S)，不接受凭据 URL、可执行路径、任意 CLI 参数、脚本、CDP 地址或登录状态路径。
- `browser.snapshot` 获取该 Session 已拥有浏览器的当前 generation／seq／元素引用；`browser.navigate`、`browser.click`、`browser.fill`、`browser.scroll` 操作准确目标，`browser.close` 请求关闭。
- 原生适配支持 Linux x64／arm64、Bun 下的 PID namespace，以及 macOS x64／arm64、Bun 下的独占 launchd resource coalition。Linux 需要 bubblewrap 和原生 init；macOS 复用固定 stdio guardian 资产，以独立 Browser 身份运行。两者均需固定原生程序、系统 Chrome／Chromium 和宿主预查。Windows 仍明确 unavailable，不降级为只杀命令行或进程组。Linux 实现与 macOS 本轮实测分别取得各自范围的证据，不相互代证。
- 默认仅定位固定版本的已安装原生包、受支持系统 Chrome／Chromium 和原进程监督资产。缺失不使应用启动崩溃，也不自动下载浏览器、运行 npx 或开启外部调试端口。可信 Service 可禁用本能力；JSONC 不能供应运行时路径、策略或原始参数。

## 权威与生命周期

普通 Tool／Action 沿原权限派发；Session 范围来自 Host 上下文，不来自页面或 renderer。`browser.session` 持有实际进程、资源许可与 Run binding；退出和取消必须有监督证据。关闭面板、切换会话、隐藏窗口只停止观察，不关闭后台任务。onRunEnd 不承担资源清理。

`browser.open` 通过原 `operations.ensure` 绑定准确 key／URL 和 Job 申请；其余 Tool 与人工 Action 通过原记录 CAS 绑定输入摘要，先耐久写入 pending，再发出操作。相同 key 的完成结果可重读，遗留 pending 或输入冲突不能再次派发。上游请求 id 不是幂等键。发送后丢失响应、超时或取消不能当成未执行，更不能自动换 key 重试。关闭浏览器只能证明进程停止，不能撤销网站已经收到的提交。

上游 `pause` 并不停止执行，CLI 退出也不意味着 daemon／Chrome 结束。本模块不将二者当成停止证明；人工接管先禁止新的模型动作并更换 generation，等待准确在途边界后重新获取页面状态。未确认清理保持 unknown，由原 Runtime 保留资源而不是假释放。

## 右侧观察与人工操作

`browser.view` 只读返回 `application/vnd.kite.browser-view+json`：不透明浏览器身份、generation、控制 seq、状态、URL／标题、有限最新 JPEG 与有限元素标注。它不启动、导航或恢复浏览器，不向 renderer 暴露 socket、CDP／WebSocket 端口或宿主认证材料；页面像素和文字本身不保证已脱敏。Native 沿现有受范围校验的 Extension 查询及 Command 流读取／提交；没有新增绕过审批的输入通道。

预览使用有界、单路、最新帧观察，不记录持续视频，也不保存每一帧历史。frame.seq 与元素／控制 seq 不同：纯像素变化不应让同一有效元素永久失效；页面导航、元素语义／几何变化和观察失败必须使旧引用失效。Native 隐藏、遮盖、卸载时停止轮询并释放读取句柄；已有命令的结果未知仍查原 Command，不能重发。

人工模式的导航、点击、填写和滚动仍使用准确 browserId／generation／元素 seq 的普通 Action。点选备注是选择标注引用，不会把选取动作传给网页点击。用户说明连同页面、元素、帧来源进入当前 Session 的受控聊天草稿；页面文字仍是不可信内容，不产生授权。现阶段不是完整桌面远程控制或 Office 控制器，也不声称具备系统鼠标接管。

## 填写内容与隐私

Tool元数据区分浏览器身份与一次输入意图的key。`generation`是不透明值，首次快照可省略未知generation，由Host取得准确所属值并等待原启动；不猜数字或starting状态。不同读取或改变输入需要独立key，同key保原结果或冲突。未知网站操作仍不能用新key重试；此说明补充未改变校验、去重、Tool版本或协议。

`browser.fill` 和人工 `browser.input` 的 `fill` 都是普通 Tool／Action 输入，填写值会进入原 Command／Execution 的耐久会话历史；它不是仅留在网页内的秘密输入。临时独立 Profile、私有 socket 或不保留逐帧视频，都不能使这条路径成为凭据安全通道。当前不支持用它填写密码、验证码、API key 或其他凭据；Native 面板在填写入口显示同一警告。没有按字段类型自动识别或删除秘密的保证，不能因网页使用 password 字段而推定输入不留存。

页面 URL／标题、元素名称和快照也可能含敏感资料；它们是低信任工具结果或明确选择的聊天引用，不产生授权，不另复制到运营观测。聊天引用只进入当前草稿，用户发送后才沿普通消息保存。页面登录状态不导入用户日常浏览器，也不提供恢复登录状态文件的入口。

## 原生适配边界

版本固定的内部 foreground daemon 与私有 NDJSON 通道在此 leaf 内适配，不向 Agent 暴露。它与普通 CLI 自动后台启动不可混用，否则上游可能重启 daemon 并改变所有权。每次启动使用自有私有目录、确定版本／会话身份和完整树停止证据，不能依赖 PID 文件或原根进程退出推测 Chrome 子孙已停止。

Linux PID namespace 与 macOS coalition 都是进程所有权机制，不等于网页文件系统安全沙箱；上游在部分 root／container／CI 情形会自动关闭 Chrome sandbox，原生预查拒绝这些宿主或无法核实的系统信息，不静默放宽。原生环境是固定白名单，不继承宿主认证、插件、CDP 或任意 `AGENT_BROWSER_*` 配置。每次启动独立 0700 目录，将 HOME、TMP、XDG、Profile 和下载定位到该目录；完整停止、句柄关闭和原目录身份确认后才删除，清理未知保留原 owner／目录及名额。

macOS 的 [owner](darwin-owner.ts)复用同包已构建的 stdio guardian，通过独立 `--browser-owner` 分支、`com.kitecode.browser.<UUID>` 注册与本次 nonce 保持 Browser 身份；没有 MCP Session、MCP Tool 或额外模型循环。Service 的直接子进程只做 broker，改变 cwd 与 launchd 启动仅发生在它内部。新 guardian 必须核独占 coalition 初始 task count=1；就绪核 broker／guardian／daemon 的准确 PID、birth、父身份及 coalition unique ID／pidversion。Darwin 的 `session_info.backgroundPid` 匹配真实 foreground daemon 的宿主 PID，Linux 仍匹配 namespace localPid。终态须原 daemon 实际 exit/reap、准确 coalition 清空、guardian 真实消失且其 exit 保持 null、原注册移除、broker exit0/reap 与双流 EOF／FD关闭；注册缺失本身不证明树停止。启动失败或清理不确定继续保留 owner、目录与名额，不以晚成功覆盖 unknown。取消期间第一个合法 ready 仍须严格验证并保存原身份，以便校验随后终态；public ready 保持拒绝，不派发业务请求。损坏／截断控制帧、终态后额外帧与伪造 guardian reap 都使结果 sticky unknown；取消超时已发布 unknown 后的迟到证据不使其恢复。独立故障回归覆盖这些边界。共享 broker 的 guardian 通道须唯一完整 terminal、有效 UTF-8、所有先前回调完成、EOF及通道关闭后才发布终态；terminal 后2秒仍缺 EOF／close 即失败并保留原资源。复用取舍见[记录](../../../../../.agents/notes/implemented/architecture/2026-10-27-darwin-browser-owned-coalition.md)。

[Darwin 目录扫描](darwin-storage.ts)使用持有父 FD 的 `fdopendir/readdir/fstatat(AT_SYMLINK_NOFOLLOW)`，仅以 `openat(O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`进入子目录并核 dev/ino。不使用 `/dev/fd` 或绝对路径重开来模拟 Linux `/proc/self/fd`。逐项预算、32层、4096项、256MiB与500ms停止门槛保持，定期让出事件循环；关闭失败保留原句柄和动态库并使清理 sticky unknown。它是采样停止保护，不是硬配额。[真实 Darwin 回归](../../../test/isolated/browser/darwin-storage.test.ts)核 symlink、inode替换、容量及关闭未知；Linux 仍保原扫描路径。

[原生实现](native.ts)的当前限制如下，均不构成 OS 磁盘／内存硬配额：

| 对象 | 当前实现 |
| --- | --- |
| 原生同时准入 | 同一进程最多 2 个；未确认清理不归还名额。Controller 每 Session 只持有一个浏览器。 |
| 生命周期 | 10 分钟后请求整树停止；daemon 配置 5 分钟空闲超时。期限不代替实际退出证明。 |
| 私有目录 | 约每秒采样；超过 256 MiB、4096 项、32 层或单次扫描 500 ms 时请求停止，不跟随子项 symlink。采样间隔及停止期间可超限。 |
| 原生通道 | 单路请求；默认请求 128 KiB／响应 512 KiB，可信注入上限分别 256 KiB／2 MiB。启动默认 10 秒、请求默认 35 秒，可信上限分别 60／120 秒；发送后超时保持未知。 |
| 预览 | 最新单帧 JPEG 最大 96 KiB（Base64 128 KiB）、尺寸不超过 1920×1080，最多 200 个标注；实际启动 viewport 为 960×540。捕获失败清空帧并使引用失效。 |
| 其他输出 | stdout／stderr 合计超过 64 KiB 请求停止；可访问性快照最多返回 65536 个字符串 code unit，并明确 `truncated`。 |

Chrome 仅设置 32 MiB disk cache／8 MiB media cache 参数，不承诺浏览器总 RSS、CPU 或硬盘占用的硬上限。固定上游 daemon **没有禁用自动站点下载**，配置的下载目标是私有目录，受上述采样停止保护而非硬隔离配额；没有 download Tool 不等于禁下载。

## 验证与尚未取得资格

[Controller 回归](../../../test/isolated/browser/controller.test.ts)与[真实 Runtime／SQLite 回归](../../../test/isolated/browser/runtime.test.ts)断言无副作用 Query、原 Job 生命周期、同 key 去重、外部 scope／旧 generation 拒绝、人工接管竞争、未知结果及清理保留。[原生协议回归](../../../test/isolated/browser/native.test.ts)使用替身进程监督和内存 socket，核版本／会话绑定、消息限额、沙箱拒绝、目录采样和未知清理；[资产回归](../../../test/isolated/browser/assets.test.ts)核固定依赖与包内资产。测试存在及断言范围不等于本次执行通过。

[扫描故障注入](../../../test/isolated/browser/native-resources.test.ts)用独立子进程的替身句柄核 ENOENT 竞态、EACCES／打开失败、目录与文件关闭结果未知、扫描停滞后的停止与资源保留。原生协议替身另核不支持平台在创建资源前拒绝、分片 UTF-8、损坏／多余响应、派发前连接失败与派发后写入失败的区别，以及迟到就绪／成功不能复活已取消操作。加速定时器只验证决策与状态，不证明真实 OS 时限、硬配额或平台实现。Desktop 替身回归核多轮接管、换会话后迟到回调、迟到帧和丢失成功响应后仅查询原命令；不将这些测试视为实机资格。 [A→B→A 联动回归](../../../../../apps/desktop/test/isolated/agent-browser-session-runtime.test.ts)连接真实 Runtime／SQLite、NativeExtensions 与 Observer，仅替换模型、浏览器 transport 和桥接端口；A 的导航尚在派发时切到 B，不取消 A 的操作或 Job，A 在后台完成后回到同一 browserId 读取原结果，且无重复启动／派发。

[Service owner](../../../../../apps/service/README.md#受管-browser-默认装配)维护默认目录、禁用硬上限、恢复配置摘要与私有目录保护；[Native owner](../../../../../apps/desktop/README.md#agent-浏览器观察与人工操作)维护同一 Main 观察身份、隐藏与卸载、选择备注和准确命令结果查询。

原云端阶段没有取得真实 Chrome／Electron 资格。2026-10-27 的 macOS 27.0.1／arm64、Bun1.4.2／Node22.21.1 本机隔离恢复基准为 `982db30e2cb692a0a499e20f0f6fffbc7ea35b16`（tree `72beb60ca455dc6d6580fb6524e074994bc2c62f`）。原实现先实测为 `browser_native_platform_unavailable`；随后增加上述 Darwin 接线。当前 Browser／Service／Desktop 的14个定向整文件57项、419个外层断言通过；Agent／Service／Desktop类型检查、Agent完整构建通过。原生Linux替身在Darwin上的短 canonical 临时目录及 proc-fd 模拟只修测试执行条件，不授予Linux原生资格。

本机真实 Runtime／SQLite／Desktop observer／Chrome 已沿本地无凭据页验证打开、快照、接管、选择备注、点击、普通填写、下滚／上滚、交还和显式关闭（44断言）。A导航等待本地页面时切B，A后台完成后回到同一browserId，只有一次启动与一次目标导航。真实取消、准确daemon强杀后恢复及Service退出另83断言通过；独立libproc读取观察到的daemon／Chrome／helper均属原coalition，参数无 `--no-sandbox`，最终核完整树、注册、FD与会话子目录清理。空的受保护基目录可以保留。首次Documents资产布局的guardian认证超时保unknown；后来一次Chrome launch超时取得confirmed整树清理；两次原始失败均保留，不重写为成功或重放未知输入。

Browser 目的的父进程正常退出（broker stdin EOF）及准确父进程 SIGKILL 另做真实 Chrome 验证：由一次 ps 父链快照取得有限的 broker／guardian／daemon／Chrome 后代 PID/birth，后续独立核对这些已观察成员消失及准确 launchd 注册缺失。这不是原 coalition 全部成员的独立终态枚举证明；实现实际调用 coalition stop，与该有限观测分开陈述。原 Runtime 已死亡，不能补造终态回执；两次会话目录保留，未由外部观察冒充 Runtime 已确认释放。

共享guardian／Service／启动失败三个整文件最新18项220断言通过。MCP双会话孙进程存活断言此前两次失败，后续诊断与完整新文件通过；恢复提交的原guardian／launchd完整文件8项132断言也通过；另在同一原测试文件路径核未修改基线也是8项132断言通过，结束后原测试字节已恢复。原失败未删除、未降低断言，其间歇原因尚未定位，不能据最终通过断言原失败与改动无关。上述结果仍不证明Linux原生、Windows或正式安装制品；客户端真实模型与窗口的独立范围归[Desktop owner](../../../../../apps/desktop/README.md#agent-浏览器观察与人工操作)。没有真实账号网页登录、外部表单或凭据填写。

上述44／83断言、父死亡以及真实窗口／gpt-6-luna通过均发生在最后控制校验加严与共享内层EOF修正之前。截至v1审查包保存时，最终代码只取得mock／静态检查证据，真实复验尚未执行：一次过严broker字段检查安全拒绝后原Job保unknown，原准确guardian／daemon／coalition／label绑定未保存，目录保留；字段已纠正，但随后新实机启动被自动审批拒绝且没有重试。当前查不到原broker及Browser注册不能补造历史整树confirmed。共享内层修正对Shell／MCP也只取得fake通道回归，没有把此前间歇失败归因于本次发现。

随后用户明确允许保留旧unknown并另开一个受限实例，2026-10-27 05:33 UTC以v1包一致的owner／native／guardian／broker源码重新构建私有guardian（SHA256 `ccc9c031d76f02b9fc00035dee7d346582f78608f61143e836defb75d2fe21ee`），仅一个真实Browser owner完成ready、本地无凭据页、可访问性快照及960×540标注帧、准确原signal取消、完整terminal及dispose。原daemon exit/reap、guardian exit=null且absent、原coalition taskCount=1、原注册移除、broker exit0/reap、FD关闭均confirmed；17个运行时采样身份随后absent，准确label print113，会话子目录清空，旧unknown目录身份保持。采样是非原子观测，完整树证明仍来自原guardian的coalition终态。正式35秒请求／10分钟生命预算未改变。此最小native闭环没有Runtime／模型／Desktop；追加的“切B期间A继续自主调用后续工具”要求在此实例关闭后才收到，未另开owner，当时最终v1窗口／模型A-B验收仍缺，共享Shell／MCP也未重新实机运行。

2026-10-27 05:53 UTC另按后续明确授权，以同一v1源码和重新构建guardian进行一个新受限真实Native窗口／gpt-6-luna后台轮。A慢导航在途时05:53:33.830选B，并在61次aria-current采样中一直保持B，至Run于05:53:49.907 completed、05:53:50.031在B观察确认。切换后模型新发fill、click、down/up scroll和最终snapshot共5个Tool，全成功；服务端独立记录填写值、一次点击、scrollY500→0，页面初始及慢导航各一次，一个Browser Job／owner，无后台取消或重启。最终回复含KITE_FINAL_BACKGROUND_DONE。

同轮切换前一次snapshot使用browser_id及generation=??，被invalid_tool_arguments在派发前拒绝，模型正确修正后读取成功。driver把“全轮每个Tool都成功”作为总断言，因该已知失败退出1，未执行回A辅助画面或UI结束按钮；不将整脚本称为通过。只读独立校验确认用户要求的后台新动作／真实页面效果／任务完成主条件。随后Service正常关闭沿准确原Job取得cancel stopped、terminal supervision=ended及dispose；冷Job回执确认owned process-tree cleanup，17个采样身份absent、准确label113、目录为空，旧unknown未动。没有为补辅助步骤重开或重发模型。
