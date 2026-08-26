# Kite Local Runtime Service

## 定位

`@kite-ai/kite-service` 是 repo-private 的本机 Service infrastructure owner。KLSV1-04 在这里实现
ports-injected lifecycle shell、Native loopback carrier、state/descriptor/token/lock composition 与 App-private
process manager；它尚未拥有默认 Store 的 concrete Runtime Application。

## 拥有职责

- 以 required ports 组合 Runtime Application lifecycle、Native state owner 与 listener；缺少任一基础设施时不得发布 ready。
- 只绑定 `127.0.0.1:0`，提供固定 Runtime WebSocket、History、exact App Control、credential 与 stop routes。
- 使用显式已验证的 `KiteHomeIdentity` 管理 restart-scoped descriptor/token/instance lock；manager 持有独立 lifecycle lock并串行 `ensure/status/stop/restart`。
- 构造 neutral cwd 与 allowlisted child env；不从请求 Workspace、cwd、`.env` 或 ambient `KITE_CODE_HOME` 推导 Service identity。
- 在普通 stop 上先 quiesce mutation admission；active operation 返回 `service_busy`，空闲时返回 `applied + draining`，随后由同一 shell关闭 carrier/application并最后清理 state。

## 不拥有职责

- KLSV1-04 不构造 Runtime Host、SQLite Store、Builtin Runtime、raw History projector、Workspace Trust repository、MCP Supervisor 或真实默认 Runtime backend；这些 surface 当前都通过 required fake/in-process ports 注入。
- 不导入 `apps/kite-cli`、Ink、React、TUI reducer或 CLI parser，不复制 CLI backend，也不提供 fallback。
- 不公开 `kite service *` 命令，不实现 KLSV1-05 connector/reconnect、KLSV1-06 default Store cutover、Web/Desktop、OS Service、public SDK、force stop或自动 updater。

## 允许依赖

只允许依赖 browser-safe `@kite-ai/kite-app-contract`、Native-only `@kite-ai/kite-local-runtime`、`@kite-ai/runtime-client`、`@kite-ai/runtime-contract`、`@kite-ai/runtime-protocol` 与 transport-neutral `@kite-ai/runtime-server`。禁止依赖 Host、Builtin、SQLite、CLI/TUI 或另一个 App source。

## 公开入口

package 根入口只服务仓库内部 composition/test，导出 shell/ports、carrier、Native infrastructure 与 App-private manager。`src/executable.ts` 是 internal foreground adapter，不是当前公开 CLI 命令；source/installed resolver同样只接受调用方显式绝对路径，不从 cwd 或 PATH 猜测。

## 关键不变量

- Runtime Application、state 与 transport ports 均必填；不存在 noop listener/state 或伪 ready。
- descriptor只在 injected application、listener与History/App ports ready后发布；startup/close fault保留 descriptor/token/lock evidence。
- access/control token独立且restart-scoped；ticket为32-byte base64url、hash-only内存保存、30秒TTL、一次性、instance/Workspace bound。
- wrong peer/Host/Origin/token/ticket、cookie、WebSocket subprotocol、binary/oversized/malformed frame与队列溢出 fail closed；diagnostic只携带固定code，不携带body、token、path或secret。
- manager仅在PID确认dead时quarantine/clear stale state；alive/uncertain均spawn=0，不kill PID。descriptor发布窗口还必须检查instance lock，不能把缺descriptor解释为可直接启动。
- control `applied + draining`不授权manager提前删除state；manager在lifecycle lock内等待Service自清，只有dead PID才执行exact stale cleanup。
- Windows state primitive在缺少current-user ACL/reparse verifier时明确`unsupported`；本地POSIX结果不是 KLSV1-07三平台支持证据。

## 本地文档

- [Native Runtime carrier](docs/runtime-server-carrier.md)
- [Service state 与锁](docs/service-state.md)
- [Service auth boundary](docs/service-auth.md)
- [Service lifecycle 与恢复](docs/service-resilience.md)

## 测试

`bun run --cwd apps/kite-service test`。当前测试使用injected fake Runtime/History/App Control application和隔离 Kite home；它证明KLSV1-04 infrastructure，不证明真实default Store composition、connector、三平台或release smoke。

## 文档影响

shell/manager/state/carrier变化更新本README及对应本地文档；跨包Runtime authority、Trust、History、恢复或测试归属变化同步更新`docs/active/`与`tests/README.md`。stage/commit前必须运行文档影响门禁。
