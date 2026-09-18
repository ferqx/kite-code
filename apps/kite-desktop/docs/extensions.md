# 设置中的 MCP 与 Skills

[设置](../src/Settings.tsx)按模型与 Provider、MCP、Skills 切换；[扩展面板](../src/Extensions.tsx)沿用 [TUI 扩展语义](../../../docs/handbook/clients/tui/guides/mcp-and-skills.md)。页面只消费现有 App Control，不能根据设计示例补造 Server、Skill、连接成功或安装状态。

[DesktopClient](../src/client.ts)通过同一个已连接的 App Server 请求 `getMcpSnapshot` 和 `getSkillCatalog`。首次打开对应分类时读取，用户可明确刷新；不常驻轮询。请求绑定当前 Workspace identity，断开清除快照，旧连接和被后发读取取代的响应不能回填当前页面。目录读取不安装 Skill、不添加配置、不启动认证。

MCP 展示真实来源、配置状态、健康状态、认证状态、安全连接元数据，以及已发现的工具。只有当前生效、启用且配置 ready 的 Server 显示操作：需要认证时可开始认证，存在认证 flow 时可取消；无需登录且尚未 ready 时可重新连接。操作携带所见 Server revision，经 `applyMcpAction` 提交一次。返回 applied 只表示该动作已受理，连接或认证是否完成仍看快照；完成浏览器认证后明确刷新。conflict、unavailable、rejected 和 outcome_unknown 均显示原位错误，异常时只尝试读取最新状态，不重放操作。认证流程、浏览器启动和凭据仍由 Service 既有 MCP owner 负责。

Skills 只展示实际目录中的名称、描述、来源、available／disabled／invalid 与诊断。当前没有安装接口，因此不提供安装按钮，也不把目录中的可用状态解释为任务已经使用该 Skill。MCP 添加、移除、启停、项目来源批准和专用模型诊断本轮未接入；没有不可用按钮占位。

Web 只读入口不提供这组 App Control 操作；共享页面不因此扩大 Browser principal 权限。扩展功能沿用既有 App Control、配置存储与凭据 owner；Electron 迁移只把桌面调用接到具名 preload bridge，没有新增业务协议或凭据 authority。

验证：[桌面 UI](../test/isolated/ui.test.tsx)核对真实状态展示、显式认证按钮及安装入口缺席；[协议导航回归](../test/navigation.test.ts)连接真实 App Server，核对两类快照、操作拒绝、丢失回执不重放和项目隔离；Service 的 [MCP owner](../../kite-service/test/isolated/app-control/mcp-owner.test.ts)与 [Skill owner](../../kite-service/test/isolated/app-control/skill-catalog-owner.test.ts)覆盖 CAS、动作分发、未知结果及目录隔离。HTML 测试数据预览不证明真实外部 Server 或 Electron 窗口已完成系统认证；[原生验收](native-validation.md)中的包内 OAuth 结果属于迁移前 Tauri 与配套 Service 的历史证据，不能替代 Electron 认证流程验收。
