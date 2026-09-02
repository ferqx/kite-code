# Runtime carrier client boundary

本页定义`apps/kite-cli`对Runtime carrier的owner-local边界。parent-owned stdio是默认terminal transport；显式daemon socket/pipe与
development reference由`apps/kite-service`拥有，CLI只拥有client/presentation adapter。

## Production App Server path

- release/source composition把managed App Server connector注入CLI/TUI；terminal package不读取
  descriptor、access/control token、lock或 executable path，也不自行发送 raw HTTP/WebSocket frame。
- stdio connection先initialize exact build/capability并准备App Control；完成Workspace Trust query/decision后才发Runtime mutation。连接失败、
  build/capability drift或不可信Workspace都fail closed，不回退InProcess、legacy Native或direct Host。
- complete History、exact App Control与Runtime command/query/subscribe都走同一Runtime Client Protocol connection；CLI reducer只接收
  client-safe projection。
- terminal exit关闭自身logical connection与child，但不会删除durable facts；新TUI可从同一profile恢复History。

## Daemon lifecycle commands

`kite server start/status/stop`只调用release composition注入的daemon control。CLI不拥有PID probe、spawn或dead cleanup。
`--kite-home`只由release composition验证并选择profile；`--server`只选择显式endpoint。旧`kite service *`不再注册。

## Stdio 与 development reference

`kite server --stdio`不是CLI public入口，parser命中后会明确拒绝。默认stdio只由release resolver以exact
`kite-service app-server run-stdio`启动，路径/profile/build/env均由composition提供；EOF或signal drain child，Session facts继续持久化。

development loopback/WebSocket reference也已迁往Service owner，仅用于transport qualification；它不是production
listener。不存在 `kite server --web`，ADR-0053 Web No-Go保持有效。

## 验证

CLI boundary：`bun test apps/kite-cli/test/cli.test.ts apps/kite-cli/test/package-exports.test.ts`。carrier owner验证见
`apps/kite-service/docs/runtime-server-carrier.md`。
