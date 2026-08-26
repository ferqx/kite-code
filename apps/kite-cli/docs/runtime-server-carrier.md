# Runtime Server carrier

本页是 `apps/kite-cli` 的 owner-local current authority，描述 App 对 Runtime Server 的 composition、stdio 与 development loopback carrier 边界。

## Composition 与支持边界

- `src/bootstrap.ts` 是唯一 concrete composition root。它组装一个 Host、SQLite Store、Runtime Server 和 Client；carrier 只把已经 framed 的 logical message 交给该 Server，绝不创建第二个 Host、Kernel、Store、reducer 或 writer。
- Server 的唯一 execution backend 是 injected `RuntimeAccess`；backend 提供 default admission，App 也可通过
  `RuntimeServer.open(connection, { admission })` 或 InProcess `hub.open({ admission })` 为每个 logical connection
  绑定独立 admission。carrier、request body 和 `clientInfo` 都不能提升 Workspace authority。
- connection admission只为 create 注入 canonical trusted Workspace；wire path不可信。resume/query/subscribe/fork
  使用唯一 Store中的持久 Session identity，并与 connection admitted Workspace交叉校验；process-wide list query
  仍由持久 Store owner回答。connection close清除 admission、subscription和interaction client binding，不终止
  Session、Turn、Host或Store；显式 owner drain/shutdown才关闭 composition。
- production TUI 与 foreground CLI 通过 `RuntimeClient → RuntimeServer → RuntimeAccess` 访问 Runtime。InProcess pair 是 App 内同一 Protocol 的 transport，不是 direct Host/SQLite fallback。
- durable complete history 不属于 Server 或 carrier：它始终经 `RuntimeClient.history → App exhaustive history
  projection → RuntimeLogQueryPort` 分页取得，并以与 live 相同的 closed `RuntimeClientEvent` 进入 TUI reducer。
  notification replay 只用于短断线恢复。

## `kite server --stdio`

`kite server --stdio --thread <id> --workspace <path>` 是 parent-owned Desktop/test child carrier，不是 daemon、sidecar 或通用公共 listener。parent 必须拥有 child 生命周期和指定 thread/workspace admission。

- stdin/stdout 使用一行一个完整 JSON 值的 UTF-8 JSONL；Protocol 在 stdout 独占，carrier 不写 banner、日志或其他文本。
- stderr 只输出固定、无内容的诊断。Protocol response/notification 永不写入 stderr。
- EOF 只结束该 stdio logical connection，不释放 Host/composition。parent-owned `SIGINT`/`SIGTERM` 或显式 owner shutdown 会让 Server drain、等待 stdout flush，再释放 composition。
- 非 UTF-8、超行、无效 JSON 或 stdout failure 均 fail closed；CRLF 仅是 framing。Server core 不导入 Bun/Node stream 或 signal type。

## Development-only loopback/reference

- loopback carrier 仅绑定 `127.0.0.1:0`，使用一次性 bootstrap bearer 换取受限 cookie；WebSocket 只接受 exact loopback Host/Origin、正确 upgrade 与 cookie，拒绝 binary、超限和非本地来源。
- 它提供 WebSocket/client reference conformance 与 development qualification，不是 production listener。reference 不进入 production support。
- 不存在 `kite server --web`。ADR-0053 的 Web No-Go 仍有效；在新的 ADR 取代它之前，不得把 Web、Desktop reference 或 loopback 说成 production-supported。

## 验证

本地覆盖入口：`apps/kite-cli/test/isolated/runtime-stdio-carrier.test.ts`、`apps/kite-cli/test/isolated/runtime-stdio-child.test.ts`、`apps/kite-cli/test/isolated/development-loopback-carrier.test.ts`、`apps/kite-cli/test/isolated/development-runtime-reference.test.ts`、`apps/kite-cli/test/isolated/runtime-transport-conformance.test.ts`。

运行：`bun test apps/kite-cli/test/isolated/runtime-stdio-carrier.test.ts apps/kite-cli/test/isolated/runtime-stdio-child.test.ts apps/kite-cli/test/isolated/development-loopback-carrier.test.ts apps/kite-cli/test/isolated/development-runtime-reference.test.ts apps/kite-cli/test/isolated/runtime-transport-conformance.test.ts`。
