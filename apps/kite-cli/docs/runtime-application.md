# Runtime Application client boundary

本页是 `apps/kite-cli` 的owner-local current authority，描述terminal App与parent-owned App Server Runtime Application的边界。Host/Store composition见
[`apps/kite-service/docs/runtime-application.md`](../../kite-service/docs/runtime-application.md)。

## 当前组合

- CLI/TUI只消费release composition注入的managed Runtime connector。默认connector返回`KiteAppServerConnection`，CLI adapter暴露
  封闭Runtime、History、App Control、credential、status与snapshot generation；没有InProcess或legacy Service fallback。
- `src/service-mode/tui-client.ts` 是 presentation facade 的显式 Native implementation。Session create/resume/query/
  subscribe、approval、rewind/fork/compact/cancel等操作全部形成 Runtime Client command/query/subscribe，不取得
  `RuntimeHost`、`RuntimeServer`、Store、Builtin executor、legacy session manager或 raw event。
- rewind在applied intent receipt后等待commandId绑定的`rewind.terminal`；target Session、失败码与bounded file outcome
  均来自Service safe projection，CLI/TUI不从source ID、checkpoint或history display推断成功。
- raw Runtime event/history projection、Runtime Application、Workspace router、interaction broker、App Control owner、
  config/credential/MCP/sandbox/git/session logging与 checkpoint composition 已完整迁往 `apps/kite-service`；CLI 不保留
  backend副本或 app-to-app import。

## 两阶段 Trust 与 Runtime admission

App Server connection首先`prepareAppControl()`并初始化唯一exact stdio protocol，使Trust/App方法可用但不发Runtime mutation。CLI/TUI随后
查询Workspace Trust；显式trust decision带observed status与revision CAS，App owner重新canonicalize并返回完整identity。

只有trusted后client才调用Runtime command。unknown、declined、conflict、identity drift或连接失败均不发mutation，也不回退embedded或
legacy Service。

## 生命周期

client `close`/TUI facade `dispose`关闭自身stdio connection、subscription、snapshot observer、presentation resource和parent-owned child；
不会删除Session facts或隐式`cancelAll`。Ctrl+C通过exact Runtime cancel command作用于当前Turn。显式legacy Service stop/restart仍是独立
lifecycle command，并非默认Runtime lifecycle。

## 验证

`bun test apps/kite-cli/test/cli.test.ts apps/kite-cli/test/service-mode apps/kite-cli/test/isolated/tui-runtime-client-conformance.test.ts apps/kite-cli/test/tui-exit-coordinator.test.ts`、
`bun run --cwd apps/kite-cli typecheck`。
