# MCP 项目 Server 审批门禁 Phase 0 完成记录

状态：completed
实施日期：2026-07-15
计划：`../../plans/2026-07-15-mcp-project-server-approval-p0.md`
设计基线：`../../../design/2026-07-15-mcp-tui-management-center-rfc.md`
架构决策：`../../../adr/0009-project-mcp-local-approval.md`

## 完成内容

- 将 MCP 配置加载拆为 source-aware catalog，保留 user、project `.kite-code`、project `.mcp.json` 与 explicit 来源、effective 和 shadow 关系，同时保持 `project .kite-code > user > project .mcp.json` 兼容优先级。
- 建立 canonical workspace/source identity、domain-separated raw config SHA-256 digest 和 `~/.kite-code/mcp-project-approvals.jsonc` 原子 Approval Store。
- 在 `McpManager` 收到连接 Map 前移除 pending、rejected、invalid 和 store error 项目条目；高优先级项目条目被阻止时不回退同名用户条目。
- 项目批准只允许创建 transport。项目 `trust` 与逐 Tool effects、minimum approval、retry 放宽均被移除，保持 remote/unknown/user/never 的保守 Runtime Policy。
- `/mcp` 可在无连接状态下展示 source path、config digest 与不包含 env/header/参数内容的审阅信息；连续两次按 `a`/`r` 确认批准或拒绝，Esc 可取消确认。
- 新增 ADR-0009、当前规则、README、book 与 documentation map 更新。

## 安全证据

- 真实 stdio fixture 在 pending 时不产生启动 marker；批准后经生产 Approval Store、配置加载、Manager、Runtime 路径完成 discovery 和 Tool 调用。
- 真实 HTTP fixture 在 pending 时请求计数保持 0。
- Approval Store 不保存 raw config、command 或 secret，损坏文件不被覆盖并使项目来源 fail closed。
- expected digest 在决定写入前重新读取 source；配置变化返回 `config_changed`，旧决定不匹配新配置。
- 项目配置声明 `trust: trusted`、`minimumApproval: none` 或 `retry: safe_read` 后，有效连接配置仍为 untrusted 且没有 Tool override。

## 测试分层说明

真实 PTY 覆盖 `/mcp` 打开、pending 展示、首次确认不启动、二次键盘确认、记录写入和真实 stdio 启动。拒绝键路径由 Ink component test 覆盖，拒绝持久化、配置变化和 TOCTOU 由 Core 单测覆盖；没有为这些确定性状态重复建立更慢的 PTY 场景。HTTP endpoint 审阅投影只保留 origin，URL 其余部分、env/header 与参数内容不进入 TUI projection。

## 验证

- 默认测试：`1430 pass, 0 fail`。
- MCP/TUI 定向单元与组件全部通过，包含双按确认与审阅投影脱敏测试。
- 真实 E2E 与 PTY：`8 pass, 0 fail`。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`、`bun test tests/docs-space.test.ts` 与 `git diff --check` 通过。
- 本次涉及的 TypeScript/TSX 文件通过定向 Biome check。仓库级 `bun run format:check` 仍会报告既有的无关诊断（例如 `scripts/postinstall.js`、`CtrlSafeTextInput.tsx` 与 `useSessionList.ts`）；本次未扩大范围修改这些用户/基线问题。
- 项目 Skill `document-before-commit` 已执行文档影响审计；本次未暂存、提交、推送或创建 PR。

## 后续

完整 MCP 管理中心尚未完成。总计划继续保留为 active，下一阶段是 Phase 1：建立单一 SDK client 路径上的 `McpSupervisor`、不可变可订阅 control snapshot、typed/redacted diagnostics，以及响应式只读管理页。OAuth、配置编辑和 Tool Policy 不在本完成记录范围内。
