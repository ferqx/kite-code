# Service lifecycle 与恢复

本页描述KLSV1-06 managed Service shell与由 `@kite-ai/kite-local-runtime/manager` 组合的lifecycle。Runtime/History/App
Control application现为Service唯一concrete default Store composition；KLSV1-05 fake process harness仍只是fixture。

启动顺序固定为state prepare（instance lock与两个token）→ concrete Runtime Application start → carrier start →
descriptor publish → readiness fd。Service以neutral cwd/allowlisted env启动，Workspace config只在Trust/admission后lazy
解析。任一步失败都不伪ready；late start进入同一close barrier，startup/close fault保留state evidence。

普通stop先quiesce mutation gate。active operation返回`service_busy`并resume；空闲时commit drain，control caller先收到
`applied + draining`，同一shell再关闭carrier/application并最后清理state。quiesce在线性化关闭新mutation admission后
立即返回是否观察到active operation，不等待active work才报告`service_busy`；只有已选择commit drain或signal shutdown
才等待idle。carrier关闭listener时先给active HTTP response一个有界刷出窗口，超时才force close；因此control ack
不依赖单个event-loop turn，但整体退出仍受drain
deadline约束。signal是owner shutdown：停止transport、
recovery-safe `cancelAll`、drain/dispose。TUI/CLI connection close不是owner shutdown。

manager在process serial queue与cross-process lifecycle lock下执行。concurrent ensure只允许一个spawn；source/installed
executable来自显式absolute resolver，environment与Kite home不从cwd/Workspace推导。probe先验证PID/state、`/readyz`，
再authenticated `POST /_kite/instance`取得process-owned identity；descriptor、lock、Protocol、client-contract、instance与
PID必须exact，server/build fields还必须与descriptor一致；expected build drift返回
`incompatible + build_mismatch`，不进入healthy路径。

alive/uncertain PID、malformed state、handshake mismatch、unknown stop outcome均fail closed且不spawn/cleanup/retry。
restart只在Service正常清除descriptor/token/instance lock后执行一次ensure；只有PID确认dead才可exact quarantine/cleanup，
从不kill未知或alive PID。`applied + draining`不授权manager提前删state。

companion candidate将`kite`、`kite-tui`、`kite-service`、`kite-coordinator`、`kite-worker`与`kite-web-gateway`作为同一
manifest/install/current launcher集合，并携带 `payload/web` 静态资产；v2 managed-install marker与唯一`active` regular-file
pointer绑定immutable candidate root。stable launcher把启动时candidate root pin给child process；running process不重新读取
pointer。首次安装才atomic-copy stable launcher，upgrade/rollback只验证既有launcher identity，不逐文件替换或停止仍在运行的
旧candidate。Windows installed resolver还要求marker、pointer、`.candidate-id`与candidate `manifest.json` identity exact，并
对launcher、candidate root、runner manifest与runtime执行no-follow/non-reparse/regular-file检查；失败时不回退source、cwd、PATH或
ambient home。
当前 candidate manifest 的 releaseSlots 已绑定 CLI、TUI、Service、Coordinator、Worker、Gateway 与 Web entrypoint/identity；
这些 slots 和本地 asset smoke 不等于三平台 process/runtime qualification。Windows ACL/write-through 与三平台 candidate/process
qualification 仍待真实 hosted 证据；candidate layout/preflight与本地packaging evidence不代表三平台runtime、fault/soak或全部
PTY已完成。

验证：`bun run --cwd apps/kite-service test`、`bun test packages/kite-local-runtime/test/manager`、
`bun run --cwd apps/kite-service typecheck`。当前 Windows runner no-follow/candidate-pin 只登记本地定向测试；Windows
ACL/write-through 与 KLSV1-07 当前实现 head 的三平台 process/release evidence 在对应远端 matrix 全部成功前保持 pending。
