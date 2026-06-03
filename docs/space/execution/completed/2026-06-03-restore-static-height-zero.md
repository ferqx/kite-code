# 恢复 Static 渲染架构，解决 Windows 输入卡顿

状态：completed
日期：2026-06-03
替代：`2026-06-02-remove-static-react-memo.md`

## 问题

2026-06-02 移除 `<Static>` 改用 React.memo 方案后，Windows 上输入严重卡顿。排查发现：

1. Ink 的 `renderNodeToOutput` 每帧遍历**整棵** fiber 树生成输出字符串，开销与节点数 × 文本内容量成正比
2. `calculateLayout` 在每次 React commit 同步执行（不受 `maxFps` 节流）
3. Windows ConPTY 处理终端 escape sequence 比 Unix PTY 慢数倍
4. React.memo 只跳过组件函数执行，但 Ink 的 layout + output 管线仍遍历全部节点
5. Perf 数据：20 blocks 时 render 平均 64ms，远超 33ms 帧预算（30fps）

## 方案

恢复 `<Static>` 渲染架构：

1. 已完成消息 → `<Static>` 渲染一次写入终端 scrollback，从 React 树移除
2. 活跃消息（streaming/running/interrupt）→ 保留在 dynamic 树实时更新
3. `<Static>` 容器用 `<Box height={0} overflow="hidden">` 包裹，消除布局空白
4. 移除 App 底部 `flexGrow={1}` spacer，Footer 紧跟最后一条消息

## 尝试过但无效的方案

| 方案 | 效果 | 原因 |
|------|------|------|
| React.memo block 组件 | 无效 | Ink 管线仍遍历全部节点 |
| `useMemo` 稳定 status 引用 | 微弱 | 只减少 React commit，不影响 Ink 管线 |
| `useAnimation` 替代 setInterval | 微弱 | 合并定时器但单次 render 开销不变 |
| `maxFps: 15` | 微弱 | 减少触发次数但单次开销不变 |
| `incrementalRendering: true` | 无效 | 行级 diff 的 split+compare 开销抵消了收益 |
| 窗口化渲染（最后 N 个 block） | 有效但 UX 差 | 减少可见消息量 |
| chalk 预格式化单 Text 节点 | 无效 | 文本内容量不变，squashTextNodes 开销不变 |
| calculateLayout throttle | 无效且有害 | 导致光标闪烁（layout 延迟，渲染用旧位置） |

## 关键发现

Claude Code 同样使用 Ink 但不卡，因为它也使用了 `<Static>`。`<Static>` 是唯一能将内容从 React 树中完全移除的机制。

## 变更文件

- `src/app/tui/OutputArea.tsx` — 恢复 Static/dynamic 分割，添加 PlanCard 支持
- `src/app/tui/App.tsx` — 移除底部 spacer
