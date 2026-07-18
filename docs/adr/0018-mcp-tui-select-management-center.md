# ADR-0018：MCP TUI 使用可见 Select 管理流程

状态：accepted
日期：2026-07-18
决策者：@chenchao
替代：ADR-0012 的 `/mcp` 只读列表产品结论；ADR-0013 中认证只能由独立 App shell 提示启动、remove 保留 credential 的 TUI 生命周期结论

## 背景

ADR-0012 将 `/mcp` 收敛为只读状态列表，降低了配置副作用和交互复杂度，但也使用户无法从 Server 状态继续完成认证、重试、启停、移除和项目审批。现有独立认证与项目审批提示又使用 `l`、`a`、`r` 等功能键或同键二次确认，用户必须记忆状态相关快捷键，且 MCP 操作分散在列表外。

Core 已具备 source-aware 配置目录、typed mutation、项目摘要审批、Supervisor retry、OAuth Coordinator 和原生 Credential Store。新的 TUI 应复用这些能力，不建立第二条配置、认证或连接路径。

## 决策

### 统一输入模型

MCP TUI 的业务交互只使用：

```text
↑ / ↓    移动选择
Enter    打开、选择、确认
Esc      返回、取消、关闭
文本输入 仅用于名称、URL 和 command
```

取消 `A/L/R/D/Space/C/Y/N` 等 MCP 功能快捷键。文本编辑所需的字符输入、Backspace/Delete 和光标移动不属于业务快捷键。

按键先转换为页面级的 move、confirm、input 和 back action，再由当前 route 与选中选项解析为业务 command。按键处理不得直接调用 Supervisor、Repository、Approval Store 或 Auth Coordinator。

### 页面与导航

`/mcp` 继续只接受无参数形式，但打开可选择的管理 Overlay：

```text
Server List
  ├─ Server Detail
  │    ├─ Authenticate
  │    ├─ Retry/Reconnect
  │    ├─ Enable/Disable
  │    ├─ Remove confirmation
  │    └─ Project approval review
  └─ Add Server flow
```

Server List 只负责选择和导航。Enter 打开 Server Detail 或 Add Server；列表不能直接认证、重试、启停、删除或审批。

Server Detail 上半部分是只读、安全投影的信息，下半部分是按当前状态动态生成的 Select 操作菜单。Esc 等价于 Back。connecting/discovering 期间只允许 Back，离开详情不会取消后台连接。

Overlay route 至少区分 `server_list`、`server_detail`、`add_server`、`authenticate`、`project_approval` 和 `confirm`。列表、详情和通用 Select 分别拥有独立 selection；返回列表时恢复原 Server 位置，snapshot 变化时按稳定 Server key 保持选择，目标消失时才就近收敛。

### 状态与操作

TUI 从现有 `configStatus`、`authStatus`、`health` 和 typed diagnostic 派生单一主状态，不新增替代 Core 状态机。优先级固定为：

1. pending approval、rejected、disabled、invalid/store unavailable 等配置门禁；
2. authorizing、login/reauth required 和 auth error；
3. connecting/discovering、ready、degraded/half-open/circuit-open、failed/disconnected。

动态操作必须覆盖 ready、login required、retryable failure、non-retryable/config failure、disabled、pending approval、rejected、connecting/discovering。危险操作使用文字标识，不只依赖颜色；remove、disable、approve 和 reject 进入显式 Select 确认，默认选择 Cancel 或 Decide later。Enable 和 Retry 可直接进入 connecting。

### 添加与配置边界

MVP Add flow 只收集：

- HTTP 或 STDIO；
- Server name；
- HTTP URL 或 STDIO command；
- `Current project` 或 `All projects`。

`Current project` 写入本机 workspace 级 `local` 配置；`All projects` 写入 `user` 配置。TUI 不创建或修改共享 project `.mcp.json`，因此项目仓库不能通过 TUI 自行声明并批准 Server。外部发现的 project/project_legacy 配置仍必须经过摘要审批。

Add 不录入 args、cwd、env、headers、timeout、required、auth metadata、Tool policy 或 secret。高级配置继续由 JSONC 完成。名称与写入必须使用现有 Repository 校验、expected revision、JSONC edit 和原子写入。保存成功后进入新 Server Detail 并显示 connecting；冲突或写入失败保留 draft 并显示 typed error。

### 认证、审批和删除

HTTP login required 由 Server Detail 的 Authenticate 进入 Overlay 内认证流程。用户先在 Select 中选择 Open browser，之后显示 waiting、success 或 failure；Esc/Cancel 在 authorizing 时取消当前 flow。URL 只可按既有脱敏规则显示；token、authorization code、PKCE 和 credential material 永不进入 TUI state、日志或 Runtime Event。

项目审批从自动弹出的独立 App shell prompt 迁入 Server Detail。Review 页面继续展示 ADR-0009 允许的脱敏投影，Approve/Reject 继续绑定当前 config digest，并在写入前执行 TOCTOU 复核。Decide later/Esc 不记录决定，不创建 transport。

Remove 确认成功后删除选中 source 的配置和该 Server/source/profile 对应的本地凭据，但不默认发起远程 revoke。执行前必须确认 source 可写并完成 Credential Store 可用性检查；任一前置检查失败时不删除配置。配置删除成功而 credential cleanup 失败必须显示明确的部分失败诊断，不得宣称完全移除。Disable 保留配置与凭据。

### 分层与 Runtime 边界

- `src/core/` 不依赖 TUI route、Select 或展示类型；
- `McpServerViewModel`、route、selection、draft 和用户文案属于 App；
- TUI 只通过 App controller 调用 Supervisor、Repository、项目审批与认证公开能力；
- Runtime Provider Action、required-provider admission、turn binding、Tool approval、invocation 与 verification 语义不变；
- 认证、审批或重试成功只影响未来 capability snapshot，不重放旧 Tool Call。

## 影响

- `/mcp` 从无操作状态列表升级为可发现的 MCP 管理中心；
- 用户不再记忆 MCP 功能快捷键，所有操作通过可见选项完成；
- ADR-0012 保留为已实施历史，代码迁移完成前 active 文档仍描述当前只读行为；
- TUI controller 将重新暴露受约束的 retry、mutation、credential cleanup 和 approval/auth command；
- App shell 的自动 MCP auth/project prompt 在迁移完成后删除，Runtime 发起的 Provider Action/required admission 不受影响；
- 实施必须同步更新 MCP active 文档、README、book、HelpPanel 和 PTY 契约。

## 回滚

可以把 Overlay 回滚到只读列表，但不得回滚项目 transport 前置审批、配置 revision 冲突、原子写入、Credential Store secret 边界、generation 失效或 Runtime binding fail-closed。回滚时独立认证和项目审批入口必须先恢复，避免产生不可达状态。
