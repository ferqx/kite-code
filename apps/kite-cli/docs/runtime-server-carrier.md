# Runtime carrier client boundary

本页定义 KLSV1-06 clean cutover 后 `apps/kite-cli` 对 Runtime carrier 的 owner-local边界。Native listener、development
reference与 parent-owned stdio implementation 都由 `apps/kite-service` 拥有；CLI 只拥有 client/presentation adapter。

## Production Native path

- release/source composition把 managed `kite-local-runtime/client` connector注入 CLI/TUI；terminal package不读取
  descriptor、access/control token、lock或 executable path，也不自行发送 raw HTTP/WebSocket frame。
- Native connection先准备 authenticated App Control surface，完成 Service-owned Workspace Trust query/decision后，
  才向 `/_kite/connect` 申请一次性 Workspace-bound ticket并打开 `/rpc`。连接失败、instance drift或不可信Workspace
  都 fail closed，不回退 InProcess、stdio或 direct Host。
- complete History 与 exact App Control继续走固定 HTTP route；Runtime command/query/subscribe走 Runtime Client Protocol。
  CLI reducer只接收 client-safe projection。
- terminal exit只关闭自身 logical connection；不会 drain Server、dispose Host/Store或停止 companion Service。

## Service lifecycle commands

`kite service ensure/status/stop/restart` 是已注册的 terminal surface，但实现只调用 release composition注入的
`KiteServiceManager`窄port。CLI 不拥有 PID probe、instance handshake、control token、spawn、stale cleanup或state lock。
`--kite-home` 只由 release composition验证并选择显式 managed Service home，不能由 Workspace/cwd猜测。

## Stdio 与 development reference

`kite server --stdio` 不再是 CLI production入口，parser命中后会明确报告 Service-owned internal entrypoint。现有
Service stdio只由 parent-owned test/internal harness直接组合，要求显式 isolated Workspace admission与显式非默认
`--checkpoints` path；EOF只关闭该 logical connection，owner signal/shutdown才drain并释放composition。

development loopback/WebSocket reference也已迁往Service owner，仅用于transport qualification；它不是production
listener。不存在 `kite server --web`，ADR-0053 Web No-Go保持有效。

## 验证

CLI boundary：`bun test apps/kite-cli/test/cli.test.ts apps/kite-cli/test/package-exports.test.ts`。carrier owner验证见
`apps/kite-service/docs/runtime-server-carrier.md`。
