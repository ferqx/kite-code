# Agent 生产化 Phase 1A：本地日志、Provider 数据与隐私计划

状态：active
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)
设计依据：RFC §3.4、§9.5、§13、§14

Task 1A.1、1A.2、1A.3 与 1A.5 已完成；1A.3 实现提交为
`2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee`。Task 1A.4 已具备 `ready` binding；其余 Task
继续按依赖保持未绑定。规范记录见
[decision register](2026-07-29-agent-production-decision-register.md)。

## 目标

关闭受限外部灰度前的数据与隐私阻断项：

1. 本地 session logger 从全量正文默认改为 metadata 默认；
2. 日志目录、文件、轮转和迁移满足同机隔离；
3. model Provider、远程 MCP 和 secondary evaluator 使用独立数据策略与授权；
4. 形成后续 telemetry 和 Release Evidence 可以复用的无正文 allowlist mapper。

## 非目标

- 不实现远程 telemetry exporter；
- 不改变 Runtime transcript、checkpoint 或 Plan Artifact 的正文持久化；
- 不承诺删除 Provider 已按其合同保留的数据；
- 不允许项目配置开启 content logging；
- 不把 regex 脱敏当作正文遥测的安全依据。

## 当前基线

- `SessionLogCollector` 总是创建并记录 Workspace、模型身份、模型/工具事件和正文相关属性；
- `SessionLogWriter` 当前没有生产保留期、总容量和单 session 容量策略；
- 旧 session logger 计划把本地全量内容视为“无隐私风险”，该结论已被 RFC 否定；
- 当前没有版本化 `ProviderDataPolicy`；
- 远程 MCP 和模型 Provider 的内容接收边界没有统一 release 资格。

## 主要改动范围

- `src/core/session-logger/`
- `src/core/config/paths.ts`
- `src/core/config/` 中新增 logging/data policy schema
- `src/core/model/` Provider route 解析边界
- `src/core/mcp/` 远程 endpoint identity 与内容外发 admission
- `src/core/runtime/agent.ts` 与 TUI/CLI composition root
- `tests/session-logger/`
- `tests/config.test.ts`
- MCP/model data policy 与迁移测试
- 相关 active、book、ADR 和 documentation map

## 共享 schema ownership

本计划是 `ProviderDataPolicyV1` 的首个实现计划，Security & Privacy 是规范 owner。2A 只消费
本计划导出的 canonical snapshot/digest，3 只消费无正文 mapper；两者不得复制或扩展 schema。
本计划同时拥有 session logging policy 和 remote MCP egress permit 的首个 schema 实现。

## 实施步骤

### 任务执行矩阵

三个迁移 flag 均默认 `false`，但 production profile 只能在对应 flag 打开且 policy 可解析时
启用相关能力。关闭 flag 的生产回滚必须收紧为 `off/metadata/no-egress`，不得回到旧全量正文
或未治理外发路径。

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 1A.1 | `T:0:0.2`、`T:0:0.3`、`D-02:CLOSED`、`D-14:CLOSED` | `src/core/config/session-logging-policy.ts`、`provider-data-policy.ts`、`release/provider-data-policies/`、schema/property tests | `bun test tests/config.test.ts tests/config/provider-data-policy.test.ts`；`bun run typecheck` | `sessionLoggingPolicyV1=false`、`providerDataPolicyV1=false`；production 缺失时 fail closed |
| 1A.2 | 1A.1、`T:1C:1C.4` | `src/core/session-logger/metadata-mapper.ts`、types/collector、secret fixtures | `bun test tests/session-logger/metadata.test.ts` | 跟随 `sessionLoggingPolicyV1`；关闭时 production logging=off，不回旧 serializer |
| 1A.3 | 1A.2 | `src/core/runtime/agent.ts`、`src/app/cli/index.ts`、`src/app/tui/run-agent.ts`、`session-manager.ts`、`tests/session-logger/composition.test.ts`、`tests/tui-system/scenarios/session-logging-status.test.ts` | `bun test tests/session-logger/composition.test.ts tests/session-logger/metadata.test.ts tests/session-logger/writer.test.ts tests/config.test.ts`；`bun test tests/tui-system/scenarios/session-logging-status.test.ts` | 双路径至少两周；production profile 只允许新 policy path |
| 1A.4 | 1A.3 | secure writer、`active-session-lease.ts`、retention/migration、`scripts/release/session-log-acl-smoke.ts` | `bun test tests/session-logger/writer.test.ts tests/session-logger/active-session-lease.test.ts`；POSIX/Windows ACL workflow | migration 先收紧权限再切换；lease 不确定时不删除 |
| 1A.5 | 1A.1、`D-14:CLOSED` | policy registry/loader、route/data classifier、payload provenance、model admission/status tests | `bun test tests/config/provider-data-policy.test.ts tests/model-provider-data-policy.test.ts` | `providerDataPolicyV1=false` 时 production route 全部关闭；旧资格全部失效 |
| 1A.6 | 1A.1、1A.5、`T:1B:1B.4` | MCP route identity/egress permit/policy/integration/concurrency tests | `bun test tests/mcp/data-egress-policy.test.ts tests/mcp/data-egress-concurrency.test.ts` | `remoteMcpEgressPolicyV1=false`；回滚为禁止 remote content egress |
| 1A.7 | 1A.1–1A.6 | active/book/map/ADR/README/完成记录；唯一产生 `MS:1A-DONE` | `bun run check:docs-impact`、`bun run check:docs` | 文档不收敛则 Phase 1A 不完成 |

### Task 1A.1：定义日志与数据策略 schema

新增或收敛：

```typescript
type SessionLoggingMode = 'off' | 'metadata' | 'content';

interface SessionLoggingPolicy {
  mode: SessionLoggingMode;
  retentionDays: number;
  maxTotalBytes: number;
  maxSessionBytes: number;
  includeReasoning: false;
  includeFileContent: false;
  includeToolContent: false;
}

interface ProviderDataPolicyV1 {
  version: 1;
  policyId: string;
  revision: string;
  decisionId: 'D-14';
  approvedRevision: string;
  effectiveFrom: string;
  expiresAt: string;
  routeId: string;
  operatorId: string;
  endpointClass: string;
  endpointIdentityDigest: string;
  region: string;
  credentialOwner: 'user_os_identity' | 'enterprise_admin';
  maxWorkspaceDataClassification: 'public' | 'internal' | 'confidential';
  allowedPayloadKinds: {
    userPrompt: boolean;
    fileSnippet: boolean;
    toolResult: boolean;
    summary: boolean;
  };
  contentRetention: string;
  trainingUse: 'prohibited' | 'contract_defined';
  abuseMonitoring: 'none' | 'metadata_only' | 'content_contract_defined';
  deletionBoundary: string;
  subprocessors: string[];
  dpaOrAdminApproval: 'not_required' | 'required_and_verified';
  userDisclosureId: string;
  requestLogging: 'none' | 'metadata' | 'content_contract_defined';
  errorLogging: 'none' | 'metadata' | 'content_contract_defined';
  productDeletionScope: string;
  allowRemoteMcpContentEgress: boolean;
  allowProductionContentEvaluation: false;
}

interface WorkspaceDataLabelV1 {
  classification: 'public' | 'internal' | 'confidential' | 'secret';
  source: 'artifact' | 'admin' | 'project_raise_only' | 'runtime_secret_detector';
  provenance: 'user_prompt' | 'workspace_file' | 'tool_result' | 'generated_summary';
  canonicalPathDigest?: string;
}
```

实施时字段可以按 ADR 收敛，但必须保持：

- route identity 不是 model name；
- secret/credential 始终高于可发送分类；
- content 用途采用 deny-wins；
- Workspace/project 只能提高分类或关闭外发；
- schema 未知时 production route fail closed。
- payload builder 必须保留 prompt/file/tool/summary provenance；route admission 对 payload kind
  和最高 classification 分别求值，不能先拼成通用字符串再判断；
- credential、受保护路径内容和 runtime secret detector 命中统一标记为 `secret`；用户主动
  粘贴不改变分类，也不自动产生外发授权；
- project 只能通过 canonical path rule 提高 classification，不能覆盖 artifact/admin 或
  secret detector 的更高分类。

权威来源与更新流程：

- policy source 是仓库受控的 `release/provider-data-policies/*.json`，由 Security & Privacy
  Owner 审核，Release Owner 批准后随 payload 打包；Runtime 不在线抓取供应商网页或条款；
- 每条记录绑定 Phase 0 决策 ID、review revision 和有效期；过期、缺失或未知 revision
  在 production profile fail closed；
- route canonical identity 至少覆盖 provider type、operator、规范化 endpoint origin、
  endpoint class/deployment 和 region；UI 只显示稳定 alias；
- 自定义 endpoint 没有批准记录时只允许 internal experimental，不能继承相同 model name
  的 policy；
- 条款或 endpoint 变化通过新 PR/revision 进入下一 payload，并自动改变 policy digest；禁止在
  已分发 artifact 内原地修改 snapshot；
- 离线启动只使用 payload 内 snapshot；无法确认 mandatory policy 时不发起请求。

涉及文件：

- 新增 `src/core/config/session-logging-policy.ts`；
- 新增 `src/core/config/provider-data-policy.ts`；
- 新增 `release/provider-data-policies/` schema 与批准 snapshot；
- 扩展 `src/core/config/index.ts`；
- 新增 schema/组合 property tests。

验证：

```bash
bun test tests/config.test.ts
bun test tests/config/provider-data-policy.test.ts
bun run typecheck
```

### Task 1A.2：建立 metadata-only mapper

将本地生产日志字段改为显式 allowlist：

允许：

- event type、duration、状态；
- tool/capability kind；
- 低基数 `FailureKind`；
- token/retry 计数；
- approval/verification 类型与结果；
- compaction before/after/failure kind；
- release version/profile/cohort。

禁止：

- user/model text、reasoning、summary；
- tool args/stdout/stderr/MCP content；
- file/workspace path；
- Plan/Skill/MCP description 正文；
- base URL、header、credential reference；
- 原始异常栈和 Provider response body。

要求：

- mapper 从结构化 Runtime Event/Receipt 构造；
- 禁止先序列化完整事件再删除字段；
- metadata mapper 与未来 telemetry mapper 共享 schema，不共享含正文对象；
- classifier 不能继续从用户可见错误字符串推断新 failure kind。

涉及文件：

- `src/core/session-logger/recorder.ts`
- `src/core/session-logger/types.ts`
- `src/core/session-logger/collector.ts`
- `src/core/runtime/failures.ts`
- 新增 `tests/session-logger/metadata.test.ts`

检查点：metadata fixture 中注入 unique secret、绝对路径、命令和源码 marker，输出全文不得命中。

### Task 1A.3：按 mode 组合 SessionLogCollector

改动：

- App composition root 注入 resolved logging policy；
- `off` 不创建目录、不缓存正文；
- `metadata` 只使用 allowlist mapper；
- `content` 需要 artifact profile 允许且用户/管理员显式 opt-in；
- project config 不能开启 `content`；
- `content` 仍禁止 reasoning、secret 和 credential，并有单独 UI 披露；
- logger 失败向用户最多显示一次脱敏诊断，不传播到 Runtime。

涉及文件：

- `src/core/runtime/agent.ts`
- `src/app/tui/index.tsx`
- `src/app/cli/index.ts`
- `src/core/session-logger/index.ts`
- TUI/CLI 配置与状态入口

验证：

- 三种 mode 的 TUI/CLI composition tests；
- `off` 模式无日志根目录；
- project 配置尝试开启 content 被拒；
- logger 构造失败不影响只读 Runtime，但不写到不安全 fallback。

完成证据：`2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee`；独立复核未发现 P0/P1，
定向回归 333 pass，默认套件 2067 pass/6 skip，真实 content composition、writer
fail-closed 与 TUI/CLI mode/status 均已覆盖。

### Task 1A.4：文件权限、轮转与迁移

POSIX：

- 根目录、frontend 和 session 目录 `0700`；
- 文件 `0600`；
- 拒绝 symlink；
- 原子写 summary/index；
- append 前验证 owner-owned regular file。

Windows：

- owner-only ACL；
- 拒绝 reparse point；
- temp/rename 保持安全目录。

清理：

- retention 和容量 cleanup 有时间/条数预算；
- 只处理规范根目录内、符合命名和 owner 的 regular file；
- active session 不删除；
- 单 session 超限后停止内容写入，保留 bounded metadata 终态；
- 历史不安全文件先收紧权限，无法收紧则隔离并提示。

active session 使用跨进程 durable lease：

- 每个 session writer 持有 owner/PID/start-time/nonce 绑定的 lock 与 heartbeat；
- 正常关闭写 terminal marker 后释放；另一个进程不能删除有效 lease 的 session；
- crash 后仅在 PID identity 不匹配且超过批准 stale window 时恢复；
- wall-clock 回拨、PID reuse、双进程 TUI/CLI、lease 文件损坏时保守跳过删除；
- cleanup 的 lease 判定、删除和目录 identity 复核必须在同一受控操作内完成。

涉及文件：

- `src/core/session-logger/writer.ts`
- `src/core/config/paths.ts`
- 新增 retention/migration 模块
- `tests/session-logger/writer.test.ts`
- 新增 POSIX 权限、symlink、rotation、migration 测试
- Windows native smoke workflow

验证：临时 home 中检查 mode/ACL、symlink、并发写、磁盘满、容量上限和迁移结果。

### Task 1A.5：Provider Data Policy admission

改动：

- production-qualified route 必须解析到明确 data policy；
- 只接受 Task 1A.1 定义的 payload 内 canonical policy registry；用户/项目配置不能新增或
  放宽 production policy；
- policy snapshot/digest 交给后续 Release Manifest；
- endpoint/operator/region/retention/training 条款变化使 qualification 失效；
- 自定义 endpoint 缺 policy 时只允许 internal experimental；
- secret、credential 和 protected path 在构造 model payload 前独立阻断；
- UI 状态页显示 route alias、允许分类和正文用途，不显示敏感 endpoint。

涉及文件：

- `src/core/model/factory.ts`
- `src/core/model/model-capabilities.ts`
- `src/core/model/invoke.ts`
- `src/core/config/provider-data-policy.ts`
- TUI/CLI status projection

验证：

- 同 model name、不同 endpoint 得到不同 route identity；
- policy digest 改变使旧资格失效；
- unknown policy 在 limited profile fail closed；
- secret marker 不进入 mocked Provider request。

### Task 1A.6：远程 MCP 独立内容外发门禁

改动：

- 本地 stdio MCP 与远程 HTTP MCP 明确区分；
- remote MCP content egress 不能继承 model Provider consent；
- server identity、endpoint、数据分类和本次参数共同进入 Policy；
- host allowlist 不等于允许上传 Workspace 内容；
- Tool Search/discovery 不触发正文外发；
- secondary evaluator 保持默认关闭且不消费生产正文。

新增单次 `RemoteMcpEgressPermitV1`：

```typescript
interface RemoteMcpEgressPermitV1 {
  version: 1;
  invocationId: string;
  serverIdentity: string;
  endpointRevision: string;
  toolRevision: string;
  argumentDigest: string;
  dataClassifications: Array<'public' | 'internal' | 'confidential'>;
  payloadKinds: Array<'user_prompt' | 'file_snippet' | 'tool_result'>;
  nonce: string;
  approvedAt: string;
  expiresAt: string;
}
```

- permit 独立于 Tool effects approval 和 model Provider consent；
- permit 绑定规范化后的最终参数 digest、server/endpoint/tool revision 和 invocation；
- dispatch 前原子消费一次；过期、revision/argument mismatch、重复消费全部拒绝；
- parallel/batched MCP 的每个 invocation 必须持有独立 nonce/permit，并分别在 dispatch 前
  原子消费；permit 不得在 sibling 间共享、转移，或由 batch 级 approval 代替；
- 一个 sibling 的 permit 消费、拒绝或失败不改变其他 sibling 的授权状态；参数排序或
  tool/server revision 变化必须对对应 invocation 重新求值；
- read-only MCP 只有在不发送 Workspace/content 数据时才可不要求 egress permit；
- permit/拒绝原因进入 receipt，正文和原始参数不进入 telemetry。

涉及文件：

- `src/core/mcp/runtime-provider.ts`
- `src/core/mcp/tool-policy.ts`
- `src/core/mcp/control-types.ts`
- `src/core/mcp/egress-permit.ts`
- `src/core/controllers/tool-controller.ts`
- MCP policy/integration tests

验证：

- 未授权 remote MCP 收到零请求；
- model route consent 不放行 remote MCP；
- read-only effect 不自动代表数据可外发；
- project MCP config 不能降低数据分类。
- permit argument/revision mismatch、过期和 replay 均产生零网络请求。
- 并发 sibling 不能复用同一 nonce/permit；竞争消费只允许一个成功，其余均在网络请求前
  fail closed，且一个拒绝不会授权同 batch 的其他调用。

### Task 1A.7：文档和迁移收敛

更新：

- 新增 active 日志/数据边界记录；
- `docs/active/model-provider-boundary.md`；
- `docs/active/mcp-runtime-governance.md`；
- `docs/book/09-CLI模式与配置.md`；
- `docs/book/10-持久化与会话管理.md`；
- `docs/book/11-MCP与Skills扩展.md`；
- `docs/documentation-map.json`；
- session logger 与数据边界 ADR。

旧 `2026-06-18-session-logger.md` 保持 archived 历史事实，不改写；完成记录说明本计划改变了
其“全量本地日志”当前行为。

实现、迁移、定向验证和文档门禁全部收敛后，本任务唯一产生 `MS:1A-DONE`。

## 验收条件

- [ ] production 默认 `metadata`；
- [ ] `off` 不落盘；
- [ ] content 只能显式 opt-in，项目不能开启；
- [ ] metadata/telemetry mapper 的敏感 marker 命中为 0；
- [ ] POSIX 0700/0600 和 Windows owner-only ACL smoke 通过；
- [ ] retention、单 session/总容量、symlink 和历史迁移通过；
- [ ] model route 有版本化 data policy 和 digest；
- [ ] remote MCP 使用独立 egress consent；
- [ ] 真实用户正文默认不进入 secondary evaluation；
- [ ] 相关 active/book/ADR/map 收敛；
- [ ] 完整 Required CI 通过。

## 回滚

- 可以从 `metadata` 降为 `off`；
- 可以关闭特定 Provider/MCP route；
- 可以缩短保留期和容量；
- 不能回滚为默认全量内容日志；
- 不能因 data policy 服务不可用而放行 unknown route；
- rollback 不删除仍在保留期内且权限安全的用户日志，除非用户明确请求。

## 风险

| 风险 | 控制 |
| --- | --- |
| metadata mapper 漏字段 | allowlist 构造 + secret corpus + snapshot |
| cleanup 删除错误文件 | canonical root、owner、regular-file、命名和 active-session 检查 |
| Windows ACL 行为难以本地验证 | dedicated native smoke，不能用 POSIX 测试代替 |
| Provider 条款无法机器读取 | artifact 内建受审 policy snapshot，变更人工触发失效 |
| 远程 MCP “只读”仍上传源码 | effects 与 data egress 分离 |
| content opt-in 成为隐性默认 | artifact ceiling + 用户显式操作 + project deny |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

完成记录至少附：

- 权限/ACL、rotation、migration 测试；
- 敏感 marker corpus 结果；
- Provider route/data policy fixture 与 digest；
- remote MCP egress admission E2E；
- default profile 的 logging/data 配置；
- 未支持 route 和平台列表。
