# E2E 测试入口

当前根 `test:e2e` 显式选择新 Service 与 Client 的 HTTP/SSE、paired 和生命周期测试，准确文件列表由[根 manifest](../../package.json)维护。原 `local/` 的 MCP/Skills 跨进程测试依赖已删除的旧 Runtime 夹具，已随旧闭包删除，不再作为此命令的入口。

[live/model](live/model/README.md)包含显式运行的真实模型验证。实际调用 Provider 的 runner 使用 `*.live.ts`，由对应根脚本或模型套件中的明确命令启动；这类运行会消耗模型配额。旧 `live/mcp`、compaction 和 background runner 已随旧 Runtime 闭包删除，历史结果按其原版本追溯。

`live/model` 中也保留质量回放和对照工具的 `*.test.ts` 辅助测试，可按明确文件路径单独运行。[默认统一计划](../../scripts/unified-test-plan.ts)不选择整个 `tests/e2e/live/`，不能把文件名是否含 `.test` 等同于默认调度范围。

TUI PTY 场景由根 `test:tui:system` 选择 `tests/tui-system/scenarios/` 与当前 CLI owner 测试，再沿原场景 harness 执行；期限、隔离和进程清理由[测试体系](../README.md)及现有调度器负责。

## 桌面会话交互

`bun test apps/desktop/test/isolated/conversation-interactions-browser.test.ts` 运行三项真实浏览器回归。默认 `bun run test` 和 Required unit 分片也会运行它们。它们构建正式 Native 界面和 CSS，用隔离测试桥控制回执顺序，并优先使用 Playwright 配套 Chromium。本机未指定配套浏览器路径且未安装配套 Chromium 时，可使用本机 Chrome。两种浏览器均不可用时，测试报错。

- 发送提示词覆盖首次和已有会话、键盘和发送按钮、用户消息上屏首帧的清空和焦点、等待期间的新草稿、历史先于回执、失败与未知回执及冷重开。
- 思维链覆盖长 Shell 命令的回执续页挂起及接管。逐帧核对工具图标、行节点、相邻折叠行位置和阅读位置，再核对详情开合与读取失败的图标。测试产物目录随运行日志输出。
- 历史轮次覆盖新轮次发送、保存、流式分段和结束。隔离构建计数旧消息、工具和附件组件的执行，逐帧核对旧节点、展开状态和阅读位置。分别暂停完整历史重扫和后续文件目标读取，再模拟权限撤销，核对旧按钮及图标的节点、尺寸和外观，并验证门禁期间无打开请求。迟到文件只重读对应轮次并追加原列表的一项。

验证范围是 Chromium 中的生产 Renderer 和受控回执。完整 Electron 窗口与真实 Service 沿各自入口验证。[会话交互回归](../../apps/desktop/test/isolated/conversation-interactions-browser.test.ts)
