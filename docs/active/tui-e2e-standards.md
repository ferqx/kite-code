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
2. 输入和等待使用 harness helper；不得用任意长 sleep 代替条件等待。
3. 每个 scenario 负责关闭子进程、mock server 和临时资源。
4. 审批、计划和 ask-user 测试必须完成结构化交互闭环，而不只断言卡片出现。
5. 持久化测试应跨进程打开同一 Runtime Store，验证 session、snapshot 和 transcript 恢复。
6. 改动 Runtime 多轮语义时同时运行 `tests/runtime/agent.integration.test.ts`、`tests/runtime/store.test.ts` 和相应 PTY scenario。
7. PTY suite 必须串行运行，避免终端尺寸、端口和全局环境相互污染。
   完整 suite 由 `scripts/run-tui-system-tests.ts` 按 scenario 文件逐个启动独立
   `bun test` 进程；每个文件默认硬超时 180 秒，超时后必须终止测试进程及其
   TUI 子进程树。需要诊断慢场景时可通过 `KITE_TUI_TEST_FILE_TIMEOUT_MS`
   调整单文件上限，不得取消硬超时。CI 设置 `KITE_TUI_TEST_REPORT_DIR` 后，
   runner 必须为每个已启动 scenario 写入 JUnit，并写入 `summary.json`；
   汇总至少包含固定 deadline、计划/完成文件数、最后执行文件、退出码、耗时和
   timeout 状态。失败或超时也必须先落汇总再退出。
8. `run.completed.output` 是最终回答的权威渲染校准点。TUI 必须在切换到 idle、把当前 turn 移入 Ink `<Static>` 之前，用它补齐可能缺失的尾部并结束所有 streaming text block。MCP/工具调用后的长回答必须断言末段在当前会话中可见，不能依赖重新进入会话后的 replay 才出现。
9. `tool_search` 在对话区按用户可理解的发现过程渲染：运行中显示 `Searching for tools…`，成功后显示 `Searched for tools`，并以 `Provider · Tool` 树列出 names-only 命中项；catalog revision 切换期间返回的 last-known names 使用同一树结构，但不得暗示已签发 Binding。只有当前结果和 last-known names 都为空时才显示 `No matching tools found`，失败使用独立状态文案。真实 MCP 调用仍是独立工具块，名称从协议形式 `mcp__provider__tool` 映射为 `provider · tool`。展示层不得从模型回答或任意参数猜测自然语言动作。
10. workspace 信任门禁默认由 harness 预信任：`spawnTui()` 为启动目录写入 `source: 'test'` 信任记录，新增场景无需关心启动授权。不使用环境变量旁路（Bun 自动注入 `<cwd>/.env*`，env 开关可被 workspace 文件伪造）。验证门禁本身时使用 `createTestWorkspace({ enforceWorkspaceTrust: true })`，参考 `tests/tui-system/scenarios/workspace-trust.test.ts`，门禁行为以 `docs/active/workspace-trust.md` 为准。

组件级 Ink 测试适合布局和 reducer 细节，但不能替代 PTY E2E 的真实终端覆盖。

## 运行入口

- `bun run test`：默认快速门禁，排除 PTY 与 spike，适合日常修改。
- `bun run test:tui:system`：按文件串行执行完整 PTY suite。
- `bun run test:all`：先运行默认门禁，再运行完整 PTY suite。
- 裸 `bun test` 会按 Bun 默认发现规则包含高成本 PTY 文件，不是仓库规范的全量入口。
