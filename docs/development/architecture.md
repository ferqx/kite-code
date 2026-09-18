# 架构与运行机制

先建立系统地图，再沿具体链路进入机制。正在修改一个局部问题时，可直接使用[任务入口](README.md)，不需要顺序读完所有章节。

## 整体理解

1. [组成与运行拓扑](architecture/topology.md)：客户端、进程、服务和 Store 的位置。
2. [依赖方向与职责](architecture/dependencies.md)：哪些模块可以调用哪些边界。
3. [身份、状态与数据归属](architecture/identities-state.md)：Session、Run、Task、Turn、连接和展示不是同一对象。

## 追踪运行

[启动与准入](flows/startup-admission.md) → [任务执行](flows/task-execution.md) → [模型和工具](flows/model-tool-cycle.md) → [交互](flows/interactions.md)。

按问题深入：[会话历史](flows/session-history.md)、[取消与恢复](flows/cancellation-recovery.md)、[Web 查询](flows/web-queries.md)。

## 子系统与底层

[会话协调](subsystems/sessions.md) · [Kernel](subsystems/kernel.md) · [模型上下文](subsystems/model-context.md) · [工具扩展](subsystems/tools.md) · [授权交互](subsystems/security.md) · [持久化恢复](subsystems/storage.md) · [客户端](subsystems/clients.md)。各子系统链接 workspace 内的机制和测试，不复制一份实现手册。

[跨包契约目录](subsystems/contracts.md)用于查规范，不是每个任务必读清单。架构负责解释，准确的共同不变量在对应契约中维护。

## 本次建图范围与证据

本节是本次全景阅读的核实边界，不是新增测试权威或持续审计台账。2026-09-18 在分支 `el`、HEAD `b7cbb096638e043b283fbe89fbd733477369c24a` 上分析；开始时工作树干净。交付只修改文档与根 Agent 规则，业务源码保持该版本，未切分支、提交或推送。并行核实按不重叠文档分工，主任务整合并复核当前 App Server 路径，未以 legacy Worker 的测试代替默认入口。

核实分三层：全部 workspace 已核对 manifest/入口及代表性实际引用；五条关键链路已沿 caller/receiver 补充源码符号、事件/状态/数据交接及相关断言；运行验证仅为下列定向套件。完整导出图、全部内部调用、真实模型/MCP、原生沙箱、PTY、Desktop GUI、断网与跨平台发行均未完整审计。Desktop 本次核实宿主/数据入口，UI 的独立取消、交互和恢复路径未深入；已有[原生验收](../../apps/kite-desktop/docs/native-validation.md)是其他任务证据，未当作本次实跑。

### 产品预期、实际与冲突

| 预期与影响范围 | 现有实现 / 文档差异 | 证据与处置 |
| --- | --- | --- |
| TUI 审批提交期间保持一致提交态、避免重复输入 | Enter 有 submitting；Esc 全局拒绝回调未给 ApprovalBlock 同等状态 | [手册](../handbook/clients/tui/guides/approvals-and-questions.md)、[owner 的源码与断言](../../apps/kite-cli/docs/approvals-and-interactions.md#当前差异esc-提交态)。保留已知冲突，未修改产品承诺或业务代码 |
| Web 所选 running/waiting 会话应更新，错误不冒充内容消失 | `selectedSession` 优先目录状态，可能遮蔽新 route snapshot；日志失败转为 unavailable/error 可能隐藏旧条目 | [产品现有差异](../handbook/clients/web/guides/updates-and-connection.md)、[reducer](../../apps/kite-web/src/presentation/reducer.ts) `selectedSession`、[App](../../apps/kite-web/src/app/app.tsx)轮询 effect 与 `loadSessionLogs`。保留，未新增行为承诺；完整可见性/失败组合尚无直接测试证明 |
| Desktop/TUI/CLI 正式会话入口统一 | 部分技术段落仍称 source 按 checkout digest 分库，与当前代码、手册和同页 Store 段落冲突 | [resolver](../../scripts/release/app-server-client.ts) `resolveManagedLocalAppServerTarget`、[Desktop host](../../apps/kite-desktop/electron/host.ts)、[Service](../../apps/kite-service/src/app-server.ts)。本次只修正拓扑、开发运行入口、Desktop README 和 [App Server 契约](../active/app-server-local-runtime.md)的相关旧说明；不宣称已清理所有历史提法 |

另有一项 TUI 条件分支冲突：共享[恢复手册](../handbook/features/recovery.md)承诺历史读取只读、继续执行命令才核验旧执行；当前 History adapter 在日志仍有 open Turn 时返回 `restart_required`，TUI 选择回调仅在该 Session 尚未登记 Runtime 时据此以 `recoverBeforeSubscribe` 注册，Native client 进入 `resume-mutation`，可能在用户尚未发送新输入前请求恢复准入。调用双方见[历史链路](flows/session-history.md#从选择到持久历史)。这是静态确认的条件调用，未实跑该恢复情境，也不表示所有历史打开都会写入；保留待核实，不修改产品承诺或业务代码。

设计理由首先沿各 owner 和 active 约束阅读；[拓扑依据](architecture/topology.md#设计依据与边界)区分已有取舍与未找到的原始理由。对旧 ADR 保留历史上下文，不能以其过时拓扑代替当前执行证据。

### 本次实际执行

环境为本机 macOS / Darwin arm64，Bun `1.4.2 (744846f84)`。以下均在仓库根运行，源码版本为上述 HEAD；每批使用 `tempfile.TemporaryDirectory` 下的独立 HOME/USERPROFILE，`KITE_CODE_HOME=该home/.kite-code`，仅继承 PATH、TMPDIR、LANG、LC_ALL、TERM。release 测试自行创建临时 workspace/Kite Home，使用 loopback fixture/测试配置，没有调用真实模型或使用用户凭据；authority 真实子进程只操作临时 SQLite。临时目录结束后清理。

| 实际命令 | 结果 | 能证明 / 不能证明 |
| --- | --- | --- |
| `bun test apps/kite-cli/test/session-navigation.test.ts packages/agent-kernel/test/approval-queue.test.ts packages/agent-kernel/test/completion.test.ts` | 20 pass，0 fail，63 assertions | 本地导航竞态、Kernel 审批及完成断言；不证明完整 UI |
| `bun test tests/release/app-server-client.test.ts` | 3 pass，0 fail，19 assertions | source canonical Home、真实配套 child 与安装目标配对断言；不是真实安装或原生桌面验收 |
| `bun test packages/runtime-host/test/persistent-command-host.test.ts packages/builtin-runtime/test/tool-pipeline-callbacks.test.ts packages/agent-kernel/test/effect-admission.test.ts` | 34 pass，0 fail，256 assertions | 持久回执/调度先后、Pipeline 绑定及 effect 准入；不是所有工具实际副作用验证 |
| `bun test packages/runtime-storage-sqlite/test/isolated/kite-session-execution-authority.test.ts` | 4 pass，0 fail，20 assertions | generation、stale writer、真实进程同 Session 互斥和不同 Session 并行取得权；不是任意外部操作 exactly-once |

共 61 项定向测试通过。各流程里的“已读断言”与这里的“实际执行”分开；仅列有测试链接的部分仍只是验证入口。

本次另执行 `bun run check:docs`、`bun run check:docs-impact --scope=all`、`git diff --check`，均通过；impact 提示根规则相关的文档语言与 docs Agent 入口需核对，已阅读且无需重复修改。`bun run check:core-boundary`、`bun run check:runtime-packages`、`bun run check:agent-api-packages` 均通过（Runtime gate 清点 18 workspaces、41 package edges）。这些是结构和边界证据，不能用其通过证明 Runtime 正确。

后续只读复核在相同源码与 Bun 版本、隔离 HOME/Kite Home 下重跑 `bun test packages/runtime-host/test/persistent-command-host.test.ts`（17 pass，0 fail）及 `bun test packages/runtime-client/test/runtime-client.test.ts --test-name-pattern 'explicit reconnect increments generation'`（1 pass，0 fail，31 filtered）。前者包含非 applied terminal 不持久提交的断言，后者只证明显式重连恢复订阅且不重放 mutation；不补足双会话 UI、历史重新选择或跨进程实时通知的场景覆盖。根据复核修正了相关图与条件说明，业务实现未变。


### 风险定向验证

2026-09-18 在同一 `b7cbb096638e043b283fbe89fbd733477369c24a` 业务源码、macOS arm64 / Bun 1.4.2 上，针对审查提出的风险执行了 8 个临时探针用例，全部通过预期断言。这里的“通过”包含成功复现限制，不表示风险被修复。未修改业务源码或既有测试；Python 驱动临时复制 owner 测试夹具、加入定向断言、执行后在 finally 删除自己的仓库探针。最终驱动只继承 PATH/TMPDIR/LANG/LC_ALL/TERM，并设置临时 HOME、USERPROFILE、KITE_CODE_HOME；Service 场景另使用显式隔离 `--kite-home` 与 workspace，传入 composition 的外部环境仅 PATH。没有发送模型请求或使用真实用户配置与凭据。

| 场景与实际命令 | 结果与证据 | 可得结论及限制 |
| --- | --- | --- |
| `python3 /tmp/kite-map-risk-verification/verify-background.py` | 1 pass，4 assertions。复用 [TUI facade 夹具](../../apps/kite-cli/test/service-mode/tui-client.test.ts)，生产 `TuiUserInputProvider` 的 action sink 接生产 Native facade；A 等待审批后切到 B，再提交 A 的有效 interaction | 实际 `respond_interaction` 仍指向 A，前台保持 B；不会误投 B。此处是主动调用 provider，不等于用户切换后按键会自动产生旧动作 |
| `python3 /tmp/kite-map-risk-verification/verify-ui-switch.py` | 4 pass，14 assertions。复用 [App 渲染夹具](../../apps/kite-cli/test/tui-layout.test.tsx)，生产 App 从 A 重渲染到 B，组合 Enter/Esc × B 有/无审批 | B 有审批时只提交 B 的 ID；B 无审批时不提交 A。正常切换完成后的旧会话误提交未复现；未覆盖切换同一事件循环内的输入竞态、完整终端选择器与真实 Service |
| `python3 /tmp/kite-map-risk-verification/verify-history.py` | 2 pass，5 assertions。现有 fake transport 配合生产 RuntimeClient/Native facade，预先完成 connect；观察 `registerSession` 后的命令 | 首次登记且 `recoverBeforeSubscribe:true` 时发送一次 `resume_session`；普通登记及已登记后的重复恢复登记均不发送。证明登记边界，与生产选择回调的 `!hasRuntime` 条件吻合；未运行完整导航 UI 或证明 Service 恢复的持久影响 |
| `python3 /tmp/kite-map-risk-verification/verify-cross-host.py` | 1 pass，9 assertions。沿 [release composition](../../scripts/release/app-server-client.ts)与[配对测试](../../tests/release/app-server-client.test.ts)使用当前默认 App Server，两个真实不同 PID 共用临时 `kite-session.sqlite`，typed Session 订阅已先收到初始 revision 0 | B 的 `set_interaction_mode` applied revision 1 后，A 2200ms 内无新通知；A 主动 query 返回 revision 1，并触发原订阅的 durable revision 1。跨进程即时刷新限制已在该场景复现；不是无限等待证明，不覆盖 Web 轮询或模型流 |

上述 `/tmp` 路径是本次本机临时复现材料，不是仓库长期测试入口，也不保证清理临时目录后仍存在；跨进程驱动还使用 `/tmp/kite-current-cross-host-probe.test.ts`。长期测试归属仍是表中既有 owner，正文保留了输入、断言与边界，避免把临时探针误列为已加入 CI 的回归。首次跨进程实验采用旧 transport fixture，已排除为默认入口依据；最终结论只用当前 paired App Server 重跑结果。历史探针也已纠正 fake connection 的预连接设置，最终通过不把夹具初始化问题列为产品缺陷。
