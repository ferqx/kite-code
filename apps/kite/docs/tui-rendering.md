# TUI 渲染规范

本页是 `apps/kite` 的 owner-local current authority，覆盖 Static/dynamic 输出、终端 resize、引用稳定、软换行和性能边界。

## 输出与 scrollback

- TUI 使用终端主屏缓冲区，已完成消息进入 `<Static>` 并保留在原生 scrollback。
- `<Static>` 必须位于 OutputArea 的 `Box(height={0} overflow="hidden")` 内，不外置到 App root。
- 活跃 streaming/running/interrupt block 留在 dynamic tree；已提交相邻文本是 append-only 前缀。
- OutputArea 不实现 focused viewport、行数估算或历史裁剪；Overlay 固定高度列表可以使用 VirtualList。
- 并发 Subagent 使用一个聚合卡片和有界步骤尾；聚合只影响展示，不删除 Runtime/TUI state 中的步骤。

## DEC 同步与 resize

- resize、Session 切换和需要整体重绘的路径使用终端 DEC synchronized-output 包围一次完整帧，防止半帧闪烁。
- resize 事件去抖后更新 columns/rows 与 generation；Static key 只在真实布局 generation 变化时重建。
- App root 不使用 `height="100%"` 或 Footer 下方 `flexGrow` spacer；Footer 与 OutputArea 保持固定一行视觉间距。
- 非 TTY 输入或输出不强制 Ink 交互；真实 PTY 即使处于 CI 也必须启用输入和增量渲染。

## 引用稳定与渐进冻结

- `useStaticContent` 使用 ref + block fingerprint，而不是依赖每帧新引用的 `useMemo`。
- fingerprint 只包含影响可见结构的 kind/status/step/text completion 等字段；timer 和 spinner tick 不改变它。
- split 重算后逐元素比较数组引用，未变化 block 继续命中 `React.memo(BlockRenderer)`。
- 新增 OutputBlock variant 必须同时定义 fingerprint 与 settled 条件。
- 并发 group identity 只来自 Runtime 明确的 `concurrencyGroupId`，TUI 不从相邻 block 猜测。

## 软换行与光标

- `CtrlSafeTextInput` 使用 `string-width` 计算终端列；CJK/全角通常占两列。
- 显示 inverse 空格光标且无 trailing text 时，为光标预留一列。
- 断行优先级为显式换行、ASCII 单词空白、脚本边界、最后可容纳字符；CJK/数字相邻空格不强制断行。
- 换行边界光标归下一视觉行开头；上下移动保持目标列并 clamp，Home/End 作用于当前视觉行。
- IME 自动前导空格只在单次输入事件满足确定条件时清理，用户主动输入的空格保留。

## 性能边界

- 减少 Yoga 节点数优先于仅使用 React.memo。
- Overlay VirtualList 只渲染 visible items，禁止因 selectedIndex 变化预计算全部行。
- timer lifecycle 只依赖真实 running/focus 状态，不依赖每帧 elapsed 值。
- dynamic 帧高度必须保留 Ink 全屏阈值安全余量，不能为速度删除内容或 Runtime 事实。

## 验证

`bun test apps/kite/test`、`bun run test:e2e`、相关 resize/streaming/scrollback PTY scenarios。
