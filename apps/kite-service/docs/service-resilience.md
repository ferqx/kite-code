# App Server lifecycle 与恢复

默认 TUI/CLI 各自拥有一个 paired stdio App Server。parent EOF、退出或 signal 只关闭该进程与它持有的 transport/execution；
Session facts 留在 `kite-session.sqlite`。新进程 resume 前必须按 durable generation、lease、cleanup 与 effect outcome 完成接管，
不能从旧 PID 是否存在推断执行结果。

显式 daemon 由 `kite server start/status/stop` 管理。start 只创建当前 profile 的 owner-only endpoint；status/stop 不隐式 spawn。
普通 client 或 Browser 断开不停止 daemon。stop 关闭 Web admission，取消 daemon 持有的 active Turn，完成 bounded drain 后清理 exact
endpoint。protocol/capability mismatch、identity uncertain 或 stale evidence 都不会触发 replacement。

candidate install/upgrade/rollback 只写 immutable release 与 active pointer。它不探测或停止运行中的 App Server；现存 daemon 继续运行
自己的 immutable executable，下一次 paired App Server/daemon start 才使用新的 active candidate。uninstall 只删除经过完整 manifest
校验的 managed install tree，也不向运行中进程发送旧 lifecycle 命令。

旧 single-Service ensure/status/stop/restart、readiness fd、previous-build stop、global Service reservation 与 process harness 已删除。

验证：`bun test tests/release/app-server-daemon.test.ts tests/release/oss-install.test.ts`、
`bun run release:build && bun run release:verify && bun run release:smoke`。
