# App Server endpoint state

显式 App Server daemon 的 process state 位于 OS runtime root，而不位于 Durable Session Store。POSIX 使用 owner-only
`app-server.sock` 与 `app-server.lock`；Windows 使用 current-user named pipe。reservation 只包含 PID、OS process-start identity、
instance/build 诊断和可选 socket inode。它只能证明 endpoint owner，不能证明 Session writer、Store revision 或执行存活。

status/stop 在 absent 时不创建目录。启动前只有在 PID/start/socket identity 全部证明旧 owner 已死且 reservation 未漂移时才精确清理；
alive、uncertain、link/type/owner/inode drift 全部 fail closed。daemon 正常停止先关闭 admission、取消并 drain 自身持有的 execution，
再关闭连接并删除 exact endpoint evidence。

Kite profile home 和 `source-profiles/<digest>` 等 fixed private subtree 由
`@kite-ai/kite-local-runtime/service` 做逐段 non-link/owner-only 校验。它不再维护旧
`runtime-service/v1/{instance.json,token,instance.lock,lifecycle.lock}` 布局。

验证：`bun test packages/kite-local-runtime/test/isolated/lifecycle-reservation.test.ts tests/release/app-server-daemon.test.ts`。

排他 endpoint ownership 先于可变 Store/Host 初始化；starting 可通过 lifecycle v1 查询。资源释放完成后才清理 endpoint，防止并发启动提前取得同一地址。停止响应只表示已接受，release client 还需等进程退出；超时不升级为 PID 强杀。
