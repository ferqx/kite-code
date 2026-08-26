# Opt-in Local Service mode

本页是`apps/kite-cli/src/service-mode/`的owner-local current authority。KLSV1-05 adapter只把已经authenticated的
`LocalKiteConnection`投影为typed Runtime、History、App Control、Native credential与`RuntimeSnapshotStore`。

adapter不读取descriptor/access/control token文件，不discover/spawn Service，不导入`apps/kite-service`，不创建
Host/Store/SQLite/Builtin或SessionManager proxy。connect失败原样reject，不silent fallback到embedded；普通CLI/TUI
bootstrap在KLSV1-06前仍使用现有InProcess owner。

reconnect由Native connection显式触发。`RuntimeClient`generation变化原子清除旧Session readiness、index与ephemeral
stream，再由replacement subscription/index reset重建，允许当前revision低于旧内存值。adapter不缓存第二份state。
close只关闭该client connection/subscription/snapshot observer，不发送Runtime cancel/close-session，也不dispose Service
Host；Session/Turn/interaction是否继续由Service Runtime authority决定。

验证：`bun test apps/kite-cli/test/service-mode/adapter.test.ts`。当前没有public CLI flag、default cutover或PTY release
claim；真实child journey由Service process harness覆盖。
