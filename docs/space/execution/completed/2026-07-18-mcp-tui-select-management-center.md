# MCP TUI Select 管理中心实施记录

状态：completed
完成日期：2026-07-18
对应 ADR：`docs/adr/0018-mcp-tui-select-management-center.md`
对应计划：`docs/space/plans/2026-07-18-mcp-tui-select-management-center.md`

## 完成范围

- `/mcp` 改为基于 Select 的 MCP 管理中心，仅使用方向键、Enter、Esc 与文本输入完成交互。
- Server List 只承担选择与进入详情；Server Detail 使用动态动作菜单承载登录、重试、启停、审批与删除。
- 新增五步 Add Server 流程，支持当前项目与全局作用域，以及 HTTP 与 stdio 配置。
- 登录、项目审批、停用和删除均改为显式选择；危险操作默认落在取消或稍后决定。
- 移除旧的自动登录提示、自动项目审批提示和业务快捷键入口。
- 补齐 Supervisor 的添加、启停、删除与凭据清理编排，并保持 Core 不依赖 TUI 类型。
- 同步 README、`docs/active/`、书稿、ADR 索引及历史方案状态。

## 安全与兼容性

- 未经用户明确选择，不打开浏览器、不启动待审批的项目 MCP、不停用或删除服务。
- 删除配置后尝试清理本地凭据；凭据清理失败会明确报告部分成功，不静默吞掉错误。
- Required Provider admission 与运行期 Provider Action 继续保留，避免将管理中心变成唯一恢复入口。

## 验证

- TypeScript 类型检查通过。
- Core 边界检查通过。
- 文档影响检查与文档一致性检查通过。
- MCP 面板单元测试、Supervisor/配置相关测试以及 MCP TUI PTY 场景通过。
- 变更文件 Biome 检查与 `git diff --check` 通过。
