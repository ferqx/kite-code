# TUI PTY E2E 测试标准

状态：active

读取时机：新增或修改 `tests/tui-system/`、终端交互、mock model server、SessionRuntime 或跨进程恢复场景时。

验证：`bun run test:e2e`、`bun run test:tui:system:core`。

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

组件级 Ink 测试适合布局和 reducer 细节，但不能替代 PTY E2E 的真实终端覆盖。
