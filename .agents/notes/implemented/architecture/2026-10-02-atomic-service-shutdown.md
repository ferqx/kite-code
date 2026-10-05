# Agent Note: 本实例原子停止接纳与分阶段资源关闭

Status: implemented

## Problem

先查询空闲再调用关闭，会在两次操作之间接受新工作；只在 HTTP 入口检查 closing 也挡不住已经开始异步准备的请求。与此同时，后台 Job、绑定 dispose 和已受理文件发布可能在前台 Run 完成之后仍持有资源。V1.3 §11.4、§22、§27.4 要求只收束本实例拥有的工作，等待实际资源释放后才宣称关闭，不能取消同 profile 的另一 Service 或把未知清理当成功。

## Decision

[Agent Runtime](../../../../packages/agent/src/lifecycle.README.md)公开同步 `getLifecycleState()` 与 `tryBeginShutdown('if_idle'|'cancel',options?)`。busy 从既有本地接纳、dispatch、execution、后台 operation 和 cleanup 事实计算。if_idle 的检查与停止接纳在同一无 await 段完成；忙时保持接纳，cancel 则封门并进入原有自有工作清理。重复关闭返回同一完成 Promise，不再把第二次调用的立即返回当成首次关闭完成。

已经提交的耐久命令仍保留原回执。关闭不因知道 command ID 就获得其 owner 权限，不扫描取消尚未取得所有权的队列；另一 Service 已接管的工作继续。派发准备和实际接管的异步窗口参与接纳计数。普通观察不产生执行 busy，但它对资源的使用必须在 Store 关闭前排空。

后台 Job 随原 handle 和执行许可独立保留原 Run binding，不能依赖启动它的 operation 仍活着。确认停止并完成 handle dispose 后，先释放执行许可，再释放 binding；binding disposer 可能等待该许可。停止或 dispose 未确认时保留这些资源，避免提前销毁仍被使用的绑定，也避免 ExtensionHost drain 与持有许可的 Job 相互等待。

窄宿主回调 `beforeResourceClose` 在本地任务、扩展及 Job 收束之后、Artifact/Store 关闭之前调用。Service 在回调中封住最后阶段的业务读取与取消接纳，再等待原 HTTP/文件操作资源使用结束。此前 draining 阶段仍允许准确取消和读取。该回调只在首次关闭接纳时固定；重复请求不能替换关闭依赖。

[Service](../../../../apps/service/README.md)提供 Native 专用 `/v1/lifecycle` 和 `/v1/lifecycle/shutdown`。独立 lifecycleVersion 和原 profile/instance 身份不依赖业务 API 兼容性或可用 Store；Native bearer、Host 和无 Origin 约束保持，Browser gateway 无此路由。202 只证明受理。成功关闭会结束 runner 自己的父管道读取，父管道仍打开时所属进程也能退出；父 EOF 与普通网络断开仍是不同事件。

未确认 Job 停止、dispose 或宿主排空失败保持 `drain_failed` 和原资源，不关闭诊断 HTTP、不释放 profile 锁、不宣称完成。当前不提供失败关闭的原地重试或恢复接纳。[独立 Client](../../../../packages/client/README.md)只查询固定原目标；关闭前核身份并只 POST 一次，丢回复或不可信回执为 unknown，只能查询原实例，不能自动改绑或重发。

## Alternatives considered

- 查询 idle 后普通 close：存在接纳竞态，无法实现 restart 的忙碌保留语义。
- 仅 HTTP closing 标志：不能覆盖已越过入口检查的异步 Store/配置准备，也不能约束直接 Runtime 使用者。
- 新建全局任务登记表并扫描 profile 取消：复制现有执行权事实，可能停止其他 Service 的工作，因此复用本地真实 owner 集合。
- 用一个预先创建的 hostDrain Promise：HTTP 数短暂为零后，draining 阶段仍可能接入新的读取或准确取消；已完成 Promise 无法保护后来资源，故使用最终资源阶段的窄回调。
- 无论清理结果都关闭 Store/listener：会让未确认资源失去监督且过早释放维护锁，不采用。
- 用业务 Client admission 管理生命周期：业务 major 不兼容或 Store 不可用时会阻断必要诊断，故保持独立有限生命周期协议。

## Consequences

关闭接纳、正在清理、失败保留和真正关闭是不同事实。资源清理失败时进程及锁可能继续存在；这比报告假成功更符合恢复与维护约束。仅支持状态查询和明确关闭，不由此建立正式 daemon 发现、启动/重启、Web 发布或三平台发行资格。

确定性交错测试覆盖首个异步接纳点、owner 获取、慢 dispose、未确认 Job、重复关闭、同 profile 两 Runtime 的交接及最后资源阶段。真实 HTTP 覆盖慢正文、已受理配置发布、慢只读 GET、数据诊断、错误原身份/Origin、实际 runner 退出和失败后维护 busy。源码树外完整 manifest 使用公共 SDK 关闭第二个真实配套进程，父管道保持打开，确认原 PID 退出且零新增 Provider；原父 EOF 路径仍保留。实际计数与限制记录在[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
