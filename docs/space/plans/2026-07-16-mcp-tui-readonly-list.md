# `/mcp` 只读连接列表纠偏实施计划

状态：archived
优先级：P0
创建日期：2026-07-16
来源：用户对 Phase 2 实际 TUI 交互的反馈
上游计划：[`2026-07-15-mcp-tui-management-center-implementation.md`](2026-07-15-mcp-tui-management-center-implementation.md)
依赖：ADR-0009、ADR-0010、ADR-0011、MCP Phase 0–2 已完成实现

## 一、结论

`/mcp` 不再是配置管理中心，只是当前 workspace 的 MCP 连接状态视图。命令不接受 Server 名称或管理子命令，Overlay 不提供选择、详情、搜索、添加、编辑、启停、删除、迁移、重试、重载或审批操作。

目标交互固定为：

```text
输入 /mcp
→ 显示当前 effective MCP Server
→ 每行只显示 Server 名称与连接状态
→ Esc 关闭
```

MCP scope 由配置文件位置推导，不是 TUI 表单字段。TUI 不创建、修改或删除 MCP 配置。项目配置的摘要审批仍是 transport 前置安全门禁，但迁移为独立的配置加载信任提示，不属于 `/mcp`。

## 二、产品契约

### 2.1 `/mcp` 唯一命令形态

只支持：

```text
/mcp
```

以下形式全部移除，不再导航或执行动作：

```text
/mcp <server>
/mcp add
/mcp retry <server>
/mcp reload
/mcp enable <server>
/mcp disable <server>
/mcp remove <server>
/mcp approve <server>
/mcp reject <server>
```

带参数的 `/mcp ...` 返回普通 unknown/usage 提示，不静默降级为 `/mcp`，避免用户误以为动作已执行。静态 slash suggestion、HelpPanel 与 README 统一描述为“查看 MCP 连接状态”。动态 MCP Prompt 命令 `/mcp__<server>__<prompt>` 不在本计划范围内。

### 2.2 列表内容

列表只投影 effective Server；shadowed 重复来源不进入该视图。每行仅包含：

```text
[status] server-name
```

状态从现有 control snapshot 投影，不由 TUI 推断：

- `connecting`：连接或 discovery 进行中；
- `ready`：连接与 discovery 成功；
- `degraded`：连接可用但 discovery/health 有诊断；
- `disconnected`：未连接或连接失败；
- `disabled`：配置禁用；
- `pending-approval` / `rejected` / `invalid`：配置门禁尚未允许连接。

不显示 transport、source/scope、tool count、Resources、Prompts、config digest、URL、command 或诊断详情。空列表显示 `No MCP servers configured.`。列表超出可用高度时只允许 Up/Down 滚动窗口；滚动不形成 Server selection，也不能触发动作。

### 2.3 配置与 scope 边界

`local`、`project`、`user` 继续是 Core 配置来源语义，由路径发现决定。TUI 不暴露 scope 选择，也不调用 `McpConfigRepository.mutate()`。

本计划只调整 TUI 职责，不同时迁移配置路径。当前 canonical project 来源仍以 ADR-0011 和 active 规则为准。若后续确认将 project 配置统一到 `<workspace>/.kite-code/mcp.json`，必须另建 ADR 和迁移计划，处理现有 `.mcp.json`、legacy `.kite-code/kite-code.jsonc`、优先级与旧 config-digest 决定的兼容。

配置 reload 仍由 watcher 和 Supervisor reconcile 自动完成。移除 `/mcp reload` 后，watcher 不可用时的人工恢复方式是重启 TUI；如需无重启恢复，应另行提供 CLI 配置命令，不能重新塞回 `/mcp`。

### 2.4 project 配置审批迁移

项目配置仍不得在批准前创建 stdio/HTTP transport。现有 config digest、Approval Store、TOCTOU 复核和保守 Tool Policy 均保持不变。

新的交互归属为独立 `McpProjectTrustPrompt`（命名可在实现时调整）：

1. Supervisor 发布 pending project config；
2. App shell 在 `/mcp` 之外排队展示脱敏信任提示；
3. approve/reject 继续二次确认并绑定当前 config digest；
4. Esc 仅延后本次提示，Server 保持 pending，不能启动 transport；
5. 配置 digest 变化后重新进入提示队列；
6. 已批准、已拒绝和历史兼容记录继续复用现有 Store。

在独立信任提示完成前，不得删除 `/mcp` 现有 approval route，否则 project MCP 会变成不可恢复的永久 pending。

## 三、非目标

- 不改变 `McpManager`、SDK client、generation 或 Runtime binding；
- 不删除 Core `McpConfigRepository`、watcher、atomic mutation 或三层来源能力；
- 不在本计划中实现 OAuth、Credential Store、Tool Policy 编辑或 Marketplace；
- 不迁移 project/user/local 配置文件路径；
- 不把连接诊断、Tool/Resource/Prompt 详情换到其他 `/mcp` 子页面；
- 不改变动态 MCP Prompt 命令和 Runtime capability disclosure。

## 四、实施步骤

### Task 1：新增替代 ADR 与交互契约测试

状态：completed

改动：

- 新增 ADR，替代 ADR-0011 中“通过 TUI mutation”和“`/mcp reload`”的 UI 结论，但不改写 ADR-0011 历史；
- 固化 `/mcp` 无参数契约、只读列表字段和 project approval 独立归属；
- 先修改 parser/component 测试表达新目标，保留 project transport 零副作用测试。

涉及：

- `docs/adr/0012-mcp-tui-readonly-list.md`；
- `tests/tui-slash-command.test.ts`；
- `tests/mcp-panel.test.tsx`。

验证：新测试在实现前应针对现有管理子命令和详情路由失败；ADR 通过 `bun run check:docs`。

### Task 2：迁移 project trust prompt

状态：completed
依赖：Task 1

改动：

- 将 approval route 从 MCP Overlay 移到 App shell 的独立 trust prompt；
- 复用现有 `McpController.decide()`、config digest 与双确认规则；
- 建立 pending 队列、Esc defer 和配置变化重新提示行为；
- 保证 prompt 尚未 mount、被取消或 TUI 重启时均不创建 transport。

涉及：

- `src/app/tui/App.tsx`；
- `src/app/tui/index.tsx`；
- `src/app/tui/mcp/controller.ts`；
- 新增 `src/app/tui/mcp/McpProjectTrustPrompt.tsx`；
- `tests/mcp-panel.test.tsx`；
- `tests/tui-system/scenarios/mcp-project-approval.test.ts`。

验证：真实 PTY 证明 project stdio/HTTP 在批准前零进程/零请求，批准后才连接；Esc 后保持 pending。

### Task 3：收敛 slash command

状态：completed
依赖：Task 2

改动：

- `McpSlashCommand` 收敛为无子命令 `/mcp`；
- 移除 `initialServer`、`initialCommand` 与 `onMcpCommand` 路由参数；
- 删除管理子命令解析、suggestion 和帮助文案；
- `/mcp ...` 明确返回 unknown/usage，不打开 Overlay。

涉及：

- `src/app/tui/hooks/useSlashCommand.ts`；
- `src/app/tui/hooks/useSlashSuggestions.ts`；
- `src/app/tui/components/HelpPanel.tsx`；
- `src/app/tui/App.tsx`；
- `src/app/tui/index.tsx`；
- `tests/tui-slash-command.test.ts`；
- `tests/slash-suggestions.test.ts`；
- `tests/tui-system/scenarios/slash-commands.test.ts`。

### Task 4：将 Overlay 降为只读状态列表

状态：completed
依赖：Task 3

改动：

- `McpOverlay` 只订阅 snapshot、过滤 effective Server 并渲染状态行；
- 移除 list selection、search、detail 和全部子 route；
- 删除 TUI Add Wizard、Confirm Dialog、Error/Tool/Resource/Prompt 子视图及其只为路由服务的 reducer state；
- 仅保留 Esc close 和超长列表滚动；
- TUI 不再调用 add/setEnabled/remove/migrate/reload/retry/decide，`decide` 只由独立 trust prompt 使用。

涉及：

- `src/app/tui/mcp/McpOverlay.tsx`；
- `src/app/tui/mcp/McpServerList.tsx`；
- `src/app/tui/mcp/reducer.ts`；
- `src/app/tui/mcp/types.ts`；
- `src/app/tui/mcp/McpAddWizard.tsx` 等不再使用的管理组件；
- `tests/mcp-overlay-reducer.test.ts`；
- `tests/mcp-panel.test.tsx`。

验证：component snapshot 只包含 status/name；断言不出现 transport、source、tool count 和操作提示。

### Task 5：PTY、文档与清理

状态：completed
依赖：Task 4

改动：

- 用只读 `/mcp` PTY 场景替换配置管理场景；
- 保留 Core Repository、watch/reconcile 与 project approval 测试，不因 TUI 删除而弱化；
- 更新 active MCP 规则、README、book 08/09/11、HelpPanel 和 documentation map 影响；
- 将当前 local HTTP Wizard 校正记录保留为历史，不改写其完成事实；新增本计划完成记录。

涉及：

- `tests/tui-system/scenarios/mcp-config-management.test.ts`（改名或替换）；
- `tests/tui-system/scenarios/mcp-management-readonly.test.ts`；
- `docs/active/mcp-control-plane.md`；
- `docs/active/mcp-config-management.md`；
- `docs/active/mcp-project-approval.md`；
- `README.md`、`docs/book/08-TUI交互全景.md`、`docs/book/09-CLI模式与配置.md`、`docs/book/11-MCP与Skills扩展.md`。

验证：

```bash
bun test tests/mcp-config-repository.test.ts tests/mcp-config-reconcile.test.ts tests/mcp-project-approval.test.ts tests/mcp-supervisor.test.ts tests/mcp-panel.test.tsx tests/tui-slash-command.test.ts tests/slash-suggestions.test.ts
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts tests/tui-system/scenarios/slash-commands.test.ts
bun run typecheck
bun run check:core-boundary
bun run check:docs-impact
bun run check:docs
git diff --check
```

提交前必须执行项目 `document-before-commit` Skill；任一文档门禁失败时不得提交。

完成记录：[`../execution/completed/2026-07-16-mcp-tui-readonly-list.md`](../execution/completed/2026-07-16-mcp-tui-readonly-list.md)。

## 五、验收标准

1. `/mcp` 只显示 effective MCP Server 的名称与连接状态；
2. `/mcp` 不接受参数或管理子命令；
3. Overlay 不存在可触发配置、连接或审批副作用的键位；
4. TUI 不写 MCP config，scope 完全来自 Core source discovery；
5. shadowed Server、transport、source、tool count、Tools/Resources/Prompts 和诊断详情不出现在 `/mcp`；
6. project Server 未批准前 transport 零副作用；
7. project approval 可在独立 trust prompt 完成，Esc 不会批准或拒绝；
8. watcher/reconcile、revision conflict、provider version 和旧 binding fail-closed 行为保持；
9. 动态 MCP Prompt 命令与 Runtime capability 行为无回归；
10. unit/component/PTY、typecheck、Core boundary 和文档门禁全部通过。

## 六、风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 先删除 approval route | project MCP 永久 pending | Task 2 必须先于只读 Overlay cutover |
| 移除 `/mcp reload` 后 watcher 失效 | 配置不能即时恢复 | 重启 TUI 作为明确 fallback；后续需要时建设 CLI 命令 |
| 误删 Core mutation | 外部配置工具和原子安全能力退化 | 只删除 TUI 调用面，不删除 Repository |
| 过滤 shadowed 后排障信息减少 | 用户无法从 `/mcp` 看 precedence | 本计划接受该取舍；排障由日志或未来 CLI diagnostics 承担 |
| status 映射丢失门禁原因 | pending/invalid 被误认为网络失败 | 连接状态枚举必须覆盖 config gate 状态 |

回滚时可恢复旧 Overlay 展示代码，但不得恢复任何绕过 config digest、TOCTOU 或 transport 前置审批的路径。
