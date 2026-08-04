# TUI 会话启动 Header

状态：active

最后更新：2026-07-31

范围：`src/app/tui/Header.tsx`、`src/app/tui/App.tsx`、`src/app/tui/index.tsx`、`tests/tui-layout.test.tsx`、`tests/tui-mock-render.test.tsx`、`tests/tui-system/scenarios/startup.test.ts`

读取时机：修改 TUI Header、启动品牌、会话切换后的顶部信息、模型或工作区启动信息、Header 窄屏布局时。

验证：`bun test tests/tui-layout.test.tsx tests/tui-mock-render.test.tsx`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/startup.test.ts`、`bun run typecheck`、`bun run check:docs-impact`、`bun run check:docs`。

## 视觉契约

每个会话在 scrollback 顶部输出一个带低对比度圆角边框的紧凑启动 Header：

```text
╭──────────────────────────────────────────────────────────╮
│ ──◆ Kite Code                                             │
│                                                          │
│ model      gpt-5.6 · low                                  │
│ workspace  ~/Code/ai/kite-code                            │
╰──────────────────────────────────────────────────────────╯

```

- Header 使用主题 `dim` 色的圆角四周边框，弱于品牌色与正文；边框内左右各留一列内边距，品牌行、`model` 和 `workspace` 在内边距之后从同一列开始左对齐，通过品牌行后的空行建立层级。
- `──` 与字段名使用弱化色；`◆` 使用普通字重品牌色，以便与细横线保持字形视觉中心；`Kite Code` 使用品牌色和粗体。线与菱形之间不得插入空格，保留“风筝线连接风筝”的字标语义。
- `model` 展示会话启动时的模型；有推理强度且终端至少 40 列时追加 ` · <thinkingMode>`。
- `workspace` 将用户 home 前缀收缩为 `~`，路径或模型超出可用列时从中部截断，保留首尾辨识信息。
- Header 外框默认最大宽度为 60 列，不占满宽终端；终端不足 60 列时随窗口收缩，最小布局宽度为 20 列。边框与两侧内边距共占用四列、边框占用两行，内部文字据此扣除可用宽度。终端 resize 继续通过 App remount 和 Static 全量重建适配新宽度，不为 Header 建立独立 resize 监听。
- Header 不再显示猫咪 ASCII、working/error 表情或帮助快捷键；运行状态属于 Footer/StatusBar。`Kite Code` 品牌只在会话 Header 展示，Overlay 题头仅显示 `── <标题> ──`。

## 状态语义

Header 是**会话启动快照**，不是持续更新的状态面板。`App` 在当前 `sessionKey` 首次渲染时冻结模型、推理强度和工作区；同一会话中的 `/model` 切换不得重绘已经写入 scrollback 的卡片。当前模型仍由 Footer/StatsLine 展示。

新会话、会话切换或恢复导致 `sessionKey` 变化时，Header 使用该会话当时的状态建立新快照；`useStaticContent` 负责清屏并按既有 Static 规则重新输出。

## 边界

- Header 只消费 App 层已有的展示状态，不向 Core 添加 TUI 类型或依赖。
- 不在启动 Header 中加入 token、cache、Git 分支、授权模式或运行阶段；这些属于动态状态区。
- 不使用 DEC 双倍宽高等终端专有字体控制序列；品牌标识只由普通 Unicode 和 Ink 样式构成。
