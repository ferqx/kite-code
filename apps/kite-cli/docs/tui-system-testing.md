# TUI 系统测试规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖真实 PTY journey、harness、smoke 与资源清理。

## 套件边界

- `bun run test:tui:harness` 运行 deterministic harness 单元测试。
- `bun run test:tui:system` 按文件启动隔离 PTY scenario；CI 使用 `KITE_TUI_SYSTEM_SHARD=index/count` 分片。
- `bun run test:tui:smoke:native` 只运行显式 native sandbox smoke。
- 默认 `bun run test` 不执行真实 PTY scenario、native smoke、spike 或 live Provider。
- source PTY child从repo-owned `scripts/release/entrypoints/tui.ts`进入同一managed Service composition，不再直入
  `apps/kite-cli/src/tui/executable.tsx`绕过release/default manager wiring；installed smoke仍使用standalone executable。

## Runtime client boundary

- TUI system journey 使用 production-shaped typed projection：terminal Native facade → RuntimeClient → Service
  RuntimeServer → RuntimeAccess。测试不得通过 direct Host/SQLite handle、旧 runtime bridge 或本地 Store写入伪造UI state。
- harness可注入显式 `in-process-service-connector` 来稳定测试presentation journey，但它必须组合Service-owned
  application并经过相同 Local Service client seam；fixture不是CLI embedded fallback，也不能重新在CLI创建Host/Store。
- 完整历史断言经 `LocalKiteConnection.history` 的 client-safe DTO完成；Server subscription replay、JSONL、trace或
  SQLite raw event不能替代它。
- reducer 输入保持封闭 `RuntimeClientEvent`/interaction projection；测试应断言 unknown/unavailable 的 fail-closed 投影，而非向 reducer 注入 `any` 或 raw Runtime event。

## 输入 readiness

- Harness 从当前 VT buffer 识别 focused InputLine 的 inverse-cursor marker；marker 不可达时 fail closed。
- 不通过写字符探测 listener；readiness 后只发送一次 bracketed-paste transaction。
- Bun `Terminal.write()` 的同步 byte count 不作为重放依据；缺少应用 projection receipt 时测试失败。

## 隔离与清理

- 每个 scenario 拥有独立 Workspace、HOME、KITE_CODE_HOME、配置与持久目录。KITE_CODE_HOME在写入任何config前
  必须由production `ensureLocalRuntimeServiceHome`创建；尤其Windows不得用普通`mkdir`继承runner ACL后再要求
  cleanup manager接管不同owner的目录。
- Runner 为每个文件设置 deadline，拥有 child process group/tree，并在成功、失败或 timeout 后回收。
- 场景不得读取开发机 credential、真实配置或 live Provider；live MCP/Model 使用独立显式命令。
- timeout、orphan process、残留 worktree/path 或缺失 terminal evidence 都是硬失败。
- fault-soak nonce下，注入取消可以合法留下未消费的预配置model response；cleanup只放宽该项，仍拒绝额外请求与未闭合
  tool continuation。普通PTY与release smoke继续要求response queue全部消费。
- manager stop返回`outcome_unknown`时cleanup不重放stop，只在有界窗口query status；仅`applied + absent`可继续删除fixture。
- `service_busy`表示operation gate在commit前明确拒绝stop；cleanup可等待resident Session/Turn有界结束后发起新的
  ordinary stop。该重试不得用于`outcome_unknown`，也不得把TUI disconnect解释成Session cancel。

## Journey 规则

- 一个文件内按具名 step 串行执行，不跨文件共享 Session 或进程 authority。
- 断言以可见 VT buffer、canonical Runtime/TUI projection 和持久副作用证据为准，不依赖固定 sleep。
- Thought journey 必须覆盖 durable terminal 与 ephemeral delta 的允许乱序、reasoning completion 的 Server
  presentation route、连续探索工具聚合、caption 紧凑行距，以及 viewport 与原生 scrollback 都不重复；
  mock Provider 可用 `stream_frame_order: 'content_first'` 构造正文先于 reasoning 的真实 SSE 乱序，
  或用 `stream_frame_sequence` 与 `stream_frame_delays` 精确构造
  `reasoning prefix → content → reasoning suffix → terminal`。后者必须逐帧断言正文出现后不再展示 reasoning
  原文或活动 Thinking 圆点，并验证 settled live 与重启 `/resume` 最终只形成一个题头和一个回答块。
- 取消、审批、Session 切换、恢复、resize 和 streaming 测试必须等待各自 exact receipt/readiness，不放宽 identity 或 lifecycle。
- Workspace Trust journey必须覆盖App Control prepare/query/decision先于Runtime connect；decline不得打开Runtime，
  trusted restart才可跳过prompt。PTY exit必须证明只关闭terminal connection，不能据此停止Service owner。

## 当前 evidence 边界

KLSV1-06的完整本地TUI system已通过40个isolated PTY scenario files，覆盖default client seam、Trust gate、
presentation、MCP、compaction/rewind与exit/reopen；每个scenario保持进程隔离，cleanup通过authenticated manager
stop且最终无残留Service进程。该结果不等于KLSV1-07三平台release/platform qualification：workflow定义与本地
POSIX结果都不能替代真实Windows结果，当前实现head的三平台evidence仍pending。

## 验证

`bun run test:tui:harness`、`bun run test:tui:system:core`、完整 `bun run test:tui:system`。
