# 请求关联、订阅与历史

入口：[client](../src/client.ts)、[store](../src/store.ts)。Runtime Client 面向 framework-neutral transport，不直接依赖 Server concrete type、Host 或 SQLite。

发送请求时维护 wire correlation，解码回执后返回 typed result。业务 commandId/revision 由上层语义保留；连接重建不能自动重发可能产生副作用的 mutation。错误应返回调用者，不把 timeout 转成默认成功。

单次请求的默认期限为 30 秒，可通过 `requestTimeoutMs` 调整。App 调用可通过 `requestApp` 的单请求 `timeoutMs` 指定正整数期限，不改变其他请求的默认值。期限覆盖建连、transport `send()` 和等待响应；到期后删除本地 correlation，迟到响应被忽略。`request_timeout` 只说明客户端未拿到结果，尤其对 mutation 应保留结果未知状态，并通过原 command ID 查询回执；不能据此生成新命令或自动重放。订阅恢复中的取消旧订阅请求也受同一期限约束，旧请求超时后继续尝试建立替代订阅。
`subscribeReady` 和 `subscribeReadyWithGeneration` 在收到订阅回执后仍等待初始 ready 边界；该等待同样使用配置的期限。ready 一直不到时关闭对应 logical connection，让服务端释放远端订阅，并向调用方返回超时错误。
订阅请求已经发出、远端 ID 尚未返回时若调用方取消，本地立即结束该订阅的等待，并以原订阅请求 ID 调用 `runtime/unsubscribe`。服务端负责清理待建立或已建立的订阅，取消不依赖原订阅回执；已取得远端 ID 时仍按该 ID 取消。取消接口失败或超时才关闭 logical connection，作为无法核实远端资源时的异常清理边界。旧连接的迟到回执不能作用于替代连接。

通知更新客户端投影与订阅。event-free snapshot 可以修正活动/交互状态，但不伪造批准、取消或完成事件。历史读取通过独立注入的 HistoryClient 获取完整 durable transcript；短期 replay window 不能代替它。

Durable notification 的 `occurredAt` 原样进入 accepted presentation envelope，History record 的同名字段保持在完整 transcript 中；二者都指向各自持久事件的发生时间。客户端只透传，不用本地接收或重放时间填补缺失，也不把 Run 时间解释为 Turn 时间。

客户端缓存只服务读取与展示，业务 State 仍由服务端决定。最后一个会话／子会话订阅结束时，Store 回收该会话投影、临时流、后台执行快照与终止 Run 过滤记录；同会话多个订阅读取期间继续共享。后台列表与详情查询始终向调用方返回 Service DTO；只有发起与收到结果时同一读取订阅仍存在，才把结果写入展示快照，避免离开后迟到响应或重进同一会话的旧响应恢复过期状态。UI 本地 pending feedback 与 accepted receipt、durable event 的合并由相应客户端实现处理，不由本包猜测消息文本 identity。

后台停止必须使用同一个list/detail投影中的`sessionRevision`作为Session CAS，并保留该item的
`ownerGeneration + revision`作为原生执行fence；item `revision`同时表示执行状态水位。Store合并detail时保留完整列表及其
`aggregateGeneration`，但允许权威detail用新的item owner generation替换同ID旧实例，不能因组合generation与item
generation天然不同而丢弃刷新。
缺省 `query({type: 'list_background_executions'})` 会逐页读取按执行ID排序的完整目录，在同一
`aggregateGeneration`、`watermark`、`sessionRevision` 下合并，再向调用者返回并更新Store；显式给出
`cursor`或`limit`则只读单页且不以该页替换Store。页间版本变化时短暂异步让出并从第一页重试，
持续变化超过配置的请求期限返回`request_timeout`，不展示不完整快照。`query`的可选`AbortSignal`
可停止后续分页与在途请求；每帧仍受Protocol容量校验，已结束执行的历史总数不受单帧容量限制。

交接见[会话历史链路](../../../docs/development/flows/session-history.md)。验证：[client](../test/runtime-client.test.ts)、[store](../test/store.test.ts)。

协议 History 的 `loadSession` 通过同一连接分页读取，首次返回的 source sequence 固定本次读取上界；校验 Session、序号顺序与游标前进后才合并为完整 transcript。后续页携带首次响应的内容 digest；同一水位的历史在分页之间被改写或缓存淘汰后重建为不同内容时，客户端丢弃已收页面，从第一页最多重试一次。再次变化则返回错误，不展示混合历史。分页只重组只读展示记录，不重放命令；断线或页身份错误会使本次加载失败。传入 `throughSequence` 可读取该已观察上界内的完整历史。

Store11 App Server 可选提供 `loadChildSession(parentSessionId, childSessionId, throughSequence?, { signal }?)`。客户端逐页核验子 Session ID 和固定 source sequence；父子血缘由服务端每页核对。普通 `loadSession(childSessionId)` 继续拒绝，知道子 ID 不取得子 History 的读取权。未组合该能力的 RuntimeHistoryClient 不提供此方法。

`subscribeChildReadyWithGeneration` 使用父、子 ID 的专用 wire 选择器，等待初始 ready 后返回与普通会话相同的安全通知及连接代际。Desktop 先读子 History，再从该 source sequence 订阅并按消息 identity 投影后续事件；重连或离开详情时取消旧订阅并重读历史。子 Session 可能在订阅前已开始发送短暂流事件，允许首个观察到的子流帧以其真实 sequence 建立本地游标；父 Session 只对初始 ready 时已运行的 Run 放宽这一首帧规则。后续帧仍必须连续，缺帧时照常重新同步。此入口不把子 Session ID 转成普通顶层会话授权。

`loadSession(sessionId, throughSequence?, { signal }?)` 的第三个参数可取消调用方的分页读取。protocol adapter 在每次请求前和响应后检查 AbortSignal；取消后丢弃在途响应且不再发出下一页。服务端在初始化时宣告 `history/cancel` 能力且单页请求已经发出时，客户端在调用方取消或响应超时后向同一连接发送携带原 RPC id 的取消通知；旧服务端未宣告此能力时，已发出的读取仍可能完成。原有两个参数调用保持兼容；注入的自定义 history adapter 按自身实现处理该可选参数。

同一 RuntimeClient 最多同时执行 4 个完整的协议 History 分页加载，其余调用按序等待，不设累计等待项、记录数或编码字节额度。等待入场受配置的请求期限约束；执行后每页分别使用这一响应期限，完整历史总耗时可超过单页期限。调用方取消会移除等待项或中断在途页，不再发送后续页。服务端明确返回 `overloaded` 时，仅完整 History 的当前只读页在该页期限内短暂异步等待并原样重发，已固定的 source sequence、cursor 与 digest 不变；其他错误和写命令不走此重试。断线、重连与关闭会取消旧队列及在途加载。客户端仍须按接口返回完整 transcript 的 records 与 events，单份历史的实际内存占用随内容增长；限制同时组装的份数只降低并发峰值。服务端若返回 `history_too_large` detailCode，仍映射为同名客户端错误。

`recoverSessionIfSafe` 仅供用户继续时处理明确的恢复拒绝：先读摘要，安全时提交独立恢复命令；不自动重跑任务或未知副作用。恢复丢回执和客户端命令结果未知时，`readCommandReceipt` 查询原命令身份，查不到则保留未知。原始发送重试只发生在服务明确拒绝且安全恢复成功之后，使用同一命令身份。
