# MCP 项目 Server 审批门禁 Phase 0 实施计划

状态：archived
优先级：P0
创建日期：2026-07-15
代码基线：`mcp` / `41585a14dcf3`
来源：[`../../design/2026-07-15-mcp-tui-management-center-rfc.md`](../../design/2026-07-15-mcp-tui-management-center-rfc.md)
父计划：[`2026-07-15-mcp-tui-management-center-implementation.md`](2026-07-15-mcp-tui-management-center-implementation.md)
依赖：ADR-0007、ADR-0009、当前 MCP Runtime Governance
分类：Capability + Policy + Lifecycle
完成记录：[`../execution/completed/2026-07-15-mcp-project-server-approval-p0.md`](../execution/completed/2026-07-15-mcp-project-server-approval-p0.md)

## 一、目标

在不实现完整 MCP 管理中心的前提下，先关闭当前最危险的启动缺口：项目仓库中的 MCP 配置必须经过本地用户按配置摘要批准，未批准前不得创建 transport、启动 stdio 进程或向 HTTP Server 发出请求。

本计划交付：

1. 保留来源信息的最小 MCP 配置目录；
2. canonical workspace identity 与稳定 config digest；
3. 用户目录中的项目 MCP 批准/拒绝记录；
4. TUI 启动连接前的强制审批门禁；
5. `/mcp` 中最小审批详情和批准/拒绝操作；
6. 配置变化后旧批准失效；
7. 项目配置不能借启动批准取得 annotation trust、低风险 effect 或放宽 retry；
8. 单元、真实 transport integration 和 PTY 测试；
9. 同批 active、book、README、ADR 和 documentation map 更新。

最终安全性质：

```text
未批准项目配置
  ⇒ transport 从未创建
  ⇒ stdio 子进程从未启动
  ⇒ HTTP 请求从未发送
  ⇒ Capability Catalog 中没有该 Server 的可执行 descriptor
```

## 二、执行前置条件

以下设计决策已于 2026-07-15 获得实施授权，并由 ADR-0009 固化：

1. 项目 MCP 本地审批是不可关闭的安全行为；
2. 项目执行批准与 annotation trust 完全分离；
3. legacy project source 只保留兼容读取，不静默迁移；
4. control-plane 审批状态不写入任务 Runtime Event；
5. Phase 0 不实现 OAuth、三层 scope 或 Tool 策略编辑器。

ADR-0009 已接受；本计划进入 `active`，从配置基线测试和 transport 前置门禁开始实施。

## 三、准入分类与最低证据

根据 `docs/active/core-entry-criteria.md`：

| 分类 | 本计划影响 | 最低证据 |
| --- | --- | --- |
| Capability | 改变哪些 MCP Server 可进入 discovery/catalog | 配置与 MCP integration test |
| Policy | 项目 Server 是否允许启动由本地批准决定 | state diagram、安全单测、架构审核 |
| Lifecycle | 配置发现 → pending → approved/rejected → connect | 状态迁移测试、PTY 闭环、ADR |
| Engine | 不修改 Runtime Kernel、checkpoint、model loop | 不新增 Runtime feature flag |

本计划不新增可关闭 feature flag。项目执行门禁是安全修复，不能在 flag 关闭时回到自动执行项目 MCP 的旧路径。

## 四、当前基线与兼容约束

### 4.1 当前配置来源

当前 `loadMcpConfig()` 实际读取：

1. `~/.kite-code/kite-code.jsonc#mcpServers`；
2. `<workspace>/.kite-code/kite-code.jsonc#mcpServers`；
3. `<workspace>/.mcp.json#mcpServers`；
4. 测试或调用方传入的显式 `configPath`。

当前合并行为必须先用 characterization test 固化：

```text
project .kite-code > user kite-code > project .mcp.json fallback
```

这里描述的是 Phase 0 兼容优先级，不是 RFC 的目标 `local > project > user`。三层 scope 与 precedence 迁移属于后续 Phase 2。

### 4.2 Phase 0 来源枚举

```ts
type McpConfigSourceKind =
  | 'user'
  | 'project_kite_code'
  | 'project_mcp_json'
  | 'explicit';
```

Phase 0 将 `project_kite_code` 和 `project_mcp_json` 都视为项目来源并强制审批。`explicit` 只表示调用方明确传入的单一配置文件，保持现有测试/CLI 显式输入语义；生产 TUI 默认路径不得使用 `explicit` 绕过项目来源检测。

### 4.3 遮蔽语义

同名高优先级项目 Server 处于 pending/rejected 时，不自动回退连接低优先级用户 Server。否则用户看到并审批的是项目配置，实际却可能调用另一个同名 Server。

目录同时保留：

- 所有 source entry；
- 当前 effective entry；
- 被遮蔽 entry；
- effective entry 的 approval status；
- 只包含 connectable Server 的连接 Map。

### 4.4 显式不改动

- 不改变 user source MCP 的现有启动行为；
- 不改变 `McpManager` 的 SDK、discovery、binding 或调用实现；
- 不改变 `.mcp.json` 的 raw 文件格式；
- 不新增 local scope；
- 不实现配置写入、enable/disable、add/remove；
- 不实现 OAuth 或 Credential Store；
- 不建立完整 `McpSupervisor`；
- 不把 project approval 复用为 Runtime Tool Approval。

## 五、状态机

### 5.1 项目配置状态

```text
                     config changed
                  ┌──────────────────┐
                  │                  ▼
discovered ──→ pending_approval ──→ approved ──→ connectable
                    │       ▲           │
                    │       │           ├─ connect failed → approved + connection error
                    │       │           │
                    └─→ rejected ───────┘
                         config changed
```

规则：

1. 没有匹配当前 digest 的记录时为 `pending_approval`；
2. `approved` 只表示允许创建 transport，不表示连接成功；
3. `rejected` 不创建 transport；
4. 配置变化产生新 digest，旧 approved/rejected 都不再匹配，重新 pending；
5. source file invalid 时为 `invalid`，不允许批准；
6. approval store 损坏或不可读时 fail closed，项目 Server 全部不可连接；
7. 被遮蔽项目 entry 不启动，也不要求立即审批；成为 effective 后再进入审批状态。

### 5.2 审批操作的 TOCTOU 约束

```text
用户打开详情（digest A）
→ 用户按批准
→ 重新读取 source file
   ├─ 仍为 digest A → 原子写入批准记录
   └─ 已为 digest B → 返回 config_changed，不写入 A 的新批准
→ 再次加载 catalog
→ 只有 record digest == effective digest 时进入 connectable Map
```

即使配置在批准记录写入后再次变化，新 catalog 也不会匹配旧 digest，因此不能启动变化后的配置。

## 六、核心数据契约

### 6.1 Source entry

建议在 `src/core/config/mcp-config.ts` 定义 Core 中立类型：

```ts
interface McpConfigSource {
  kind: McpConfigSourceKind;
  path: string;
  workspace: string;
}

interface McpServerConfigEntry {
  name: string;
  source: McpConfigSource;
  rawConfig: Readonly<Record<string, unknown>>;
  normalizedConfig?: McpServerConfig;
  configDigest?: string;
  diagnostics: readonly McpConfigDiagnostic[];
}

interface McpConfigCatalog {
  entries: readonly McpServerConfigEntry[];
  effective: ReadonlyMap<string, McpServerConfigEntry>;
  connectableServers: Readonly<Record<string, McpServerConfig>>;
  projectApprovals: readonly McpProjectServerApprovalView[];
}
```

`rawConfig` 只在 Core 内存中用于 digest、详情和诊断，不进入 Runtime Event 或 session log。TUI 接收单独的脱敏 view，不直接接收 raw config。

### 6.2 Approval record

建议文件：

```text
~/.kite-code/mcp-project-approvals.jsonc
```

建议 schema：

```ts
interface McpProjectApprovalFileV1 {
  version: 1;
  records: Record<string, McpProjectApprovalRecord>;
}

interface McpProjectApprovalRecord {
  workspaceKey: string;
  serverName: string;
  sourceKind: 'project_kite_code' | 'project_mcp_json';
  sourcePathDigest: string;
  configDigest: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}
```

Map key 使用 `sha256(workspaceKey + sourceKind + serverName)`；字段仍显式保存，便于校验和审计。记录不保存 command、args、URL、env、header、token 或 raw config。

### 6.3 Workspace identity

`workspaceKey`：

1. 对 workspace 执行 `realpathSync.native()`；
2. 统一路径分隔符为 `/`；
3. Windows 下规范化 drive letter 和大小写；
4. 对规范化绝对路径做 domain-separated SHA-256；
5. 不使用 Git remote 作为身份，避免 remote 改动、fork 和无 Git workspace 漂移；
6. 不同 worktree 默认分别审批。

### 6.4 Config digest

使用独立版本域：

```text
sha256("kite-mcp-project-approval-v1\0" + canonicalJson(input))
```

输入至少包含：

- server name；
- source kind；
- transport type；
- command、args、cwd；
- URL；
- env/header 的键与 raw 引用表达式；
- auth、timeout、trust 和 Tool policy raw 字段；
- 未识别字段，以保证项目新增行为字段时旧批准默认失效。

摘要基于 raw JSON 值、排序后的对象键和保持顺序的数组。它不包含展开后的环境变量值，避免 secret digest 持久化；环境变量值由本地用户环境控制，项目对引用表达式的修改仍会触发重新审批。

### 6.5 项目策略收紧

项目执行批准不能让仓库自行取得安全信任。Phase 0 对项目来源生成 connectable config 时：

- 强制忽略项目 `trust`；
- 不采纳项目 `tools.*.effects` 的风险降低；
- 不采纳项目 `minimumApproval: none|auto_review`；
- 不采纳项目 `safe_read`/`idempotency_key` 自动重试放宽；
- 默认回到 `UNKNOWN_EXTERNAL_EFFECTS`、`minimumApproval: user`、`retry: never`；
- raw 字段仍进入 config digest 和诊断，防止无提示变化。

Phase 0 不建立本地 Tool policy override UI。需要降低风险、允许 annotation 或配置 retry 的 Server 继续使用 user source；完整 source-aware policy merge 留给 Phase 4。

## 七、实施任务

### Task 0：冻结基线并新增 ADR

状态：completed

改动：

1. 在 `tests/config.test.ts` 增加当前 MCP 来源和同名 precedence characterization；
2. 覆盖 user、project `.kite-code`、`.mcp.json` 和 explicit path；
3. 证明当前 project `.kite-code` 覆盖 user，而 `.mcp.json` 只补充缺失名称；
4. 新增 `docs/adr/0009-mcp-project-server-approval.md`；
5. ADR 决定审批存储、digest、不可关闭门禁、trust 分离和 control-plane 边界。

涉及文件：

- `tests/config.test.ts`
- `docs/adr/0009-mcp-project-server-approval.md`
- `docs/adr/README.md`

依赖：无。

验证：

```bash
bun test tests/config.test.ts
bun run check:docs
```

检查点：新增 characterization 在未改生产代码时通过；ADR 接受后才开始 Task 1。

### Task 1：建立 source-aware MCP 配置目录

状态：completed

改动：

1. 新增 `src/core/config/mcp-config.ts`，分别读取各 MCP source；
2. 从 raw JSONC 提取每个 Server，保留 source path、source kind 和 raw entry；
3. 导出或复用现有 `mcpServerSchema` 与 normalize 逻辑，避免两套校验；
4. 生成 entries/effective/shadowed，但暂不应用 approval；
5. 保持现有 precedence 和 explicit config 行为；
6. `loadMcpConfig()` 先保留兼容返回类型，由内部 catalog 投影 `servers`；
7. invalid entry 进入 diagnostics，不因一个 Server 损坏而执行其他同文件项目 Server 前绕过审批。

涉及文件：

- 新增 `src/core/config/mcp-config.ts`
- 修改 `src/core/config/index.ts`
- 修改 `src/core/config/paths.ts`（仅为后续 approval path 导出预留）
- 新增 `tests/mcp-config-catalog.test.ts`
- 修改 `tests/config.test.ts`

依赖：Task 0。

验证：

```bash
bun test tests/config.test.ts tests/mcp-config-catalog.test.ts
bun run typecheck
bun run check:core-boundary
```

检查点：在尚未接入审批时，catalog 投影的有效 Server 与现有 `loadMcpConfig().servers` 完全一致。

### Task 2：实现 workspace identity 与 config digest

状态：completed

改动：

1. 新增 domain-separated canonical hash；
2. 实现 workspace realpath 规范化；
3. 对 raw config 计算 digest，不对展开后的 secret 值计算持久 digest；
4. object key 排序、array 顺序保留；
5. 未识别字段纳入 digest；
6. 为 symlink、Windows drive normalization、key order、array order 和 env 引用变化增加测试；
7. 确认技术 diagnostic 不包含 raw secret value。

涉及文件：

- `src/core/config/mcp-config.ts`
- 新增 `tests/mcp-project-approval.test.ts`

依赖：Task 1。

验证：

```bash
bun test tests/mcp-project-approval.test.ts
bun run typecheck
```

检查点：语义相同但对象键顺序不同的配置 digest 相同；command/args/URL/env 引用或未知字段变化时 digest 不同。

### Task 3：实现本地 Approval Store

状态：completed

改动：

1. 新增 `src/core/config/mcp-project-approvals.ts`；
2. 在 `paths.ts` 增加 approval store path；
3. 使用版本化 schema 读取 records；
4. 提供 list/get/decide API，decide 接收 expected digest；
5. 写入使用同目录临时文件、flush/close、mode `0600` 和 atomic rename；
6. approval store 不存在时返回空记录；
7. 文件损坏、版本未知、权限错误时返回 typed diagnostic 并 fail closed；
8. 不覆盖损坏文件，不静默重建；
9. reject 与 approve 使用同一原子写路径；
10. mutation 前重新读取 source 并验证 expected digest，关闭 TOCTOU。

建议接口：

```ts
type McpProjectDecisionResult =
  | { ok: true; record: McpProjectApprovalRecord }
  | {
      ok: false;
      code: 'config_changed' | 'approval_store_corrupt' | 'approval_store_unavailable';
    };
```

涉及文件：

- 新增 `src/core/config/mcp-project-approvals.ts`
- 修改 `src/core/config/paths.ts`
- 修改 `src/core/config/index.ts` 的 exports
- `tests/mcp-project-approval.test.ts`

依赖：Task 2。

验证：

```bash
bun test tests/mcp-project-approval.test.ts
bun run typecheck
bun run check:core-boundary
```

检查点：批准文件不包含 raw config、command、token 或 env value；配置在用户确认前变化时返回 `config_changed`。

### Task 4：在连接前应用审批和项目策略门禁

状态：completed

改动：

1. catalog 对 effective project entry 查询 Approval Store；
2. 仅 matched approved entry 进入 `connectableServers`；
3. pending/rejected/invalid/shadowed 不进入连接 Map；
4. project entry 转为 Manager config 前应用保守策略：untrusted、unknown effects、user approval、never retry；
5. 保持 user/explicit source 当前 policy 行为；
6. 修改 `useMcpConnection` 只把 `connectableServers` 传给 `connectAll()`；
7. 更新所有生产调用方和 fixture，禁止再次从 raw merged Map 直接 connect；
8. approval store 出错时 user Server 仍可连接，但所有 project Server fail closed并显示诊断；
9. 不向 Runtime 发送 project approval event。

涉及文件：

- `src/core/config/mcp-config.ts`
- `src/core/config/mcp-project-approvals.ts`
- `src/core/config/index.ts`
- `src/app/tui/hooks/useMcpConnection.ts`
- `tests/fixtures/run-mcp-e2e-client.ts`
- `tests/e2e/mcp-skills-auth-scopes.test.ts`

依赖：Task 3。

验证：

```bash
bun test tests/config.test.ts tests/mcp-config-catalog.test.ts tests/mcp-project-approval.test.ts
bun test tests/e2e/mcp-skills-auth-scopes.test.ts
bun run typecheck
```

检查点：现有 user HTTP MCP E2E 不变；project stdio E2E 必须先通过生产 Approval Store API 预置匹配批准后才能启动。

### Task 5：增加真实 transport 安全回归

状态：completed

改动：

1. 新增启动即写 marker 的 stdio MCP fixture；
2. 对 `.mcp.json` 和 project `.kite-code` 分别验证未批准时 marker 不存在；
3. 验证 approved 后进程启动并完成 discovery；
4. 修改 command/args/env raw 引用后验证旧批准失效，新的 marker 不产生；
5. rejected 时不启动；
6. malformed approval store 时不启动；
7. 增加 HTTP fixture，请求计数在 pending/rejected 时保持 0；
8. 扫描 stdout/stderr、approval file、Runtime events，确保 secret 不出现。

涉及文件：

- 新增 `tests/fixtures/mcp-startup-marker-server.ts`
- 新增 `tests/e2e/mcp-project-approval.test.ts`
- 复用或扩展现有 authenticated MCP fixture

依赖：Task 4。

验证：

```bash
bun test --parallel=1 --max-concurrency=1 tests/e2e/mcp-project-approval.test.ts
bun test tests/e2e/mcp-skills-auth-scopes.test.ts
```

检查点：测试必须证明“进程/请求从未发生”，不能只断言 Capability 不可见。

### Task 6：实现最小 TUI 审批入口

状态：completed

改动：

1. `useMcpConnection` 保存 catalog 的 project approval projection；
2. 暴露 `approveProjectServer(expectedDigest)`、`rejectProjectServer(expectedDigest)` 和 reload；
3. `/mcp` 空连接状态仍显示 pending/rejected/invalid project entry；
4. 在 `McpPanel` 中增加最小 selected row 和 approval detail，不建设完整三层管理路由；
5. Detail 显示 Server name、source path、transport、raw command/args 或 URL 的脱敏预览、config digest 短前缀和风险警告；
6. `a` 批准、`x` 拒绝、`Esc` 返回；批准/拒绝前有明确确认；
7. 批准成功后 reload catalog，并只连接刚变为 connectable 的 Server；
8. `config_changed` 时不连接，刷新详情并要求重新审阅；
9. 审批写入失败时显示可恢复错误，不静默关闭；
10. 项目批准不创建 Runtime Tool Approval，也不提升 Session authorization。

涉及文件：

- `src/app/tui/hooks/useMcpConnection.ts`
- `src/app/tui/components/McpPanel.tsx`
- `src/app/tui/App.tsx`
- `src/app/tui/index.tsx`
- `tests/tui-reducer.test.ts`（只有新增 reducer 状态时）
- 新增或修改 MCP panel component tests

依赖：Task 4、Task 5。

验证：

```bash
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/tui-slash-command.test.ts
bun run typecheck
```

检查点：TUI 展示只消费脱敏 projection；Manager 内部 Map 直读问题留到 Phase 1 Supervisor 计划解决，但不得扩大现有耦合范围。

### Task 7：增加 PTY 审批闭环

状态：completed

改动：

1. 扩展 `createTestWorkspace()` 支持 project MCP 文件和隔离 Approval Store；
2. 新增 PTY scenario：打开含 stdio MCP 的 workspace；
3. 断言 `/mcp` 显示 Pending approval 和风险来源；
4. 在批准前断言 marker 不存在；
5. 通过真实键盘操作打开详情并批准；
6. 断言状态进入 connecting/ready 或发现成功，marker 出现；
7. 另测 reject 和 config_changed；
8. 使用 screen semantic assertion，不依赖精确 ANSI、spinner 或空格快照；
9. suite 串行运行并完整清理进程、HOME 和 workspace。

涉及文件：

- `tests/tui-system/harness/test-workspace.ts`
- 新增 `tests/tui-system/scenarios/mcp-project-approval.test.ts`
- 必要时扩展 input helper，不复制任意 sleep 模式

依赖：Task 6。

验证：

```bash
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-project-approval.test.ts
bun run test:tui:system:core
```

检查点：测试经过真实 TUI 子进程、生产配置加载和真实 stdio MCP，不 mock TUI、Core gate 或 reducer。

### Task 8：文档收敛与完成门禁

状态：completed

改动：

1. 新增 `docs/active/mcp-project-approval.md`；
2. 更新 `docs/active/mcp-runtime-governance.md`；
3. 更新 `docs/book/08-TUI交互全景.md`；
4. 更新 `docs/book/09-CLI模式与配置.md`；
5. 更新 `docs/book/11-MCP与Skills扩展.md`；
6. 更新 `README.md` 的首次 pending approval 与 `/mcp` 操作说明；
7. 更新 `docs/documentation-map.json`，覆盖新 config/approval/TUI 文件；
8. 更新 RFC 的 Phase 0 实施状态；
9. 计划完成后创建 `docs/space/execution/completed/2026-07-15-mcp-project-server-approval-p0.md`；
10. 将本计划标为 completed/archived，并更新两个 space index；
11. 未完成项拆到后续 plan 或 backlog，不能在完成记录中隐藏。

涉及文件：

- 上述文档与索引
- `.agents/skills/document-before-commit/SKILL.md`（只读并执行）

依赖：Task 0–7 全部完成。

验证：

```bash
bun run check:docs-impact
bun run check:docs
bun test tests/docs-space.test.ts
git diff --check
```

检查点：实现、active 文档、book、README、ADR、计划状态和完成记录共同收敛后才能宣称 Phase 0 完成。

## 八、验收矩阵

| 场景 | 预期 | 证据 |
| --- | --- | --- |
| user HTTP/stdio Server | 保持当前连接行为 | 现有 config/E2E 回归 |
| project `.kite-code` 未批准 | 不启动、不请求、不发现 | marker + HTTP request count |
| project `.mcp.json` 未批准 | 不启动、不请求、不发现 | marker + HTTP request count |
| project Server approved | 允许连接，但 Tool 仍按 unknown/user/never 治理 | integration + descriptor assertion |
| project Server rejected | 不启动 | integration |
| approved config 改 command | 重新 pending | digest unit + integration |
| rejected config 改 URL | 重新 pending | digest unit |
| approval store 损坏 | project fail closed，user 不受影响 | unit + integration |
| project 声明 `trust: trusted` | 仍为 remote/untrusted effect | descriptor test |
| project 声明 `minimumApproval: none` | effective 仍为 user | policy test |
| project 声明 safe retry | effective 仍为 never | policy test |
| 高优先级 project pending、低优先级 user 同名 | 不回退 user | catalog test |
| TUI approve | 审阅、确认、写记录、reload、connect | PTY |
| 审阅期间配置变化 | 返回 config_changed，不连接 | unit + PTY/component |
| secret 扫描 | 配置引用外无 token 泄漏 | E2E serialized scan |

## 九、共同验证命令

定向验证：

```bash
bun test tests/config.test.ts tests/mcp-config-catalog.test.ts tests/mcp-project-approval.test.ts
bun test tests/mcp-manager.test.ts tests/mcp.test.ts
bun test tests/e2e/mcp-skills-auth-scopes.test.ts
bun test --parallel=1 --max-concurrency=1 tests/e2e/mcp-project-approval.test.ts
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/tui-slash-command.test.ts
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-project-approval.test.ts
```

仓库门禁：

```bash
bun run typecheck
bun run check:core-boundary
bun run format:check
bun run check:docs-impact
bun run check:docs
bun test tests/docs-space.test.ts
git diff --check
```

不运行真实模型测试；本阶段不依赖真实模型行为。真实 MCP transport 使用本地隔离 fixture。

## 十、提交切片

建议按以下可独立验证的切片提交，避免一个提交同时混合全部安全、TUI 和文档变化：

1. `test/docs: freeze MCP config source precedence and accept approval ADR`；
2. `feat(config): add source-aware MCP catalog and stable project digest`；
3. `feat(config): persist local project MCP approval decisions`；
4. `fix(mcp): gate project transports before connect`；
5. `test(mcp): prove unapproved stdio/http transports never start`；
6. `feat(tui): add minimal project MCP approval flow`；
7. `test(tui): cover project MCP approval in PTY`；
8. `docs: converge project MCP approval behavior and completion evidence`。

每次准备暂存、提交、推送或创建 PR 前，都必须读取并完整执行 `.agents/skills/document-before-commit/SKILL.md`。`bun run check:docs-impact` 未通过时停止提交。

## 十一、风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 来源重构改变同名 precedence | 连接错误 Server | Task 0 characterization；Phase 0 保持当前顺序 |
| pending project 自动回退 user | UI 与实际连接不一致 | effective entry pending 时整体不连接同名 Server |
| TOCTOU：审阅后配置变化 | 批准未审阅命令 | expected digest + 决策前重读 + 连接前再匹配 |
| 项目批准被误作 annotation trust | 仓库降低 Tool 风险 | project connectable config 强制保守 policy |
| approval store 损坏 | 项目 MCP 意外启动或永久不可修复 | fail closed、保留损坏文件、typed diagnostic |
| TUI 审批逻辑成为临时架构债 | Phase 1 重构成本 | 只增加窄 projection/action，不复制 Manager 生命周期 |
| Windows/symlink workspace identity 漂移 | 重复审批或错误复用 | realpath 规范化和跨平台单测 |
| 测试只证明 Tool 不可见 | 进程仍可能已执行 | marker 与 HTTP request count 证明 transport 未发生 |
| 项目现有 E2E 直接失效 | 阻塞安全修复 | fixture 通过生产 Approval Store API 预置批准，不加 bypass |

## 十二、回滚与不可回滚边界

可以回滚：

- `/mcp` 中最小审批详情布局；
- 非必要的诊断文案；
- approval projection 的 App 组织方式。

不得回滚：

- 项目来源识别；
- transport 创建前的 matched approval gate；
- 配置变化使批准失效；
- 项目批准与 annotation/tool policy trust 分离；
- secret 不进入 approval store；
- 未批准项目 Server 不进入 connectable Map。

如果 TUI 审批入口出现严重回归，允许临时只显示 CLI/文件级修复指引，但项目 MCP 必须继续 fail closed，不能恢复自动启动。

## 十三、完成定义

只有同时满足以下条件，Phase 0 才能标记完成：

1. 两类项目来源都在 transport 创建前被门禁；
2. user source 回归通过；
3. approval digest、store、TOCTOU 和保守 policy 有单测；
4. 本地真实 stdio/HTTP fixture 证明未批准时没有副作用；
5. `/mcp` 可以完成审阅、批准、拒绝和 config-changed 恢复；
6. PTY 真实闭环通过；
7. credential 泄漏扫描通过；
8. ADR、active、book、README、documentation map 和完成记录共同更新；
9. `document-before-commit` Skill 完整执行；
10. `check:docs-impact`、`check:docs`、typecheck、core boundary 和所有定向测试通过；
11. 本计划归档，未完成范围进入后续 plan，而不是被宣称完成。

Phase 0 完成后，下一份计划应是 RFC Phase 1：`McpSupervisor`、不可变 control snapshot、typed diagnostics 和只读路由化管理页。不得直接跳到 OAuth 或完整配置编辑器。
