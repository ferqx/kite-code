# 请求关联、订阅与历史

入口：[client](../src/client.ts)、[store](../src/store.ts)。Runtime Client 面向 framework-neutral transport，不直接依赖 Server concrete type、Host 或 SQLite。

发送请求时维护 wire correlation，解码回执后返回 typed result。业务 commandId/revision 由上层语义保留；连接重建不能自动重发可能产生副作用的 mutation。错误应返回调用者，不把 timeout 转成默认成功。

通知更新客户端投影与订阅。event-free snapshot 可以修正活动/交互状态，但不伪造批准、取消或完成事件。历史读取通过独立注入的 HistoryClient 获取完整 durable transcript；短期 replay window 不能代替它。

客户端缓存只服务读取与展示，业务 State 仍由服务端决定。UI 本地 pending feedback 与 accepted receipt、durable event 的合并由相应客户端实现处理，不由本包猜测消息文本 identity。

交接见[会话历史链路](../../../docs/development/flows/session-history.md)。验证：[client](../test/runtime-client.test.ts)、[store](../test/store.test.ts)。

协议 History 的 `loadSession` 通过同一连接分页读取，首次返回的 source sequence 固定本次读取上界；校验 Session、序号顺序与游标前进后才合并为完整 transcript。分页只重组只读展示记录，不重放命令；断线或页身份错误会使本次加载失败。传入 `throughSequence` 可读取该已观察上界内的完整历史。
