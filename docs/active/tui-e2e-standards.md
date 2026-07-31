# TUI PTY E2E 测试标准

状态：active

读取时机：新增或修改 `tests/tui-system/`、终端交互、mock model server、SessionRuntime 或跨进程恢复场景时。

验证：`bun run test:tui:system`、`bun run test:tui:system:core`。

## 测试边界

PTY E2E 必须启动真实 TUI 子进程，走生产配置加载、HTTP 模型调用、`runRuntimeAgent()`、Runtime Store、SessionRuntime、AgentEvent reducer 和 Ink 渲染。只允许 mock 模型服务及必要的外部 provider；不得 mock TUI、Kernel 或 reducer 主链路。

## Harness 结构

```text
tests/tui-system/
├── harness/    PTY 进程、mock server、输入辅助、screen 解析、临时 workspace
└── scenarios/  startup、input、approval、plan、session、recovery、tool lifecycle 等
```

测试必须使用隔离的临时 HOME、workspace、配置和 Runtime 数据库。禁止读取开发机真实密钥、用户配置或会话数据。

## 编写规则

1. 断言用户可见的稳定语义，不依赖 ANSI 字节、spinner 帧或精确空格快照。
2. 输入和等待使用 harness helper；不得用任意长 sleep 代替条件等待。`typeText()` 必须在
   返回前确认本次输入已由 Ink 回显；普通模型消息优先使用 `submitUserMessage()`，把输入回显、
   Enter 和“本次提交之后产生的 mock model request”绑定为一个同步原语。slash command 优先
   使用 `submitCommand()`；需要分步断言时可使用 receipt-confirmed `typeText()` 后单独发送
   Enter。两种方式都必须随后等待该命令独有的可见状态，不能用历史输出中的旧 prompt 作为
   就绪证据。
3. 每个 scenario 负责关闭子进程、mock server 和临时资源。
4. 审批、计划和 ask-user 测试必须完成结构化交互闭环，而不只断言卡片出现。
5. 持久化测试应跨进程打开同一 Runtime Store，验证 session、snapshot 和 transcript 恢复。
6. 改动 Runtime 多轮语义时同时运行 `tests/runtime/agent.integration.test.ts`、`tests/runtime/store.test.ts` 和相应 PTY scenario。
7. PTY suite 必须串行运行，避免终端尺寸、端口和全局环境相互污染。
   完整 suite 由 `scripts/run-tui-system-tests.ts` 先运行 harness 单元测试，再按 scenario
   文件逐个启动独立 `bun test` 进程；每个文件默认硬超时 180 秒，超时后必须终止测试进程及其
   TUI 子进程树。需要诊断慢场景时可通过 `KITE_TUI_TEST_FILE_TIMEOUT_MS`
   调整单文件上限，不得取消硬超时。
8. `run.completed.output` 是最终回答的权威渲染校准点。TUI 必须在切换到 idle、把当前 turn 移入 Ink `<Static>` 之前，用它补齐可能缺失的尾部并结束所有 streaming text block。MCP/工具调用后的长回答必须断言末段在当前会话中可见，不能依赖重新进入会话后的 replay 才出现。
9. `tool_search` 在对话区按用户可理解的发现过程渲染：运行中显示 `Searching for tools…`，成功后显示 `Searched for tools`，并以 `Provider · Tool` 树列出 names-only 命中项；catalog revision 切换期间返回的 last-known names 使用同一树结构，但不得暗示已签发 Binding。只有当前结果和 last-known names 都为空时才显示 `No matching tools found`，失败使用独立状态文案。真实 MCP 调用仍是独立工具块，名称从协议形式 `mcp__provider__tool` 映射为 `provider · tool`。展示层不得从模型回答或任意参数猜测自然语言动作。
10. workspace 信任门禁默认由 harness 预信任：`spawnTui()` 为启动目录写入 `source: 'test'` 信任记录，新增场景无需关心启动授权。不使用环境变量旁路（Bun 自动注入 `<cwd>/.env*`，env 开关可被 workspace 文件伪造）。验证门禁本身时使用 `createTestWorkspace({ enforceWorkspaceTrust: true })`，参考 `tests/tui-system/scenarios/workspace-trust.test.ts`，门禁行为以 `docs/active/workspace-trust.md` 为准。
11. 终端 focus reporting 由进程级 `TerminalFocusStore` 复用：任意数量 React subscriber 只能
    对 stdin 保持一个物理 `data` listener；首个 subscriber 开启 DEC 1004，最后一个
    unsubscribe 必须移除 listener 并关闭 DEC 1004。禁止组件 mount 各自添加 stdin listener。
12. 完整 suite 每个 scenario 后采集协调进程 RSS、active resource 和可用平台 FD 数；最后
    一个窗口出现持续且超过阈值的正斜率时门禁失败。该趋势门禁用于发现 harness 泄漏，不替代
    1C.7 的长会话 soak。
13. MCP tool failure 与紧随其后的 Provider recovery interaction 必须按同一 Kernel batch
    顺序提交；`run.completed + turn.completed` batch 必须产生命名 rewind 恢复点。
    `SET_EXITED` 不得重写已经交给 Ink `<Static>` 的 streamed text block；最终回答尾段由
    `run.completed.output` 校准。
14. 条件等待在共享 CI runner 上默认使用 1.5 倍预算，本地保持 1 倍；可用
    `KITE_TUI_TEST_TIMEOUT_SCALE` 设为大于 0 的倍数覆盖，超过 3 时按 3 倍处理。增加预算不能
    替代输入回显、请求 baseline 和 modal/命令结果条件。失败诊断必须包含最近 mock request
    与终端输出尾部。

组件级 Ink 测试适合布局和 reducer 细节，但不能替代 PTY E2E 的真实终端覆盖。

## 运行入口

- `bun run test`：默认快速门禁，排除 PTY 与 spike，适合日常修改。
- `bun run test:tui:system`：按文件串行执行完整 PTY suite。
- `bun run test:all`：先运行默认门禁，再运行完整 PTY suite。
- 裸 `bun test` 会按 Bun 默认发现规则包含高成本 PTY 文件，不是仓库规范的全量入口。
