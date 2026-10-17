# Agent Note: Windows 发布夹具、精确身份与物理依赖共同祖先

Status: implemented

## Problem

现行发布合同在Windows有32项失败：夹具固定 `/private/tmp`、依赖无权限的文件符号链接、用chmod代证权限、缺Windows前门资产并断言POSIX锁路径。修正夹具后真实NTFS又复现两个不同64位文件ID被Number舍入为同一值，完整验证器误报别名。真实Bun启动还会将分离的 `--config` 参数值当作入口，退出0却没有执行应用。

完整物理npm图为每个workspace重复展开相同节点，增加构建、逐文件复制与原对象验证的耗时。优化必须保原解析边、资源、许可证和文件安全约束，不能通过缩减Windows断言或扩大正式安装门禁取得资格。

## Decision

测试使用当前SID真实私有目录、junction／hardlink反例与实际宽ACL反例；资产、错误码和协调锁按平台实际合同核对，POSIX保原模式断言。共享夹具不顶层导入 `bun:test`，普通子进程仍可使用。有限原生I/O测试给足夹具时限，完整实际构建测试另计构建成本，不修改正式安装／窗口／维护／命令期限。

Windows installed 准备沿安装器已有的原 HANDLE 私有批量复制，输入和输出仍由完整 verifier 核准确库存、ACL 和全部 SHA；完整 Native 同一新复制品实测普通复制加校验约 23.3 秒，批量复制加校验约 8.3 秒。Terminal 的未发布 B manifest 在持有模型响应前准备；真正安装 B、回滚、活动 A 的共享权与卸载拒绝仍在原 Run 期间核对，整体 120 秒和命令 30 秒保持。

UIA 的 snapshot 是只读观察：已核原 PID／出生时间／映像后，尚无可见窗口或 Chromium 尚无 Document 时返回空快照，让同一个原驱动在原 10 秒文本等待内继续观察。多窗口、身份变化、协议错误、动作错误和未知关闭仍封闭驱动。此前首次临时错误会永久封闭驱动，外层重试只是重收旧错误；隔离诊断已核实际窗口随后可见、Document 和完整历史均存在。输入只发送一次，再在同一个原动作截止时间内读取完整 Value／Text；不重复输入、不裁剪正文或扩大原 45 秒驱动预算。普通 dev／prod 不增加测试或调试入口。

普通 Native 的完成态不能依赖仅诊断模式显示的“轮次：completed”。安装 caller 分别要求原 UIA 完整回复正文，以及实际候选 SQLite reader 的准确 Run 数量和全部 completed；后续原 Command／Run／Execution、完整输出 EOF／字节／SHA、冷读与零重放断言继续保留。此处沿现行[普通界面约束](../../../../docs/handbook/clients/desktop/README.md)，不向普通制品恢复调试文字，也不以测试诊断制品代替其窗口资格。

Terminal与Native完整内容验证以BigInt的dev/ino比较身份，保single-link、原对象pin、ACL、大小与全字节SHA。固定Bun参数以 `--config=<路径>` 和 `--tsconfig-override=<路径>` 绑定，实际探针同时断言正文运行和恶意cwd preload未运行，不能只查退出0。

Windows构建布局为每个查找名按已锁图的确定顺序选择准确源节点，放置到真实共同node_modules祖先；多版本和peer context冲突仍局部物化，不按名称／版本文本合并不同源。任何原本缺失的optional／peer查找名不提升，避免扩展其可见性。原始包资源与LICENSE逐字节保留，仍无symlink／junction／hardlink或派生.bin；无法有限表达的遮蔽循环仍拒绝。POSIX默认linked图不变。

## Alternatives considered

- 平台跳过或只断言抛错：不能证明原权限、锁和安装合同，拒绝。Windows专属原生调用只在其他平台跳过，不作availability skip。
- chmod或修复既有对象ACL：不能证明Windows安全，也会把不合格输入改成表面合格；仅新建私有输入并核原字节，不改原nvm／Electron安装。
- 删除重复身份检查：会放宽真实别名边界；使用精确整数修正数值表达。
- 只拉长正式120秒门禁或采用内容缓存：不能建立原平台资格，保持完整检查及期限，准备阶段超时也失败。
- 让 snapshot 的临时未就绪封闭整个驱动，或在外层无限重建驱动：前者使真实后续内容不可观察，后者丢失原驱动总预算；保留同一个原驱动并要求期限内的真实完整文本。
- 原有每workspace重复物化：语义正确但实际扩大闭包；采用真实共同祖先且核每条原解析边及所有资源字节，不以hash相同推断peer等价。

UIA 的每次快照只批量读取本次属性和 Value，TextPattern 仍用实际完整 GetText(-1)。已核原身份后，只有明确的 provider 失效/模式变更异常会丢弃整份快照并记录 observation；空结果不能满足任何正文/Document gate，其他错误和原绝对截止仍拒绝。菜单只打开一次并在同一动作期限等候唯一可执行退出项；实际自然退出必须在关闭原成员 HANDLE 前核为 dead。

短正文按产品允许以内联保存，仍要求 complete、准确内容、UTF-8 字节、SHA、空 reasoning/toolCalls 和全部原身份；存在 sealed 输出时仍完整读取至 EOF。Terminal 使用实际加载且进入真实 Provider 请求的工作区 AGENTS.md 产生引用媒体，不能放入无关 blob 或删除媒体断言。Daemon caller 的同步首次 endpoint 选择临时使用同一私有 HOME/USERPROFILE，并立即恢复；绑定的是实际 Windows Known Folder 命名空间，不修改产品 endpoint、安全根或原记录校验。

Daemon bootstrap 每次实际请求仍校验新 nonce；重复观察只排除 requestId，再严格比较全部稳定字段，包含 token、instance、build、PID/出生、workspace、HTTP/Web 和 Profile，错误只报告身份变化，不输出凭据。业务110秒和清理总120秒使用调用者原两个绝对截止，失败 stop 可用原预留10秒，不延长业务。真实安装 TUI 对首次信任提示显式选择确认，再等原会话 ready，核这一步模型请求数未增加，不绕过产品信任流程。

## Consequences

32项有限归档／身份／安装控制测试已在真实Windows通过；不能代替完整安装、Main／Service可信创建链、窗口退出或维护恢复。完整锁图新增解析边与资源原字节回归，真实DLL加载决定归[构建导入决定](../bug-fix/2026-10-16-windows-bun-eager-system-imports.md)。当前实现和实际整包执行结果归[Terminal owner](../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现)与[Native owner](../../../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。
## Cross-platform test paths

用户随后明确要求清理固定 `/private/tmp` 等路径。当前八个 workspace 的实际临时根统一由 OS tmpdir 的真实路径派生；183 处临时目录调用与 291 处 file URL 构造属于测试层的机械替换，不改变产品文件授权或发布准入。362 处原本明确 mode 0700 的目录准备改为真实平台私有目录；Windows 不用 chmod 代证 DACL。UI owner 保原 rootDir，使用公开私有目录原语建立本地夹具，不扩张 production 编译边界。诊断文件同样进入实际临时目录或所属 HOME。

私有记录的公开权限反例在 Windows 实际授予 Everyone 只读权限，并核读取拒绝；恢复时只撤回夹具自己加入的 ACE。原硬链接、坏 UTF-8、原字节保全、128 条容量和身份断言保持。文件 symlink 不要求开发者开启 Windows 特权；对所有 reparse entry 都拒绝的私有记录 consumer 用真实 junction 作为 Windows reparse 反例，POSIX 保文件 symlink。编辑器允许普通文件路径，故其 Windows 反例通过父 junction 指向外部普通文件，先核 realpath 等于外部目标，再核禁止打开，不能只以目标类型错误代替目录外访问检查。

共享夹具的实际 OS 权限、唯一临时根、Unicode/空格/百分号 URL 往返、原外部文件身份与源库存检查另有完整测试。macOS/Linux 的具体原生资格仍须对应系统执行；本机 Windows 的路径修复不外推为三平台安装、窗口或维护通过。正式默认 Windows 的 30 秒测试预算来自现有 runner，发布及安装的原绝对期限保持。
Client 三范围恢复的实际打包夹具另外创建两级私有制品父目录，沿现有制品 ACL 准入，不能把 OS Temp 直接当合格制品父目录。原 caller journal 在 POSIX 保文件和目录 fsync；Windows 使用现有原生私有写入、原生移动及文件同步，并逐次核发布后的准确字节，不捕获或忽略 EPERM 来宣称成功。原60秒内完整实际模型、三范围／独立 Ask、冷 GET-only 与部分恢复旅程在 Windows 44.31秒通过，187断言保持。

这次路径修复在 Windows Bun1.4.3 实测：发布原八完整文件40pass／6原平台skip／0fail；Desktop加文件系统守卫七文件45pass／0fail；UI SSE观察整文件通过；Files／Node-API／打包及Service边界十文件45pass／701断言／0fail。准确 r23 Terminal 的原20秒每命令实际entry／daemon／Web／正常cleanup smoke通过；五workspace的481份原manifest与通知全文校验通过。类型检查覆盖根及八workspace。

CLI journal十完整文件42pass／4fail，剩余四项128记录写入耗时31.97–36.63秒，超过原30秒预算；默认整轮仍在CLI shard出现容量超时及原20秒daemon夹具构建超时并排空其他作业。保留实际失败，不能把路径修复写成完整默认、Windows installed、Native窗口或维护通过；macOS/Linux本轮未实测。新的测试原语及路径替换不改生产准入、安全断言、默认发现／四并发或原时限。
## Capacity budget and fixture initialization

用户本轮明确接受128次真实持久化约32–37秒的耗时，并指出主机性能差异。六个Caller／Recovery／MCP Selection／Connection／Reconnection／Source Approval容量用例统一跨平台使用显式120秒有限上限，覆盖普通runner默认值；仅改该六条test调用参数，函数正文及全部容量、未知记录保留、原字节、私有权限、坏数据和身份断言逐字保持。此前30秒失败是当轮事实，本决定只替代这六项继承默认时限的要求，其他原预算继续适用。容量功能通过不代表已取得单次延迟、吞吐或正式性能资格，不为此修改生产持久化路径。

POSIX daemon-host的五个原业务用例在Windows本已skip，beforeAll却无条件构建四workspace，产生20秒准备失败。初始化现在使用与用例相同的既有平台条件；没有新增平台skip，没有改POSIX每个构建子命令20秒或整体准备60秒。Windows专属endpoint／pipe文件及真实Windows完整链保持独立验证，不能把此夹具跳过计作Windows daemon能力通过。产品启动、IPC、完整安装、窗口与维护期限均保持。
调整后在Windows x64／Bun1.4.3，以原默认相同的 --no-orphans／--timeout=30000执行七份完整文件：29pass／5项原POSIX skip／0fail，476断言，216.05秒；六项容量用例实际26.30–36.79秒，全部完成原断言。120秒仅给这组聚合I/O留主机和负载余量，并保有限失败上限；没有扩大全局默认或增加无限等待。两份原Windows daemon endpoint／pipe完整文件另4pass／0fail／12断言；不把POSIX初始化返回计作Windows业务通过。CLI类型、文档结构／影响、计划与格式检查通过；本轮未重跑完整默认，不能将33项专项通过记作864文件全绿或安装／窗口／维护验收。

继续审查daemon构建调用链后，发现共享CLI／管理／状态以及Skills四份完整文件也在用例已按原平台skip时无条件执行beforeAll。四处初始化现与各自原条件共用同一布尔值；前三份仍限macOS/Linux，Skills仍限macOS，没有新增或扩大平台skip，也不改用例正文。相关八个构建入口由file URL的pathname改用fileURLToPath，保盘符、空格、Unicode与百分号路径。修复前Windows单独执行共享CLI完整文件，真实四workspace构建已完成，但随后以无效的 /D:/Code/... 路径进入Bun.build而报EINVAL；该失败与此前并发时20秒daemon_fixture_deadline分别保留，不将二者误判为产品daemon启动失败。

Windows x64／Bun1.4.3复验五份完整平台文件：25项原skip／0fail，438毫秒，不再为不适用的用例构建。另实际使用buildOwnedDaemon的Files恢复lost-replies完整文件1pass／20断言／11.29秒，执行真实构建及Service，核POST与首次GET响应丢失后的准确原身份和冷只读查询；Windows endpoint／pipe两份完整文件4pass／12断言／0fail，含真实当前用户管道。原构建子命令20秒、准备60秒和全部产品期限保持；平台初始化跳过不代证macOS/Linux业务或Windows完整安装／窗口／维护资格。

另在带中文、空格、百分号的真实Windows临时输出目录，直接调用未放宽时限的共享构建器，四workspace、八个相关daemon驱动入口完整构建通过，实测1.35秒；核全部导出文件、无src回退、Native资产平台／架构与完整SHA。该准备验证不启动POSIX业务或替代安装资格。CLI类型、五文件格式、文档结构／影响、计划证据及git diff --check通过；本轮未重跑完整默认或Windows完整安装／窗口／维护。
