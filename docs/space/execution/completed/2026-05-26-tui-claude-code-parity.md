# TUI Claude Code 全面对标完成记录

状态：archived
日期：2026-05-26（完成），2026-06-08（归档）

## 改动摘要

5 维度对标 Claude Code：

### 布局重构

- Header → cat ASCII + 产品名 + 使用提示
- Footer → 3 行容器：StatusBar（top）+ 交互行 + StatsLine（bottom）
- 移除 ActivityBar，信息下沉至 StatusBar/StatsLine
- 四层布局：Header / Body / Footer / Overlay

### 快捷键精简

- 10+ leader keys → 仅 Ctrl+C / Ctrl+T / Ctrl+E
- 移除 `useLeaderKeys.ts`、Ctrl+X 体系
- CtrlSafeTextInput 改为白名单拦截

### 功能补全

- Markdown `[text](url)` 链接渲染
- `@file` 搜索遵循 `.gitignore` 规则
- `/export` 命令注册

### 配置

- 模型列表从 `kite-code.jsonc` 动态加载，替换硬编码
- 新增 `theme` 字段支持 dark / light 双主题
- 全部组件迁移至 ThemeContext

### 额外修复

- 移除启动自动恢复最近会话（每次启动新建）
- `sanitizeToolCallPairs` + `forceContextCompaction` 修复 DeepSeek 400 错误

### Commits (14)

```
15b031d refactor: 精简 Header 为 cat + 产品名 + 使用提示
85cba1e refactor: StatusBar 重写为 Top 状态行，Footer 重构为 3 行容器
a270989 feat: 新增 StatsLine 组件 — Footer Bottom 状态行
f65bc10 refactor: 快捷键精简为 Ctrl+C/T/E，移除 Leader 键体系
bf59a8f feat: Markdown 链接渲染 [text](url) + /export 命令注册
7465dbc feat: @file 搜索遵循 .gitignore 规则
df1aa3f feat: 模型列表从 kite-code.jsonc 动态加载
8f28919 feat: 新增 light 主题支持，ThemeContext
95d1ec7 fix: forceContextCompaction 确保配对完整性
6d0212a test: sanitizeToolCallPairs 7 个测试
fdddea7 fix: 移除自动恢复最近会话
... (14 commits total)
```

### 设计文档

- `understanding/2026-05-26-tui-claude-code-parity-design.md`
- `plans/2026-05-26-tui-claude-code-parity.md`
