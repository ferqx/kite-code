# 真实模型 E2E 套件（保留接口）

AQ-8 的 `test:model:live` 及 AQ-9B 的 `test:model:auto-compaction:live:*` 是将来 L3 diagnostic compatibility wrapper 的保留接口；它们不是 G1 smoke、release Gate 或 production content admission。

## 当前可用性

当前三个 public wrapper 均由 checked-in `liveScratchSupervisorActivationIsImplementedV1() === false` 安全停用。固定 source-byte binding 后，它们在读取 caller credential/environment 或 ledger、创建 resolver、reservation、credential lease、scratch root 或 child 前确定性返回 `blocked/governance_reservation_unavailable`。提供 opt-in、key、base URL、ledger root 或 forged health JSON 都不会使它们访问真实 Provider；不要把 credential 填入命令、脚本、fixture、日志或本目录来尝试开启它们。

health 文件未来只可校验有界 no-secret wire shape/freshness。它不是 activation、maintainer authorization、protected-ref control-plane proof、durable deletion witness 或 persistent supervisor identity。公共 wrapper 在 activation literal 为 false 时不读取 health/ledger。当前仅可称本地 zero-network contract 经过测试；不可称 L3 compatibility、G1 或发布准入已验证。

ADR-0068/ADR-0069 的 `test:provider:smoke` 仍是完全独立的现有 G1 入口，保留原有 DeepSeek 与 Qwen `qwen3.6-flash` 语义；AQ-8/AQ-9B 不替代、削弱或吸收它们，也不能获得 production content admission。

## 未来 implementation/proof 分支的要求

ADR-0071 已接受；只有其可验证 persistent-supervisor service identity、受保护 control plane、Linux native isolation 与 crash/normal-exit retention/deletion proof 都完成并经独立安全复审后，才可重新审查 activation literal。届时仍必须满足：

- 使用 `*.live.ts` 和显式 `bun run` wrapper，默认测试永不发现或调用它；禁止 `pull_request_target`、任意 SHA/fork ref 与不受信 fixture 接触 secret。
- credential 仅在 resolver/model boundary 短暂存在；Tool/Skill/MCP/Subagent/stdio child 只得 allowlist environment，普通 Kite/workspace/project/session config 不得读取。
- 只读 sealed synthetic root、临时 HOME/config/cwd、固定零 retry、预注册 route/policy、JIT quota reservation 与 output guard 必须全部 fail closed。
- output/retained metadata 不得含 key、完整 endpoint、prompt/response/reasoning、源码/工作区内容、绝对路径或 child output；future observation 仍固定 `authority='diagnostic'`、`evidenceEligible=false`，不进入 G0/G1/Gate。
- AQ-9B 只可在内存使用 8,192 absolute threshold 与 12,229 phase cap，且不得读取、设置或推断产品 `contextWindowTokens`（registry 固定 `unknown/not_declared`）。

当前 AQ-9B product-chain coverage 仅来自 test-only `runSyntheticAutoCompactionContractV1`：它不接收 environment、ledger、resolver、lease、caller model function 或 real provider boundary，并不生成 reservation、receipt、observation、report 或 evidence。Mock model、仅公网 MCP 和本地 transport 测试不属于本目录。

## 历史验证记录（非 AQ-8/AQ-9B 资格化证据）

以下记录早于 sealed L3 policy、source-owned identity 和 append-only ledger，保留为历史 context-compaction
兼容性观察；它们不能迁移、重放或表述为 AQ-8/AQ-9B observation、G1 结果或发布资格。

- 2026-07-22，provider `deepseek`，model `deepseek-v4-flash`，正常网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 和 `incremental-summary` 通过。本记录未保留 request 或 response 正文。
- 2026-07-29，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 因 `ContextCompactionValidationError: Summary was truncated` 失败，未进入 incremental 场景。本记录未保留 request 或 response 正文。
