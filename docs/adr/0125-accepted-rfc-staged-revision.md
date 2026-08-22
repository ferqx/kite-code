# ADR-0125：同步已接受 RFC 的分期实施事实

状态：accepted

日期：2026-08-20

决策者：用户直接指令

相关：Runtime Modularization V1 RFC、ADR-0123、ADR-0124、RMV1 implementation plan、RAV1 implementation plan

## 背景

ADR-0124 已把 Runtime Modularization 的交付拆为保持 State 25/Store 4/current epoch 的 RMV1，以及后续升级 authority、identity、cross-Host coordination 和 State 26/Store 5/new epoch 的 RAV1。它最初选择保留 accepted RFC 原文，通过 ADR 与 plan 覆盖旧实施默认值。

这导致 RFC 单独阅读时仍显示旧包名、Host-owned Context Compiler、单体 RuntimeCompositionIdentity、RMV1 内切 Store 5/State 26、旧迁移拓扑和旧 qualification Gate。用户随后明确要求把 RFC 的过时信息直接更新掉。

修订前 RFC SHA-256 为 `df16b31faad2cfad89c792d6dd8df6b3024b98f459b7b8bc408f1bcce770619d`。

## 决策

1. 允许直接修订 accepted RFC 中已被 ADR-0124 取代的实施信息；RFC 的 accepted 状态和最终四边界目标不变。
2. RFC 正文同步：
   - `runtime-spi` 与 `builtin-runtime` 包名；
   - Host 只拥有通用机制，具体 Context/Prompt/Skill/Model/Capability 语义由 builtin runtime 通过 port 提供；
   - RMV1/RAV1 双计划、任务拓扑与自动 stop-and-report Gate；
   - RMV1 保持 State 25、Store 4、当前 epoch 与当前安全行为；
   - RAV1 承接 Project/分层 identity、Grant/Receipt authenticity、DataOrigin/Egress/Credential、可选 Project resource fence、State 26/Store 5/new epoch；
   - 同进程可信代码模型、人工/自动 manifest 分类、静态领域 reducer 与 Release Qualification Gate。
3. 不改变 RFC 的 Client/Host/Kernel/execution 四条最终权威边界，不取消 ADR-0123 的最终 authority 方向，也不提前解除 RAV1 的 blocked 状态。
4. 修订后 RFC SHA-256 为 `a8fd3f35b5ca2331ff800c5a71f8a7907da5f6c5d11778b00e90c647c4d8be62`。该摘要替代旧摘要，作为当前 accepted RFC revision identity。
5. 两个 implementation plan 继续是实际执行范围、顺序和 Gate 的权威入口；RFC 不取代 task-level plan。

## 替代范围

- 仅替代 ADR-0124 中“accepted RFC 不改写历史正文”的文档维护选择；ADR-0124 的 RMV1/RAV1 分期和所有架构决定继续有效。
- 不改写 ADR-0123 或 ADR-0124 的历史正文。

## 后果

- 单独阅读 RFC 不再得到旧包名、单计划 cutover 或 RMV1 内切新格式的错误指令；
- 原 RFC 摘要保留在本 ADR 中，修订历史可审计；
- RMV1-00 完成证据和所有 digest verifier 必须更新到新摘要；
- 当前仍只允许启动 RMV1-01 精简 baseline/manifest，RAV1 保持 blocked。
