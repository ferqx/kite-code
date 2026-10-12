# Agent Note: macOS 原 Worker 退出与锁交接

Status: implemented

## Problem

网页解析返回消息、SQLite strict-close ACK 和 Bun Worker close 是三个不同事实。Bun 1.4.2 的 close 只报告被标记 terminated；本机原 Mach 权实测在 close 到来时仍是 SEND，稍后才变 DEAD_NAME。V1.3 §11.4 要求自有 Worker 收尾后才释放原 owner，不能把通知升级为实际退出。

当前公共调用和资源门禁归 [Store owner](../../../../packages/agent/src/storage/README.md)、[Web Fetch owner](../../../../packages/agent/src/tools/web-fetch/README.md)和[Runtime owner](../../../../packages/agent/src/lifecycle.README.md)。本决定只补 macOS 的单个原 Worker 收尾；Win/Linux 原调用路径与未闭合资格保持，全部 Runtime census、出生后代全集、VM/RSS 和阶段退出不是该线程事实。

## Decision

保持原 Worker 文件、hash、相对 import、主模块身份和一次业务输入，用固定可信同步 preload 在业务模块前取得原 mach_thread_self send-right。preload 以 pthread_threadid_np 和 THREAD_IDENTIFIER_INFO 独立核身份；同一父 Worker owner 消费首个私有消息，不让它进入 parser/SQL 协议。最早取消先取得这份原身份再请求 terminate。

父 owner 保留同 Task 的原权。SEND 仅表示尚待确认；只有该原权严格变 DEAD_NAME 才确认线程终态，随后准确释放原 thread/task 权。thread_info 失败、HALTED、数字 ID 消失、close/exit 标记和等待超时均不能升级。五秒收尾观察预算耗尽、取得或释放失败保 unknown 与仍持原权；SQLite 仍须另有真实 db.close(true) ACK 才归还 Profile/Session/recovery 锁。原错误与清理错误同时存在时保两者及原 cause，不自动重试或重发写入。

新增 preload 是真实运行资产，随 storage companion 同次构建，源码和包入口定位同一受审查文件；Service 只把准确 loader 元数据装配进文件保护范围。根 import/factory 不加载 FFI、不打开 Worker。

普通 Tool把清理失败保存为 outcome_unknown后会释放permit；先前仅从execute抛错误并未把parser owner交给Runtime，正式Run仍可能closed。现Agent提供每Run的Web binding，实际scope在授权Tool execute、prepare之前取得；登记真实Worker并缓存原termination，成功才移除，close先封门并只取消自身scope。Service独立组合该disposer与原Files assembly，复用已有Run lease及shutdown_cleanup_unconfirmed门禁，失败保原scope，不新增Core的Web类别分支或全局registry。网络、robots和origin队列继续由工厂共享，无bind的可信custom port继续由宿主管理。

被动descriptor不在配置准备时调用custom bind，避免本次新引入Web owner在Runtime取得disposer前发生。当时通用assembly准备清理失败只保局部cause，没有跨Runtime接收边界的custody；本次Web执行中parser红绿不能授该相位。此限制现由[配置准备交接Note](2026-10-13-configuration-preparation-custody.md)在明确typed producer／receiver范围内部分替代，其他I/O owner和完整资源门禁仍保留；原Worker终态及Web执行scope决定继续适用。

## Alternatives considered

- 只让Tool抛清理错误：真实默认Service回归中Tool已unknown、Model恰一次，但关闭仍返回成功；需要原Run disposer保owner及lease，单次业务异常不足。
- 等 Bun close：官方合同及原 Mach 权实测均否定其为线程退出证明；最初通知交付 draft 的字节和红保留于测试证据，不能拿它授资格。
- 改用 Node worker_threads.terminate Promise：固定 Bun revision 实现仍等同一个 close marker，没有独立 join。
- 包装主模块：会改变可信 custom Worker 的 import.meta.main、相对 import 和入口身份，故使用 preload。
- 重开数字线程 ID/port 或建立全局 registry：不能保原对象身份，也复制 owner，故每个已创建 Worker 只交接自己的原权。
- 将 Linux thread pidfd poll 直接称最终物理退出：其固定 6.9 源码在最后 kernel cleanup 前通知，不足以解除当前严格门禁；本次不改其产品调用或支持下界。

## Consequences

实际公共 web_fetch 结果、准确取消、SQLite ACK 后 Runtime close 与维护 EX 交接均等待原线程终态及原权准确释放；冷只读 HTTP 历史保原正文且零 Model 重放。可信 custom Worker 与同文件的无 preload 独立 Bun child 对照，保原 URL、import.meta.main、相对依赖、一次完整输入、syntax error 与最早 abort 原 reason。完整交接两项／61个 Bun expect 通过。web_fetch 在取消／timeout 分类前传播私有清理未知，让原 Core attempted Tool 保 outcome_unknown 并停止依赖；另一个实际 Core／SQL／冷读准确取消 case 覆盖该分支，整 Core 文件六项／46断言通过。

原Worker终态改动的18个完整相关文件／61项／835个 Bun expect、47.328秒通过，生产与测试输入零漂移，含源码外完整包和截图对应真实 Electron：40效果、零业务取消、四个真实 native_draining 读取拒绝、零quit弹窗／page error／观测错误，Electron与Service正常0且无信号。测试可三端执行；只授本机实际 Mac 原权证据，Win/Linux unknown 不放行原资源资格。当前验证范围与原失败归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13macos-原-worker-收尾与准确锁交接)。

本次Run所有权的真实默认Service／Client测试先保持正式配置未接线，实际parser完成后注入JavaScript terminate失败；原Tool unknown及Model恰一次均成立，关闭却返回成功，原红保留。接线后同文件1项／29断言通过，保Service／Runtime关闭失败、drain_failed、活进程维护owner_busy；测试自己child实际退出0及双EOF后，公开backup和原metadata／Command／View／Message／Execution冷读全等、Model零重放。两scope隔离及无bind宿主归属2项／7断言通过；无OSskip，注入错误不授nativeAPI故障资格。

最终15个完整相关文件／61项／658断言／34.320秒actual0，3873份非文档代码／配置输入零漂移；根及八workspace类型、Agent／Service构建和必要门禁按当前进度核对。真实Electron再验40效果、零业务取消、四次读取拒绝而无quit弹窗／page error／观测错误，Electron及Service正常0且无信号。冻结／原日志／result为 `/private/tmp/kite-web-parser-owner-final-targets-20261013-*`，result SHA dedd5a194a8e44108516980db12adfa450b0fe23bb1cce196d07162c501d2839。它不证明截图中的安装包已更新。准确原红／fixture修正及当前范围见[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13默认-web-run-的清理所有权)。

未知收尾仍可能需要原宿主实际退出才能归还保有的权和锁。单线程停止不证明全部 JSC/native 分配已释放；原 RSS 与全 resources/handles/descendants 门禁不变。实际 Win/Linux 资格继续后置，不能从私有 metadata 或 Mac 通过推导。

固定来源为 [Bun close 合同](https://bun.com/docs/runtime/workers#close)、[固定 Bun worker_threads](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/js/node/worker_threads.ts)及 [Apple thread](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/thread.c)、[Apple IPC thread](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/ipc_tt.c)。源码顺序与本机实测分别提供边界和本次证据，不称本机 kernel 的逐字构建审计。
