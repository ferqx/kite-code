# Runtime Application client boundary

本页是 `apps/kite-cli` 的 owner-local current authority，描述 KLSV1-06 clean cutover 后 terminal App 与
Service-owned Runtime Application 的边界。Service 的唯一 Host/Store composition见
[`apps/kite-service/docs/runtime-application.md`](../../kite-service/docs/runtime-application.md)。

## 当前组合

- CLI/TUI 只消费 release composition 注入的 managed connector。connector返回 `LocalKiteConnection`，CLI adapter再
  暴露封闭 Runtime、History、App Control、credential、status与snapshot generation；没有 InProcess application。
- `src/service-mode/tui-client.ts` 是 presentation facade 的显式 Native implementation。Session create/resume/query/
  subscribe、approval、rewind/fork/compact/cancel等操作全部形成 Runtime Client command/query/subscribe，不取得
  `RuntimeHost`、`RuntimeServer`、Store、Builtin executor、SessionManager或 raw event。
- rewind在applied intent receipt后等待commandId绑定的`rewind.terminal`；target Session、失败码与bounded file outcome
  均来自Service safe projection，CLI/TUI不从source ID、checkpoint或history display推断成功。
- raw Runtime event/history projection、Runtime Application、Workspace router、interaction broker、App Control owner、
  config/credential/MCP/sandbox/git/session logging与 checkpoint composition 已完整迁往 `apps/kite-service`；CLI 不保留
  backend副本或 app-to-app import。

## 两阶段 Trust 与 Runtime admission

Native connection首先 `prepareAppControl()`：manager ensure与state discovery只准备authenticated exact HTTP client，
不会打开 Runtime WebSocket。CLI/TUI随后查询 Workspace Trust；显式 trust decision带 observed status与revision CAS，
Service重新 canonicalize 并返回完整 identity。

只有 trusted 后 client才调用 `connect()`。Service再对请求 Workspace执行 connection admission，签发instance/Workspace
bound one-shot ticket，并在 Runtime initialize把 persisted/canonical Workspace 与 connection admission交叉校验。
unknown、declined、conflict、identity drift或连接失败均不发 Runtime command，也不回退 embedded。

## 生命周期

client `close`/TUI facade `dispose`只关闭自身 WebSocket、subscription、snapshot observer与presentation resource；不会
调用 Service Runtime Application `cancelAll`、drain或dispose。Ctrl+C通过 exact Runtime cancel command作用于当前Turn。
Service stop/restart是独立 lifecycle command；`service_busy`、`outcome_unknown`与identity uncertainty按 manager contract
fail closed。

## 验证

`bun test apps/kite-cli/test/cli.test.ts apps/kite-cli/test/service-mode apps/kite-cli/test/isolated/tui-runtime-client-conformance.test.ts apps/kite-cli/test/tui-exit-coordinator.test.ts`、
`bun run --cwd apps/kite-cli typecheck`。
