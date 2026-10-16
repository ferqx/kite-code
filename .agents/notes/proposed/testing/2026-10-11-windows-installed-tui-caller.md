# Agent Note: Windows installed TUI 完整用户调用者

Status: proposed

## Problem

Windows installed Terminal 的现有 qualification 只核 TUI help/version；POSIX PTY 不能验证 Windows 实际键盘、私有草稿、完整输出与正常退出。源码还在九份私有文件采用 POSIX uid／mode／目录 fsync，可能在首个用户提交或冷草稿读取前拒绝。完整用户能力不能由单个 journal 或模块 mock 宣告迁移完成。

## Proposal

私有文件已按 [原分角色决定](../architecture/2026-10-04-windows-private-and-workspace-scope-paths.md)迁入 Windows record 端口。新增 [installed caller](../../../../tests/fixtures/unified-agent/windows-installed-tui.qualification.ts)只消费 release job 准确 Terminal／Native 候选，同一稳定前门先独立选择、再登记 Native。固定原 candidate Bun driver 在创建前纳入原 Job，再创建真实 ConPTY；父只接受闭合有序 frame 和完整输出，成功要求自然退出、全部 EOF／Job0／严格 Close 及未请求 Terminate。

当前已实现完整源码与 mandatory CI，Windows 尚未实际执行，故保 proposed。完整合同和预算归 [Terminal owner](../../../../apps/cli/docs/terminal-release.md#windows-installed-tui-正式调用者)，有限日志与失败归 [进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11windows-installed-tui-私有持久化与正式调用者)。

客户端测试调试功能与 dev／prod 隔离后，该 installed caller 使用普通用户界面，不传测试诊断参数。正常界面自动读取完整正文，测试从原生终端解析缓冲核原全文与完成后的思考摘要；精确 ID 展示和 preview→Ctrl+O 读取过程由隔离 host fixture 验证，不能向正式前门重新加入公开测试开关。

## Alternatives considered

- 复用 POSIX PTY 或 help/version：不能验 Windows ConPTY、首个持久提交／草稿、精确取消和冷读，保持原工具范围并新增完整 caller。
- 直接创建产品后再纳入 Job，或用数字 PID 清理：有创建到归属之间的空窗，PID 不证明所有权；选创建前原 Job／原 HANDLE driver，关闭未知保原 owner。
- 直接把原始 stdout 的历史字串当画面：思考隐藏后旧输出仍存在，完整正文也可能把思考滚到可视范围之外；以当前解析后的 VT 缓冲绑定原 complete Message，读取该位置，再回到底部核当前 Idle。
- 给产品加入 preload／测试存储入口：会绕过已安装前门和所选模块；仅 driver 用已核测试入口，产品固定稳定前门、真实 HTTP／SQLite，污染环境单独隔离。
- 为保留诊断画面而开放正式启动开关，或另打诊断候选替代正式候选：前者违反客户端测试功能隔离，后者改变所证明的产物；保留真实普通产品入口并适配其 UI 断言，诊断专属断言继续在隔离 fixture 核对。

## Acceptance criteria

实际 Windows x64 从稳定 `kite-tui.exe` 完成两种选择下的提交、普通界面自动读取完整正文、完成后思考摘要与原已加载 Markdown 导出、准确第二项 Command 取消、未提交完整 Unicode 草稿、Ctrl+Q 普通退出及同会话冷读。原 Store／Command／Run／Execution／完整输出与 Provider／cursor／journal／草稿／配置原字节分别独立核对，冷读零重放。原 TUI／Service 必须同 Job 原成员／FILETIME／准确映像；退出须全部 EOF、Job0／wait／strict Close、未 Terminate 和安装 EX。原第二个已取消 Model 的未完成 preview 不误判为全文加载失败。

各选择 120 秒、各 PTY 30 秒、写操作最多 10 秒；Native 撤登记后独立前门仍存在，最后两种卸载保原 Profile 数据。CI 不允许错平台／候选、过滤、忽略失败、删除步骤或先于 build／verify／smoke。无 native availability skip；Win/Linux 实机按用户安排交后续 GitHub Actions。

## Risks

本机 macOS 只证明适用原测试、Close mock、惰性导入、类型与 CI 接线；ConPTY、Bun 当前 Terminal 实现、DACL／private read/write、嵌套 Job 及安装原生结果尚待 Windows。此 caller 不是两个真实代码版本、完整 Shell／MCP 或恢复发布中断矩阵；原 RSS 红、全 Runtime census／activeResources／handles、Shell 原合同 guard 和阶段退出仍未闭合。来源及错误不因新增文档变成资格证据。
