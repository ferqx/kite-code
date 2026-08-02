# ADR-0066：单维护者接受 DeepSeek 精确 Route 的数据政策风险

状态：accepted
日期：2026-08-02
决策者：`github:@ferqx`（Security & Privacy + Evaluation/Product，single-maintainer）
关联：D-14.3、ADR-0056、ADR-0060、Phase 1A、Task 2B.4

## 背景

首发模型候选是 DeepSeek 官方 API 的 `deepseek-v4-flash`。官方政策披露个人数据直接在中华人民
共和国处理和存储，可能用于训练或改进技术，并提供个人数据训练 opt-out 权利；公开材料未承诺
固定 API 正文保留期、特定 deployment region 或 DPA。该政策还说明开发者下游产品的最终用户数据
处理不由 DeepSeek 隐私政策直接覆盖，因此 Kite Code 仍需承担自身披露责任。

项目当前由一人维护。维护者明确决定这些已知政策属性可接受，不应继续阻塞该精确 Route；与此同时，
不能把风险接受扩大为任意 DeepSeek、自定义 endpoint、secret 外发或虚构真实评估证据。

## 决策

1. `release/provider-data-policies/approved-v1.json` 可批准且只批准官方 DeepSeek API 的
   `deepseek-v4-flash`。resolved config 必须为 `providerType=deepseek`、精确 model name，以及
   `https://api.deepseek.com` 或 `/v1` path。
2. canonical identity 固定为 `operatorId=hangzhou-deepseek-ai`、`endpointClass=official_api`、
   `deploymentId=deepseek-api`、`region=unspecified`。换模型、换 host、HTTP、非默认端口、URL
   credentials/query/fragment 或 digest 漂移都不能继承资格。
3. 维护者接受中国处理/存储、可能训练、未承诺固定 API 正文 retention、无 DPA 和 unspecified
   deployment region；这些不再是该精确 Route 的 admission blocker。
4. 当前 pre-release/single-maintainer 阶段使用 release-owned disclosure ID 把上述事实固定到 README、
   active 文档与用户手册；不要求每次 Runtime 调用单独确认，也不把 disclosure receipt 设为模型
   admission 前置条件。正式发版前若产品引入交互式确认，必须另行定义持久化与 revision drift 语义。
   批准 policy 保持短期失效时间；到期未复核、缺失或不匹配时 fail closed。
5. `secret`、runtime secret detector 命中和 protected credential/path marker 在 Provider 网络调用
   前一律拒绝。该风险接受不得降低这些边界。
6. 该批准允许 primary model、compaction 与 Sub-agent 在其他门禁满足时处理最高
   `confidential` 数据；`allowProductionContentEvaluation=false` 保持不变，auto review 与
   Verification reviewer 不得据此消费 production content。
7. Model Provider admission 不签发 remote MCP content egress；`allowRemoteMcpContentEgress=false`
   保持不变。
8. policy approval 只关闭数据政策阻塞，不产生真实 API credential、authenticated run、retained
   evaluation ledger、canary/SLO 或第三方安全评审证据。

## 后果

单维护者可以使用明确配置的官方 DeepSeek Route 推进真实评估，不再被已接受的数据政策属性阻塞。
其他 route 继续 fail closed；发行文档保留准确披露，密钥边界、secondary evaluator 隔离和外部发布
硬门禁不变。

## 回滚

可以删除或缩窄 approved policy、提前失效，或把 `providerDataPolicyV1` 保持关闭。扩大到其他 model、
endpoint、数据用途或 remote MCP 必须追加新决策，不能复用本 ADR 的风险接受。
