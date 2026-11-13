# Trace Extension SDK

本包定义受限 Trace 消费者的公共 TypeScript 接口、注册函数和本地 IIFE 打包器。事件及授予视图复用 [`@kite-ai/trajectory`](../trajectory/README.md)；扩展无需导入 Agent、Store、Service 或 OTel。公共接口没有写业务事实、任意状态、CAS 或 Outbox 事务能力。

`defineTraceExtension` 注册可选 initialize／flush／shutdown 及必需 `onEvents(batch, context)`。initialize 只收到安装身份和受限能力；每次 onEvents 的 context 带 source、taskId 与该批 Evidence 入口。SDK 将返回的明确 `acknowledgedEventIds`／有限 rejected 绑定原 batch／lease／generation／epoch，拒绝未投递、重复或 ACK/reject 重叠的 ID。Host 仍独立验证整个响应、当前 grant 和投递租约，再持久推进连续 ACK；后项 ACK 不能跳过前项未确认事件。

ACK 表示扩展接受处理责任，不能证明外部系统最终持久保存。未 ACK、ACK 丢失、崩溃和重启会重投；扩展应以 taskId 加 eventId 实现处理幂等。同一事件可能同时经 live 和用户另行请求的 history task 交付，不能用跨任务去重吞掉另一个明确目的地。通用 SDK 不托管扩展状态。官方 OTel 参考适配器有独立私有持久化，不能作为任意第三方扩展的存储能力。

context 只提供自身 settings、获准历史请求、当前批的 Evidence open/read/close、受限 HTTP 和三种安全日志 code。scope／材料使用 opaque refs，只能关联，不能反查数据库。Evidence open 由 SDK 绑定当前 batchId；分块每次复核授权，关闭或撤销使 reader 失效。HTTP 使用获准 Origin 和用途 credentialHandle，正文为 base64；扩展不得取得凭据明文，状态分别为 complete、未派发 unavailable 和已派发结果未知 unconfirmed。默认 metadata 不包含正文、路径、自由错误或原始身份，额外 Evidence／网络必须独立授权。

本地模板见 [metadata.ts](examples/metadata.ts)和 [manifest](examples/metadata.manifest.json)。在仓库根运行：

```sh
node --import ./scripts/tooling/register.mjs packages/trace-extension-sdk/scripts/pack.ts packages/trace-extension-sdk/examples/metadata.ts packages/trace-extension-sdk/examples/metadata.manifest.json /tmp/kite-metadata-extension.json
```

输出包含原 manifest 和 `{apiVersion,source,sha256}` 单脚本 bundle；同名输出存在时拒绝覆盖。`@kite-ai/trace-extension-sdk/bundle` 是源码 checkout 的构建入口；Terminal 和桌面运行包只携带扩展运行时契约。Host 校验 manifest、API 和完整 hash 后安装；安装默认关闭，配置和授权后才能开启 live，首次 enable 只消费其固定起点后的事实，更早历史须单独请求。disable 保留未交付事实，更新和减权退休旧 engine，新权限不继承；uninstall 终止消费义务，重装有新安装身份。扩展脚本在独立进程的无默认 I/O engine 中执行，不是 Node／Bun 插件；不支持外部 import、native addon、宿主 fetch 或任意文件访问。

workspace 的 `build` 对公共接口和构建叶子保留外部依赖，由发行闭包复制声明的 workspace／第三方依赖及 notices。上面的第三方扩展打包器另行生成可交给 Host 的完整 IIFE 单脚本；workspace 构建产物不直接充当 guest 脚本。manifest 保持 API 1，声明的是可请求能力，实际使用仍须安装后独立 grant。

[SDK 测试](test/sdk.test.ts)实际构建单脚本并核原租约 ACK 和受限 bridge；正式隔离、安装、grant、可靠投递及本机可用性由 [Service Trace owner](../../apps/service/src/trace-extensions/engine/README.md)负责。源码包和本机测试不代表已发布 SDK、扩展市场或其他平台安装资格。
