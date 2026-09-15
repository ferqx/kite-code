# 请求关联、订阅与历史

入口：[client](../src/client.ts)、[store](../src/store.ts)。Runtime Client 面向 framework-neutral transport，不直接依赖 Server concrete type、Host 或 SQLite。

发送请求时维护 wire correlation，解码回执后返回 typed result。业务 commandId/revision 由上层语义保留；连接重建不能自动重发可能产生副作用的 mutation。错误应返回调用者，不把 timeout 转成默认成功。

通知更新客户端投影与订阅。event-free snapshot 可以修正活动/交互状态，但不伪造批准、取消或完成事件。历史读取通过独立注入的 HistoryClient 获取完整 durable transcript；短期 replay window 不能代替它。

客户端缓存只服务读取与展示，业务 State 仍由服务端决定。UI 本地 pending feedback 与 accepted receipt、durable event 的合并由相应客户端实现处理，不由本包猜测消息文本 identity。

交接见[会话历史链路](../../../docs/development/flows/session-history.md)。验证：[client](../test/runtime-client.test.ts)、[store](../test/store.test.ts)。

协议 History 的 `loadSession` 通过同一连接分页读取，首次返回的 source sequence 固定本次读取上界；校验 Session、序号顺序与游标前进后才合并为完整 transcript。分页只重组只读展示记录，不重放命令；断线或页身份错误会使本次加载失败。传入 `throughSequence` 可读取该已观察上界内的完整历史。

`loadSession(sessionId, throughSequence?, { signal }?)` 的第三个参数可取消调用方的分页读取。protocol adapter 在每次请求前和响应后检查 AbortSignal；取消后丢弃在途响应且不再发出下一页。已经发送到服务的单页读取仍可能完成，不新增远端取消方法、不改变协议 DTO 或命令重放语义。原有两个参数调用保持兼容；注入的自定义 history adapter 按自身实现处理该可选参数。

`recoverSessionIfSafe` 仅供用户继续时处理明确的恢复拒绝：先读摘要，安全时提交独立恢复命令；不自动重跑任务或未知副作用。恢复丢回执和客户端命令结果未知时，`readCommandReceipt` 查询原命令身份，查不到则保留未知。原始发送重试只发生在服务明确拒绝且安全恢复成功之后，使用同一命令身份。
