# TUI 会话启动 Header

状态：active

最后更新：2026-08-07

范围：`apps/kite/src/tui/Header.tsx`、`apps/kite/src/tui/App.tsx`、`apps/kite/src/tui/index.tsx`、`tests/tui-layout.test.tsx`、`tests/tui-mock-render.test.tsx`、`tests/tui-system/scenarios/startup.test.ts`

读取时机：修改 TUI Header、启动品牌、会话切换后的顶部信息、模型或工作区启动信息、Header 窄屏布局时。

验证：`bun test tests/tui-layout.test.tsx tests/tui-mock-render.test.tsx`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/startup.test.ts`、`bun run typecheck`、`bun run check:docs-impact`、`bun run check:docs`。

## 视觉契约

每个会话在 scrollback 顶部输出一个带低对比度圆角边框的紧凑启动 Header：

```text
╭──────────────────────────────────────────────────────────╮
│ ──◆ Kite Code                                             │
│                                                          │
│ model      gpt-5.6 low                                    │
│ workspace  ~/Code/ai/kite-code                            │
╰──────────────────────────────────────────────────────────╯

```

- Header 使用主题 `dim` 色的圆角四周边框，弱于品牌色与正文；边框内左右各留一列内边距，品牌行、`model` 和 `workspace` 在内边距之后从同一列开始左对齐，通过品牌行后的空行建立层级。
- `──` 与字段名使用弱化色；`◆` 使用普通字重品牌色，以便与细横线保持字形视觉中心；`Kite Code` 使用品牌色和粗体。线与菱形之间不得插入空格，保留“风筝线连接风筝”的字标语义。
- `model` 展示会话启动时的模型；终端至少 40 列且模型配置未显式设定 `reasoning: false` 时追加 ` <thinkingMode>`。缺省配置和 `reasoning: true` 都必须显示该强度。
- `workspace` 将用户 home 前缀收缩为 `~`，路径或模型超出可用列时从中部截断，保留首尾辨识信息。
- Header 外框默认最大宽度为 60 列，不占满宽终端；终端不足 60 列时随窗口收缩，最小布局宽度为 20 列。边框与两侧内边距共占用四列、边框占用两行，内部文字据此扣除可用宽度。终端 resize 继续通过 App remount 和 Static 全量重建适配新宽度，不为 Header 建立独立 resize 监听。
- Header 不再显示猫咪 ASCII、working/error 表情或帮助快捷键；运行状态属于 Footer/StatusBar。`Kite Code` 品牌只在会话 Header 展示，Overlay 题头仅显示 `── <标题> ──`。

## 状态语义

Header 使用 Ink `Static` 写入 scrollback，但模型或推理强度切换后，`TuiApp` 必须通过已有的同步清屏重挂载路径原子重绘，以免会话 Header 保留旧配置；会话和当前输入状态不得因此重置。当前模型和推理强度也由 Footer/StatsLine 展示。

新会话、会话切换或恢复导致 `sessionKey` 变化时，Header 使用该会话当时的状态建立新快照；`useStaticContent` 负责清屏并按既有 Static 规则重新输出。

## 历史会话加载失败

启动时读取历史会话索引失败，不得让 TUI 挂载失败，也不得通过 `console.error`、裸 `stderr` 或其他终端日志通道暴露数据库错误、路径、堆栈或内部异常文本。当前界面进入历史会话服务不可用状态，只允许用户显式执行 `/resume` 重试；不得提供 `/new` 作为绕过，因为它的首次 Kernel 持久化仍会命中同一个不可用 Store。普通任务输入必须被阻止，避免在没有可用 RuntimeStore 时静默丢失用户消息。

正常的 `LOCAL_TEXT` 提示为：

```text
  ⎿  历史会话服务不可用，请输入 /resume 重试。
```

`/resume` 加载成功后清除该状态；加载失败则继续显示会话服务错误。用户手动打开某个历史会话失败时，同样只显示脱敏的 TUI 提示；不得把底层异常原文拼接到渲染文本中。

## Fatal startup boundary

若错误发生在 React error boundary，退出提示不得统一猜测为 Model Provider 配置问题，只显示 Enter/Esc
退出，不建议运行 `kite-code setup`。Runtime/Artifact 不创建 installation key，因此不存在 key-loss startup
screen。旧 `project-identities-v1.json` 与 `.runtime-v5.db` header shim 不属于当前 target evidence；PTY
回归必须证明旧字节保持不变、canonical Workspace identity 与 `.runtime-state26-store5.db` 正常初始化。

## 边界

- Header 只消费 App 层已有的展示状态，不向 Kernel、Host 或 Builtin 添加 TUI 类型或依赖。
- 不在启动 Header 中加入 token、cache、Git 分支、授权模式或运行阶段；这些属于动态状态区。
- 不使用 DEC 双倍宽高等终端专有字体控制序列；品牌标识只由普通 Unicode 和 Ink 样式构成。
