# Kite Local Runtime

> 实施中：[会话存储兼容性与连续性 V1](../../docs/plans/session-store-compatibility-and-continuity.md)已统一正式数据入口，并验证 macOS 已知格式的自动整理、历史来源归并和原会话保留。未知格式保留原数据，不切换空库；完整方案与未验证平台的边界以计划中的最新验收记录为准。


## 定位

`@kite-ai/kite-local-runtime` 提供本机 App client 与 App Server 之间的 typed transport、profile/config filesystem primitive
和显式 daemon endpoint lifecycle primitive。它不拥有 Runtime Host、Store、Session writer、TUI presentation 或 release policy。

## 公开子路径

- `/client`：stdio、Unix socket/named-pipe transport，App Server connection，Runtime/History/App Control/credential adapters，
  以及独立 lifecycle v1 codec/client 和业务 daemon status/shutdown codec。
- `/client/protocol`：供可信原生应用传输组合的环境无关 Runtime/History/App Control connection；桌面 WebView 只消费此子路径，不能导入含 Node/Bun I/O 的 `/client`。它不启动进程，也不为浏览器 Web 扩权。
- `/config`：共享用户配置的 owner-specific lock、revision CAS 与 atomic replacement primitive。
- `/coordinator`：仍有生产消费者的 internal coordination substrate；不参与默认 App Server discovery。
- `/service`：Kite profile home 校验、owner-only private directory、daemon endpoint path、PID/start identity 与 dead-only endpoint
  cleanup。

旧 `/manager` export、single-Service manager/client、Native lifecycle request codec、canonical `service.sock`、
descriptor/token filesystem state和 build replacement 已删除。

## Endpoint 与 authority

显式 daemon endpoint 由 canonical profile root 的 digest 决定：POSIX 使用 owner-only
`<runtime-parent>/kite-code/v1/<digest>/app-server.sock` 与 `app-server.lock`，Windows 使用 current-user protected named pipe。
reservation 只记录 PID、OS start identity、instance、build 与可选 socket inode，用于证明 dead owner 后精确清理；它不保存 Store、
Session generation、credential 或启动意图。

`status`/`stop` 在 endpoint absent 时不创建 profile 或 state。alive、identity uncertain、inode drift 一律保留证据并 fail closed；
只有 exact dead proof 才允许清理。业务 mismatch 不触发自动替换；显式 stop/restart 使用独立 lifecycle v1 与 expectedInstanceId 校验。

## Profile 与配置

source/installed Runtime Store 均为 `<canonical-config-root>/kite-session.sqlite`。已验证的 macOS source CLI/TUI、paired Desktop 与 installed CLI/TUI 入口在满足进程准入和 Store 独占维护条件后，可于 Service 打开前整理已知旧 `kite.sqlite` 和 source profile 数据；未知格式、无法证明旧 writer 已停止或未验证的平台保持原数据并拒绝切换空库。适用范围与验证见[会话存储兼容性计划](../../docs/plans/session-store-compatibility-and-continuity.md)。
Provider/config/credential/Trust 继续共享 canonical config root，通过 file-local CAS 序列化；不存在 global writer lease。

profile 与 private state directory 必须是 canonical、non-link、owner-only 路径。POSIX 收紧为 `0700`；Windows 使用 current-user
protected DACL。路径或 owner 证据不确定时拒绝，不自动修复外部替换的 entry。

## 不变量

- client transport 不包含 Store/Host object，也不自动重放 mutation；
- default local connection 由 parent 直接持有，不通过 canonical discovery；
- daemon endpoint ownership 只管理 process/transport，不管理 Session；
- 不提供 previous-build client、active-candidate replacement、OS service、upgrade watcher、remote discovery 或 compatibility range。

## 验证

`bun run --cwd packages/kite-local-runtime test`、`bun run --cwd packages/kite-local-runtime typecheck`、
`bun test tests/release/app-server-client.test.ts tests/release/app-server-daemon.test.ts`。

## 产品与修改导航

[共享产品定义](../../docs/handbook/README.md) · [开发地图](../../docs/development/architecture.md)。本模块说明实现，不重新定义客户端操作。

- [test](test)

## 深入机制

- [Native 连接与 App Control](docs/native-client-and-control.md)

生命周期客户端位于 [lifecycle](src/client/lifecycle.ts)，只连接已选 owner-only endpoint，一次请求不自动重试 mutation；业务 codec 的升级不影响此入口。

CLI 与 Desktop 共用 canonical config root，不再按 checkout 或 Store epoch 生成独立数据入口。`startup-diagnostic` 使用独立的封闭阶段记录与终止错误记录；错误包含类别、可选阶段及 schema 数字，维护准入拒绝另含有限的 `admissionReason`。旧错误记录仍可读取；其他类别不能夹带准入原因，未知原因或多余字段拒绝解析。阶段不占终止错误保留窗口，初始化后停止处理。可保存的诊断由这些白名单事实生成，并附处理条件；不转发原始 stderr、路径、cause 或数据库内容。


## 会话维护发行准入

macOS的只读进程观测采用PID与精确OS起始身份。source CLI/TUI准入核对当前构建和同仓库父入口；paired Desktop核对Host内置manifest摘要、Service自身文件摘要与精确父Electron；installed CLI/TUI核对选中候选、父客户端与launcher链，并持有发行选择锁。三条入口都按目标canonical config home判断活动Kite进程；没有显式Store目录的进程按其自身的`HOME`推导默认目录，不能使用观测者Service的`HOME`。其他已核实数据目录的进程及其他发行入口的存在不阻断本Store迁移。同目录活动进程或无法核实数据目录的候选Kite进程仍拒绝。结果只是一项维护前提，必须与Service持有所有Store独占锁和源文件复核组合；不代替Session execution authority，不自动停止未知进程。进程观测仍识别自定义安装根下符合固定发行布局的同用户Kite进程；路径形状只用于拒绝，不构成父进程豁免或执行授权。此观测不保证任意旧launcher未来不能启动，未参与维护协议的历史入口仍受已声明的资格限制。

Desktop进程识别只匹配应用主程序或明确的source Electron主进程，不把Bun开发启动器和Electron renderer当作旧Store写入者。[观测器](src/service/legacy-store-processes.ts)在可执行路径及内核执行名能够共同确认进程无法承载受支持Kite入口时，可略过其参数读取失败；路径缺失时仅对代码签名和执行身份精确匹配的已知非Kite辅助进程放行。已退出但尚未被父进程回收的macOS僵尸进程，须经`KERN_PROC_PID`两次核对同一PID、启动身份及僵尸状态后略过；`kill(pid, 0)`成功不代表它仍能写Store。可能属于Kite或身份不明的活进程仍阻止维护准入。

Electron Host使用独立纯Node `desktop-manifest` 子入口，不能把含Bun native API的Service barrel导入renderer。固定数据/构建环境不得经manifest.environmentKeys覆盖。Windows、显式daemon及未参与新协议的历史发行组合的支持资格不得从macOS当前路径外推；参见[实施计划](../../docs/plans/session-store-compatibility-and-continuity.md)。

在已验证POSIX入口，准备阶段可以持有维护权异步等待发布前决定。取消不写发布意图；同意提交后重新验证准入和源文件。stdio Service在安全点处理启动期退出信号，已有意图恢复不取消。父客户端预初始化关闭等待Service实际退出，不以计时SIGKILL打断发布；已初始化后的普通运行收尾规则不变。
