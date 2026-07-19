# ADR-0014：MCP Tool 可见性与来源约束策略

状态：accepted
日期：2026-07-17
决策者：@chenchao
相关：ADR-0007、ADR-0009、ADR-0012

## 背景

MCP Server discovery 返回的 Tool 集合会动态变化。配置需要能够隐藏单个 Tool、声明本地 effect 和 minimum approval，并在安全条件满足时指定 retry；但远端 annotation、项目共享配置和只读 `/mcp` 视图都不能成为扩大授权的路径。仅在模型工具列表生成时过滤也不够，因为 Runtime 直接调用、control snapshot、旧 turn binding 和重试逻辑仍可能观察到不同策略。

## 决策

`McpManager` 保留 Server 返回的完整原始 Tool discovery，Runtime capability catalog 只发布 enabled 且 object-root schema 有效的 Tool。可见性按 `enabledTools` allowlist、`disabledTools` denylist、`tools.<name>.enabled` 精确 override 的顺序计算。filter 只改变 catalog 可见性，不产生执行授权；Manager 的调用入口再次要求当前 catalog 中存在可用 descriptor。

Tool descriptor 同时记录远端声明的 effects 和本地解析后的 effective effects。远端 annotation 默认只用于诊断；只有本地 trust 明确允许 read-only annotation 时，`readOnlyHint` 才能成为 effective read。`safe_read` 只有在全部 effective effect 都是 `none|read` 时才生效，`idempotency_key` 必须配置 key argument；否则执行策略降为 `never`。

local、user 和调用方授权的 explicit 配置可以声明完整 per-tool policy。project 与 project_legacy 配置在 transport 获批后仍只保留收紧项：allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never`；annotation trust、精确 enable、effect 降级、较低 minimum approval 和可重试策略全部忽略。

任意 filter 或 policy 配置变化进入 provider config digest，并重新生成 descriptor/catalog revision。旧 turn binding 不更新且 fail closed。Control snapshot 保留完整 discovery 投影，区分 discovered、enabled、available/quarantined，记录 declared/effective effects、annotation provenance、policy source、minimum approval 和 retry；配置引用但 discovery 不存在的 Tool 以 typed diagnostic 暴露，不导致整个 Server 失败。

ADR-0012 继续有效：TUI `/mcp` 不展示或编辑这些策略。策略通过 JSONC/Repository 配置，未来若增加新的管理前端，必须消费同一 Core contract。

## 备选方案

- 只在模型工具生成阶段过滤：无法保护直接 provider 调用，也不能使 control snapshot 与 binding revision 一致。
- 信任远端 annotation：Server 可自行降低 effect 与审批，违反本地授权边界。
- 项目配置全部丢弃：安全但无法让共享项目声明禁用危险 Tool；本决策保留只能收紧的子集。
- 恢复 `/mcp` Tool 编辑器：违反 ADR-0012 的只读产品边界。

## 影响

禁用或 schema 无效的 Tool 不进入 capability catalog，也不能通过 Manager 直接调用。缺失 Tool 引用保持可诊断，Server 其余能力继续可用。Policy 更新会使旧 binding 和旧 approval 失效，但不会回滚或自动重放已进入 provider 的调用。

## 回滚

可以移除配置字段或管理投影，但不得恢复远端 annotation 自动授权、项目来源放宽策略、无 revision 的动态 Tool 替换，或绕过当前 descriptor 的直接调用。回滚后不确定 Tool 必须保持不可见或回到 unknown/user/never 的保守策略。
