# ADR-0070：Agent 发布资格化仅产生诊断证据，并受独立数据治理约束

状态：accepted
日期：2026-08-05
决策者：`github:@ferqx`（Release + Security & Privacy + Evaluation，single-maintainer）
补充：ADR-0052、ADR-0056、ADR-0057、ADR-0058、ADR-0068、ADR-0069
关联：[Agent 发布资格化实施方案](../space/plans/2026-08-05-agent-release-qualification.md)

## 背景

现有首发权威由 ADR-0068/0069 定义：只有 G0/G1 是当前必要 Gate，且现有 DeepSeek 与
Qwen `qwen3.6-flash` 的最小真实调用属于 G1。RFC 提出的 Feature Matrix、L0–L3、候选绑定
evidence 和自动压缩验证能提高诊断能力，但不能借由新增 schema、报告或真实模型运行重新引入
企业式 Gate、dogfood、private reserve 或 production content admission。

真实 Provider 评测还引入与普通本地测试不同的风险：candidate、fixture、workspace overlay、stdio
child 或日志路径若能接触 credential，测试本身会扩大秘密和内容暴露面。因此在实现任何 schema、runner、CI
或 current 行为文档前，必须先冻结可审计的数据、保留、配额、授权、受保护 ref 和凭据隔离决策。

## 决策

### 1. 诊断 authority 与现有发布 Gate 的隔离

1. `AgentQualificationEvidenceV1`、`LiveCompatibilityObservationV1`、Feature Matrix、L0–L3
   receipt 和 aggregate report 的 authority 固定为 `diagnostic`，`evidenceEligible` 固定为
   `false`。它们不构成 `ReleaseEvidenceV1`，不输入 release bundle、G0–G5 vocabulary、release
   gate evaluator 或 G0/G1 policy。
2. 本 ADR 只补充 ADR-0052 的 identity discipline，且只复用
   `ReleaseArtifactIdentityV1`、`ReleaseEvidenceExecutionIdentityV1` 与 canonical digest
   primitives；不得创建平行的 candidate SHA 身份。
3. `qualified` 仅表示指定 candidate、scope、suite 与 diagnostic evidence 下的派生资格状态，
   不是发布许可、production content admission 或对外支持升级。L3 即使复用 G1 的 route，也只能产生
   独立 diagnostic compatibility observation。
4. `LiveCompatibilityObservationV1` 必须以独立 diagnostic candidate closure 精确闭合
   local-synthetic execution、scope profile、source-owned Matrix/suite、fixture/corpus/oracle/evaluator/verifier/runner、
   governance/retention 和 record/report digest。local-synthetic 的保留 commit sentinel 不是 repository revision，
   closure 不是 candidate aggregate 或任何发布输入；不得为此生成平行 candidate SHA。
5. 当前 G0/G1 release control、workflow 和 DeepSeek/Qwen G1 smoke 的语义保持不变；保留的 historical
   evaluator/bundle 也不得接收 diagnostic record。把 F0–F6、
   private reserve、dogfood 或任何 qualification report 升格为 release hard Gate，必须另有 ADR，
   明确成本、统计、数据边界、失败语义、rollback 与实施计划。

### 2. EvidenceGovernanceProfileV1

后续实现必须以如下 versioned、canonicalizable profile 为唯一治理输入；未知 profile、未知字段、
profile digest 不匹配、超额、缺少 authorization 或无法执行删除都必须得到 `blocked`，不得降级为 pass。

```ts
type EvidenceDataCategoryV1 =
  | 'candidate_identity'
  | 'execution_identity'
  | 'route_alias_and_model'
  | 'canonical_digest'
  | 'reason_code'
  | 'aggregate_counter'
  | 'duration_bucket'
  | 'token_cost_bucket'
  | 'repro_fingerprint'
  | 'workflow_identity'
  | 'retained_artifact_digest'
  | 'reserve_case_digest'
  | 'public_source_reference'
  | 'diagnostic_policy_metadata';
type EvidenceProhibitedDataCategoryV1 =
  | 'credential'
  | 'endpoint_full'
  | 'prompt_content'
  | 'response_content'
  | 'reasoning_content'
  | 'source_content'
  | 'workspace_content'
  | 'session_log_content'
  | 'absolute_path'
  | 'command_content'
  | 'child_output'
  | 'untrusted_executable_output'
  | 'reserve_content';
type EvidenceRetentionClassV1 =
  | 'repository_declaration'
  | 'ephemeral_local'
  | 'protected_ci_retained'
  | 'private_reserve';
type EvidenceAclV1 =
  | 'repository_readers'
  | 'local_owner_only'
  | 'protected_ci_maintainers'
  | 'reserve_custodian_and_reviewer';
type EvidenceEncryptionV1 =
  | 'github_managed_at_rest_and_tls'
  | 'local_owner_disk_encryption'
  | 'customer_managed_key_and_tls';
type EvidenceAuditV1 =
  | 'git_history_and_review'
  | 'local_metadata_audit'
  | 'github_actions_artifact_access'
  | 'append_only_reserve_access_deletion';

interface EvidenceGovernanceProfileV1 {
  schema: 'EvidenceGovernanceProfileV1';
  version: 1;
  profiles: Record<EvidenceRetentionClassV1, {
      profileId: `qualification-governance/${EvidenceRetentionClassV1}/v1`;
      retentionClass: EvidenceRetentionClassV1;
      /** Recomputed from the strict profile material without this field. */
      profileDigest: `sha256:${string}`;
      allowedDataCategories: readonly EvidenceDataCategoryV1[];
      prohibitedDataCategories: readonly EvidenceProhibitedDataCategoryV1[];
      retention: {
        maxAgeSeconds: number | 'source_lifecycle';
        deleteTrigger: 'process_exit' | 'artifact_expiry' | 'cryptographic_purge' | 'source_lifecycle';
      };
      storage: { acl: EvidenceAclV1; encryption: EvidenceEncryptionV1; audit: EvidenceAuditV1 };
      quotas: {
        perRun: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number };
        perDay: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number };
        perMonth: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number };
        maxConcurrentRuns: number;
      };
      issuePublication: 'default_deny';
      requiredAuthorizer: 'none' | 'local_owner' | 'repository_maintainer' | 'reserve_custodian';
  }>;
}
```

后续 schema 必须使用 strict exact-key records；上述两个 data-category array 按代码点稳定排序、去重，并且每个
profile 恰好使用该 profile 的固定闭合集合。`profileDigest` 使用 domain-separated canonical JSON 对去掉
`profileDigest` 的严格 material 重建，profile ID、retention class 或任何枚举变化均使 evidence 失效。
route alias、reason code、repro fingerprint、计数和 bucket 也必须是闭合、长度受限的 metadata 类型；不得以
任意错误文本或 URL 填入这些字段。

`tokens` 是 input 与 output 合计的预算上限；`runWallClockSeconds` 只从 resolver reservation 到 terminal
reconciliation 计时，绝不包括 artifact 的 retention lifetime；`costUsdMicros` 为以微美元表示的成本 ceiling。
所有计数包含 retry 和 cancelled attempt；未能取得 usage/cost 时必须保守记为配置的本次最大值。runner 在
dispatch 前 reservation，在 terminal 后 reconcile；无法 reservation、计数器不可用或上限超出时零网络 `blocked`。

| profile / retention class | 允许的数据 | 禁止的数据 | 保留与删除 | ACL / encryption / audit | 配额（run / day / month；并发） | Issue 与授权 |
| --- | --- | --- | --- | --- | --- | --- |
| `repository_declaration` | `route_alias_and_model`、`canonical_digest`、`public_source_reference`、`diagnostic_policy_metadata` | 全部 prohibited category | 活跃声明随 source lifecycle 移除；不可变 Git 历史按 repository retention 保留，runner 不宣称能删除它 | `repository_readers` / `github_managed_at_rest_and_tls` / `git_history_and_review` | 全部为 0；并发 0 | default deny；无需 live authorization |
| `ephemeral_local` | `candidate_identity`、`execution_identity`、`route_alias_and_model`、`canonical_digest`、`reason_code`、`aggregate_counter`、`duration_bucket`、`token_cost_bucket`、`repro_fingerprint`、`diagnostic_policy_metadata` | 全部 prohibited category | `process_exit`；正常退出立即删除运行 scratch，crash-recovery scratch 最迟 86,400 秒删除 | `local_owner_only` / `local_owner_disk_encryption` / `local_metadata_audit` | 3 / 6 / 30 attempts；12,288 / 24,576 / 122,880 tokens；600 / 1,200 / 7,200 **run seconds**；250,000 / 500,000 / 2,500,000 micros；并发 1 | default deny；仅 `local_owner` 可显式 opt-in |
| `protected_ci_retained` | ephemeral 的允许类别，加 `workflow_identity`、`retained_artifact_digest` | 全部 prohibited category，及未审查 fixture、任意 SHA、任何 candidate/fixture executable output | artifact expiry，最多 1,209,600 秒（14 天）；expiry 后删除 | `protected_ci_maintainers` / `github_managed_at_rest_and_tls` / `github_actions_artifact_access` | 2 / 4 / 30 attempts；12,288 / 24,576 / 184,320 tokens；600 / 1,200 / 9,000 **run seconds**；250,000 / 500,000 / 3,750,000 micros；并发 1 | default deny；`repository_maintainer` authorization 与受保护 job 均必需 |
| `private_reserve` | `reserve_case_digest` 与 ephemeral 的 metadata（不含内容） | 全部 prohibited category，尤其 `reserve_content` | `cryptographic_purge`，最多 2,592,000 秒（30 天）；到期或撤销立即不可恢复删除 | `reserve_custodian_and_reviewer` / `customer_managed_key_and_tls` / `append_only_reserve_access_deletion` | 10 / 20 / 100 attempts；49,152 / 98,304 / 491,520 tokens；1,800 / 3,600 / 18,000 **run seconds**；5,000,000 / 10,000,000 / 50,000,000 micros；并发 1 | default deny；`reserve_custodian` 逐次授权；本计划不实现该 profile |

每个 profile 的 `prohibitedDataCategories` 必须严格等于全部 `EvidenceProhibitedDataCategoryV1` 值；
table 中的 allowed 列是该 profile 唯一合法、排序后的 `allowedDataCategories` 集合，不得通过新增自由字符串
扩大收集面。`repository_declaration` 没有 quota ledger 或 live authorization；其零预算本身必须阻止 dispatch。

所有 profile 的 metadata-only 规则优先于诊断便利性。跨 process/day/month 的配额使用独立的
`EvidenceQuotaLedgerV1`，它只保存 profile/policy/route digest、period bucket、reservation ID、attempt/token/
run-second/cost counters、terminal reconciliation 与 record digest；不得保存 evidence 或内容。ledger 在 synthetic
fixture root 外、child 不可见的位置以 owner-only/受保护-maintainer ACL 保存，使用相应 profile 的 encryption/audit，
至少保留 7,776,000 秒（90 天）以审计月度限额，并以原子 compare-and-reserve 防止并发绕过。每次 retry/cancel
先占用 attempt；reservation 未在 deadline 内 reconciliation 时保守结算为 per-run maximum。没有可用且可审计的
ledger 时，所有有非零配额的 profile 一律 `blocked`。

任何向 Issue、PR comment、默认 artifact、telemetry 或 release bundle 外发 evidence 的请求默认拒绝。
唯一可选例外是维护者发起的 metadata-only handoff：`EvidenceGovernanceAuthorizationV1` 必须严格绑定
`profileId`、`profileDigest`、route/policy digest、sanitized summary digest、actor identity、purpose、issuedAt、
expiresAt 和 domain-separated record digest；其 actor 必须是 profile 的 required authorizer，且该 record 只能由
受信 maintainer control path 产生，candidate、fixture、model、workflow input 或 child 永远不能 mint。CI 永不
发布 Issue；没有未过期 authorization 或目标 ACL/encryption/audit 无法验证时仍为 `blocked`。`private_reserve`
在真实 owner、ACL、轮换和退出机制出现前不可被 runner 选择。

```ts
interface EvidenceQuotaLedgerV1 {
  schema: 'EvidenceQuotaLedgerV1';
  profileId: string;
  profileDigest: `sha256:${string}`;
  routePolicyDigest: `sha256:${string}`;
  period: 'day' | 'month';
  periodStart: string;
  reservationId: string;
  status: 'reserved' | 'reconciled' | 'expired';
  reserved: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number };
  reconciled?: { attempts: number; tokens: number; runWallClockSeconds: number; costUsdMicros: number };
  recordDigest: `sha256:${string}`;
}

interface EvidenceGovernanceAuthorizationV1 {
  schema: 'EvidenceGovernanceAuthorizationV1';
  profileId: string;
  profileDigest: `sha256:${string}`;
  routePolicyDigest: `sha256:${string}`;
  actorIdentity: string;
  purpose: 'metadata_only_issue_handoff';
  sanitizedSummaryDigest: `sha256:${string}`;
  issuedAt: string;
  expiresAt: string;
  recordDigest: `sha256:${string}`;
}
```

两个 record 都是 strict、canonical、domain-separated 且 append-only；`expiresAt` 必须晚于 `issuedAt`，
authorization 只能声明精确 profile authorizer。它们不含正文 payload，且不能接受 candidate/test/fixture/model input。
`requiredAuthorizer='none'` 的 profile 不得创建 authorization record 或 Issue handoff。

### 3. 固定 live runner 隔离契约

1. live runner 只读取 checked-in、reviewed、无密钥 route declaration、policy、evaluator 和 sealed
   synthetic fixture root。fixture 必须由固定 digest/revision materialize 到 detached temporary root，随后
   mount 或 chmod 为只读；runner 必须拒绝任何 fixture 写入、symlink escape、可执行不受信 fixture 或从该 root
   启动 child。唯一可写位置是独立的 detached temporary `cwd`。它还必须使用空的临时 `HOME`、
   `KITE_CODE_HOME`、`USERPROFILE`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME` 与 `XDG_STATE_HOME`；不得读取
   caller workspace、project `.kite-code` overlay、session、log 或普通 config loader。
2. Provider credential 只可在 parent resolver 与 model transport boundary 存在。Tool、Skill、MCP、
   Subagent、shell/stdio child 和不受信 stdio MCP 使用从最小 allowlist 重建的 environment，绝不继承
   credential 或 ambient environment；初期 live Tool/MCP/Subagent case 只允许 in-process deterministic fake。
3. 所有真实调用都需要显式 package-script opt-in 和有效的 `LiveSuitePolicyV1` reservation。未提供 route、
   key、allowlist、capability、policy 或预算即 `blocked`，不回退到普通用户/provider 配置。
4. runner stdout、stderr、report 和 retained artifact 只允许 route alias、model、事件类型、reason code、
   digest、计数、duration、token/cost bucket 与派生状态。任何 key、完整 endpoint、prompt、response、
   hidden reasoning、源码正文、工作区内容、绝对路径或 child output 都必须被 schema 和 output guard 拒绝。
5. 负向 contract 必须在 credential sentinel、恶意 workspace/project/session overlay、stdio MCP、Tool、
   Skill、Subagent 和 child process fixture 下证明：读取、route 覆盖、output 泄漏和 child inheritance 全部
   fail closed，并证明 synthetic fixture root 的 write/execution/symlink-escape 尝试全部拒绝。
6. 每个 diagnostic route 必须绑定独立、versioned 的 `DiagnosticProviderDataPolicyV1`，其严格 material
   至少包括 route ID、operator 与规范化 origin identity digest、仅 `sealed_synthetic` 的允许数据类、
   content retention/training/use 条款、credential source 枚举、issued/expiry 和 policy digest。缺 policy、
   expiry、operator/origin mismatch 或非 synthetic data class 一律 `blocked`。它不等同也不写入
   `ProviderDataPolicyV1` 的 production content admission；Qwen 和任何未来 OpenCode route 因此仍只可能
   产生 diagnostic observation，OpenCode Messages/Responses 在没有原生 adapter 时保持 unsupported。

### 4. 受保护 ref 与 secret CI 契约

带 Provider secret 的 diagnostic workflow 只能在 `ProtectedDiagnosticRefV1` 的固定、reviewed
`refs/heads/main` 上运行。该 strict record 绑定 canonical repository/repository ID、required ref、
workflow path/digest、evaluator digest、fixture digest、policy digest 和独立可验证的 branch-protection snapshot
digest；job 必须同时验证 GitHub event ref/repository/commit 与该 record，并验证 snapshot 仍表明该 ref 受保护。
host 无法提供该保护事实或任一 digest 不匹配时，secret job 不创建而结果为 `blocked`。它不得使用
`pull_request_target`，不得接受 arbitrary SHA、fork ref、可执行 candidate、可执行 fixture 或用户输入来选择
checkout、runner、policy 或 route。workflow 最小权限为 `contents: read`；credential 不写盘、不传给
artifact/upload step，job 结束时撤销临时 root。

任何无法证明 `main` 受保护、workflow/ref/fixture digest 精确匹配或 credential isolation 的 CI run 都是
`blocked`，不产生 retained diagnostic evidence。当前既有 G1 workflow 的入口和 smoke 语义不被本 ADR 修改；
新 contract 只约束后续 AQ live diagnostic job。

### 5. 可测试的实施门槛

AQ-1 及之后只能在本 ADR accepted 且后续实现至少能测试下列事实时开始：

- profile 的 canonical digest、literal profile ID、retention class、expiry、retained artifact 和每一配额
  会被 verifier/reservation 一起校验；
- profile drift、unknown data category、超额或不可删除均为 `blocked`；
- quota ledger 的跨进程原子 reservation/reconciliation、90-day retention 与不可用即 blocked 都有 contract test；
- Issue publication 没有 default allow 路径，且 authorization record 不可由 candidate、fixture 或 model 产生；
- secret runner 对 overlay、child environment、stdio MCP、只读 fixture root、output sink 和 protected-ref
  predicate 的 sentinel 测试全部拒绝；
- 每条 route 的 synthetic-only diagnostic data policy 有效且不扩大 production Provider admission；
- release evidence/gate parser 拒绝 diagnostic schema，diagnostic verifier 不导入 release evaluator/bundle。

## 备选方案

1. **维持单一 Agent task 成功率作为中心发布证据。** 拒绝：它不能区分 deterministic Runtime
   correctness、平台 conformance、真实模型 compatibility 和 evaluator 自身错误，也不能给公开 surface
   提供可审计覆盖。
2. **让 qualification report 直接替代或接入 G0/G1。** 拒绝：这会违反 ADR-0068/0069 的首发终态，
   并在缺少独立的数据、成本、统计和失败语义审查时扩大发布 authority。
3. **把 holdout/private reserve 放进公开仓库或默认 Issue 流。** 拒绝：会污染评测、扩大内容暴露面，且没有
   可验证 ACL、轮换、删除或独立 owner。
4. **允许 workflow、fixture 或输入 arbitrary SHA 获取 secret。** 拒绝：不受信代码可读取 Provider
   credential，破坏最小权限和 candidate-bound audit。
5. **将 Provider key 放入普通 config 或让 child 继承 process.env。** 拒绝：workspace/project overlay、stdio
   MCP、Tool、Skill 和 Subagent 都会成为秘密旁路。

## 后果

- 新资格化 schema、runner、CI 与报告必须独立于 release evidence/gate 路径，并对 profile/digest/retention
  和 scope fail closed。
- 真实 L3 运行默认缺失，因此报告应为 `blocked`/`not_observed`，而不是用 mock、历史绿色或
  G1 结果模拟兼容性通过。
- 诊断能力增加了 profile reservation、删除和 output-scrubbing 实现成本；无法验证这些边界时必须关闭
  live runner，而不能降低保护。
- ADR-0068、ADR-0069 保持历史原文，不被本 ADR 改写或隐式 supersede。

## 回滚

可以删除/关闭 diagnostic runner、route declaration、CI job 或报告入口，并撤销测试 credential；
现有 G0/G1、release profile 和 release candidate workflow 继续按原语义运行。不得通过回滚恢复将
diagnostic evidence 输入 release gate、将 secret 传给 child、记录正文或接受未受保护 ref 的路径。
