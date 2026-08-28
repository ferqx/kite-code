# KLSV1-05 fake process harness

`src/process-harness/`是未公开的integration fixture，不是production Service composition。parent使用隔离
`KiteHomeIdentity`、neutral env、detached child与fd3 readiness；child在真实Native state/carrier/shell后注入fake
Runtime/History/App Control/credential application。

KLSV1-06 已由 `src/executable.ts` + `src/composition.ts` 建立唯一production Host/Store/Builtin owner；本fixture保留为
detached-process/transport fault harness，不是default entry，也不能用fake Session持久性替代Service composition evidence。

fixture不导入`apps/kite-cli`、Host、Store、Builtin或SQLite，不打开default Store，不进入package根出口，也不注册
`kite service *`。fault vocabulary只包含startup delay/failure与credential lost-response，不能成为generic daemon配置。

真实process tests覆盖ensure/status/stop/restart、authenticated instance handshake、instance变化、Runtime WebSocket command/query、完整History client、
exact App Control、client disconnect后的Session继续、credential response unavailable后query确认、stdout purity与startup
timeout。所有state位于测试临时home；本地POSIX结果不构成Windows或release evidence。

验证：`bun test --no-orphans apps/kite-service/test/isolated/process-harness/process-harness.test.ts`。
