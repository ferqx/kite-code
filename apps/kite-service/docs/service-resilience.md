# Service lifecycle 与恢复

本页描述KLSV1-06 managed Service shell与由 `@kite-ai/kite-local-runtime/manager` 组合的lifecycle。Runtime/History/App
Control application现为Service唯一concrete default Store composition；KLSV1-05 fake process harness仍只是fixture。

启动顺序固定为state prepare（instance lock与两个token）→ concrete Runtime Application start → carrier start →
descriptor publish → readiness fd。Service以neutral cwd/allowlisted env启动，Workspace config只在Trust/admission后lazy
解析。任一步失败都不伪ready；late start进入同一close barrier，startup/close fault保留state evidence。

普通stop先quiesce mutation gate。active operation返回`service_busy`并resume；空闲时commit drain，control caller先收到
`applied + draining`，同一shell再关闭carrier/application并最后清理state。signal是owner shutdown：停止transport、
recovery-safe `cancelAll`、drain/dispose。TUI/CLI connection close不是owner shutdown。

manager在process serial queue与cross-process lifecycle lock下执行。concurrent ensure只允许一个spawn；source/installed
executable来自显式absolute resolver，environment与Kite home不从cwd/Workspace推导。probe先验证PID/state、`/readyz`，
再authenticated `POST /_kite/instance`取得process-owned identity；descriptor、lock、Protocol、client-contract、instance与
PID必须exact，server/build fields还必须与descriptor一致；expected build drift返回
`incompatible + build_mismatch`，不进入healthy路径。

alive/uncertain PID、malformed state、handshake mismatch、unknown stop outcome均fail closed且不spawn/cleanup/retry。
restart只在Service正常清除descriptor/token/instance lock后执行一次ensure；只有PID确认dead才可exact quarantine/cleanup，
从不kill未知或alive PID。`applied + draining`不授权manager提前删state。

companion candidate将`kite`、`kite-tui`、`kite-service`作为同一manifest/install/current launcher集合；installed resolver
只认terminal executable相邻companion。candidate layout/preflight是本地packaging evidence，不代表三平台runtime、
fault/soak、全部PTY或Windows state qualification已完成。

验证：`bun run --cwd apps/kite-service test`、`bun test packages/kite-local-runtime/test/manager`、
`bun run --cwd apps/kite-service typecheck`。当前Windows ACL/reparse与KLSV1-07平台/release evidence保持pending。
